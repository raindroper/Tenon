import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Agent, type AgentExecutionOptions, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { RequestContext } from '@mastra/core/request-context';
import { Mastra } from '@mastra/core/mastra';
import type { AnyWorkflow } from '@mastra/core/workflows';
import type { StorageThreadType } from '@mastra/core/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { defaultStabilityErrorProcessors, type Processor } from '@mastra/core/processors';
import PQueue from 'p-queue';
import { z } from 'zod';
import type { PersonalMemoryContext, PersonalMemoryContextItem, PersonalMemoryCorrectionNotice, PersonalMemoryDetails, PersonalMemorySubject } from '../../shared/personal-memory.js';
import { taskOutcomeEvidenceSchema } from '../../shared/personal-memory.js';
import type { ImageAttachment } from '../../shared/chat-images.js';
import { isSceneThemeId, legacySceneTheme, pickSceneTheme, type SceneThemeId } from '../../shared/scene-theme.js';
import { sceneBackgroundSourcesSchema, type SceneBackgroundSource } from '../../shared/scene-background.js';
import { caseImageContext, imageReference, withLocalImageReferences, type CaseImageResolver } from './image-context.js';
import { withChatFileContext, type ChatFileContext } from './chat-file-context.js';
import { caseSourceContext, type ConnectorEvidenceFilter, type SourceEvidenceFilter } from './source-context.js';
import { RuntimeInputError } from '../runtime.js';
import { SceneMemory, observationModelKey, type SceneMemoryOptions as NativeSceneMemoryOptions } from './scene-memory.js';
import { PersonalMemoryStore } from './personal-memory-store.js';
import { createTimeContextProcessor, withTimeContext, type TimeContextOptions } from './time-context.js';
import type { ObservationContext } from './observation-context.js';
import { createLocalMemoryEmbedder, hasLocalMemoryModel, resolveMemoryModelDirectory } from './embedding.js';
import { PersonalMemoryRelevance, type PersonalRelevanceFocus } from './personal-relevance.js';
import { summarizeFailure } from './failure-diagnostics.js';
import type { RunProgressSignal } from './run-progress.js';
export interface SceneMemoryOptions extends NativeSceneMemoryOptions { personalMemoryFile?: string; personalMemoryRequireCutover?: boolean }
export const PERSONAL_CONTEXT_POLICY_VERSION = 3;

export interface CaseRecord {
  id: string; title: string; objective: string; domain: string;
  backgroundSources?: SceneBackgroundSource[];
  themeId: SceneThemeId;
  status: 'active' | 'waiting' | 'completed' | 'cancelled';
  threadId: string; createdAt: string; updatedAt: string;
}
export interface SharedFact {
  key: string; value: string; domains: string[]; evidenceIds: string[]; createdAt: string; updatedAt: string;
  personal?: PersonalMemoryDetails;
}
export interface TaskMemoryContext {
  taskId: string;
  requirementsRevision: number;
}
export interface CaseRunOptions {
  caseId: string; message: string; model: LanguageModelV4; instructions: string;
  attachments?: ReadonlyArray<Pick<ImageAttachment, 'id' | 'mediaType'>>;
  chatFiles?: readonly ChatFileContext[];
  tools?: ToolsInput; signal?: AbortSignal; maxSteps?: number | null; maxOutputTokens?: number;
  /** Only bounds optional observation and reflection when the actor has no step ceiling. */
  auxiliaryMaxSteps?: number;
  isolatedSourceReview?: boolean;
  memoryConversationId?: string;
  memoryFocus?: readonly string[];
  temporal?: TimeContextOptions;
  onMemoryContext?: (context: PersonalMemoryContext) => void;
  /** Execution history is separate from owner conversation; this context is not an authorization. */
  execution?: TaskMemoryContext;
  /** A task's explicit evidence references may be narrower or different from its scene. */
  evidenceAllowed?: SourceEvidenceFilter;
  observeOwnerConversation?: boolean;
  onMemoryCall?: () => void;
  onProgress?: (signal: RunProgressSignal) => void;
  memoryCorrections?: PersonalMemoryCorrectionNotice[];
  stopAfterStep?: () => boolean;
  finalTools?: string[];
  context?: AgentExecutionOptions['context'];
  onStepFinish?: AgentExecutionOptions['onStepFinish'];
  onText?: (delta: string) => void | Promise<void>;
  maxOutputContinuations?: number;
  onOutputContinuation?: () => void | Promise<void>;
  providerOptions?: AgentExecutionOptions['providerOptions'];
}
export interface CaseRunResult {
  text: string; threadId: string; usage: { inputTokens: number; outputTokens: number };
  finishReason?: string; steps: number; continuations: number; stalled: boolean;
}

const defaultCaseMaxSteps = 20;

function completedToolStepFingerprint(parts: readonly unknown[]): string | undefined {
  const tools = new Map<string, unknown[][]>();
  for (const value of parts) {
    if (!value || typeof value !== 'object') continue;
    const part = value as Record<string, unknown>;
    if (typeof part.toolCallId !== 'string' || (part.type !== 'tool-call' && part.type !== 'tool-result' && part.type !== 'tool-error')) continue;
    const call = tools.get(part.toolCallId) ?? [];
    const detail = part.type === 'tool-call' ? part.input ?? part.args : part.type === 'tool-result' ? part.output : part.error;
    call.push([part.type, part.toolName, detail]);
    tools.set(part.toolCallId, call);
  }
  if (!tools.size) return;
  try {
    const fingerprints = [...tools.values()].map(tool => createHash('sha256').update(JSON.stringify(tool, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message };
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    })).digest('hex'));
    return fingerprints.sort().join(':');
  } catch { return undefined; }
}

const nonempty = (max: number) => z.string().trim().min(1).max(max);
const taskContextSchema = z.object({ taskId: nonempty(200), requirementsRevision: z.number().int().positive().safe() }).strict();
const caseInput = z.object({ title: nonempty(200), objective: z.string().trim().max(8_000), domain: nonempty(100), backgroundSources: sceneBackgroundSourcesSchema.optional() }).strict();
const statusSchema = z.enum(['active', 'waiting', 'completed', 'cancelled']);
const updateInput = z.object({ title: nonempty(200).optional(), objective: z.string().trim().max(8_000).optional(), status: statusSchema.optional(), backgroundSources: sceneBackgroundSourcesSchema.optional() }).strict()
  .refine(input => !input.backgroundSources || input.objective !== undefined, '背景来源必须与背景正文一起更新。');
const factInput = z.object({ key: nonempty(200), value: nonempty(2_000), domains: z.array(nonempty(100)).min(1).max(20),
  evidenceIds: z.array(nonempty(200)).min(1).max(30) }).strict();
const evidenceSchema = z.object({ eventId: nonempty(300), excerpt: nonempty(2000), actor: z.enum(['owner', 'external', 'agent', 'system']), kind: nonempty(200),
  sourceId: nonempty(300), sourceGeneration: nonempty(300).optional(), caseId: nonempty(200), occurredAt: z.string().datetime(), receivedAt: z.string().datetime(),
  rating: z.object({ verdict: z.enum(['useful', 'off_target', 'correction', 'not_now']), targetType: z.enum(['message', 'artifact', 'case']),
    targetId: nonempty(300), targetContentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  taskOutcome: taskOutcomeEvidenceSchema.optional() }).strict();
const identitySchema = z.object({ kind: z.enum(['name', 'alias']), value: nonempty(200), platform: nonempty(100).optional(), conversationId: nonempty(300).optional() }).strict();
const mutationSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner-message'), eventId: nonempty(300), caseId: nonempty(200), contentHash: z.string().regex(/^[a-f0-9]{64}$/), excerpt: nonempty(2000), messageId: nonempty(300).optional() }).strict(),
  z.object({ kind: z.literal('owner-command'), commandId: nonempty(300), acceptedAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal('legacy') }).strict(),
]);
const versionFields = {
  subject: z.enum(['owner', 'agent']).default('owner'),
  purpose: z.enum(['identity', 'interaction', 'context']).optional(), identity: identitySchema.optional(), mutationSource: mutationSourceSchema.optional(),
  revision: z.number().int().positive(), value: nonempty(2000), kind: z.enum(['fact', 'preference', 'habit', 'experience']),
  level: z.enum(['hypothesis', 'explicit']), scope: z.enum(['case', 'domain', 'global']), domains: z.array(nonempty(100)).min(1).max(20),
  caseIds: z.array(nonempty(200)).max(30), evidenceIds: z.array(nonempty(300)).max(30), evidence: z.array(evidenceSchema).max(30),
  status: z.enum(['active', 'retracted']), origin: z.enum(['learned', 'owner', 'legacy']), validFrom: z.string().datetime(), expiresAt: z.string().datetime().nullable(), updatedAt: z.string().datetime(),
} as const;
const retirementScopeSchema = z.object({ domains: z.array(nonempty(100)).min(1).max(20), caseIds: z.array(nonempty(200)).max(30).optional() }).strict();
const retirementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), eventId: nonempty(300), caseId: nonempty(200), excerptHash: z.string().regex(/^[a-f0-9]{64}$/),
    ownerChat: z.boolean(), except: retirementScopeSchema.optional() }).strict(),
  z.object({ type: z.literal('literal'), value: nonempty(2_000), scope: retirementScopeSchema, except: retirementScopeSchema.optional() }).strict(),
]);
const personalSchema = z.object({ ...versionFields, supersedes: z.number().int().positive().nullable(), history: z.array(z.object(versionFields).strict()).max(8),
  retirements: z.array(retirementSchema).optional() })
  .omit({ value: true, domains: true, evidenceIds: true, updatedAt: true }).strict();
const factSchema = factInput.extend({ evidenceIds: z.array(nonempty(300)).max(30), createdAt: z.string(), updatedAt: z.string(), personal: personalSchema.optional() });
const coreSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), facts: z.array(factSchema).max(64) }).strict()
  .refine(value => new Set(value.facts.map(fact => fact.key)).size === value.facts.length, '个人记忆键重复，未选择性覆盖。');
const threadConfig = { workingMemory: { enabled: true, scope: 'thread' as const, agentManaged: false } };
const resourceConfig = { workingMemory: { enabled: true, scope: 'resource' as const, agentManaged: false } };

const memoryContextBudgets = { identities: 12_000, interactionPolicies: 12_000, ownerFacts: 18_000, methods: 8_000 };

function personalContextCandidate(fact: SharedFact) {
  const p = fact.personal;
  const item: PersonalMemoryContextItem = { key: fact.key, revision: p?.revision ?? 1, value: fact.value,
    subject: p?.subject ?? 'owner', level: p?.level ?? 'explicit', purpose: p?.purpose ?? 'context',
    scope: p?.scope ?? (fact.domains.includes('*') ? 'global' : 'domain'), domains: fact.domains,
    caseIds: p?.caseIds ?? [], expiresAt: p?.expiresAt ?? null, ...(p?.identity ? { identity: p.identity } : {}) };
  const group: keyof typeof memoryContextBudgets = item.subject === 'agent' ? 'methods' : item.purpose === 'identity' ? 'identities'
    : item.purpose === 'interaction' ? 'interactionPolicies' : 'ownerFacts';
  return { fact, item, group, size: JSON.stringify(item).length };
}

function logCaseFailure(caseId: string, error: unknown): void {
  const diagnostic = summarizeFailure(error);
  console.error(diagnostic.category === 'model_api' ? '模型接口调用失败。' : '模型回合处理失败。', { caseId, ...diagnostic });
}

function causedBy(error: unknown, expected: Error): boolean {
  const seen = new Set<unknown>();
  const matches = (value: unknown): boolean => {
    if (value === expected) return true;
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if ('errors' in value && Array.isArray(value.errors) && value.errors.length) return value.errors.every(matches);
    return 'cause' in value && matches(value.cause);
  };
  return matches(error);
}

/**
 * Native Mastra threads own case history/state. Only an explicitly filtered
 * resource view crosses case boundaries. No model is called by storage methods.
 * Evidence authenticity/promotion policy belongs to the domain service.
 */
export class CaseMemory {
  private readonly storage: LibSQLStore;
  private readonly memory: SceneMemory;
  private readonly vector: LibSQLVector;
  // The SDK's agent and internal workflow loggers can emit entire request and tool payloads.
  private readonly mastra = new Mastra({ logger: false, recovery: { workflows: 'off', durableAgents: 'off' } });
  private readonly coreThreadId: string;
  private readonly personalStore: PersonalMemoryStore;
  private readonly personalRelevance: PersonalMemoryRelevance;
  private readonly personalMemoryRequireCutover: boolean;
  private readonly sharedWrites = new PQueue({ concurrency: 1 });
  private readonly caseRuns = new Map<string, PQueue>();
  private readonly taskRuns = new Map<string, PQueue>();
  private readonly caseWrites = new Map<string, PQueue>();
  private readonly caseCreations = new PQueue({ concurrency: 1 });
  private initialization?: Promise<void>;
  private sceneBackground?: (item: CaseRecord) => Promise<string>;
  private closed = false;
  private closing = false;
  private closeOperation?: Promise<void>;
  private personalEvidenceFilter?: (fact: SharedFact) => boolean;
  private personalCorrections?: (caseId: string) => Promise<PersonalMemoryCorrectionNotice[]>;
  private ownerObservations?: ObservationContext;
  private sourceEvidenceFilter?: SourceEvidenceFilter;
  private connectorEvidenceFilter?: ConnectorEvidenceFilter;

  constructor(databaseUrl: string, private readonly ownerId = 'owner', private readonly resolveImage?: CaseImageResolver,
    options: SceneMemoryOptions = {}) {
    nonempty(200).parse(ownerId);
    this.coreThreadId = `core-${createHash('sha256').update(ownerId).digest('hex').slice(0, 32)}`;
    this.personalStore = new PersonalMemoryStore(options.personalMemoryFile ?? (databaseUrl === ':memory:' || databaseUrl === 'file::memory:'
      ? ':memory:' : databaseUrl.replace(/^file:/, '') + '.personal.sqlite'), ownerId, fact => factSchema.parse(fact));
    this.personalMemoryRequireCutover = options.personalMemoryRequireCutover === true;
    this.storage = new LibSQLStore({ id: 'rae-v2-case-memory', url: databaseUrl });
    this.mastra.setStorage(this.storage);
    this.vector = new LibSQLVector({ id: 'rae-scene-vectors', url: databaseUrl });
    const modelDirectory = resolveMemoryModelDirectory(dirname(databaseUrl.replace(/^file:/, '')));
    const embedder = options.embedder ?? createLocalMemoryEmbedder(modelDirectory);
    this.memory = new SceneMemory(this.storage, this.vector, ownerId, { ...options, embedder });
    this.personalRelevance = new PersonalMemoryRelevance(embedder, () => Boolean(options.embedder) || hasLocalMemoryModel(modelDirectory));
  }

  setObservationContext(value: ObservationContext) { this.ownerObservations = value; this.memory.setAttribution(value); }
  setSceneBackgroundResolver(resolve: (item: CaseRecord) => Promise<string>) { this.sceneBackground = resolve; }
  registerWorkflow(workflow: AnyWorkflow): void {
    if (this.closing || this.closed) throw new Error('记忆存储正在关闭，未注册新的工作流。');
    this.mastra.addWorkflow(workflow);
  }
  historyForObservation(caseId: string) { return this.memory.historyForCase(caseId); }
  observationsForCase(caseId: string) { return this.memory.observationText(caseId); }
  async semanticRecall(query: string, caseIds: readonly string[], signal: AbortSignal) {
    for (const id of caseIds) await this.requireCase(id);
    return this.memory.semanticSources(query, caseIds, signal);
  }

  async init(): Promise<void> {
    if (this.closed) throw new Error('记忆存储已关闭。');
    if (!this.initialization) this.initialization = (async () => {
      await this.storage.init();
      if (!this.personalStore.migrated) {
        if (this.personalMemoryRequireCutover) throw new Error('此数据版本要求已提交的个人记忆账本；检测到不匹配的备份，未从旧核心恢复。');
        const raw = await this.memory.getWorkingMemory({ threadId: this.coreThreadId, resourceId: this.ownerId, memoryConfig: resourceConfig });
        let facts: SharedFact[] = [];
        try { facts = raw ? coreSchema.parse(JSON.parse(raw)).facts : []; }
        catch { throw new Error('共享记忆格式无效，未迁移或覆盖原始内容。'); }
        this.personalStore.importLegacy(raw ?? null, facts);
      }
      // Theme identity belongs to the native scene record. Upgrade once without
      // changing activity ordering, working memory, or conversation history.
      const { threads } = await this.memory.listThreads({ perPage: false, filter: { resourceId: this.ownerId, metadata: { kind: 'case' } } });
      for (const thread of threads) {
        this.asCase(thread);
        if (!isSceneThemeId(thread.metadata?.themeId)) await this.memory.saveThread({
          thread: { ...thread, metadata: { ...thread.metadata, themeId: legacySceneTheme(thread.id) } }, memoryConfig: threadConfig,
        });
      }
    })();
    return this.initialization;
  }

  private asCase(thread: StorageThreadType | null): CaseRecord | undefined {
    if (!thread || thread.resourceId !== this.ownerId || thread.metadata?.kind !== 'case') return undefined;
    const parsed = caseInput.safeParse({ title: thread.title, objective: thread.metadata.objective, domain: thread.metadata.domain,
      ...(thread.metadata.backgroundSources ? { backgroundSources: thread.metadata.backgroundSources } : {}) });
    const status = statusSchema.safeParse(thread.metadata.status);
    if (!parsed.success || !status.success) throw new Error('事项元数据不完整，请恢复有效版本。');
    return { id: thread.id, threadId: thread.id, ...parsed.data, status: status.data,
      themeId: isSceneThemeId(thread.metadata.themeId) ? thread.metadata.themeId : legacySceneTheme(thread.id),
      createdAt: new Date(thread.createdAt).toISOString(), updatedAt: new Date(thread.updatedAt).toISOString() };
  }

  private async requireCase(id: string): Promise<CaseRecord> {
    const item = await this.getCase(id);
    if (!item) throw new Error('事项不存在或不属于当前用户。');
    return item;
  }

  private writeCase<T>(id: string, work: () => Promise<T>): Promise<T> {
    let queue = this.caseWrites.get(id);
    if (!queue) { queue = new PQueue({ concurrency: 1 }); this.caseWrites.set(id, queue); }
    return queue.add(work);
  }

  async createCase(input: Pick<CaseRecord, 'title' | 'objective' | 'domain' | 'backgroundSources'>): Promise<CaseRecord> {
    return this.ensureCase(randomUUID(), input);
  }

  /** Admission supplies a journaled ID before the native thread side effect. */
  async ensureCase(id: string, input: Pick<CaseRecord, 'title' | 'objective' | 'domain' | 'backgroundSources'>): Promise<CaseRecord> {
    nonempty(200).parse(id); const value = caseInput.parse(input); await this.init();
    return this.writeCase(id, async () => {
      const intentHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
      // A resource-filtered lookup can return null for a foreign ID. Inspect
      // existence first so an ensure cannot upsert/reassign somebody else's ID.
      const existingThread = await this.memory.getThreadById({ threadId: id });
      if (existingThread) {
        if (existingThread.resourceId !== this.ownerId) throw new Error('固定事项ID不属于当前用户。');
        const existing = this.asCase(existingThread);
        if (!existing) throw new Error('固定事项ID已被其他类型的记录占用。');
        const savedHash = existingThread.metadata?.creationIntentHash;
        const matches = typeof savedHash === 'string' ? savedHash === intentHash :
          existing.title === value.title && existing.objective === value.objective && existing.domain === value.domain;
        if (!matches) throw new RuntimeInputError(409, '场景创建编号已有不同内容，请重新提交。');
        return existing; // Retries never overwrite later user edits/status or working state.
      }
      return this.caseCreations.add(async () => {
        const cases = await this.listCases();
        // Reserve the general scene's established sage palette, including when
        // a custom scene is created before the first general conversation.
        const themeId = id === 'personal-growth' ? 'sage' : pickSceneTheme(['sage', ...cases.map(item => item.themeId)]);
        const thread = await this.memory.createThread({ threadId: id, resourceId: this.ownerId, title: value.title,
          metadata: { kind: 'case', objective: value.objective, domain: value.domain, status: 'active', themeId, creationIntentHash: intentHash,
            ...(value.backgroundSources ? { backgroundSources: value.backgroundSources } : {}) } });
        return this.asCase(thread)!;
      });
    });
  }

  async getCase(id: string): Promise<CaseRecord | undefined> {
    await this.init();
    // Pass resourceId on every read: the library validates ownership as well.
    return this.asCase(await this.memory.getThreadById({ threadId: id, resourceId: this.ownerId }));
  }

  async listCases(): Promise<CaseRecord[]> {
    await this.init();
    const { threads } = await this.memory.listThreads({ perPage: false, filter: { resourceId: this.ownerId, metadata: { kind: 'case' } } });
    return threads.map(thread => this.asCase(thread)).filter((item): item is CaseRecord => Boolean(item));
  }

  async updateCase(id: string, input: Partial<Pick<CaseRecord, 'title' | 'objective' | 'status' | 'backgroundSources'>>): Promise<CaseRecord> {
    const value = updateInput.parse(input); await this.init();
    return this.writeCase(id, async () => {
      const item = await this.requireCase(id);
      const thread = await this.memory.updateThread({ id: item.threadId, title: value.title ?? item.title,
        metadata: { objective: value.objective ?? item.objective, status: value.status ?? item.status,
          ...(value.backgroundSources ? { backgroundSources: value.backgroundSources }
            : value.objective !== undefined && value.objective !== item.objective ? { backgroundSources: null } : {}) } });
      return this.asCase(thread)!;
    });
  }

  async getWorking(id: string): Promise<string | null> {
    const item = await this.requireCase(id);
    return this.memory.getWorkingMemory({ threadId: item.threadId, resourceId: this.ownerId, memoryConfig: threadConfig });
  }

  async setWorking(id: string, workingMemory: string): Promise<void> {
    if (workingMemory.length > 12_000) throw new Error('事项工作记忆最多12000字符，请先整理。');
    await this.init();
    await this.writeCase(id, async () => {
      const item = await this.requireCase(id);
      await this.memory.updateWorkingMemory({ threadId: item.threadId, resourceId: this.ownerId, workingMemory, memoryConfig: threadConfig });
    });
  }

  async history(id: string): Promise<MastraDBMessage[]> {
    const item = await this.requireCase(id);
    const result = await this.memory.recall({ threadId: item.threadId, resourceId: this.ownerId, perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' } });
    return result.messages;
  }

  private taskThreadId(execution: TaskMemoryContext): string {
    return `task-${createHash('sha256').update(JSON.stringify([this.ownerId, execution.taskId, execution.requirementsRevision])).digest('hex')}`;
  }

  /** Called under the task queue. Native metadata records identity, never task state or permission. */
  private async ensureTaskThread(item: CaseRecord, execution: TaskMemoryContext): Promise<string> {
    const threadId = this.taskThreadId(execution);
    const existing = await this.memory.getThreadById({ threadId });
    if (existing) {
      if (existing.resourceId !== this.ownerId || existing.metadata?.kind !== 'task' || existing.metadata.caseId !== item.id
        || existing.metadata.taskId !== execution.taskId || existing.metadata.requirementsRevision !== execution.requirementsRevision) {
        throw new Error('任务上下文已绑定其他身份、场景或要求版本。');
      }
    } else {
      await this.memory.createThread({ threadId, resourceId: this.ownerId, title: item.title,
        metadata: { kind: 'task', caseId: item.id, ...execution } });
    }
    return threadId;
  }

  /** Read-only export: all requirement generations remain available without entering scene recall. */
  async taskHistories(caseId: string): Promise<Array<TaskMemoryContext & { caseId: string; threadId: string; history: MastraDBMessage[] }>> {
    await this.requireCase(caseId);
    const { threads } = await this.memory.listThreads({ perPage: false,
      filter: { resourceId: this.ownerId, metadata: { kind: 'task', caseId } } });
    return Promise.all(threads.map(async thread => {
      const execution = taskContextSchema.parse({ taskId: thread.metadata?.taskId, requirementsRevision: thread.metadata?.requirementsRevision });
      if (thread.resourceId !== this.ownerId || thread.metadata?.kind !== 'task' || thread.metadata.caseId !== caseId
        || thread.id !== this.taskThreadId(execution)) throw new Error('任务上下文归属无效，未导出其他范围。');
      const result = await this.memory.recall({ threadId: thread.id, resourceId: this.ownerId, perPage: false,
        orderBy: { field: 'createdAt', direction: 'ASC' } });
      return { ...execution, caseId, threadId: thread.id, history: result.messages };
    }));
  }

  async listSharedFacts(): Promise<SharedFact[]> {
    await this.init();
    return this.personalStore.list();
  }
  listSharedFactsSync(): SharedFact[] { return this.personalStore.list(); }
  async sharedFactPage(offset = 0, limit = 50, subject?: PersonalMemorySubject) { await this.init(); return this.personalStore.page(offset, limit, subject); }
  async legacySharedArchive() { await this.init(); return this.personalStore.archive(); }
  async personalMemoryLedgerExport() { await this.init(); return this.personalStore.exportLedger(); }

  setPersonalEvidenceFilter(filter: (fact: SharedFact) => boolean): void { this.personalEvidenceFilter = filter; }
  setPersonalCorrectionsResolver(resolve: (caseId: string) => Promise<PersonalMemoryCorrectionNotice[]>): void { this.personalCorrections = resolve; }
  setSourceEvidenceFilter(filter: SourceEvidenceFilter): void { this.sourceEvidenceFilter = filter; }
  setConnectorEvidenceFilter(filter: ConnectorEvidenceFilter): void { this.connectorEvidenceFilter = filter; }

  /** A row transaction is the only authority; the native resource core is a frozen migration archive. */
  async updateSharedFact<T>(key: string, change: (existing: SharedFact | undefined, facts: readonly SharedFact[]) => { fact: SharedFact; result: T }, expectedRevision?: number): Promise<T> {
    key = nonempty(200).parse(key); await this.init();
    return this.sharedWrites.add(() => this.personalStore.mutate(key, change, expectedRevision));
  }

  async sharedForCase(id: string, purpose: 'conversation' | 'observation' = 'conversation'): Promise<SharedFact[]> {
    const item = await this.requireCase(id);
    const timestamp = Date.now();
    const facts = (await this.listSharedFacts()).filter(fact => {
      const personal = fact.personal;
      if (!(fact.domains.includes('*') || fact.domains.includes(item.domain))) return false;
      if (!personal) return true;
      if (personal.status !== 'active' || Date.parse(personal.validFrom) > timestamp || personal.expiresAt && Date.parse(personal.expiresAt) <= timestamp) return false;
      if (personal.scope === 'case' && !personal.caseIds.includes(id)) return false;
      if (purpose === 'observation' && personal.subject === 'agent'
        && personal.origin !== 'owner'
        && !personal.evidence.some(evidence => evidence.actor === 'owner'
          && ['owner.message', 'owner.feedback'].includes(evidence.kind) && !evidence.rating)) return false;
      return personal.origin !== 'learned' || Boolean(this.personalEvidenceFilter?.(fact));
    });
    // Persisted version history/provenance is owner-facing, not an unbounded actor prompt.
    return facts.map(({ personal, ...fact }) => {
      if (!personal) return fact;
      const { retirements: _retirements, ...visible } = personal;
      return { ...fact, personal: { ...visible, history: [], evidence: [] } };
    });
  }

  /** Eligibility is checked before independent owner/method selection; omitted facts remain readable. */
  contextForCase(id: string, conversationId?: string, purpose: 'conversation' | 'observation' = 'conversation',
    focus: readonly string[] = [], signal?: AbortSignal): Promise<PersonalMemoryContext> {
    return this.selectPersonalContext(id, conversationId, purpose, this.personalRelevance.forFocus(focus), signal);
  }

  private async selectPersonalContext(id: string, conversationId: string | undefined, purpose: 'conversation' | 'observation',
    relevance: PersonalRelevanceFocus, signal?: AbortSignal): Promise<PersonalMemoryContext> {
    const current = async () => (await this.sharedForCase(id, purpose)).filter(fact => !conversationId || !fact.personal?.identity?.conversationId
      || fact.personal.identity.conversationId === conversationId).map(personalContextCandidate);
    let candidates = await current();
    const totals = { identities: 0, interactionPolicies: 0, ownerFacts: 0, methods: 0 };
    for (const { group, size } of candidates) totals[group] += size;
    const rankedGroup = (group: keyof typeof totals) => group === 'ownerFacts' || group === 'methods';
    const prepared = relevance.prepare(candidates.filter(({ group }) => rankedGroup(group) && totals[group] > memoryContextBudgets[group])
      .map(({ fact }) => fact), signal);
    if (prepared) {
      await prepared;
      // Local embedding can overlap a correction, withdrawal or source revocation.
      candidates = await current();
    }
    signal?.throwIfAborted();
    const output: PersonalMemoryContext = { identities: [], interactionPolicies: [], ownerFacts: [], methods: [],
      completeness: { complete: true, eligibleCount: candidates.length, selectedCount: 0, omittedCount: 0, omitted: [] } };
    const used = { identities: 0, interactionPolicies: 0, ownerFacts: 0, methods: 0 };
    const ranked = candidates.map(candidate => ({ ...candidate, score: rankedGroup(candidate.group) ? relevance.score(candidate.fact) : 0 }));
    const ordered = ranked.sort(({ fact: a, score: aScore }, { fact: b, score: bScore }) => {
      const explicit = Number(b.personal?.level !== 'hypothesis') - Number(a.personal?.level !== 'hypothesis');
      return bScore - aScore || explicit || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key);
    });
    for (const { item, group, size } of ordered) {
      if (used[group] + size > memoryContextBudgets[group]) {
        output.completeness.omittedCount++;
        if (output.completeness.omitted.length < 100) output.completeness.omitted.push({ key: item.key, revision: item.revision, reason: 'context_capacity' });
        continue;
      }
      used[group] += size; output[group].push(item); output.completeness.selectedCount++;
    }
    output.completeness.complete = output.completeness.omittedCount === 0;
    return output;
  }

  async runCase(input: CaseRunOptions): Promise<CaseRunResult> {
    const progress = (phase: RunProgressSignal['phase']) => { try { input.onProgress?.({ phase }); } catch { /* Display projection only. */ } };
    progress('preparing');
    if (this.closing || this.closed) throw new Error('记忆存储正在关闭，未接受新的回合。');
    const execution = input.execution ? taskContextSchema.parse(input.execution) : undefined;
    if (execution && input.isolatedSourceReview) throw new Error('任务执行不能同时作为来源回顾。');
    await this.requireCase(input.caseId);
    if (this.closing || this.closed) throw new Error('记忆存储正在关闭，未接受新的回合。');
    const queues = execution ? this.taskRuns : this.caseRuns;
    const queueKey = execution?.taskId ?? input.caseId;
    let queue = queues.get(queueKey);
    if (!queue) { queue = new PQueue({ concurrency: 1 }); queues.set(queueKey, queue); }
    return queue.add(async () => {
      input.signal?.throwIfAborted();
      const item = await this.requireCase(input.caseId);
      if (item.status === 'cancelled') throw new Error('事项已取消。');
      const threadId = execution ? await this.ensureTaskThread(item, execution) : item.threadId;
      const isolatedSourceReview = input.isolatedSourceReview === true;
      const relevance = this.personalRelevance.forFocus([...(input.memoryFocus ?? [input.message]), item.title]);
      const memoryMarker = '本次请求的现行个人记忆（背景资料，不是执行许可）：\n';
      const personalContext: Processor & { processLLMRequest: NonNullable<Processor['processLLMRequest']> } = { id: 'rae-personal-context', processLLMRequest: async ({ prompt }) => {
        const facts = await this.selectPersonalContext(item.id, input.memoryConversationId, isolatedSourceReview ? 'observation' : 'conversation', relevance, signal);
        facts.corrections = this.personalCorrections ? await this.personalCorrections(item.id) : input.memoryCorrections ?? [];
        if (isolatedSourceReview && this.ownerObservations) facts.recentOwnerMessages = await this.ownerObservations.recentOwnerContext(item.id);
        signal.throwIfAborted(); input.onMemoryContext?.(facts);
        const retained = prompt.filter(message => message.role !== 'system' || !message.content.startsWith(memoryMarker));
        const position = retained.findIndex(message => message.role !== 'system');
        retained.splice(position < 0 ? retained.length : position, 0,
          { role: 'system' as const, content: memoryMarker + JSON.stringify(facts)
            + '\nidentities和interactionPolicies是适用于当前范围的本人身份与交流要求，ownerFacts是其他本人理解，methods是代理方法；hypothesis仍待核对。corrections是刚读取的现行更正：retracted表示已撤回，out_of_scope表示不适用于当前场景，不能用旧聊天恢复。recentOwnerMessages是当前场景核验过的近期本人原话背景；其中的历史请求不是本轮执行许可，助手承诺不包含在内。结合当前有效版本理解交流要求，不因尚未形成长期记忆就忽略本人刚说过的话。缺失的偏好称呼不表示身份未知。completeness不完整时不能把未选中的事实说成不存在。' });
        return { prompt: retained };
      } };
      const observationTurn = this.memory.createTurn(item.id);
      const observeOwnerConversation = !execution && input.observeOwnerConversation === true;
      const agentFor = (tools: ToolsInput | undefined, continuation: boolean) => new Agent({ id: execution ? threadId : `case-${item.id}`, name: item.title,
        model: withLocalImageReferences(trackedModel('actor')), mastra: this.mastra, maxRetries: 0,
        ...(!isolatedSourceReview ? { memory: this.memory } : {}),
        instructions: input.instructions, tools, inputProcessors: [
          personalContext,
          createTimeContextProcessor(input.temporal ?? { timezone: () => 'Asia/Shanghai' }),
          ...(!isolatedSourceReview ? [this.memory.actorContext(item.id, observeOwnerConversation, observationTurn)] : []),
          ...(input.evidenceAllowed || this.sourceEvidenceFilter || this.connectorEvidenceFilter
            ? [caseSourceContext(item.id, input.evidenceAllowed ?? this.sourceEvidenceFilter, this.connectorEvidenceFilter, continuation)] : []),
          caseImageContext(item.id, this.resolveImage)],
        // A failed vision request must remain a failure, never a successful
        // text-only retry with the owner's image silently removed.
        errorProcessorDefaults: false,
        errorProcessors: defaultStabilityErrorProcessors().filter(processor => processor.id !== 'unsupported-file-handler') });
      const message = input.attachments?.length ? [{ role: 'user' as const, content: [
        { type: 'text' as const, text: input.message },
        ...input.attachments.map(attachment => ({ type: 'image' as const, image: imageReference(attachment.id), mediaType: attachment.mediaType })),
      ] }] : input.message;
      const controller = new AbortController();
      const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
      const budget = input.maxSteps === undefined ? defaultCaseMaxSteps : input.maxSteps;
      const auxiliaryBudget = budget === null ? input.auxiliaryMaxSteps ?? defaultCaseMaxSteps - 1 : budget - 1;
      const continuationLimit = isolatedSourceReview ? 0 : Math.min(1, Math.max(0, input.maxOutputContinuations ?? 0));
      let steps = 0; let continuations = 0; let text = ''; let finishReason: string | undefined;
      const usage = { inputTokens: 0, outputTokens: 0 };
      let modelCalls = 0; let memoryCalls = 0;
      let stalled = false;
      let checkedSteps = 0;
      const recentToolSteps: string[] = [];
      const stopUncappedRun = ({ steps: completed }: { steps: ReadonlyArray<{ content: readonly unknown[] }> }) => {
        if (input.stopAfterStep?.() || stalled) return true;
        if (completed.length <= checkedSteps) return false;
        checkedSteps = completed.length;
        const fingerprint = completedToolStepFingerprint(completed.at(-1)!.content);
        if (fingerprint === undefined) { recentToolSteps.length = 0; return false; }
        recentToolSteps.push(fingerprint);
        if (recentToolSteps.length > 6) recentToolSteps.shift();
        // Stop after three identical tool steps or three repeats of a two-step cycle.
        stalled = [1, 2].some(period => {
          const window = recentToolSteps.slice(-period * 3);
          return window.length === period * 3 && window.every((step, index) => step === window[index % period]);
        });
        return stalled;
      };
      const auxiliaryLimit = new Error('本轮记忆处理已达到共同上限，保留一次本人回复。');
      const pendingModels = new Set<Promise<unknown>>();
      const trackedModel = (role: 'actor' | 'observer' | 'reflector'): LanguageModelV4 => new Proxy(input.model, { get(target, key) {
        if (key === 'doGenerate' || key === 'doStream') return (parameters: Parameters<LanguageModelV4['doGenerate']>[0]) => {
          signal.throwIfAborted();
          if (role !== 'actor' && memoryCalls >= auxiliaryBudget) {
            throw auxiliaryLimit;
          }
          if (budget !== null && modelCalls >= budget) throw new Error('本轮记忆和回复已达到共同模型调用上限。');
          modelCalls++;
          if (role !== 'actor') { memoryCalls++; input.onMemoryCall?.(); }
          const args = { ...parameters, abortSignal: parameters.abortSignal ? AbortSignal.any([signal, parameters.abortSignal]) : signal,
            prompt: role === 'actor'
              ? withChatFileContext(parameters.prompt, input.chatFiles ?? [])
              : withTimeContext(parameters.prompt, input.temporal ?? { timezone: () => 'Asia/Shanghai' }, role),
            ...(role === 'actor' ? {} : { providerOptions: input.providerOptions }),
            ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }) };
          progress(role === 'actor' ? 'model' : 'preparing');
          const operation: Promise<unknown> = Promise.resolve(key === 'doGenerate' ? target.doGenerate(args) : target.doStream(args) as PromiseLike<unknown>);
          pendingModels.add(operation);
          void operation.finally(() => pendingModels.delete(operation)).catch(() => undefined);
          return operation;
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      try {
        if (observeOwnerConversation && !isolatedSourceReview) {
          await this.memory.prepareObservations(item.id, signal, observationTurn);
          if (auxiliaryBudget >= 2) {
            const context = new RequestContext();
            context.set(observationModelKey, { observer: trackedModel('observer'), reflector: trackedModel('reflector') });
            try { await this.memory.observeCase(item.id, context, signal, observationTurn); }
            catch (error) {
              // The native Reflector may refine compression more than once. Admission stops it before dispatch,
              // preserving the remaining reply slot and any observations already committed by the SDK.
              if (!causedBy(error, auxiliaryLimit)) throw error;
              signal.throwIfAborted();
            }
            await this.memory.settled({ threadId: item.id, resourceId: this.ownerId });
          }
        }
        do {
          signal.throwIfAborted();
          const continuation = continuations > 0;
          const output = await agentFor(continuation ? {} : input.tools, continuation).stream(continuation
            ? '继续补完上一轮被截断的公开回复，只写尚未输出的后续正文，不重复已有正文。已保存的操作保持原样；本次没有操作工具，不能执行或声称新增任何安排、文件或交付。'
            : message, {
            ...(!isolatedSourceReview ? { memory: { thread: threadId, resource: this.ownerId,
              options: { observationalMemory: false } }, savePerStep: true } : {}),
            instructions: `${input.instructions}\n\n当前事项：${JSON.stringify({ id: item.id, title: item.title, objective: this.sceneBackground ? await this.sceneBackground(item) : item.objective, domain: item.domain })}`
              + (execution ? `\n当前任务上下文：${JSON.stringify(execution)}。此处历史仅属于这项任务的要求版本，不是本人新指令或执行许可；当前任务要求与授权以本轮提供的有效记录为准。` : ''),
            ...(continuation ? { maxSteps: 1 } : budget === null ? { stopWhen: stopUncappedRun } : {
              maxSteps: budget - memoryCalls - steps, stopWhen: input.stopAfterStep,
            }),
            ...(!continuation && budget !== null && budget >= 2 && input.finalTools ? {
              prepareStep: ({ stepNumber }) => {
                if (stepNumber === budget - memoryCalls - 1) return { activeTools: input.finalTools, toolChoice: 'auto' as const };
              },
            } : {}),
            context: input.context,
            ...(input.maxOutputTokens === undefined ? {} : { modelSettings: { maxOutputTokens: input.maxOutputTokens } }),
            ...(continuation ? { activeTools: [], toolChoice: 'none' as const } : {}),
            onStepFinish: async step => { steps++; await input.onStepFinish?.(step); },
            abortSignal: signal, providerOptions: input.providerOptions,
          });
          const reader = output.fullStream.getReader();
          let segmentText = '';
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              signal.throwIfAborted();
              if (chunk.value.type === 'text-delta') {
                const delta = chunk.value.payload.text;
                if (delta) progress('reply');
                segmentText += delta; text += delta;
                await input.onText?.(delta);
              } else if (chunk.value.type === 'error') {
                throw chunk.value.payload.error ?? new Error('模型流式响应失败。');
              }
            }
          } catch (error) {
            controller.abort(error);
            await reader.cancel(error).catch(() => undefined);
            // fullStream is a subscriber, not the native execution owner.
            // Cancelling it alone leaves output processors writing after close.
            await output.consumeStream().catch(() => undefined);
            throw error;
          } finally { reader.releaseLock(); }
          const result = await output.getFullOutput();
          await this.memory.settled({ threadId, resourceId: this.ownerId });
          if (result.error) throw result.error;
          signal.throwIfAborted();
          finishReason = result.finishReason;
          usage.inputTokens += result.totalUsage.inputTokens ?? 0;
          usage.outputTokens += result.totalUsage.outputTokens ?? 0;
          const budgetUsed = budget !== null && modelCalls >= budget;
          if (stalled || input.stopAfterStep?.() || finishReason !== 'length' || !segmentText.trim()
            || budgetUsed || continuations >= continuationLimit) break;
          continuations++; await input.onOutputContinuation?.();
        } while (true);
        return { text, threadId, finishReason, steps: steps + memoryCalls, continuations, stalled, usage };
      } catch (error) {
        if (!input.signal?.aborted) logCaseFailure(item.id, error);
        throw error;
      } finally {
        await Promise.allSettled([...pendingModels]);
        await this.memory.settled({ threadId, resourceId: this.ownerId });
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    return this.closeOperation = (async () => {
      await Promise.all([...this.caseRuns.values(), ...this.taskRuns.values()].map(queue => queue.onIdle()));
      await Promise.all([...this.caseWrites.values()].map(queue => queue.onIdle()));
      await this.sharedWrites.onIdle(); await this.memory.settled();
      try { await this.mastra.shutdown(); }
      finally { try { await this.storage.close(); } finally { try { await this.vector.close(); } finally { this.personalStore.close(); this.closed = true; } } }
    })();
  }
}
