import type { MastraDBMessage } from '@mastra/core/agent';
import { RuntimeInputError } from '../runtime.js';
import { CaseMemory, type CaseRecord } from './memory.js';

export type CaseInput = Pick<CaseRecord, 'title' | 'objective' | 'domain' | 'backgroundSources'>;
export type CasePatch = Partial<Pick<CaseRecord, 'title' | 'objective' | 'status' | 'backgroundSources'>>;
export type CaseMutationHook = <T>(caseId: string, work: () => Promise<T>) => Promise<T>;
export interface CaseServiceOptions { withMutation?: CaseMutationHook }
export interface MutationOrigin { fromRun?: boolean }

/** Single domain write entry. Native thread status is the sole persistent authority. */
export class CaseService {
  private initialization?: Promise<void>;
  private readonly statuses = new Map<string, CaseRecord['status']>();
  private readonly revisions = new Map<string, number>();
  private readonly ownerWrites = new Map<string, Promise<unknown>>();
  constructor(private readonly memory: CaseMemory, private readonly options: CaseServiceOptions = {}) {}

  init(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      await this.memory.init(); for (const item of await this.memory.listCases()) this.observeRead(item, 0);
    })();
    return this.initialization;
  }
  private revision(id: string): number { return this.revisions.get(id) ?? 0; }
  private advance(id: string): void { this.revisions.set(id, this.revision(id) + 1); }
  private observeRead(item: CaseRecord, revision: number): CaseRecord {
    if (this.revision(item.id) === revision) this.statuses.set(item.id, item.status);
    return item;
  }
  private observeCommit(item: CaseRecord): CaseRecord {
    this.advance(item.id); this.statuses.set(item.id, item.status); return item;
  }
  private async require(id: string): Promise<CaseRecord> {
    const item = await this.get(id); if (!item) throw new Error('事项不存在或不属于当前用户。'); return item;
  }
  private mutate<T>(id: string, work: () => Promise<T>, origin: MutationOrigin): Promise<T> {
    return !origin.fromRun && this.options.withMutation ? this.options.withMutation(id, work) : work();
  }
  async create(input: CaseInput): Promise<CaseRecord> { await this.init(); return this.observeCommit(await this.memory.createCase(input)); }
  async ensureCase(id: string, input: CaseInput): Promise<CaseRecord> {
    await this.init(); const revision = this.revision(id);
    return this.observeRead(await this.memory.ensureCase(id, input), revision);
  }
  async get(id: string): Promise<CaseRecord | undefined> {
    await this.init(); const revision = this.revision(id); const item = await this.memory.getCase(id);
    return item ? this.observeRead(item, revision) : undefined;
  }
  async list(): Promise<CaseRecord[]> {
    await this.init(); const revisions = new Map(this.revisions); const items = await this.memory.listCases();
    for (const item of items) this.observeRead(item, revisions.get(item.id) ?? 0); return items;
  }
  isCancelled(id: string): boolean { return this.statuses.get(id) === 'cancelled'; }
  statusOf(id: string): CaseRecord['status'] | undefined { return this.statuses.get(id); }
  async requireOpen(id: string): Promise<CaseRecord> {
    const item = await this.get(id);
    if (!item) throw new RuntimeInputError(404, '事项不存在。');
    if (item.status === 'cancelled' || item.status === 'completed') throw new RuntimeInputError(409, '当前场景已停止，请先恢复。');
    return item;
  }
  async serializeOwnerWrite<T>(id: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.ownerWrites.get(id) ?? Promise.resolve()).then(work, work);
    this.ownerWrites.set(id, operation);
    try { return await operation; }
    finally { if (this.ownerWrites.get(id) === operation) this.ownerWrites.delete(id); }
  }
  async update(id: string, patch: CasePatch, origin: MutationOrigin = {}): Promise<CaseRecord> {
    await this.require(id);
    return this.mutate(id, async () => {
      // Invalidate reads started before or during this write. Do not use wall
      // clock timestamps: separate commits may share the same millisecond.
      this.advance(id);
      try { return this.observeCommit(await this.memory.updateCase(id, patch)); }
      catch (error) { this.advance(id); throw error; }
    }, origin);
  }
  async activate(id: string, origin: MutationOrigin = {}): Promise<CaseRecord> {
    const item = await this.require(id); return item.status === 'active' && this.statusOf(id) === 'active' ? item : this.update(id, { status: 'active' }, origin);
  }
  async cancel(id: string): Promise<CaseRecord> {
    const item = await this.require(id); return item.status === 'cancelled' && this.statusOf(id) === 'cancelled' ? item : this.update(id, { status: 'cancelled' });
  }
  async getWorking(id: string): Promise<string | null> { await this.require(id); return this.memory.getWorking(id); }
  async setWorking(id: string, value: string): Promise<void> { await this.require(id); await this.memory.setWorking(id, value); }
  async history(id: string): Promise<MastraDBMessage[]> { await this.require(id); return this.memory.history(id); }
  /** Bootstrap-only importer, before workers start; clear the old key only on success. */
  async migrateLegacyCancelled(ids: string[]): Promise<void> {
    await this.init();
    for (const id of new Set(ids)) if (await this.get(id)) await this.update(id, { status: 'cancelled' }, { fromRun: true });
  }
}
