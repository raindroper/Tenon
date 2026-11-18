import { useRef, useState, type FormEvent } from 'react';
import { ChevronRight, LoaderCircle, Plus, Upload } from 'lucide-react';
import { api } from '../api';
import { dateTime } from '../lib/format';
import { Empty } from '../components/primitives';
import type { PanelContext } from './types';

const sourceStates = { starting: '正在连接', active: '已连接', failed: '连接异常', removed: '已停止' };

export function SourcesPanel({ runtime, perform, busy, onOpenPanel, onSelectCase }: PanelContext) {
  return <>
    <div className="form-actions"><p className="field-note">榫只观察你明确提供的资料。</p><button className="button" onClick={() => onOpenPanel({ type: 'addSource' })}><Plus size={15} />添加资料</button></div>
    <section className="panel-section">
      <h3>目录观察</h3>
      {!runtime.workspaceSources.length ? <p className="muted">还没有连接目录来源。</p> : <div className="panel-list">{runtime.workspaceSources.map(source => <article className="list-row" key={source.sourceId}>
        <div className="list-row-heading"><strong>{source.root.split(/[\\/]/).filter(Boolean).at(-1) || source.root}</strong><span className="tag">{sourceStates[source.status]}</span></div>
        <p className="resource-path">{source.root}</p>
        <p className="field-note">{source.watching ? '正在观察' : '当前未观察'}{source.include?.length ? ` · 范围：${source.include.join('、')}` : ''}</p>
        {source.health && <p className={source.status === 'failed' ? 'field-error' : 'field-note'}>{source.health}</p>}
        <div className="form-actions"><button className="text-link" onClick={() => onSelectCase(source.caseId)}>{runtime.cases.find(item => item.id === source.caseId)?.title || '查看关联对话'}<ChevronRight size={13} /></button>{source.status !== 'removed' && <button className="text-link" disabled={busy.includes(`source:${source.sourceId}`)} onClick={() => void perform(`source:${source.sourceId}`, () => api(`/api/sources/workspace/${encodeURIComponent(source.sourceId)}`, 'DELETE'), '已停止观察，历史记录保留。')}>停止观察</button>}</div>
      </article>)}</div>}
    </section>
    <section className="panel-section">
      <h3>已保存文本</h3>
      {!runtime.sources.length ? <Empty title="从一点真实背景开始">可以放进一份近期计划、项目说明，或你愿意分享的内容。</Empty> : <div className="panel-list">{[...runtime.sources].reverse().map(source => <button className="list-row list-button" key={source.id} onClick={() => onOpenPanel({ type: 'source', id: source.id })}>
        <strong>{source.title}</strong><p className="line-clamp">{source.content.slice(0, 160)}</p><span className="field-note">{dateTime(source.createdAt, runtime.settings.timezone, true)}</span>
      </button>)}</div>}
    </section>
    <p className="field-note">停止目录观察只终止后续采集。当前版本尚未提供上传文本与全部派生记录的完整遗忘操作。</p>
  </>;
}

export function AddSourcePanel({ perform, busy, onClose, caseId }: PanelContext & { caseId?: string | null }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const saving = busy.includes('source-upload');
  async function loadFile(file?: File) {
    if (!file) return;
    const version = ++readVersion.current;
    setError(''); setReading(false);
    if (!/\.(txt|md|json)$/i.test(file.name)) { setError('请选择 TXT、Markdown 或 JSON 文件。'); return; }
    if (file.size > 200 * 1024) { setError('文件超过 200 KB，请先拆分。'); return; }
    setReading(true);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (readVersion.current !== version) return;
      setContent(text); setFilename(file.name); setTitle(current => current || file.name.replace(/\.(txt|md|json)$/i, ''));
    } catch { if (readVersion.current === version) setError('无法读取，请保存为 UTF-8 编码后重试。'); }
    finally { if (readVersion.current === version) setReading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (new TextEncoder().encode(content).length > 200 * 1024) { setError('内容超过 200 KB，请精简或拆分。'); return; }
    if (await perform('source-upload', () => api('/api/sources', 'POST', { title: title.trim(), content: content.trim(), ...(filename ? { filename } : {}), ...(caseId ? { caseId } : {}) }), '资料已保存。')) onClose();
  }
  return <form className="form-stack" onSubmit={event => void submit(event)}>
    <fieldset disabled={saving || reading} className="form-stack">
      <button type="button" className="upload-button" onClick={() => input.current?.click()}><Upload size={20} /><span>{reading ? '正在读取…' : filename || '从电脑选择文件'}<small>TXT、Markdown、JSON · UTF-8 · 最多 200 KB</small></span></button>
      <input className="sr-only" ref={input} type="file" accept=".txt,.md,.json" aria-label="上传资料文件" onChange={event => void loadFile(event.target.files?.[0])} />
      <label>资料名称<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>资料内容<textarea required rows={10} value={content} onChange={event => setContent(event.target.value)} placeholder="或直接粘贴你愿意分享的背景…" /></label>
    </fieldset>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="button button-quiet" type="button" onClick={onClose}>取消</button><button className="button button-primary" type="submit" disabled={saving || reading || !title.trim() || !content.trim()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}添加资料</button></div>
  </form>;
}
