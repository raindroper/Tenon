import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { EwsAttachmentList } from './EwsAttachmentList';
import type { EwsComposeMode } from '../lib/ews-mail';
import type { EwsMessagePage, EwsMessageReadPage, EwsMessageSummary } from '../../shared/ews';
import { api } from '../api';
import { dateTime } from '../lib/format';

const pageSize = 25;
const bodyPageSize = 4000;
const bodyStates: Record<string, string> = {
  empty: '这封邮件的正文为空。',
  certificate_missing: '这封邮件使用 S/MIME 加密，服务端尚未配置解密证书。请更新连接中的证书后重新查询。',
  decrypt: '现有证书未能解密这封邮件。请核对收件人证书及其私钥，再重新查询。',
  mime: '邮件已取得，但正文格式暂时无法解析。',
  smime_container: '无法唯一识别这封邮件的 S/MIME 正文容器。',
  response_limit: '这封邮件超过本次读取上限，未取得完整正文。',
};

interface ListPage { result: EwsMessagePage; subject: string; offset: number; previous: number[] }
interface ReadPage { result: EwsMessageReadPage; content: string }

/** Mounted only after the owner explicitly opens the mailbox. */
export function EwsMailboxBrowser({ connectionId, timezone, onClose, onCompose }: {
  connectionId: string; timezone: string; onClose: () => void;
  onCompose?: (mode: EwsComposeMode, original: { queryId: string; messageId: string }) => void;
}) {
  const headingId = useId();
  const [subject, setSubject] = useState('');
  const [page, setPage] = useState<ListPage>();
  const [selected, setSelected] = useState<EwsMessageSummary>();
  const [body, setBody] = useState<ReadPage>();
  const [listing, setListing] = useState(false);
  const [reading, setReading] = useState(false);
  const [listError, setListError] = useState('');
  const [readError, setReadError] = useState('');
  const listRequest = useRef<AbortController | undefined>(undefined);
  const bodyRequest = useRef<AbortController | undefined>(undefined);
  const selectedId = useRef<string | undefined>(undefined);
  const listBusy = useRef(false);
  const bodyRegion = useRef<HTMLElement | null>(null);
  const endpoint = `/api/connectors/ews/${encodeURIComponent(connectionId)}`;

  const loadList = useCallback(async (filter: string, offset: number, previous: number[]) => {
    listRequest.current?.abort(); bodyRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    listBusy.current = true;
    selectedId.current = undefined;
    setSelected(undefined); setBody(undefined); setReading(false); setReadError('');
    setPage(undefined); setListError(''); setListing(true);
    try {
      const result = await api<EwsMessagePage>(`${endpoint}/messages`, 'POST', {
        readExistingInbox: true, ...(filter ? { subject: filter } : {}), offset, limit: pageSize,
      }, controller.signal);
      if (!controller.signal.aborted && listRequest.current === controller) {
        if (result.nextOffset !== null && result.nextOffset <= offset) throw new Error('邮件列表翻页位置无效，请重新查询。');
        setPage({ result, subject: filter, offset, previous });
      }
    } catch (error) {
      if (!controller.signal.aborted && listRequest.current === controller) setListError(error instanceof Error ? error.message : '邮件列表读取失败，请重试。');
    } finally {
      if (!controller.signal.aborted && listRequest.current === controller) { listBusy.current = false; setListing(false); }
    }
  }, [endpoint]);

  useEffect(() => {
    void loadList('', 0, []);
    return () => { listRequest.current?.abort(); bodyRequest.current?.abort(); };
  }, [loadList]);

  useEffect(() => {
    if (selected) bodyRegion.current?.scrollIntoView({ block: 'start' });
  }, [selected?.id]);

  async function search(event: FormEvent) {
    event.preventDefault();
    await loadList(subject.trim(), 0, []);
  }

  async function read(message: EwsMessageSummary, offset = 0) {
    if (!page || listBusy.current) return;
    bodyRequest.current?.abort();
    const controller = new AbortController(); bodyRequest.current = controller;
    selectedId.current = message.id;
    setSelected(message); setReadError(''); setReading(true);
    if (offset === 0) setBody(undefined);
    try {
      const result = await api<EwsMessageReadPage>(`${endpoint}/message`, 'POST', {
        readExistingInbox: true, messageId: message.id, queryId: page.result.queryId, offset, limit: bodyPageSize,
      }, controller.signal);
      if (controller.signal.aborted || bodyRequest.current !== controller || selectedId.current !== message.id) return;
      if (result.connectionId !== connectionId || result.messageId !== message.id) throw new Error('邮件读取结果与所选邮件不符，请重新查询。');
      if (result.nextOffset !== null && result.nextOffset <= offset) throw new Error('邮件正文翻页位置无效，请重新查询。');
      setBody(current => ({ result, content: offset === 0 ? result.content : (current?.content ?? '') + result.content }));
    } catch (error) {
      if (!controller.signal.aborted && bodyRequest.current === controller && selectedId.current === message.id) {
        setReadError(error instanceof Error ? error.message : '邮件正文读取失败，请重试。');
      }
    } finally {
      if (!controller.signal.aborted && bodyRequest.current === controller) setReading(false);
    }
  }

  const messages = page?.result.messages ?? [];
  const result = body?.result;
  const stoppedAtPageBound = page && page.result.nextOffset === null && page.result.totalItems > page.offset + messages.length;
  return <section className="connector-section form-stack" aria-labelledby={headingId}>
    <div className="connector-section-heading"><h5 id={headingId} style={{ margin: 0, fontSize: 14 }}>收件箱邮件</h5>
      <button type="button" className="text-link" onClick={onClose}>关闭邮件列表</button>
    </div>
    <p className="field-note">按需查看此收件箱中已有的邮件；新邮件自动观察仍沿用原来的起点。点选邮件可读取正文，S/MIME 邮件使用服务端已配置的证书解密。</p>
    <form className="form-stack" onSubmit={event => void search(event)}>
      <label>按邮件主题检索<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={240}
        placeholder="留空查看最近收到的邮件" autoComplete="off" /></label>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={listing}>{listing ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}查询邮件</button>
        <button type="button" className="text-link" disabled={listing} onClick={() => void loadList(page?.subject ?? '', 0, [])}><RefreshCw size={14} />刷新列表</button>
      </div>
    </form>
    {listing && <p className="field-note" role="status">正在查询收件箱…</p>}
    {listError && <p className="inline-result failure" role="alert">{listError}</p>}
    {page && <>
      <p className="field-note" role="status">{messages.length ? `显示第 ${page.offset + 1}–${page.offset + messages.length} 封，匹配 ${page.result.totalItems} 封。` : '没有找到匹配的邮件。'}</p>
      <ul className="connector-list" aria-label="收件箱邮件列表" style={{ maxHeight: '42vh', overflowY: 'auto' }}>{messages.map(message => <li className="connector-record" key={message.id}>
        <button type="button" className="list-button" aria-pressed={selected?.id === message.id} disabled={listing}
          onClick={() => void read(message)} style={{ width: '100%' }}>
          <span className="list-row-heading"><strong>{message.subject || '（无主题）'}</strong>
            {!message.isRead && <span className="tag">未读</span>}</span>
        </button>
        <p className="field-note">{message.sender || '未提供发件人'} · <time dateTime={message.receivedAt}>{dateTime(message.receivedAt, timezone, true)}</time>
          {/smime/i.test(message.encryptionHint) && ' · S/MIME'}</p>
      </li>)}</ul>
      <div className="form-actions" aria-label="邮件列表翻页">
        <button type="button" className="button button-quiet" disabled={listing || !page.previous.length}
          onClick={() => void loadList(page.subject, page.previous.at(-1)!, page.previous.slice(0, -1))}>较新邮件</button>
        <button type="button" className="button button-quiet" disabled={listing || page.result.nextOffset === null}
          onClick={() => void loadList(page.subject, page.result.nextOffset!, [...page.previous, page.offset])}>更早邮件</button>
      </div>
      {stoppedAtPageBound && <p className="field-note">当前查询已达到可翻页范围，请缩小主题条件后继续检索。</p>}
    </>}
    {selected && <article ref={bodyRegion} className="connector-section form-stack" aria-label="所选邮件正文">
      <h5 style={{ margin: 0, fontSize: 14 }}>{result?.subject || selected.subject || '（无主题）'}</h5>
      <p className="field-note">{result?.sender || selected.sender || '未提供发件人'} · {dateTime(result?.receivedAt ?? selected.receivedAt, timezone, true)}。读取不会修改邮件的已读状态。</p>
      {onCompose && page && <div className="form-actions" aria-label="处理所选邮件">
        {(['reply', 'replyAll', 'forward'] as const).map(mode => <button type="button" className="button button-quiet" key={mode}
          onClick={() => onCompose(mode, { queryId: page.result.queryId, messageId: selected.id })}>
          {mode === 'reply' ? '回复' : mode === 'replyAll' ? '回复全部' : '转发'}</button>)}
      </div>}
      {reading && <p className="field-note" role="status">正在读取邮件正文…</p>}
      {readError && <p className="inline-result failure" role="alert">{readError} 可刷新列表后重新选择邮件。</p>}
      {result && <>
        {result.bodyStatus !== 'read' && <p className="inline-result" role="status">{bodyStates[result.bodyStatus] ?? '尚未取得这封邮件的可读正文。'}</p>}
        {result.encryption === 'smime-decrypted' && <p className="field-note">S/MIME 正文已在服务端解密；本次未认证邮件数字签名。</p>}
        {result.encryption === 'smime-signed-unverified' && <p className="field-note">已读取签名邮件正文，数字签名尚未验证。</p>}
        {body!.content && <div className="markdown" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body!.content}</div>}
        {result.bodyStatus === 'read' && <p className="field-note">已显示 {body!.content.length.toLocaleString()} / {result.totalCharacters.toLocaleString()} 个字符。</p>}
        {result.truncated && <p className="field-note">本邮件超过读取上限，当前正文不完整。</p>}
        {result.nextOffset !== null && <button type="button" className="button button-quiet" disabled={reading}
          onClick={() => void read(selected, result.nextOffset!)}>继续读取正文</button>}
      </>}
      {readError && <button type="button" className="text-link" disabled={reading} onClick={() => void read(selected)}>重试读取这封邮件</button>}
      {page && <EwsAttachmentList key={`${page.result.queryId}:${selected.id}`} connectionId={connectionId} queryId={page.result.queryId} messageId={selected.id} />}
    </article>}
  </section>;
}
