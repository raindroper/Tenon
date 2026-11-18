import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Paperclip, Send, X } from 'lucide-react';
import { mailTaskSpecSchema, type MailTaskSpec } from '../../shared/mail';
import type { ConnectorDirectory } from '../../shared/connectors';
import type { TaskSpec } from '../../shared/task-consent';
import { EWS_MAX_ATTACHMENT_BYTES, EWS_MAX_OUTGOING_ATTACHMENT_BYTES, EWS_MAX_OUTGOING_ATTACHMENTS } from '../../shared/ews';
import { api, ApiError } from '../api';
import { attachmentSize, mailAddresses, mailModeLabel, mailSubject, quotedMail, sourceIsProtected, uniqueMailAddresses,
  uploadMailAttachment, type EwsAttachmentPage, type EwsComposeMode, type EwsMailContext, type EwsMailUpload } from '../lib/ews-mail';
import { sceneName } from '../state/ui-state';
import type { PanelContext } from './types';

interface DraftUpload extends EwsMailUpload { sourceAttachmentId?: string }
export function EwsComposePanel({ runtime, perform, onClose, onPanelSubmitted, connectionId, mode, original }: PanelContext & {
  connectionId: string; mode: EwsComposeMode; original?: { queryId: string; messageId: string };
}) {
  const [directory, setDirectory] = useState<ConnectorDirectory>();
  const [context, setContext] = useState<EwsMailContext>();
  const [originalAttachments, setOriginalAttachments] = useState<EwsAttachmentPage>();
  const [attachmentError, setAttachmentError] = useState('');
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [to, setTo] = useState(''); const [cc, setCc] = useState(''); const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [includeOriginal, setIncludeOriginal] = useState(mode === 'forward');
  const [allowProtected, setAllowProtected] = useState(false);
  const [uploads, setUploads] = useState<DraftUpload[]>([]); const [uploading, setUploading] = useState(false); const [saving, setSaving] = useState(false);
  const [admissionUncertain, setAdmissionUncertain] = useState(false);
  const uncertain = useRef(false);
  const uploadController = useRef<AbortController | undefined>(undefined);
  const uploadInput = useRef<HTMLInputElement>(null);
  const submission = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);
  const inFlight = useRef(false); const retainedUploads = useRef<DraftUpload[]>([]); const submitted = useRef(false);
  const endpoint = `/api/connectors/ews/${encodeURIComponent(connectionId)}`;
  const connection = directory?.connections.find(item => item.id === connectionId && item.kind === 'ews');
  const activeCase = runtime.cases.find(item => item.id === connection?.caseId && ['active', 'waiting'].includes(item.status));
  const protectedSource = sourceIsProtected(context?.encryption);
  const sourceAllowed = !protectedSource || allowProtected;
  const sourceBodyReadable = Boolean(context && ['read', 'empty'].includes(context.bodyStatus) && typeof context.body === 'string');
  const actualBody = [body.trimEnd(), includeOriginal && sourceAllowed && sourceBodyReadable ? quotedMail(context!) : ''].filter(Boolean).join('\n\n');
  const source = context?.source;
  const candidate = connection?.ews ? {
    connectionId, credentialRevision: context?.credentialRevision ?? connection.ews.credentialRevision, mode,
    ...(mode === 'send' ? {} : { source }), to: mailAddresses(to), cc: mailAddresses(cc), bcc: mailAddresses(bcc), subject: subject.trim(), body: actualBody,
    attachments: uploads.map(({ id, sha256 }) => ({ id, sha256 })), protection: 'plaintext' as const,
    ...(protectedSource && allowProtected ? { allowProtectedSourcePlaintext: true as const } : {}),
  } : undefined;
  const parsed = mailTaskSpecSchema.safeParse(candidate);
  const missingOriginal = mode !== 'send' && !context;
  const invalidQuote = includeOriginal && (!sourceBodyReadable || !sourceAllowed);
  const ready = parsed.success && activeCase && !loading && !uploading && !missingOriginal && !invalidQuote && sourceAllowed;

  useEffect(() => {
    const request = new AbortController(); setLoading(true); setError(''); setAttachmentError('');
    void (async () => {
      try {
        const list = await api<ConnectorDirectory>('/api/connectors', 'GET', undefined, request.signal);
        let selected: EwsMailContext | undefined;
        let files: EwsAttachmentPage | undefined;
        if (mode !== 'send') {
          if (!original) throw new Error('回复或转发需要先选择一封邮件。');
          [selected, files] = await Promise.all([
            api<EwsMailContext>(`${endpoint}/message-context`, 'POST', { readExistingInbox: true, ...original }, request.signal),
            api<EwsAttachmentPage>(`${endpoint}/attachments`, 'POST', { readExistingInbox: true, ...original }, request.signal)
              .catch(cause => {
                if (!request.signal.aborted) setAttachmentError(cause instanceof Error ? cause.message : '原信附件列表暂时无法读取。');
                return undefined;
              }),
          ]);
        }
        if (request.signal.aborted) return;
        setDirectory(list); setContext(selected); setOriginalAttachments(files);
        if (selected) {
          setSubject(mailSubject(mode, selected.subject));
          if (!['read', 'empty'].includes(selected.bodyStatus)) setIncludeOriginal(false);
          const targets = selected.replyTo?.length ? selected.replyTo : [selected.from];
          const excluded = selected.selfAddress ? [selected.selfAddress] : [];
          if (mode === 'reply') setTo(uniqueMailAddresses(targets).join('; '));
          if (mode === 'replyAll') {
            const primary = uniqueMailAddresses([...targets, ...selected.to], excluded);
            setTo(primary.join('; ')); setCc(uniqueMailAddresses(selected.cc, [...excluded, ...primary]).join('; '));
          }
        }
      } catch (cause) {
        if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : '邮件信息无法读取，请关闭后重新打开。');
      } finally { if (!request.signal.aborted) setLoading(false); }
    })();
    return () => request.abort();
  }, [connectionId, endpoint, mode, original?.messageId, original?.queryId]);

  useEffect(() => { retainedUploads.current = uploads; }, [uploads]);
  useEffect(() => () => {
    uploadController.current?.abort();
    if (!submitted.current) for (const upload of retainedUploads.current) {
      void api(`${endpoint}/mail-uploads/${encodeURIComponent(upload.id)}`, 'DELETE').catch(() => undefined);
    }
  }, [endpoint]);

  async function addFiles(files: FileList | null) {
    if (!files?.length || uploading || saving || uncertain.current) return;
    const selected = [...files]; if (uploadInput.current) uploadInput.current.value = '';
    if (uploads.length + selected.length > EWS_MAX_OUTGOING_ATTACHMENTS) { setError('一封邮件最多添加十个附件。'); return; }
    if (selected.some(file => file.size > EWS_MAX_ATTACHMENT_BYTES)
      || [...uploads, ...selected].reduce((sum, file) => sum + file.size, 0) > EWS_MAX_OUTGOING_ATTACHMENT_BYTES) {
      setError('单个附件最多 5 MB，全部附件合计最多 10 MB。'); return;
    }
    uploadController.current?.abort(); const controller = new AbortController(); uploadController.current = controller;
    setUploading(true); setError(''); const accepted: DraftUpload[] = [];
    try {
      for (const file of selected) accepted.push(await uploadMailAttachment(connectionId, file, controller.signal));
      if (!controller.signal.aborted) setUploads(values => [...values, ...accepted]);
    } catch (cause) {
      for (const file of accepted) void api(`${endpoint}/mail-uploads/${encodeURIComponent(file.id)}`, 'DELETE').catch(() => undefined);
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '附件上传失败。');
    } finally { if (!controller.signal.aborted) setUploading(false); }
  }
  async function removeFile(upload: DraftUpload) {
    if (saving || uploading || uncertain.current) return;
    setError(''); setUploading(true);
    try { await api(`${endpoint}/mail-uploads/${encodeURIComponent(upload.id)}`, 'DELETE'); setUploads(values => values.filter(value => value.id !== upload.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '附件暂时无法移除。'); }
    finally { setUploading(false); }
  }
  async function selectOriginalAttachment(attachmentId: string) {
    if (!original || uploading || saving || uncertain.current) return;
    const existing = uploads.find(file => file.sourceAttachmentId === attachmentId);
    if (existing) { await removeFile(existing); return; }
    if (!sourceAllowed || uploads.length >= EWS_MAX_OUTGOING_ATTACHMENTS) return;
    const attachment = originalAttachments?.attachments.find(file => file.id === attachmentId);
    if (!attachment || attachment.size > EWS_MAX_ATTACHMENT_BYTES
      || uploads.reduce((sum, file) => sum + file.size, attachment.size) > EWS_MAX_OUTGOING_ATTACHMENT_BYTES) {
      setError('单个附件最多 5 MB，全部附件合计最多 10 MB。'); return;
    }
    setUploading(true); setError('');
    const controller = new AbortController(); uploadController.current = controller;
    try {
      const file = await api<EwsMailUpload>(`${endpoint}/mail-uploads/from-message`, 'POST', {
        readExistingInbox: true, ...original, attachmentId, ...(protectedSource ? { allowProtectedSourcePlaintext: true } : {}),
      }, controller.signal);
      if (!controller.signal.aborted) setUploads(values => [...values, { ...file, sourceAttachmentId: attachmentId }]);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '原信附件未能准备。'); }
    finally { if (!controller.signal.aborted) setUploading(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (!ready || !parsed.success || !connection || inFlight.current) return;
    inFlight.current = true; setSaving(true);
    try {
      const mail: MailTaskSpec = parsed.data;
      const spec: TaskSpec = { caseId: connection.caseId, title: `${mailModeLabel[mode]}：${mail.subject}`.slice(0, 200),
        objective: `使用所选 EWS 邮箱按已填写的收件人、正文和附件${mode === 'forward' ? '转发' : mode === 'send' ? '发送' : '回复'}邮件。`,
        expectedOutput: '向邮件服务器提交这一封邮件，保存真实发送回执；结果未知时不自动重发。', capabilities: ['mail'], mail };
      const fingerprint = JSON.stringify(spec);
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, requestId: crypto.randomUUID() };
      const accepted = await perform('task-request', async () => {
        const wasUncertain = uncertain.current;
        // Keep the immutable upload refs if the browser closes while admission
        // is in flight: the server may already own a durable sending task.
        submitted.current = true;
        try {
          const result = await api('/api/tasks', 'POST', { requestId: submission.current!.requestId, spec });
          uncertain.current = false; setAdmissionUncertain(false); return result;
        } catch (cause) {
          if (cause instanceof ApiError && cause.status < 500 && !wasUncertain) submitted.current = false;
          else { uncertain.current = true; setAdmissionUncertain(true); }
          throw cause;
        }
      }, '邮件发送委托已保存，请查看任务中的真实提交结果。');
      if (accepted) { submitted.current = true; onPanelSubmitted(connection.caseId); }
    } finally { inFlight.current = false; setSaving(false); }
  }

  return <form className="form-stack" onSubmit={event => void send(event)}>
    <p className="field-note">填写下面的收件人、内容和附件，点击“发送这一封”即明确委托。提交后的真实结果会显示在对话任务中。</p>
    {!runtime.settings.enabled && <p className="field-note">榫当前已暂停。点击发送会先保存这次委托，恢复运行后才会执行。</p>}
    {loading && <p className="field-note" role="status"><LoaderCircle className="spin" size={14} />正在准备邮箱和原邮件信息…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {admissionUncertain && <p className="field-error" role="alert">提交时连接中断，发送任务可能已经登记。请先核对这一次任务，或进入对话查看结果；表单已固定，不会自动再次发送邮件。</p>}
    <fieldset className="form-stack" disabled={loading || saving || uploading || admissionUncertain || !connection}>
      <p className="field-note">发件连接：{connection?.ews?.endpoint ?? '正在读取'} · {sceneName(connection?.caseId ?? '', activeCase?.title)}{context?.selfAddress ? ` · ${context.selfAddress}` : ''}</p>
      {!activeCase && !loading && <p className="field-error">这份连接的关联场景已停止，请先恢复场景。</p>}
      <label>收件人 To<input value={to} onChange={event => setTo(event.target.value)} maxLength={13000} placeholder="完整邮箱地址，以逗号或分号分隔" autoComplete="off" /></label>
      <label>抄送 Cc<input value={cc} onChange={event => setCc(event.target.value)} maxLength={13000} autoComplete="off" /></label>
      <label>密送 Bcc<input value={bcc} onChange={event => setBcc(event.target.value)} maxLength={13000} autoComplete="off" /></label>
      {mode === 'replyAll' && !context?.selfAddress && <p className="field-note">未取得当前邮箱的地址，请检查回复全部的收件人并移除自己的地址。</p>}
      <label>主题<input required value={subject} onChange={event => setSubject(event.target.value)} maxLength={998} /></label>
      <label>正文<textarea rows={8} maxLength={200000} value={body} onChange={event => setBody(event.target.value)} /></label>
      {context && <>
        <label className="checkbox-label"><input type="checkbox" checked={includeOriginal} onChange={event => setIncludeOriginal(event.target.checked)} disabled={!sourceBodyReadable} />包含已获取的原信正文</label>
        {!sourceBodyReadable && <p className="field-note">原信正文尚不可读，本次不能引用原信正文。</p>}
        {context.truncated && <p className="field-note">原信正文超过读取上限，引用只能包含当前已获取的部分。</p>}
      </>}
      {protectedSource && <section className="task-scope form-stack">
        <p>原信使用 S/MIME 保护。当前版本以明文发送，引用原信或转发其附件会让所填收件人直接读取这些内容。</p>
        <label className="checkbox-label"><input type="checkbox" checked={allowProtected} onChange={event => setAllowProtected(event.target.checked)} />我明确允许把这封受保护邮件的内容和所选附件以明文发送给上述收件人</label>
      </section>}
      {originalAttachments && originalAttachments.attachments.length > 0 && <fieldset className="form-stack"><legend>原信附件（仅发送勾选的文件）</legend>
        {originalAttachments.attachments.map(file => <label className="checkbox-label" key={file.id}>
          <input type="checkbox" checked={uploads.some(upload => upload.sourceAttachmentId === file.id)} disabled={!file.supported || !sourceAllowed || uploading}
            onChange={() => void selectOriginalAttachment(file.id)} />{file.name} · {attachmentSize(file.size)}{file.sourceProtected ? ' · 来自受保护原信' : ''}{!file.supported ? ' · 暂不支持转发此类附件' : ''}
        </label>)}
      </fieldset>}
      {attachmentError && <p className="field-error" role="alert">原信附件未能载入：{attachmentError} 本次不会包含原信附件；关闭后重新打开可重试。</p>}
      <label>添加本机附件<input ref={uploadInput} type="file" multiple onChange={event => void addFiles(event.target.files)} /></label>
      <p className="field-note">最多十个附件，单个最多 5 MB，合计最多 10 MB。</p>
      {uploads.length > 0 && <ul className="connector-list">{uploads.map(file => <li className="connector-record" key={file.id}>
        <div className="connector-record-heading"><span><Paperclip size={14} />{file.name} · {attachmentSize(file.size)}</span>
          <button className="text-link" type="button" aria-label={`移除附件 ${file.name}`} onClick={() => void removeFile(file)}><X size={14} />移除</button></div>
      </li>)}</ul>}
    </fieldset>
    {uploading && <p className="field-note" role="status">正在准备附件…</p>}
    <section className="task-scope form-stack" aria-label="实际发送内容">
      <h3>实际发送内容</h3>
      <dl className="connector-details"><dt>收件人</dt><dd>{mailAddresses(to).join('；') || '尚未填写'}</dd><dt>抄送</dt><dd>{mailAddresses(cc).join('；') || '无'}</dd>
        <dt>密送</dt><dd>{mailAddresses(bcc).join('；') || '无'}</dd><dt>主题</dt><dd>{subject.trim() || '尚未填写'}</dd><dt>保护方式</dt><dd>明文邮件{protectedSource ? ' · 原信受保护，须明确允许分享' : ''}</dd>
        <dt>附件</dt><dd>{uploads.length ? uploads.map(file => `${file.name}（${attachmentSize(file.size)}）`).join('；') : '无'}</dd></dl>
      <details><summary>查看完整待发送正文</summary><div className="markdown" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{actualBody || '（正文为空）'}</div></details>
    </section>
    {actualBody.length > 200000 && <p className="field-error">正文与原信引用合计超过 200,000 个字符，请缩短正文或取消引用。</p>}
    {!parsed.success && !loading && <p className="field-note">请核对收件地址、主题和附件；同一地址不能在 To、Cc、Bcc 中重复。</p>}
    <div className="form-actions"><button className="button button-quiet" type="button" disabled={saving}
      onClick={() => admissionUncertain && connection ? onPanelSubmitted(connection.caseId) : onClose()}>{admissionUncertain ? '查看发送任务' : '取消'}</button>
      <button className="button button-primary" type="submit" disabled={!ready || saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{admissionUncertain ? '核对这一次发送任务' : '发送这一封'}</button></div>
  </form>;
}
