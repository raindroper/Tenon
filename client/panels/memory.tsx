import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Check, LoaderCircle, Pencil } from 'lucide-react';
import type { PersonalMemoryEntry, PersonalMemoryMutationSource, TaskOutcomeEvidence } from '../../shared/personal-memory';
import { api } from '../api';
import { dateTime } from '../lib/format';
import { createMemoryPager } from '../lib/memory-pages';
import { Empty } from '../components/primitives';
import type { PanelContext } from './types';

const kinds = { fact: '个人事实', preference: '个人偏好', habit: '生活习惯', experience: '相处经验' };
const states = { active: '正在使用', expired: '已过期', retracted: '已撤回', evidence_unavailable: '依据已不可用' };
const ratings = { useful: '有帮助', off_target: '理解偏了', not_now: '暂时不用', correction: '纠正' };
function mutationSourceLabel(source?: PersonalMemoryMutationSource): string {
  return source?.kind === 'owner-message' ? '来自你的对话'
    : source?.kind === 'owner-command' ? '来自你的记忆管理操作'
    : '早期记录，变更来源未完整记录';
}
function memoryLevelLabel(entry: PersonalMemoryEntry): string {
  if (entry.level !== 'explicit') return entry.subject === 'owner' ? '暂时这样理解' : '暂定方法';
  if (entry.subject === 'agent') return '已明确记录';
  return entry.mutationSource?.kind === 'owner-message' ? '你明确说过'
    : entry.mutationSource?.kind === 'owner-command' ? '你明确设置' : '已明确记录';
}
const checkNames: Record<string, string> = { 'artifact.persisted': '交付文本已保存', 'device.authenticated_receipt': '指定设备的认证回执',
  'media.private_copy': '媒体私有文件已保存', 'runtime.delivery_state': '当前要求版本的执行状态',
  'project.native_receipt': '本机回合已返回', 'project.tool_receipt': '本机工具完成回执', 'project.command_exit': '本机命令退出码',
  'mail.submission': 'Exchange 提交回执', 'github.submission': 'GitHub 操作回执', 'github.receipt_coverage': 'GitHub 回执覆盖范围' };

export function TaskOutcomeDetails({ outcome, taskTitle }: { outcome: TaskOutcomeEvidence; taskTitle?: string }) {
  return <div className="task-scope">
    <p className="field-note">{taskTitle ? `任务：${taskTitle} · ` : ''}要求版本 {outcome.requirementsRevision}</p>
    {outcome.checks.length ? <ul className="scope-files">{outcome.checks.map((check, index) => <li key={`${check.source}:${check.referenceId}:${index}`}>
      <strong>{checkNames[check.name] ?? check.name}</strong> · {check.passed ? '通过' : '未通过'}
      <p>{check.detail.replaceAll(check.referenceId, '本次记录')}</p>
    </li>)}</ul> : <p className="field-note">这条结果没有列出可核验条件。</p>}
    <p className="field-note">只证明列出的条件，方法仍待验证。</p>
  </div>;
}

export function MemoryPanel({ runtime, perform, busy, onOpenPanel }: PanelContext) {
  const [pager] = useState(() => createMemoryPager(runtime.understanding));
  const page = useSyncExternalStore(pager.subscribe, pager.getSnapshot, pager.getSnapshot);
  const subject = page.subject;
  useEffect(() => pager.start(), [pager]);
  useEffect(() => { pager.reconcile(runtime.understanding); }, [pager, runtime.understanding]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const entries = page.entries.filter(entry => includeInactive || entry.effectiveStatus === 'active');
  const zone = runtime.settings.timezone;
  const mutate = async (path: string, method: string, body: unknown) => {
    const entry = await api<PersonalMemoryEntry>(path, method, body); pager.updateEntry(entry); return entry;
  };
  return <>
    <div className="tabs" aria-label="记忆对象"><button aria-pressed={subject === 'owner'} onClick={() => pager.setSubject('owner')}>对你的理解</button><button aria-pressed={subject === 'agent'} onClick={() => pager.setSubject('agent')}>我的方法</button></div>
    <p className="field-note">{subject === 'owner' ? '有依据的事实、偏好和经验。暂时的推断会标明，你可以随时纠正或撤回。' : '来自相处和授权资料的方法假设，与个人偏好分别记录；被记住不代表已经验证成功。'}</p>
    <label className="checkbox-label"><input type="checkbox" checked={includeInactive} onChange={event => setIncludeInactive(event.target.checked)} />显示已撤回、过期及依据不可用的记录</label>
    <div className="form-actions"><span className="field-note">已读取 {page.entries.length} 条{page.total === null ? '' : ` / 共 ${page.total} 条`}</span><button className="text-link" disabled={page.loading} onClick={() => void pager.refresh()}>刷新列表</button></div>
    {page.error && <p className="field-note" role="alert">{page.error} <button className="text-link" disabled={page.loading} onClick={() => void pager.retry()}>重试</button></p>}
    {page.loading && <p className="field-note" role="status">正在读取记忆…</p>}
    {!entries.length ? page.loaded ? <Empty title={subject === 'owner' ? '了解需要一点相处' : '方法来自真实相处'}>{page.entries.length ? '当前已读取的记录均被状态筛选隐藏，可以继续读取或显示非当前记录。' : subject === 'owner' ? '安静和没有回应，不会被当成认可。' : '你教过的方法和有依据的经验，会单独保存在这里。'}</Empty> : null : <div className="panel-list">{entries.map(entry => {
      const key = `memory:${entry.key}`;
      const scope = entry.scope === 'global' ? '适用于所有场景' : entry.scope === 'domain' ? `适用领域：${entry.domains.join('、')}` : `仅限场景：${entry.caseIds.map(id => runtime.cases.find(item => item.id === id)?.title || id).join('、')}`;
      return <article className="list-row" key={entry.key}>
        <div className="list-row-heading"><span className="tag">{entry.subject === 'agent' ? '做事方法' : entry.purpose === 'identity' ? '身份信息' : entry.purpose === 'interaction' ? '交流方式' : kinds[entry.kind]}</span><span className="field-note">{memoryLevelLabel(entry)}</span></div>
        <p className="memory-value">{entry.value}</p>
        <p className="field-note">{scope} · {states[entry.effectiveStatus]}{entry.expiresAt ? ` · 有效至 ${dateTime(entry.expiresAt, zone, true)}` : ''}</p>
        <details className="memory-evidence">
          <summary>依据与版本</summary>
          {entry.evidence.length ? entry.evidence.map((evidence, index) => <blockquote key={`${evidence.eventId}:${index}`}>
            <p>{evidence.excerpt}</p>
            {evidence.taskOutcome && <TaskOutcomeDetails outcome={evidence.taskOutcome}
              taskTitle={runtime.tasks.find(task => task.id === evidence.taskOutcome?.taskId)?.spec.title} />}
            <footer className="field-note">{evidence.rating ? `你评价过的回应 · ${ratings[evidence.rating.verdict]}` : evidence.actor === 'owner' ? '你的输入' : evidence.actor === 'external' ? '授权资料' : '运行记录'} · {dateTime(evidence.occurredAt, zone, true)}</footer>
          </blockquote>) : <p className="field-note">没有可展示的原始摘录。</p>}
          <p className="field-note">当前版本 {entry.revision} · {mutationSourceLabel(entry.mutationSource)}</p>
          {entry.history.length > 0 && <ol className="memory-history">{[...entry.history].reverse().map(version => <li key={version.revision}>
            <p>{version.value}</p><div className="form-actions"><span className="field-note">版本 {version.revision} · {dateTime(version.updatedAt, zone, true)} · {mutationSourceLabel(version.mutationSource)}{version.status === 'retracted' ? ' · 已撤回' : ''}</span>
              {version.status !== 'retracted' && <button className="text-link" disabled={busy.includes(key)} onClick={() => void perform(key, () => mutate(`/api/personal-memory/${encodeURIComponent(entry.key)}/restore`, 'POST', { revision: version.revision, expectedRevision: entry.revision }), '已恢复为新版本，历史记录保留。')}>恢复这个版本</button>}
            </div>
          </li>)}</ol>}
        </details>
        <div className="form-actions"><button className="text-link" onClick={() => onOpenPanel({ type: 'editMemory', key: entry.key, entry })}><Pencil size={13} />{entry.subject === 'agent' ? '纠正方法' : '纠正理解'}</button>{entry.status !== 'retracted' && <button className="text-link" disabled={busy.includes(key)} onClick={() => void perform(key, () => mutate(`/api/personal-memory/${encodeURIComponent(entry.key)}`, 'DELETE', { expectedRevision: entry.revision }), '已撤回，并保留修改记录。')}>撤回</button>}</div>
      </article>;
    })}</div>}
    {page.loaded && page.nextOffset !== null && <button className="button button-quiet" disabled={page.loading} onClick={() => void pager.loadMore()}>{page.loading ? <LoaderCircle size={15} className="spin" /> : null}继续读取</button>}
  </>;
}

export function EditMemoryPanel({ entry, initialEntry, perform, busy, onClose }: PanelContext & { entry: PersonalMemoryEntry; initialEntry?: PersonalMemoryEntry }) {
  const [draft, setDraft] = useState(() => ({ value: (initialEntry ?? entry).value, revision: (initialEntry ?? entry).revision }));
  const stale = draft.revision !== entry.revision;
  const key = `memory:${entry.key}`;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (stale) return;
    if (await perform(key, () => api(`/api/personal-memory/${encodeURIComponent(entry.key)}`, 'PATCH', { value: draft.value.trim(), expectedRevision: draft.revision }), '纠正已保存为新版本。')) onClose();
  }
  return <form className="form-stack" onSubmit={event => void submit(event)}>
    <label>{entry.subject === 'agent' ? '纠正方法' : '纠正理解'}<textarea required rows={6} maxLength={2000} value={draft.value} onChange={event => setDraft(current => ({ ...current, value: event.target.value }))} /></label>
    <p className="field-note">保留对象、适用范围和历史记录，将你的纠正保存为明确输入。</p>
    {stale && <p className="field-note" role="status">这条记忆已有新版本，当前草稿尚未保存。请复制草稿后重新打开核对。</p>}
    <div className="form-actions"><button type="button" className="button button-quiet" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={stale || !draft.value.trim() || busy.includes(key)}>{busy.includes(key) ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存纠正</button></div>
  </form>;
}
