import type { RuntimeEventSummary, RuntimeMessage, RuntimeRun, RuntimeView } from '../../shared/runtime-view';
import type { TaskRecord } from '../../shared/task-consent';
import type { RunProgressOperation } from '../../shared/run-progress';
import type { RuntimeConnectionHealth } from '../api';
import { replyStoppedText } from './run-state';

type ProgressRuntime = Pick<RuntimeView, 'events' | 'runs' | 'messages'>;
const ordered = (runs: RuntimeRun[]) => [...new Map(runs.map(run => [run.id, run])).values()]
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));

/** An active scene alone is not evidence that Rae is answering this owner message. */
export function ownerProgressRuns(runtime: ProgressRuntime, owner: RuntimeMessage): RuntimeRun[] {
  if (owner.role !== 'user') return [];
  const events = new Set(runtime.events.filter(event => event.kind === 'owner.message' && event.messageId === owner.id
    && event.caseId === owner.caseId).map(event => event.id));
  const replies = new Set(runtime.messages.filter(message => message.role === 'assistant' && message.caseId === owner.caseId
    && message.replyTo === owner.id && message.runId).map(message => message.runId!));
  return ordered(runtime.runs.filter(run => !run.taskId && run.caseId === owner.caseId && run.mode !== 'execution' && run.mode !== 'connection'
    && (run.trigger === 'chat' || run.trigger === 'recovery')
    && (Boolean(run.eventId && events.has(run.eventId)) || run.trigger === 'chat' && replies.has(run.id))));
}

export function taskProgressRuns(runs: readonly RuntimeRun[], task: TaskRecord): RuntimeRun[] {
  return ordered(runs.filter(run => run.taskId === task.id && run.caseId === task.spec.caseId && run.mode === 'execution'));
}

export function pendingOwnerEvent(runtime: ProgressRuntime, owner: RuntimeMessage): RuntimeEventSummary | undefined {
  if (owner.role !== 'user') return;
  const runs = ownerProgressRuns(runtime, owner);
  if (runs.some(run => run.status === 'running') || runs.at(-1)?.status === 'completed') return;
  return runtime.events.filter(event => event.kind === 'owner.message' && event.messageId === owner.id && event.caseId === owner.caseId
    && (event.status === 'pending' || event.status === 'leased'))
    .sort((left, right) => (left.receivedAt ?? left.occurredAt).localeCompare(right.receivedAt ?? right.occurredAt)).at(-1);
}

export function progressReply(runtime: Pick<RuntimeView, 'messages'>, run: RuntimeRun): RuntimeMessage | undefined {
  return runtime.messages.find(message => message.role === 'assistant' && message.runId === run.id && message.caseId === run.caseId);
}
/** A history page may start at the reply, with its owner message on the preceding page. */
export function assistantProgressRun(runtime: ProgressRuntime, message: RuntimeMessage): RuntimeRun | undefined {
  if (message.role !== 'assistant' || !message.runId) return;
  const run = runtime.runs.find(item => item.id === message.runId && item.caseId === message.caseId && !item.taskId
    && item.mode !== 'execution' && item.mode !== 'connection' && (item.trigger === 'chat' || item.trigger === 'recovery'));
  if (!run) return;
  const owner = runtime.events.find(event => event.id === run.eventId && event.kind === 'owner.message'
    && event.caseId === run.caseId && event.messageId && (!message.replyTo || message.replyTo === event.messageId));
  return owner || run.trigger === 'chat' && message.replyTo ? run : undefined;
}
const milliseconds = (value?: string) => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : undefined; };
export function progressDuration(start: string, end: string | undefined, now: number, running = false): number | undefined {
  const from = milliseconds(start); const until = milliseconds(end) ?? (running ? now : undefined);
  return from === undefined || until === undefined ? undefined : Math.max(0, until - from);
}
export function progressDurationText(duration: number | undefined): string | undefined {
  if (duration === undefined || !Number.isFinite(duration)) return;
  const seconds = Math.floor(Math.max(0, duration) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
const phaseLabels = { preparing: '正在准备', model: '正在等待模型响应', tool: '正在处理资料', reply: '正在回复', settling: '正在保存结果' };
export const progressOperationStatus: Record<RunProgressOperation['status'], string> = {
  running: '进行中', succeeded: '已完成', failed: '未完成', interrupted: '已停止', unknown: '结果待核对',
};
export function progressForRun(run: RuntimeRun, connection: RuntimeConnectionHealth | undefined, now: number) {
  const running = run.status === 'running'; const progress = run.progress;
  const stopped = run.status === 'interrupted' && run.stopReason === 'owner_stopped';
  if (!progress && !running && !stopped) return;
  const elapsed = progressDurationText(progressDuration(run.startedAt, run.endedAt, now, running));
  const activity = milliseconds(progress?.lastActivityAt);
  const waitingLonger = running && activity !== undefined && now - activity >= 60_000;
  const heartbeatOld = connection?.state === 'connected' && connection.lastHeartbeatAt !== undefined && now - connection.lastHeartbeatAt >= 45_000;
  const reconnecting = running && Boolean(connection && (connection.state !== 'connected' || heartbeatOld));
  const active = progress?.operations.filter(operation => operation.status === 'running') ?? [];
  let headline: string;
  if (stopped) headline = replyStoppedText;
  else if (!running) headline = { running: '正在处理', completed: '本轮已结束', failed: '本轮未完成', interrupted: '本轮已中断' }[run.status];
  else if (reconnecting) headline = '连接恢复中，最新进度待同步';
  else if (run.stopReason === 'owner_stopped') headline = '正在停止回复';
  else if (!progress) headline = '正在处理，暂无详细进度记录';
  else if (waitingLonger) headline = progress.phase === 'model' ? '等待模型响应较久' : progress.phase === 'tool'
    ? active.length === 1 ? `${active[0].label} · 等待较久` : active.length > 1 ? `${active.length} 项操作等待较久` : '等待操作返回较久'
    : '等待新的进度较久';
  else {
    headline = progress.phase === 'tool' && active.length ? active.length === 1 ? `${active[0].label} · 进行中` : `正在处理 ${active.length} 项操作`
      : phaseLabels[progress.phase];
  }
  return { headline, elapsed, waitingLonger, reconnecting, running, hasDetails: Boolean(progress),
    lastState: progress ? phaseLabels[progress.phase] : undefined,
    operations: progress?.operations.map(operation => ({ id: operation.id, label: operation.label,
      status: !running && operation.status === 'running' ? 'unknown' as const : operation.status,
      summary: operation.summary, duration: progressDurationText(progressDuration(operation.startedAt, operation.endedAt ?? (!running ? run.endedAt : undefined), now,
        running && operation.status === 'running')) })) ?? [] };
}

export function queuedProgressText(enabled: boolean, connection?: RuntimeConnectionHealth): string {
  if (connection && connection.state !== 'connected') return '已收到，等待连接恢复后同步进度';
  return enabled ? '已收到，等待开始' : '已收到，等待恢复推理';
}
