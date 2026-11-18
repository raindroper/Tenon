import type { LanguageModelV4 } from '@ai-sdk/provider';
import { randomUUID } from 'node:crypto';
import type { Run } from '../../shared/types.js';
import type { Store } from '../store.js';
import { meterModel, type MeteredUsage } from './metering.js';

/** Owns durable pending-call markers and the provider's reported token counts. */
export class UsageTracker {
  private readonly pending = new Map<string, Run>();
  constructor(private readonly store: Store, private readonly options: { assertActive?: () => void } = {}) {}

  recover(): void {
    this.store.atomic(() => {
      for (const call of this.store.list('modelCalls')) if (call.status === 'pending') {
        this.store.put('modelCalls', { ...call, status: 'settled', settledAt: new Date().toISOString(), usageStatus: 'unknown' });
      }
    for (const run of this.store.list('runs')) {
      const legacyReservation = (run as Run & { reservedCostCny?: number }).reservedCostCny ?? 0;
      if ((run.pendingModelCalls ?? 0) > 0 || legacyReservation > 0) {
        this.store.put('runs', { ...run, pendingModelCalls: 0, usageStatus: 'unknown', ...(legacyReservation > 0 ? { reservedCostCny: 0 } : {}) });
      }
    }
    });
  }

  private settle(id: string, usage: MeteredUsage): void {
    const run = this.pending.get(id); if (!run) return;
    const call = this.store.get('modelCalls', id);
    if (!call || call.status !== 'pending') { this.pending.delete(id); return; }
    const order = { reported: 0, partial: 1, unknown: 2 };
    const next: Run = { ...run, inputTokens: run.inputTokens + usage.inputTokens, outputTokens: run.outputTokens + usage.outputTokens,
      usageStatus: !run.usageStatus || run.usageStatus === 'not_used' || order[usage.usageStatus] > order[run.usageStatus] ? usage.usageStatus : run.usageStatus,
      pendingModelCalls: Math.max(0, (run.pendingModelCalls ?? 0) - 1) };
    // Counts and clearing this pending marker commit together. A crash after
    // this write cannot recover the same request as another unknown call.
    this.store.atomic(() => {
      this.store.put('modelCalls', { ...call, ...usage, status: 'settled', settledAt: new Date().toISOString() });
      this.store.put('runs', next);
    });
    Object.assign(run, next); this.pending.delete(id);
  }
  private begin(run: Run, id: string, signal: AbortSignal, assertTask?: () => void, service?: 'hub'): void {
    this.options.assertActive?.(); signal.throwIfAborted(); assertTask?.();
    if (this.store.get('modelCalls', id)) throw new Error('模型调用编号已经受理，不会重复派发。');
    // The pending marker and removal of native-only status commit before dispatch.
    // A crash or a missing response can therefore never recover as "not used".
    const next: Run = { ...run, usageStatus: run.usageStatus === 'not_used' ? undefined : run.usageStatus,
      pendingModelCalls: (run.pendingModelCalls ?? 0) + 1 };
    this.store.atomic(() => {
      this.store.insert('modelCalls', { id, runId: run.id, taskId: run.taskId, caseId: run.caseId,
        createdAt: new Date().toISOString(), status: 'pending', ...(service ? { service } : run.modelBinding ? { binding: structuredClone(run.modelBinding) } : {}),
        inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' });
      this.store.put('runs', next);
    });
    Object.assign(run, next); this.pending.set(id, run);
  }

  /** A hosted tool may run auxiliary models without exposing their complete usage. */
  async trackUnknown<T>(run: Run, signal: AbortSignal, operation: () => Promise<T>, assertTask?: () => void): Promise<T> {
    const id = randomUUID(); this.begin(run, id, signal, assertTask, 'hub');
    const unknown: MeteredUsage = { inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' };
    let failure: unknown;
    const abort = () => { try { this.settle(id, unknown); } catch (error) { failure = error; } };
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); return await operation(); }
    finally {
      signal.removeEventListener('abort', abort); this.settle(id, unknown);
      if (failure) throw failure;
    }
  }

  meter(run: Run, model: LanguageModelV4, signal: AbortSignal, assertTask?: () => void): LanguageModelV4 {
    return meterModel(model, {
      signal,
      begin: id => this.begin(run, id, signal, assertTask),
      record: (usage, id) => this.settle(id, usage),
    });
  }

  /** Native local engines use the same durable usage ledger as Mastra model calls. */
  external(run: Run, id: string, signal: AbortSignal, assertTask: () => void): (usage: MeteredUsage) => void {
    this.begin(run, id, signal, assertTask);
    let settled = false;
    return usage => { if (settled) return; this.settle(id, usage); settled = true; };
  }
}
