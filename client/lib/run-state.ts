import type { RuntimeEventSummary, RuntimeMessage, RuntimeRun } from '../../shared/runtime-view';

export const replyStoppedText = '已停止回复。';

/** Match failures to the real owner message in the current conversation only. */
export function failedReplies(events: readonly RuntimeEventSummary[], messages: readonly RuntimeMessage[]): Map<string, RuntimeEventSummary> {
  const owners = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message]));
  const failures = new Map<string, RuntimeEventSummary>();
  for (const event of events) {
    if (event.kind !== 'owner.message' || event.status !== 'failed' || !event.messageId) continue;
    const message = owners.get(event.messageId);
    if (message && message.caseId === event.caseId) failures.set(message.id, event);
  }
  return failures;
}

export function runStateText(run: Pick<RuntimeRun, 'status' | 'mode' | 'stopReason' | 'reviewOutcome'>): string {
  if (run.status === 'interrupted' && run.stopReason === 'owner_stopped') return replyStoppedText;
  if (run.stopReason === 'output_limit') return '达到输出上限 · 本轮未完成';
  if (run.stopReason === 'step_limit') return '达到步数上限 · 本轮未完成';
  if (run.stopReason === 'no_progress') return '重复操作无进展 · 已停止';
  if (run.status === 'completed' && run.reviewOutcome === 'needs_input') return '回顾已结束 · 待本人补充';
  if (run.mode === 'execution' && run.status === 'completed') return '本次执行结束 · 成果待验收';
  return { running: '正在运行', completed: '本轮结束', failed: '运行失败', interrupted: '已中断' }[run.status];
}

/** A stale streaming projection after interruption must not look as if it is still generating. */
export function messageOutputText(message: Pick<RuntimeMessage, 'outputState' | 'outputNote'>, run?: Pick<RuntimeRun, 'status'>): string {
  if (message.outputState === 'streaming') {
    if (run && run.status !== 'running') return '回复未完成，已生成的内容已保留。';
    return message.outputNote || '正在生成…';
  }
  if (message.outputState === 'incomplete') return message.outputNote || '回复未完成，已生成的内容已保留。';
  return message.outputNote || '';
}
