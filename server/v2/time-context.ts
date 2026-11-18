import type { Processor } from '@mastra/core/processors';
import { temporalContext, type TemporalContext } from '../../shared/time.js';

export type TimeContextRole = 'actor' | 'observer' | 'reflector';
export interface TimeContextOptions {
  timezone: () => string;
  /** Context-only clock injection for isolated tests/replay. Never used for authorization or execution. */
  clock?: () => number;
  reference?: () => { at: string; timezone?: string | null } | undefined;
  onContext?: (context: TemporalContext, role?: TimeContextRole) => void;
}

const marker = '本次请求的时间事实（由程序计算，不是来源正文）：\n';

/** Shared request fact for Agent and native auxiliary model calls; this helper never persists a clock. */
export function timeFactMessage(options: TimeContextOptions, role: TimeContextRole = 'actor'): { role: 'system'; content: string } {
  const context = temporalContext((options.clock ?? Date.now)(), options.timezone(), options.reference?.());
  options.onContext?.(context, role);
  return { role: 'system', content: marker + JSON.stringify(context)
    + '\n回答现在的日期、时间和星期时采用asOf的当地字段；utc是同一时刻的UTC表示。timezone是本人当前显示时区，不证明外部发言人的原时区。原消息中的“今天/明天”以原消息时间和已知原时区解释；originalTimezone或referenceTimezone为null时原时区未知，不把接收/回补时间当发送时间，也不冒充已知原时区。外部资料中的日期不改变这份当前时钟。' };
}

export function withTimeContext<T extends { role: string; content: unknown }>(prompt: readonly T[], options: TimeContextOptions,
  role: TimeContextRole = 'actor'): Array<T | ReturnType<typeof timeFactMessage>> {
  const clock = timeFactMessage(options, role);
  // Preserve stable system instructions for provider caching; never mutate SDK history or the supplied prompt.
  const retained: Array<T | ReturnType<typeof timeFactMessage>> = prompt.filter(message =>
    message.role !== 'system' || typeof message.content !== 'string' || !message.content.startsWith(marker));
  const position = retained.findIndex(message => message.role !== 'system');
  retained.splice(position < 0 ? retained.length : position, 0, clock);
  return retained;
}

/** Request-only: the actual dispatch gets fresh time, without saving a stale clock in scene history. */
export function createTimeContextProcessor(options: TimeContextOptions): Processor & {
  processLLMRequest: NonNullable<Processor['processLLMRequest']>;
} {
  return { id: 'rae-time-context', processLLMRequest: async ({ prompt }) => ({ prompt: withTimeContext(prompt, options) }) };
}
