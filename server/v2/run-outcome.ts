export type RunFinish = { kind: 'complete' }
  | { kind: 'limited'; stopReason: 'output_limit' | 'step_limit' | 'no_progress'; note: string }
  | { kind: 'invalid'; note: string };

/** A bounded model return is a finished attempt, not a transport failure to replay. */
export function classifyRunFinish(finishReason?: string, stalled = false): RunFinish {
  if (stalled) return {
    kind: 'limited', stopReason: 'no_progress', note: '重复操作没有取得新结果，本轮已停止，已收到的内容保留。',
  };
  if (finishReason === 'stop') return { kind: 'complete' };
  if (finishReason === 'length') return {
    kind: 'limited', stopReason: 'output_limit', note: '本轮已达到回复长度上限，未能完整回复。',
  };
  if (finishReason === 'tool-calls') return {
    kind: 'limited', stopReason: 'step_limit', note: '本轮已达到处理步数上限，处理尚未完成。',
  };
  return { kind: 'invalid', note: '模型未返回可确认的结束状态，原消息已保留。' };
}
