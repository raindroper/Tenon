import { randomUUID } from 'node:crypto';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { TokenUsage } from '../../shared/types.js';

export type MeteredUsage = TokenUsage;
export interface MeterOptions {
  signal?: AbortSignal;
  begin(id: string): void;
  record(usage: MeteredUsage, id: string): void;
}

const unknownUsage: MeteredUsage = { inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' };
function reportedUsage(usage: LanguageModelV4Usage): MeteredUsage {
  const total = (reported: number | undefined, parts: Array<number | undefined>) => {
    const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
    if (valid(reported)) return { value: reported, complete: true, known: true };
    const values = parts.filter(valid); const value = values.reduce((sum, item) => sum + item, 0);
    if (!Number.isSafeInteger(value)) return { value: 0, complete: false, known: false };
    return { value, complete: parts.every(valid), known: values.length > 0 };
  };
  const input = total(usage.inputTokens.total, [usage.inputTokens.noCache, usage.inputTokens.cacheRead, usage.inputTokens.cacheWrite]);
  const output = total(usage.outputTokens.total, [usage.outputTokens.text, usage.outputTokens.reasoning]);
  return { inputTokens: input.value, outputTokens: output.value,
    usageStatus: input.complete && output.complete ? 'reported' : input.known || output.known ? 'partial' : 'unknown' };
}

/** Counts only provider-reported tokens. Missing usage remains unknown, never a character-based estimate. */
export function meterModel(model: LanguageModelV4, options: MeterOptions): LanguageModelV4 {
  const withSignal = (params: LanguageModelV4CallOptions): LanguageModelV4CallOptions => options.signal ? {
    ...params, abortSignal: params.abortSignal ? AbortSignal.any([options.signal, params.abortSignal]) : options.signal,
  } : params;
  const begin = (params: LanguageModelV4CallOptions) => {
    params.abortSignal?.throwIfAborted();
    const id = randomUUID();
    options.begin(id); // Persist the pending call before dispatching the provider.
    let settled = false; let settlementFailed = false; let settlementError: unknown;
    const settle = (usage: MeteredUsage) => {
      if (settled) { if (settlementFailed) throw settlementError; return; }
      settled = true;
      params.abortSignal?.removeEventListener('abort', abort);
      try { options.record(usage, id); }
      catch (error) { settlementFailed = true; settlementError = error; throw error; }
    };
    // Abort listeners cannot throw persistence errors globally. The owning call
    // surfaces the error; its durable pending marker remains recoverable.
    const abort = () => { try { settle(unknownUsage); } catch { /* surfaced by end() */ } };
    params.abortSignal?.addEventListener('abort', abort, { once: true });
    if (params.abortSignal?.aborted) abort();
    return { usage: (usage: LanguageModelV4Usage) => settle(reportedUsage(usage)), end: () => settle(unknownUsage) };
  };
  return new Proxy(model, { get(target, property) {
    if (property === 'doGenerate') return async (params: LanguageModelV4CallOptions) => {
      params = withSignal(params);
      const meter = begin(params);
      try { params.abortSignal?.throwIfAborted(); const result = await target.doGenerate(params); meter.usage(result.usage); return result; }
      finally { meter.end(); }
    };
    if (property === 'doStream') return async (params: LanguageModelV4CallOptions) => {
      params = withSignal(params);
      const meter = begin(params);
      try {
        params.abortSignal?.throwIfAborted();
        const result = await target.doStream(params);
        const reader = result.stream.getReader();
        const stream: typeof result.stream = new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { meter.end(); controller.close(); return; }
              if (next.value.type === 'finish') meter.usage(next.value.usage);
              controller.enqueue(next.value);
            } catch (error) {
              try { meter.end(); } catch (settlementError) { controller.error(settlementError); return; }
              controller.error(error);
            }
          },
          async cancel(reason) { try { await reader.cancel(reason); } finally { meter.end(); } },
        });
        return { ...result, stream };
      } catch (error) { meter.end(); throw error; }
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
