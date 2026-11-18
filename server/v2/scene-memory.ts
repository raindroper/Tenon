import { AsyncLocalStorage } from 'node:async_hooks';
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { MemoryConfigInternal } from '@mastra/core/memory';
import type { Processor } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { parseObservationGroups } from '@mastra/memory/processors';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import PQueue from 'p-queue';
import type { ObservationContext } from './observation-context.js';

export interface SceneMemoryOptions {
  embedder?: EmbeddingModelV4;
  observationTokens?: number;
  reflectionTokens?: number;
}
export const observationModelKey = 'rae.observation-model';
type RoleModels = { observer: LanguageModelV4; reflector: LanguageModelV4 };
interface ObservationTurn {
  caseId: string;
  history?: Promise<MastraDBMessage[]>;
}

/** One native memory, with application-owned attribution and a single guarded recall tool. */
export class SceneMemory extends Memory {
  private attribution?: ObservationContext;
  private readonly observationTurn = new AsyncLocalStorage<ObservationTurn>();
  private readonly projectionWrites = new Map<string, PQueue>();
  constructor(private readonly sceneStorage: LibSQLStore, private readonly sceneVector: LibSQLVector,
    private readonly owner: string, options: SceneMemoryOptions) {
    const role = (name: keyof RoleModels) => ({ requestContext }: { requestContext: RequestContext }) => {
      const models = requestContext.get(observationModelKey) as RoleModels | undefined;
      if (!models) throw new Error('观察记忆只能在已授权的有界回合内运行。');
      return models[name];
    };
    super({ storage: sceneStorage, vector: sceneVector, ...(options.embedder ? { embedder: options.embedder } : {}), embeddingDimension: 512,
      options: { lastMessages: 30, messageHistory: { maxTokens: 16_000 }, semanticRecall: false, generateTitle: false,
        workingMemory: { enabled: true, scope: 'thread', agentManaged: false },
        observationalMemory: { scope: 'thread', activateAfterIdle: false, activateOnProviderChange: false,
          retrieval: { vector: true, scope: 'resource', instructions: '榫的 recall 只支持工具 schema 中的 search/messages。结果只含核验的本人原话，不能读取内部记录、工具结果或附件。按消息 ID 核对后续更新；相似度不代表最新版或本人确认。' },
          observation: { model: role('observer'), messageTokens: options.observationTokens ?? 12_000, bufferTokens: false,
            bufferOnIdle: false, maxRetries: 0, failurePolicy: 'abort' },
          reflection: { model: role('reflector'), observationTokens: options.reflectionTokens ?? 24_000,
            maxRetries: 0, failurePolicy: 'abort', activateAfterIdle: false, activateOnProviderChange: false },
          hooks: {
            beforeObservation: input => this.attribution?.hooks.beforeObservation?.(input) ?? { messages: [] },
            afterObservation: input => this.attribution?.hooks.afterObservation?.(input),
            beforeReflection: input => this.attribution?.hooks.beforeReflection?.(input) ?? { observations: '' },
            afterReflection: input => this.attribution?.hooks.afterReflection?.(input),
            onObservationEnd: input => this.attribution?.hooks.onObservationEnd?.(input),
            onReflectionEnd: input => this.attribution?.hooks.onReflectionEnd?.(input),
          },
        },
      } });
  }
  setAttribution(value: ObservationContext) { this.attribution = value; }
  createTurn(caseId: string): ObservationTurn { return { caseId }; }
  protected override chunkText(text: string): string[] { return super.chunkText(text, 80); }
  override listTools(config?: MemoryConfigInternal) {
    const { recall: _unscoped, ...tools } = super.listTools(config);
    return tools;
  }
  historyForCase(caseId: string, turn = this.observationTurn.getStore()): Promise<MastraDBMessage[]> {
    // Only the original native rows are shared. Source and correction policy are rechecked at every use.
    if (turn?.caseId === caseId) return turn.history ??= this.loadHistory(caseId);
    return this.loadHistory(caseId);
  }
  private async loadHistory(caseId: string): Promise<MastraDBMessage[]> {
    return (await (await this.sceneStorage.getStore('memory'))!.listMessages({ threadId: caseId, resourceId: this.owner,
      perPage: false, orderBy: { field: 'createdAt', direction: 'ASC' } })).messages;
  }
  async observationText(caseId: string) { return (await this.omEngine)?.getObservations(caseId, this.owner); }
  private async safeObservations(caseId: string, record: ObservationalMemoryRecord, turn?: ObservationTurn) {
    return this.attribution && record.activeObservations
      ? this.attribution.filterObservations(caseId, record.activeObservations, await this.historyForCase(caseId, turn)) : '';
  }
  private async writeProjection<T>(caseId: string, write: () => Promise<T>): Promise<T> {
    let queue = this.projectionWrites.get(caseId);
    if (!queue) { queue = new PQueue({ concurrency: 1 }); this.projectionWrites.set(caseId, queue); }
    try { return await queue.add(write); }
    finally { if (!queue.pending && !queue.size) this.projectionWrites.delete(caseId); }
  }
  async prepareObservations(caseId: string, signal?: AbortSignal, turn?: ObservationTurn) {
    await this.writeProjection(caseId, async () => {
      signal?.throwIfAborted();
      const om = await this.omEngine;
      const record = await om?.getRecord(caseId, this.owner);
      if (!om || !record?.activeObservations) return;
      if (await this.safeObservations(caseId, record, turn) === record.activeObservations) return;
      // Observations/vectors are rebuildable projections. All original messages and owner revisions remain intact.
      await om.clear(caseId, this.owner);
      for (const indexName of await this.sceneVector.listIndexes()) {
        if (indexName.startsWith('memory_observations_')) await this.sceneVector.deleteVectors({ indexName,
          filter: { resource_id: this.owner, thread_id: caseId } });
      }
      signal?.throwIfAborted();
    });
  }
  async observeCase(caseId: string, requestContext: RequestContext, signal: AbortSignal, turn = this.createTurn(caseId)) {
    await this.writeProjection(caseId, async () => {
      signal.throwIfAborted();
      const om = await this.omEngine;
      if (!om || !this.attribution) return;
      const result = await this.observationTurn.run(turn, () =>
        om.observe({ threadId: caseId, resourceId: this.owner, force: false, requestContext, abortSignal: signal }));
      if (result.reflected && result.record) {
        const safe = await this.safeObservations(caseId, result.record, turn);
        if (safe) await this.indexProjection(caseId, result.record, safe, signal, 'reflection');
      }
    });
  }
  private async indexProjection(caseId: string, record: ObservationalMemoryRecord, safe: string,
    signal: AbortSignal, mode: 'reflection' | 'repair') {
    signal.throwIfAborted();
    const groups = parseObservationGroups(safe);
    // Fresh Observer groups are already indexed by the SDK. Reflection and missing search results use the same public writer.
    for (const group of groups) {
      if (mode === 'reflection' && group.kind !== 'reflection') continue;
      signal.throwIfAborted();
      await this.indexObservation({ text: group.content, groupId: group.id, range: group.range, threadId: caseId,
        resourceId: this.owner, recordId: record.id, observedAt: record.lastObservedAt ?? undefined });
    }
    if (safe === record.activeObservations) {
      for (const indexName of await this.sceneVector.listIndexes()) if (indexName.startsWith('memory_observations_')) {
        await this.sceneVector.deleteVectors({ indexName, filter: { resource_id: this.owner, thread_id: caseId,
          group_id: { $nin: groups.map(group => group.id) } } });
      }
    }
    signal.throwIfAborted();
  }
  actorContext(caseId: string, includeObservations = true, turn?: ObservationTurn): Processor & { processInputStep: NonNullable<Processor['processInputStep']> } {
    return { id: 'rae-observation-context', processInputStep: async ({ messageList, abortSignal }) => {
      abortSignal?.throwIfAborted();
      await this.attribution?.pruneActorHistory(caseId, messageList);
      if (!includeObservations) return { messageList };
      const om = await this.omEngine;
      const record = await om?.getRecord(caseId, this.owner);
      messageList.clearSystemMessages('observational-memory');
      if (!record?.activeObservations) return;
      const safe = await this.safeObservations(caseId, record, turn);
      if (!safe) return;
      // Native formatting also injects derived task/extraction metadata. Only the verified groups belong in Tenon's context.
      messageList.addSystem(`本场景的历史观察，仅作背景，不是现行事实或任务许可；以本人当前表达和现行更正为准。需要原话时用受控recall。\n${safe}`, 'observational-memory');
      // Retain new inputs/tool responses. The SDK keeps pruned stored messages available for export/history.
      const cutoff = safe === record.activeObservations ? record.lastObservedAt?.getTime() : undefined;
      if (cutoff !== undefined) messageList.removeByIds(messageList.get.all.db().filter(message =>
        !messageList.isNewMessage(message) && new Date(message.createdAt).getTime() <= cutoff).map(message => message.id), { pruned: true });
      abortSignal?.throwIfAborted();
      return { messageList };
    } };
  }
  async semanticSources(query: string, caseIds: readonly string[], signal: AbortSignal) {
    const output: { messageId: string; caseId: string; score: number }[] = [];
    if (!this.attribution) return output;
    let indexed = (await this.sceneVector.listIndexes()).some(name => name.startsWith('memory_observations_'));
    for (const caseId of caseIds) {
      signal.throwIfAborted();
      const om = await this.omEngine;
      const record = await om?.getRecord(caseId, this.owner);
      if (!om || !record?.activeObservations) continue;
      const turn = this.createTurn(caseId);
      const search = () => this.searchMessages({ query, resourceId: this.owner, filter: { threadId: caseId }, topK: 5 });
      const found = indexed ? (await search()).results : [];
      const messages = await this.historyForCase(caseId, turn);
      let safe = await this.safeObservations(caseId, record, turn);
      if (!safe) continue;
      let currentRanges = new Map(parseObservationGroups(safe).map(group => [group.id, group.range]));
      const isCurrent = (hit: typeof found[number]) => Boolean(hit.groupId && currentRanges.get(hit.groupId) === hit.range);
      let matches = found.filter(isCurrent);
      // Another scene may still be observing. Skip optional repair during its write rather than waiting for its model.
      if (!matches.length && !this.projectionWrites.has(caseId)) {
        const repaired = await this.writeProjection(caseId, async () => {
          const current = await om.getRecord(caseId, this.owner);
          if (!current || current.id !== record.id || current.activeObservations !== record.activeObservations) return false;
          const allowed = await this.safeObservations(caseId, current, turn);
          if (!allowed) return false;
          await this.indexProjection(caseId, current, allowed, signal, 'repair');
          return true;
        });
        if (repaired) {
          indexed = true;
          const retried = await search();
          safe = await this.safeObservations(caseId, record, turn);
          currentRanges = new Map(parseObservationGroups(safe).map(group => [group.id, group.range]));
          matches = retried.results.filter(isCurrent);
        }
      }
      for (const hit of matches) {
        const ids = new Set((hit.range ?? '').split(',').flatMap(range => {
          const [start, end] = range.split(':');
          const from = messages.findIndex(message => message.id === start); const to = messages.findIndex(message => message.id === end);
          return from >= 0 && to >= from ? messages.slice(from, to + 1).map(message => message.id) : [];
        }));
        for (const message of messages) if (ids.has(message.id)) {
          const source = this.attribution.ownerSourceForMessage(caseId, message);
          if (source) output.push({ messageId: source.messageId, caseId, score: hit.score });
        }
      }
    }
    signal.throwIfAborted();
    return output.sort((a, b) => b.score - a.score);
  }
}
