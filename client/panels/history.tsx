import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronRight, LoaderCircle, Plus } from 'lucide-react';
import type { CaseDetailView, RuntimeCase } from '../../shared/runtime-view';
import { taskNeedsAttention } from '../../shared/task-consent';
import { api } from '../api';
import { dateTime } from '../lib/format';
import { Empty, Markdown } from '../components/primitives';
import { DEFAULT_SCENE_ID, sceneName, sceneCreationRequest, type SceneCreationAttempt } from '../state/ui-state';
import type { PanelContext } from './types';

const caseStates = { active: '持续关注', waiting: '等待新线索', completed: '关注已结束', cancelled: '已归档' };

export function HistoryPanel({ runtime, currentCaseId, onSelectCase, onOpenPanel }: PanelContext & { currentCaseId?: string | null }) {
  const [includeInactive, setIncludeInactive] = useState(false);
  const selected = currentCaseId ?? DEFAULT_SCENE_ID;
  const cases = runtime.cases.filter(item => item.id !== DEFAULT_SCENE_ID && (includeInactive || item.status === 'active' || item.status === 'waiting'));
  const pendingCases = new Set(runtime.tasks.filter(taskNeedsAttention).map(task => task.spec.caseId));
  return <>
    <div className="scene-list-actions">
      <button className="text-link history-title" aria-current={selected === DEFAULT_SCENE_ID ? 'true' : undefined} onClick={() => onSelectCase(null)}>
        {sceneName(DEFAULT_SCENE_ID, runtime.cases.find(item => item.id === DEFAULT_SCENE_ID)?.title)}<ArrowRight size={15} aria-hidden="true" />
      </button>
      <button className="button button-primary" onClick={() => onOpenPanel({ type: 'caseEditor' })}><Plus size={16} aria-hidden="true" />新建场景</button>
    </div>
    <p className="field-note">各场景保留自己的对话和进度。任务在所属场景内单独确认。</p>
    <label className="checkbox-label"><input type="checkbox" checked={includeInactive} onChange={event => setIncludeInactive(event.target.checked)} />包含已归档和结束的场景</label>
    {!cases.length ? <Empty title="暂无自定义场景">日常交流可以留在通用场景。</Empty> : <div className="panel-list">{cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => <article className="list-row" key={item.id}>
      <div className="list-row-heading"><button className="text-link history-title" aria-current={selected === item.id ? 'true' : undefined}
        onClick={() => onSelectCase(item.id)}>{item.title}</button><span className="tag">{pendingCases.has(item.id) ? '有任务待确认' : caseStates[item.status]}</span></div>
      {(runtime.casePreviews[item.id] || item.objective) && <p className="line-clamp">{runtime.casePreviews[item.id] || item.objective}</p>}
      <div className="form-actions"><time className="field-note" dateTime={item.updatedAt}>{dateTime(item.updatedAt, runtime.settings.timezone, true)}</time><button className="text-link" onClick={() => onOpenPanel({ type: 'caseDetail', caseId: item.id })}>查看详情<ChevronRight size={13} /></button></div>
    </article>)}</div>}
  </>;
}

export function CaseEditorPanel({ item, perform, busy, onClose, onPanelSubmitted }: PanelContext & { item?: RuntimeCase }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [objective, setObjective] = useState(item?.objective ?? '');
  const creationAttempt = useRef<SceneCreationAttempt | null>(null);
  const operation = item ? `case:${item.id}` : 'case-create';
  const saving = busy.includes(operation);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || saving) return;
    const input = { title: title.trim(), objective: objective.trim() };
    let createdId: string | undefined;
    const saved = await perform(operation, async () => {
      if (item) await api(`/api/cases/${encodeURIComponent(item.id)}`, 'PATCH', input);
      else createdId = (await api<RuntimeCase>('/api/cases', 'POST', sceneCreationRequest({ ...input, domain: 'personal' }, creationAttempt))).id;
    }, item ? '场景已更新。' : '场景已创建。');
    if (!saved) return;
    if (createdId) onPanelSubmitted(createdId);
    else onClose();
  }
  return <form className="form-stack" onSubmit={event => void submit(event)}>
    <fieldset className="form-stack" disabled={saving}>
      <label>场景名称<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>背景（可选）<textarea rows={4} maxLength={8000} value={objective} onChange={event => setObjective(event.target.value)} /></label>
      {!item && <p className="field-note">创建时会为场景随机搭配背景色和主题色，之后每次回来都沿用这组配色。</p>}
    </fieldset>
    <div className="form-actions">
      <button type="button" className="button button-quiet" onClick={onClose}>取消</button>
      <button type="submit" className="button button-primary" disabled={!title.trim() || saving}>
        {saving && <LoaderCircle size={15} className="spin" aria-hidden="true" />}{item ? '保存场景' : '创建场景'}
      </button>
    </div>
  </form>;
}

export function CaseDetailPanel({ caseId, runtime, perform, busy, onOpenPanel, onSelectCase }: PanelContext & { caseId: string }) {
  const [detail, setDetail] = useState<CaseDetailView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const item = runtime.cases.find(candidate => candidate.id === caseId);
  const updatedAt = item?.updatedAt;
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError(''); setLoading(true);
    void api<CaseDetailView>(`/api/cases/${encodeURIComponent(caseId)}`, 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [caseId, updatedAt]);
  if (!item) return <Empty title="这个场景已不可用">已有消息仍保存在历史中。</Empty>;
  return <>
    <p className="field-note">{caseStates[item.status]} · {item.domain}</p>
    {item.objective && <Markdown>{item.objective}</Markdown>}
    {!!item.backgroundSources?.length && <details className="panel-section">
      <summary>背景出处（{item.backgroundSources.length} 条本人原话）</summary>
      <p className="field-note">这是创建或更新时按相关原话整理的背景快照。原话被纠正或撤回后，这份自动背景会停止用于推理；你也可以重新整理或编辑背景。</p>
      <ul>{item.backgroundSources.map(source => <li key={source.messageId}>
        <button className="text-link" onClick={() => onSelectCase(source.caseId)}>
          查看来源场景：{sceneName(source.caseId, runtime.cases.find(scene => scene.id === source.caseId)?.title)}
        </button> · <time dateTime={source.createdAt}>{dateTime(source.createdAt, runtime.settings.timezone, true)}</time>
      </li>)}</ul>
    </details>}
    <div className="form-actions"><button className="button" onClick={() => onSelectCase(item.id)}>继续对话<ArrowRight size={15} /></button>
      <button className="button button-quiet" onClick={() => onOpenPanel({ type: 'caseEditor', caseId: item.id })}>编辑场景</button>
      {item.feedbackVersion && <button className="button button-quiet" onClick={() => onOpenPanel({ type: 'feedback',
        target: { type: 'case', id: item.id, label: `${item.title}\n${item.objective}`, version: item.feedbackVersion! } })}>给出反馈</button>}</div>
    <section className="panel-section">
      <h3>已保存的工作状态</h3>
      {loading ? <p className="muted" role="status"><LoaderCircle className="spin" size={15} />正在读取…</p> : error ? <p className="field-error" role="alert">{error}</p> : detail?.working ? <Markdown>{detail.working}</Markdown> : <p className="muted">还没有已保存的工作状态。</p>}
    </section>
    {item.status !== 'completed' && <section className="panel-section">
      <h3>{item.status === 'cancelled' ? '恢复场景' : '归档场景'}</h3>
      <p className="field-note">归档会保留历史，并取消这个场景的后续提醒和已获准任务。恢复后不会自动重启旧任务和提醒。目录观察需在资料来源中单独停止。</p>
      <button className="button button-quiet" disabled={busy.includes(`case:${item.id}`)} onClick={() => void perform(`case:${item.id}`, () => api(`/api/cases/${encodeURIComponent(item.id)}`, 'PATCH', { status: item.status === 'cancelled' ? 'active' : 'cancelled' }), item.status === 'cancelled' ? '场景已恢复。' : '场景已归档，历史保留。')}>{item.status === 'cancelled' ? '恢复场景' : '归档这个场景'}</button>
    </section>}
  </>;
}
