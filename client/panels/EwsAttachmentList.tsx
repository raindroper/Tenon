import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import { attachmentSize, downloadMailAttachment, type EwsAttachmentMetadata, type EwsAttachmentPage } from '../lib/ews-mail';

export function EwsAttachmentList({ connectionId, queryId, messageId }: { connectionId: string; queryId: string; messageId: string }) {
  const [page, setPage] = useState<EwsAttachmentPage>();
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [downloading, setDownloading] = useState<string>();
  const download = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setPage(undefined);
    void api<EwsAttachmentPage>(`/api/connectors/ews/${encodeURIComponent(connectionId)}/attachments`, 'POST', {
      readExistingInbox: true, queryId, messageId,
    }, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '附件列表暂时无法读取。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); download.current?.abort(); };
  }, [connectionId, queryId, messageId]);

  async function save(file: EwsAttachmentMetadata) {
    if (downloading) return;
    download.current?.abort(); const controller = new AbortController(); download.current = controller;
    setDownloading(file.id); setError('');
    try { await downloadMailAttachment(connectionId, { queryId, messageId }, file, controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '附件下载未完成。'); }
    finally { if (!controller.signal.aborted) setDownloading(undefined); }
  }
  return <section className="form-stack" aria-label="邮件附件">
    <h5 style={{ margin: 0, fontSize: 14 }}>附件</h5>
    {loading && <p className="field-note" role="status">正在读取附件信息…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {page && (page.attachments.length ? <>
      {page.attachments.some(file => file.sourceProtected) && <p className="field-note">附件来自受保护邮件，下载时会由服务端解密。</p>}
      <ul className="connector-list">{page.attachments.map(file => <li className="connector-record" key={file.id}>
        <div className="connector-record-heading"><span>{file.name} · {attachmentSize(file.size)}{file.isInline ? ' · 内嵌文件' : ''}</span>
          <button type="button" className="text-link" disabled={!file.supported || Boolean(downloading)} onClick={() => void save(file)}>
            {downloading === file.id ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{downloading === file.id ? '正在下载…' : '下载附件'}</button></div>
        {!file.supported && <p className="field-note">此类附件暂不支持下载。</p>}
      </li>)}</ul>
    </> : <p className="field-note">没有附件。</p>)}
  </section>;
}
