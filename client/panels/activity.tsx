import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronRight } from 'lucide-react';
import type { RuntimeArtifact, RuntimeEventSummary, RuntimeHistoryPage, RuntimeRun } from '../../shared/runtime-view';
import { api } from '../api';
import { dateTime, download, tokenUsageText } from '../lib/format';
import { Empty, Markdown } from '../components/primitives';
import type { PanelContext } from './types';
import { runStateText } from '../lib/run-state';

const triggers = { chat: '消息', timer: '唤醒', feedback: '反馈', source: '来源变化', manual: '主动唤醒', recovery: '恢复' };
type HistoryKind = 'runs' | 'events';
interface HistorySelection { page: RuntimeHistoryPage; before: string; previous: Array<string | undefined> }
const eventStates = { pending: '等待处理', leased: '正在处理', processed: '已处理', failed: '处理失败' };
const eventKinds: Record<string, string> = { 'owner.message': '本人消息', 'owner.feedback': '本人反馈', 'owner.source': '上传资料',
  'owner.reflect': '手动回顾', 'workspace.file': '目录资料变化', 'connector.change': '连接资料变化',
  'growth.observation': '资料回顾', 'growth.reminder': '日常提醒', 'case.wake': '学习回访', 'task.execute': '获准任务' };

export function ActivityPanel({ runtime, onOpenPanel, onSelectCase }: PanelContext) {
  const [tab, setTab] = useState<HistoryKind | 'artifacts'>('runs');
  const [history, setHistory] = useState<Partial<Record<HistoryKind, HistorySelection>>>({});
  const [loading, setLoading] = useState<Partial<Record<HistoryKind, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<HistoryKind, string>>>({});
  const requests = useRef<Partial<Record<HistoryKind, AbortController>>>({});
  useEffect(() => () => { for (const request of Object.values(requests.current)) request.abort(); }, []);
  const loadPage = async (kind: HistoryKind, before: string | undefined, previous: Array<string | undefined>) => {
    requests.current[kind]?.abort();
    const request = new AbortController(); requests.current[kind] = request;
    setErrors(value => ({ ...value, [kind]: undefined }));
    if (before === undefined) {
      setHistory(value => ({ ...value, [kind]: undefined })); setLoading(value => ({ ...value, [kind]: false })); return;
    }
    setLoading(value => ({ ...value, [kind]: true }));
    try {
      const page = await api<RuntimeHistoryPage>(`/api/history/${kind}?before=${encodeURIComponent(before)}`, 'GET', undefined, request.signal);
      if (!request.signal.aborted) setHistory(value => ({ ...value, [kind]: { page, before, previous } }));
    } catch (error) {
      if (!request.signal.aborted) setErrors(value => ({ ...value, [kind]: error instanceof Error ? error.message : '历史记录读取失败，请重试。' }));
    } finally { if (!request.signal.aborted) setLoading(value => ({ ...value, [kind]: false })); }
  };
  const runPage = history.runs?.page ?? runtime.history.runs;
  const eventPage = history.events?.page ?? runtime.history.events;
  const active = tab === 'artifacts' ? undefined : history[tab];
  const currentPage = tab === 'runs' ? runPage : eventPage;
  const zone = runtime.settings.timezone;
  return <div className="activity-panel">
    <p className="panel-summary"><strong>今日用量</strong><span>{tokenUsageText(runtime.status.todayUsage)}</span></p>
    <p className="field-note">{runtime.status.nextWakeAt ? `下次唤醒 ${dateTime(runtime.status.nextWakeAt, zone, true)}。` : '暂未安排下次唤醒。'}仅记录模型报告的 token，不推算未知用量。</p>
    <div className="tabs" aria-label="运行与成果"><button aria-pressed={tab === 'runs'} onClick={() => setTab('runs')}>运行记录</button><button aria-pressed={tab === 'events'} onClick={() => setTab('events')}>事件记录</button><button aria-pressed={tab === 'artifacts'} onClick={() => setTab('artifacts')}>已保存的成果{runtime.artifacts.length ? ` · ${runtime.artifacts.length}` : ''}</button></div>
    {tab !== 'artifacts' && <>
      <div className="form-actions" aria-label="历史记录翻页">
        <button className="button button-quiet" disabled={!active || loading[tab]} onClick={() => void loadPage(tab, active?.previous.at(-1), active?.previous.slice(0, -1) ?? [])}>较新记录</button>
        <button className="button button-quiet" disabled={!currentPage.nextBefore || loading[tab]} onClick={() => void loadPage(tab, currentPage.nextBefore!, [...active?.previous ?? [], active?.before])}>更早记录</button>
        {active && <button className="text-link" onClick={() => void loadPage(tab, undefined, [])}>回到最新</button>}
      </div>
      <p className="field-note" role="status">{loading[tab] ? '正在读取历史记录…' : active ? `历史第 ${active.previous.length + 1} 页，每页最多 40 条。` : '显示最近记录，每页最多 40 条；更早记录保留，可翻页查看或完整导出。'}</p>
      {errors[tab] && <p className="field-error" role="alert">{errors[tab]}</p>}
    </>}
    {tab === 'runs' ? !runPage.items.length ? <Empty title="还没有运行记录">开始真实相处后，每轮处理会在这里留下记录。</Empty> : <div className="panel-list">{[...runPage.items as RuntimeRun[]].reverse().map(run => <article className="list-row activity-item" key={run.id}>
      <div className="list-row-heading"><strong>{triggers[run.trigger]} · {run.steps} 步</strong><time className="field-note" dateTime={run.startedAt}>{dateTime(run.startedAt, zone, true)}</time></div>
      <p className="field-note">{runStateText(run)}{run.mode === 'growth' ? ' · 相处与成长' : run.mode === 'connection' ? ' · 连接测试' : ''}</p>
      {run.reasoning && <p className="field-note">请求思考强度：{run.reasoning.effort} · {run.reasoning.source === 'message' ? '本次消息' : '默认设置'}{run.reasoning.policy === 'auto' ? ' · 自动选择' : ''}。{run.reasoning.reason}上游是否采纳尚未核验。</p>}
      <p className="field-note">{tokenUsageText({ ...run, usageStatus: run.pendingModelCalls ? 'unknown' : run.usageStatus })}</p>
      {run.caseId && <button className="text-link" onClick={() => onSelectCase(run.caseId!)}>{runtime.cases.find(item => item.id === run.caseId)?.title || '关联对话'}<ChevronRight size={13} /></button>}
      {run.error && <p className="field-error">{run.error}</p>}
    </article>)}</div> : tab === 'events' ? !eventPage.items.length ? <Empty title="还没有事件记录">消息、来源变化和提醒的处理状态会保存在这里。</Empty> : <div className="panel-list">{[...eventPage.items as RuntimeEventSummary[]].reverse().map(event => <article className="list-row activity-item" key={event.id}>
      <div className="list-row-heading"><strong>{eventKinds[event.kind] ?? '其他事件'}</strong><span className="tag">{eventStates[event.status]}</span></div>
      <p className="field-note">{dateTime(event.receivedAt ?? event.occurredAt, zone, true)} · 已尝试 {event.attempts} 次</p>
      {event.caseId && <button className="text-link" onClick={() => onSelectCase(event.caseId!)}>{runtime.cases.find(item => item.id === event.caseId)?.title || '关联对话'}<ChevronRight size={13} /></button>}
      {event.lastError && <p className="field-error">{event.lastError}</p>}
    </article>)}</div> : !runtime.artifacts.length ? <Empty title="还没有已保存的成果">真实准备好的内容会出现在这里，保存不代表已经验收。</Empty> : <div className="panel-list">{[...runtime.artifacts].reverse().map(artifact => <button className="list-row list-button activity-item" data-status={artifact.status} key={artifact.id} onClick={() => onOpenPanel({ type: 'artifact', id: artifact.id })}>
      <div className="list-row-heading"><strong>{artifact.title}</strong><span className="tag">{artifact.status === 'verified' ? '已核验' : '已保存 · 待验收'}</span></div><p className="line-clamp">{artifact.content.slice(0, 180)}</p><span className="field-note">{dateTime(artifact.createdAt, zone, true)}</span>
    </button>)}</div>}
  </div>;
}

export function ArtifactPanel({ artifact, runtime, onOpenPanel }: PanelContext & { artifact: RuntimeArtifact }) {
  return <>
    <p className="field-note">{artifact.status === 'verified' ? '已核验' : '已保存 · 待验收'} · {dateTime(artifact.createdAt, runtime.settings.timezone, true)}</p>
    <Markdown>{artifact.content}</Markdown>
    <div className="form-actions"><button className="button" onClick={() => download(`${artifact.title.replace(/[\\/:*?"<>|]/g, '-')}.${artifact.format === 'markdown' ? 'md' : 'txt'}`, artifact.content)}><ArrowDownToLine size={15} />下载文本</button>
      {artifact.feedbackVersion && <button className="button button-quiet" onClick={() => onOpenPanel({ type: 'feedback',
        target: { type: 'artifact', id: artifact.id, label: artifact.content, version: artifact.feedbackVersion! } })}>给出反馈</button>}</div>
  </>;
}
