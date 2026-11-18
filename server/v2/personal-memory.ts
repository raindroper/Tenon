import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EventInbox, InboxEvent } from './events.js';
import { CaseMemory, type CaseRecord, type SharedFact } from './memory.js';
import type { RetiredObservationEvidence } from './observation-context.js';
import type { SourceRegistry } from './sources.js';
import type { CorrectPersonalMemoryInput, LearnMethodMemoryInput, LearnPersonalMemoryInput, PersonalMemoryCorrectionNotice, PersonalMemoryEntry, PersonalMemoryEvidence,
  PersonalMemoryLearnResult, PersonalMemoryRating, PersonalMemoryRetirement, PersonalMemoryScope, PersonalMemorySubject, PersonalMemoryVersion,
  RetiredMemoryScope, TaskOutcomeEvidence } from '../../shared/personal-memory.js';
import type { PersonalMemoryContext, PersonalMemoryMutationContext, PersonalMemoryMutationSource, PersonalMemoryOwnerDependencies, PersonalMemoryPage } from '../../shared/personal-memory.js';
import { taskOutcomeEvidenceSchema } from '../../shared/personal-memory.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const kindSchema = z.enum(['fact', 'preference', 'habit', 'experience']);
const scopeSchema = z.enum(['case', 'domain', 'global']);
const purposeSchema = z.enum(['identity', 'interaction', 'context']);
const identitySchema = z.object({ kind: z.enum(['name', 'alias']), value: text(200), platform: text(100).optional(), conversationId: text(300).optional() }).strict();
const expectedRevision = z.number().int().min(0).safe().optional();
const learnSchema = z.object({ key: text(200), value: text(2000), evidenceExcerpt: text(2000), kind: kindSchema.optional(),
  scope: scopeSchema.optional(), mode: z.enum(['observe', 'correction']).optional(), expiresAt: z.string().datetime({ offset: true }).optional(),
  interpretation: z.enum(['assertion', 'inference']).optional(), purpose: purposeSchema.optional(), identity: identitySchema.optional(), expectedRevision }).strict();
const methodSchema = learnSchema.omit({ kind: true }).extend({ scope: z.enum(['case', 'domain']).optional() });
const ratingSourceSchema = z.object({ verdict: z.enum(['useful', 'off_target', 'correction', 'not_now']), targetType: z.enum(['message', 'artifact', 'case']),
  targetId: z.string().min(1).max(300).refine(value => value === value.trim()), targetContent: z.string().min(1).max(10000) });
const correctionSchema = z.object({ subject: z.enum(['owner', 'agent']).optional(), value: text(2000), kind: kindSchema.optional(), scope: scopeSchema.optional(),
  domains: z.array(text(100)).min(1).max(20).optional(), caseIds: z.array(text(200)).max(30).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(), purpose: purposeSchema.optional(), identity: identitySchema.optional(), expectedRevision }).strict();
const excerptHash = (excerpt: string) => createHash('sha256').update(excerpt).digest('hex');

function retirementScope(version: PersonalMemoryVersion): RetiredMemoryScope {
  return { domains: [...version.domains].sort(), ...(version.scope === 'case' ? { caseIds: [...version.caseIds].sort() } : {}) };
}

function scopeApplies(scope: RetiredMemoryScope, item: CaseRecord): boolean {
  return (scope.domains.includes('*') || scope.domains.includes(item.domain)) && (!scope.caseIds || scope.caseIds.includes(item.id));
}

function coversScope(next: RetiredMemoryScope, previous: RetiredMemoryScope): boolean {
  return (next.domains.includes('*') || previous.domains.every(domain => next.domains.includes(domain)))
    && (!next.caseIds || !!previous.caseIds?.every(id => next.caseIds!.includes(id)));
}
export interface PersonalMemoryOptions {
  memory: CaseMemory; inbox: Pick<EventInbox, 'get'>;
  sources: Pick<SourceRegistry, 'isEventAllowed' | 'resolveEventCase'>;
  /** Read-only evidence resolution against the original approved task and real result records. */
  resolveTaskOutcome?: (event: InboxEvent) => TaskOutcomeEvidence | undefined;
  ownerMessageMatches?: (event: InboxEvent) => boolean;
}

/** Single policy writer over the application ledger; Mastra still owns scene history and OM. */
export class PersonalMemory {
  constructor(private readonly options: PersonalMemoryOptions) {
    options.memory.setPersonalEvidenceFilter(fact => this.decorate(this.entry(fact)).effectiveStatus === 'active');
    options.memory.setPersonalCorrectionsResolver(caseId => this.correctionsForCase(caseId));
  }
  private entry(fact: SharedFact): PersonalMemoryEntry {
    const { personal, ...base } = fact;
    const { retirements: _retirements, ...visible } = personal ?? {};
    return { ...base, subject: 'owner', kind: 'fact', level: 'explicit', scope: fact.domains.includes('*') ? 'global' : 'domain',
      caseIds: [], evidence: [], status: 'active', origin: 'legacy', validFrom: fact.updatedAt, expiresAt: null,
      revision: 1, supersedes: null, history: [], ...visible, effectiveStatus: 'active' };
  }
  private fact(entry: PersonalMemoryEntry, previous: SharedFact | undefined): SharedFact {
    const { key, value, domains, evidenceIds, createdAt, updatedAt, effectiveStatus: _effective, ...personal } = entry;
    const retirements = previous ? this.retirements(previous, entry) : [];
    return { key, value, domains, evidenceIds, createdAt, updatedAt,
      personal: { ...personal, ...(retirements.length ? { retirements } : {}) } };
  }

  /** Older cores can be read without writes. Save their recoverable evidence before the next history trim. */
  private retirements(fact: SharedFact, next?: PersonalMemoryVersion): PersonalMemoryRetirement[] {
    const stored = fact.personal?.retirements;
    if (!next && stored) return stored;
    const entry = this.entry(fact);
    const versions = [...entry.history, entry];
    const retained = new Map<string, PersonalMemoryRetirement>();
    const add = (basis: PersonalMemoryRetirement) => { retained.set(JSON.stringify(basis), basis); };
    for (const basis of stored ?? []) add(basis);
    for (const [index, previous] of versions.entries()) {
      if (previous.status !== 'active') continue;
      const scope = retirementScope(previous);
      const decisions = stored && next ? [next] : [...versions.slice(index + 1), ...(next ? [next] : [])];
      for (const decision of decisions) {
        if (decision.status !== 'retracted' && decision.level !== 'explicit') continue;
        const except = decision.status === 'retracted' || decision.value !== previous.value ? undefined : retirementScope(decision);
        if (except && coversScope(except, scope)) continue;
        if (previous.evidence.length) {
          for (const evidence of previous.evidence) add({ type: 'event', eventId: evidence.eventId, caseId: evidence.caseId,
            excerptHash: excerptHash(evidence.excerpt), ownerChat: evidence.actor === 'owner' && evidence.kind === 'owner.message' && evidence.sourceId === 'owner-chat',
            ...(except ? { except } : {}) });
        } else add({ type: 'literal', value: previous.value, scope, ...(except ? { except } : {}) });
        if (!except) break;
      }
    }
    return [...retained.values()];
  }
  private snapshot(entry: PersonalMemoryEntry): PersonalMemoryVersion {
    const { key: _key, createdAt: _created, supersedes: _supersedes, history: _history, effectiveStatus: _effective, ...version } = entry;
    return version;
  }
  private next(existing: PersonalMemoryEntry | undefined, update: Omit<PersonalMemoryEntry, 'revision' | 'supersedes' | 'createdAt' | 'updatedAt' | 'history' | 'effectiveStatus'>): PersonalMemoryEntry {
    const date = new Date().toISOString();
    return this.decorate({ ...update, revision: (existing?.revision ?? 0) + 1, supersedes: existing?.revision ?? null,
      createdAt: existing?.createdAt ?? date, updatedAt: date, history: existing ? [...existing.history, this.snapshot(existing)].slice(-8) : [], effectiveStatus: 'active' });
  }
  private ownerTeaching(event: InboxEvent): boolean { return event.actor === 'owner' && ['owner.message', 'owner.feedback'].includes(event.kind); }
  private mutationSource(context: PersonalMemoryMutationContext | undefined, operation: { action: 'correct' | 'retract' | 'restore'; key: string }): PersonalMemoryMutationSource {
    const source = context?.source ?? { kind: 'legacy' as const };
    if (source.kind === 'owner-message') {
      const event = this.event(source.caseId, source.eventId, source.excerpt);
      if (event.kind !== 'owner.message' || event.sourceId !== 'owner-chat' || this.options.ownerMessageMatches?.(event) === false
        || createHash('sha256').update(String(event.payload.content)).digest('hex') !== source.contentHash
        || source.messageId !== undefined && source.messageId !== event.externalId) throw new Error('本人记忆变更的消息来源无法核对。');
    } else if (source.kind === 'owner-command') {
      const event = this.options.inbox.get(source.commandId);
      if (!event || event.actor !== 'owner' || event.kind !== 'owner.memory' || event.sourceId !== 'owner-memory'
        || event.receivedAt !== source.acceptedAt || event.payload.action !== operation.action || String(event.payload.key).trim() !== operation.key) throw new Error('本人记忆变更缺少匹配目标的真实产品操作记录。');
    }
    return structuredClone(source);
  }
  private rating(event: InboxEvent, excerpt: string, subject: PersonalMemorySubject): PersonalMemoryRating | undefined {
    if (subject !== 'agent' || event.actor !== 'owner' || event.kind !== 'owner.feedback') return undefined;
    // Actual owner comment takes precedence. Target text is a distinct, weaker source.
    if (typeof event.payload.comment === 'string' && event.payload.comment.includes(excerpt)) return undefined;
    const parsed = ratingSourceSchema.safeParse(event.payload);
    if (!parsed.success || !parsed.data.targetContent.includes(excerpt)) return undefined;
    const target = parsed.data;
    if (target.targetType === 'case' && target.targetId !== event.caseId) return undefined;
    if (event.payload.caseId !== undefined && event.payload.caseId !== event.caseId) return undefined;
    return { verdict: target.verdict, targetType: target.targetType, targetId: target.targetId,
      targetContentHash: createHash('sha256').update(target.targetContent).digest('hex') };
  }
  private event(caseId: string, eventId: string, excerpt: string, subject: PersonalMemorySubject = 'owner'): InboxEvent {
    const event = this.options.inbox.get(eventId);
    const taskOutcome = event && subject === 'agent' ? this.taskOutcome(event) : undefined;
    const methodDocument = event && subject === 'agent'
      && (event.actor === 'external' && ['workspace.file', 'connector.change'].includes(event.kind)
        || event.actor === 'owner' && event.kind === 'owner.source');
    if (!event || !this.ownerTeaching(event) && !methodDocument && !(event.kind === 'task.outcome' && taskOutcome)) throw new Error(subject === 'owner'
      ? '个人理解只能基于真实本人消息或反馈，不能把外部文件或代理输出当作本人偏好。'
      : '代理方法须引用本人教导或当前授权资料；模型输出、草稿和自述成功不构成独立验证证据。');
    if (event.kind === 'owner.message' && (event.sourceId !== 'owner-chat' || this.options.ownerMessageMatches?.(event) === false)) throw new Error('本人消息来源无法核对。');
    if (subject === 'agent' && event.payload.taskOutcome !== undefined && !taskOutcome) throw new Error('反馈关联的任务结果依据无效，未将其作为方法证据。');
    if (event.caseId !== caseId || this.options.sources.resolveEventCase(event) !== caseId || !this.options.sources.isEventAllowed(event)) throw new Error('证据不属于当前事项或来源已失效。');
    const body = event.kind === 'owner.feedback' ? event.payload.comment : event.payload.content;
    if ((typeof body !== 'string' || !body.includes(excerpt)) && !this.rating(event, excerpt, subject)) throw new Error('证据必须逐字来自获授权的原始事件。');
    return event;
  }
  private taskOutcome(event: InboxEvent): TaskOutcomeEvidence | undefined {
    const resolved = this.options.resolveTaskOutcome?.(event);
    const parsed = taskOutcomeEvidenceSchema.safeParse(resolved);
    return parsed.success && parsed.data.caseId === event.caseId ? parsed.data : undefined;
  }
  private evidence(event: InboxEvent, excerpt: string, subject: PersonalMemorySubject): PersonalMemoryEvidence {
    const rating = this.rating(event, excerpt, subject);
    const taskOutcome = subject === 'agent' ? this.taskOutcome(event) : undefined;
    return { eventId: event.id, excerpt, actor: event.actor, kind: event.kind, sourceId: event.sourceId,
      ...(event.sourceGeneration ? { sourceGeneration: event.sourceGeneration } : {}), caseId: event.caseId!, occurredAt: event.occurredAt, receivedAt: event.receivedAt,
      ...(rating ? { rating } : {}), ...(taskOutcome ? { taskOutcome } : {}) };
  }
  private evidenceValid(evidence: PersonalMemoryEvidence, subject: PersonalMemorySubject): boolean {
    try {
      const event = this.event(evidence.caseId, evidence.eventId, evidence.excerpt, subject);
      const rating = this.rating(event, evidence.excerpt, subject); const recorded = evidence.rating;
      const sameRating = !rating && !recorded || rating && recorded && rating.verdict === recorded.verdict && rating.targetId === recorded.targetId
        && rating.targetType === recorded.targetType && rating.targetContentHash === recorded.targetContentHash;
      const currentOutcome = subject === 'agent' ? this.taskOutcome(event) : undefined;
      return Boolean(sameRating && isDeepStrictEqual(currentOutcome, evidence.taskOutcome)
        && event.sourceId === evidence.sourceId && event.sourceGeneration === evidence.sourceGeneration && event.kind === evidence.kind && event.actor === evidence.actor);
    } catch { return false; }
  }
  private decorate(entry: PersonalMemoryEntry): PersonalMemoryEntry {
    const timestamp = Date.now();
    const effectiveStatus = entry.status === 'retracted' ? 'retracted'
      : Date.parse(entry.validFrom) > timestamp || entry.expiresAt !== null && Date.parse(entry.expiresAt) <= timestamp ? 'expired'
      : entry.origin === 'learned' && !entry.evidence.some(evidence => this.evidenceValid(evidence, entry.subject)) ? 'evidence_unavailable' : 'active';
    return { ...entry, effectiveStatus };
  }
  private applicable(entry: PersonalMemoryVersion, item: CaseRecord): boolean {
    return (entry.domains.includes('*') || entry.domains.includes(item.domain)) && (entry.scope !== 'case' || entry.caseIds.includes(item.id));
  }
  private actorView(entry: PersonalMemoryEntry): PersonalMemoryEntry { return { ...entry, evidence: [], history: [] }; }
  async list(): Promise<PersonalMemoryEntry[]> {
    return (await this.options.memory.listSharedFacts()).map(fact => this.decorate(this.entry(fact))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async page(options: { offset?: number; limit?: number; subject?: PersonalMemorySubject } = {}): Promise<PersonalMemoryPage> {
    const { facts, ...page } = await this.options.memory.sharedFactPage(options.offset ?? 0, options.limit ?? 50, options.subject);
    return { ...page, entries: facts.map(fact => this.decorate(this.entry(fact))) };
  }
  async forCase(caseId: string): Promise<PersonalMemoryEntry[]> {
    const item = await this.options.memory.getCase(caseId); if (!item) throw new Error('事项不存在或不属于当前用户。');
    return (await this.list()).filter(entry => entry.effectiveStatus === 'active' && this.applicable(entry, item)).map(entry => this.actorView(entry));
  }
  contextFor(caseId: string, conversationId?: string, purpose: 'conversation' | 'observation' = 'conversation',
    focus?: readonly string[], signal?: AbortSignal): Promise<PersonalMemoryContext> {
    return this.options.memory.contextForCase(caseId, conversationId, purpose, focus, signal);
  }
  async readForCase(caseId: string, key: string, conversationId?: string): Promise<PersonalMemoryEntry | undefined> {
    const item = await this.options.memory.getCase(caseId); if (!item) throw new Error('事项不存在。');
    const fact = this.options.memory.listSharedFactsSync().find(value => value.key === key);
    if (!fact) return undefined;
    const entry = this.decorate(this.entry(fact));
    if (entry.effectiveStatus !== 'active' || !this.applicable(entry, item)
      || conversationId && entry.identity?.conversationId && conversationId !== entry.identity.conversationId) return undefined;
    return this.actorView(entry);
  }
  private ownerFingerprint(caseId: string, domain: string): string {
    const records = this.options.memory.listSharedFactsSync().map(fact => this.decorate(this.entry(fact)))
      .filter(entry => entry.subject === 'owner' && this.applicable(entry, { id: caseId, domain } as CaseRecord))
      .map(entry => [entry.key, entry.revision, entry.effectiveStatus, entry.scope, entry.domains, entry.caseIds,
        entry.evidence.map(evidence => [evidence.eventId, evidence.sourceId, evidence.sourceGeneration])]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return createHash('sha256').update(JSON.stringify(records)).digest('hex');
  }
  async ownerDependenciesForCase(caseId: string): Promise<PersonalMemoryOwnerDependencies> {
    const item = await this.options.memory.getCase(caseId); if (!item) throw new Error('事项不存在。');
    return { caseId, domain: item.domain, fingerprint: this.ownerFingerprint(caseId, item.domain) };
  }
  assertOwnerDependencies(snapshot: PersonalMemoryOwnerDependencies): void {
    if (this.ownerFingerprint(snapshot.caseId, snapshot.domain) !== snapshot.fingerprint) throw new Error('本人身份或交流要求已变化，旧回顾决定不能继续公开。');
  }
  async correctionsForCase(caseId: string): Promise<PersonalMemoryCorrectionNotice[]> {
    const item = await this.options.memory.getCase(caseId); if (!item) throw new Error('事项不存在或不属于当前用户。');
    const notices: PersonalMemoryCorrectionNotice[] = [];
    for (const entry of await this.list()) {
      const { key, subject, revision, updatedAt, value } = entry;
      const notice = { key, subject, revision, updatedAt };
      const previous = entry.history.filter(version => version.status === 'active' && this.applicable(version, item));
      if (!this.applicable(entry, item)) {
        if (previous.length) notices.push({ ...notice, status: 'out_of_scope' });
      } else if (entry.effectiveStatus === 'retracted') {
        notices.push({ ...notice, status: 'retracted' });
      } else if (entry.effectiveStatus === 'active' && entry.level === 'explicit' && previous.some(version => version.value !== value)) {
        notices.push({ ...notice, status: 'active', value });
      }
      if (notices.length === 8) break;
    }
    return notices;
  }
  /** Retired raw evidence for derived observations and recall, without exposing old values as facts. */
  async retiredOwnerEvidence(caseId: string): Promise<RetiredObservationEvidence> {
    const item = await this.options.memory.getCase(caseId); if (!item) throw new Error('事项不存在或不属于当前用户。');
    const eventIds = new Set<string>();
    const values = new Set<string>();
    for (const fact of await this.options.memory.listSharedFacts()) {
      const entry = this.entry(fact);
      for (const basis of this.retirements(fact)) {
        if (basis.except && scopeApplies(basis.except, item)) continue;
        if (basis.type === 'event') {
          if (basis.ownerChat && basis.caseId === caseId) eventIds.add(basis.eventId);
        } else if (scopeApplies(basis.scope, item) && (basis.value !== entry.value || !this.applicable(entry, item)
          || this.decorate(entry).effectiveStatus !== 'active')) values.add(basis.value);
      }
    }
    return { eventIds, values: [...values] };
  }
  async forDirector(): Promise<PersonalMemoryEntry[]> {
    return (await this.list()).filter(entry => entry.effectiveStatus === 'active' && entry.scope !== 'case').map(entry => this.actorView(entry));
  }
  async learn(caseId: string, eventId: string, input: LearnPersonalMemoryInput): Promise<PersonalMemoryLearnResult> {
    return this.learnSubject('owner', caseId, eventId, learnSchema.parse(input));
  }
  async learnMethod(caseId: string, eventId: string, input: LearnMethodMemoryInput): Promise<PersonalMemoryLearnResult> {
    return this.learnSubject('agent', caseId, eventId, { ...methodSchema.parse(input), kind: 'experience' });
  }
  private async learnSubject(subject: PersonalMemorySubject, caseId: string, eventId: string, value: LearnPersonalMemoryInput): Promise<PersonalMemoryLearnResult> {
    const item = await this.options.memory.getCase(caseId);
    if (!item || item.status === 'cancelled') throw new Error('当前事项不可学习。');
    this.event(caseId, eventId, value.evidenceExcerpt, subject);
    return this.options.memory.updateSharedFact(value.key, (saved, facts) => {
      // Revalidate inside the one write queue, after any earlier correction/revocation.
      const event = this.event(caseId, eventId, value.evidenceExcerpt, subject); const existing = saved ? this.decorate(this.entry(saved)) : undefined;
      const blocked = (reason: PersonalMemoryLearnResult['reason']) => ({ fact: saved!, result: { entry: this.actorView(existing!), applied: false, reason } });
      if (existing && existing.subject !== subject) throw new Error('同一记忆键不能混用本人理解和代理方法主体。');
      if (existing && !this.applicable(existing, item)) throw new Error('该记忆键已用于其他范围，请为当前范围使用独立的键。');
      const mode = value.mode ?? 'observe';
      const assertion = subject === 'owner' && value.interpretation === 'assertion';
      const identity = value.identity ?? (existing?.value === value.value ? existing.identity : undefined);
      const purpose = value.purpose ?? (value.identity ? 'identity' : existing?.purpose === 'identity' && !identity ? 'context' : existing?.purpose ?? 'context');
      if (value.interpretation === 'assertion' && !assertion) throw new Error('代理方法不能把抽取声明当作独立验证。');
      if (assertion && (event.kind !== 'owner.message' || event.sourceId !== 'owner-chat')) throw new Error('明确本人陈述必须来自真实本人消息原文。');
      if (value.scope === 'global' && (!assertion || value.purpose !== 'identity' || !value.identity)) throw new Error('全局自动理解仅允许有原文依据的本人明确身份声明。');
      if (subject === 'agent' && (value.identity || value.purpose && value.purpose !== 'context')) throw new Error('代理方法不能占用本人身份或交流要求。');
      if (value.identity && (!value.evidenceExcerpt.includes(value.identity.value) || !value.value.includes(value.identity.value))) throw new Error('身份值必须逐字存在于本人依据和保存的理解中。');
      if (purpose === 'identity' && !identity) throw new Error('身份理解需要明确的姓名或别名属性。');
      if (this.rating(event, value.evidenceExcerpt, subject) && mode === 'correction') throw new Error('被评价的目标文本只支持方法假设，不能冒充本人的明确纠正。');
      if (mode === 'correction' && !this.ownerTeaching(event)) throw new Error('资料片段不能冒充本人的明确方法纠正。');
      if (existing && value.scope && value.scope !== existing.scope) return blocked('scope_conflict');
      if (existing && existing.value === value.value && existing.evidence.some(evidence => evidence.eventId === eventId && evidence.excerpt === value.evidenceExcerpt)) return blocked('duplicate');
      if (mode === 'observe' && existing?.status === 'retracted') return blocked('retracted');
      if (mode === 'observe' && existing && (existing.level === 'explicit' || existing.origin === 'owner')) return blocked('protected_explicit');
      if (existing && Date.parse(event.receivedAt) < Date.parse(existing.validFrom)) return blocked('stale_evidence');
      if (mode === 'correction') {
        if (!existing) throw new Error('自然语言纠正必须指向已有记忆。');
        if (event.kind === 'owner.feedback' && !['correction', 'off_target'].includes(String(event.payload.verdict))) throw new Error('此反馈没有明确纠正信号。');
      }
      // Compare exact retired evidence within the same write queue as owner edits.
      // Other excerpts from the event and newer owner events can still teach.
      const digest = excerptHash(value.evidenceExcerpt);
      const retiredEvidence = facts.some(fact => fact.personal?.subject === subject && this.retirements(fact).some(basis =>
        basis.type === 'event' && basis.caseId === caseId && basis.eventId === eventId && basis.excerptHash === digest
        && (!basis.except || !scopeApplies(basis.except, item))));
      if (retiredEvidence) throw new Error('这段证据关联的记忆已被本人纠正或撤回，请使用新的有效证据。');
      const scope: PersonalMemoryScope = existing?.scope ?? value.scope ?? 'domain';
      if (scope === 'domain' && item.domain === '*') throw new Error('自动学习必须使用具名领域，不能借事项领域通配符扩大共享范围。');
      const latest = this.evidence(event, value.evidenceExcerpt, subject);
      const evidence = mode === 'observe' && existing?.value === value.value
        ? [...existing.evidence.filter(part => part.eventId !== eventId), latest].slice(-8) : [latest];
      const validFrom = new Date(event.receivedAt).toISOString();
      const expiresAt = value.expiresAt ? new Date(value.expiresAt).toISOString() : mode === 'correction' || assertion ? null : new Date(Date.parse(validFrom) + 30 * 86400000).toISOString();
      if (expiresAt && Date.parse(expiresAt) > Date.now() + 366 * 86400000) throw new Error('推断有效期最多一年。');
      const entry = this.next(existing, { subject, key: value.key, value: value.value, kind: subject === 'agent' ? 'experience' : value.kind ?? existing?.kind ?? 'preference',
        purpose, ...(identity ? { identity } : {}),
        ...(event.kind === 'owner.message' ? { mutationSource: { kind: 'owner-message' as const, eventId: event.id, caseId,
          contentHash: createHash('sha256').update(String(event.payload.content)).digest('hex'), excerpt: value.evidenceExcerpt, messageId: event.externalId } } : {}),
        level: mode === 'correction' || assertion ? 'explicit' : 'hypothesis', scope, domains: existing?.domains ?? (scope === 'global' ? ['*'] : [item.domain]), caseIds: scope === 'case' ? existing?.caseIds ?? [caseId] : [],
        evidenceIds: evidence.map(part => part.eventId), evidence, status: 'active', origin: 'learned', validFrom, expiresAt });
      return { fact: this.fact(entry, saved), result: { entry: this.actorView(entry), applied: true, reason: mode === 'correction' ? 'corrected' : 'learned' } };
    }, value.expectedRevision);
  }
  /** Trusted owner API; chat applies a durable owner command after the model turn drains. */
  async correct(key: string, input: CorrectPersonalMemoryInput, mutation?: PersonalMemoryMutationContext): Promise<PersonalMemoryEntry> {
    key = text(200).parse(key); const value = correctionSchema.parse(input);
    const selectedDomains = new Set<string>();
    for (const caseId of value.caseIds ?? []) {
      const item = await this.options.memory.getCase(caseId); if (!item) throw new Error('范围含有不属于当前用户的事项。'); selectedDomains.add(item.domain);
    }
    return this.options.memory.updateSharedFact(key, saved => {
      const mutationSource = this.mutationSource(mutation, { action: 'correct', key });
      const existing = saved ? this.entry(saved) : undefined; const scope = value.scope ?? existing?.scope ?? 'global';
      if (existing && value.subject && value.subject !== existing.subject) throw new Error('已有记忆键不可更换主体。');
      const subject = existing?.subject ?? value.subject ?? 'owner';
      const identity = value.identity ?? (existing?.value === value.value ? existing.identity : undefined);
      const purpose = value.purpose ?? (value.identity ? 'identity' : existing?.purpose === 'identity' && !identity ? 'context' : existing?.purpose ?? 'context');
      if (subject === 'agent' && (value.identity || value.purpose && value.purpose !== 'context')) throw new Error('代理方法不能占用本人身份或交流要求。');
      if (value.identity && !value.value.includes(value.identity.value)) throw new Error('身份值必须存在于保存的理解中。');
      if (purpose === 'identity' && !identity) throw new Error('身份理解需要明确的姓名或别名属性。');
      if (mutationSource.kind === 'owner-message' && value.identity && !mutationSource.excerpt.includes(value.identity.value)) throw new Error('身份值必须逐字来自本人原文。');
      if (subject === 'agent' && value.kind && value.kind !== 'experience') throw new Error('代理方法的条目类型为experience，不是本人偏好。');
      const caseIds = scope === 'case' ? value.caseIds ?? existing?.caseIds ?? [] : [];
      const domains = scope === 'global' ? ['*'] : value.domains ?? (scope === 'case' && selectedDomains.size ? [...selectedDomains] : existing?.domains ?? []);
      if (scope === 'case' && (!caseIds.length || !domains.length) || scope === 'domain' && (!domains.length || domains.includes('*'))) throw new Error('请明确记忆适用的事项或领域。');
      const evidence = mutationSource.kind === 'owner-message' ? [this.evidence(this.options.inbox.get(mutationSource.eventId)!, mutationSource.excerpt, subject)] : [];
      const entry = this.next(existing, { subject, key, value: value.value, kind: subject === 'agent' ? 'experience' : value.kind ?? existing?.kind ?? 'fact', level: 'explicit', scope,
        purpose, ...(identity ? { identity } : {}), mutationSource,
        domains: [...new Set(domains)], caseIds: [...new Set(caseIds)], evidenceIds: evidence.map(part => part.eventId), evidence, status: 'active', origin: 'owner',
        validFrom: new Date().toISOString(), expiresAt: value.expiresAt == null ? null : new Date(value.expiresAt).toISOString() });
      return { fact: this.fact(entry, saved), result: entry };
    }, mutation?.expectedRevision ?? value.expectedRevision);
  }
  async retract(key: string, mutation?: PersonalMemoryMutationContext): Promise<PersonalMemoryEntry> {
    key = text(200).parse(key);
    return this.options.memory.updateSharedFact(key, saved => {
      const mutationSource = this.mutationSource(mutation, { action: 'retract', key });
      if (!saved) throw new Error('记忆不存在。'); const existing = this.entry(saved);
      if (existing.status === 'retracted') return { fact: saved, result: this.decorate(existing) };
      const { revision: _revision, supersedes: _supersedes, createdAt: _created, updatedAt: _updated, history: _history, effectiveStatus: _effective, ...current } = existing;
      const entry = this.next(existing, { ...current, mutationSource, status: 'retracted', origin: 'owner', validFrom: new Date().toISOString() });
      return { fact: this.fact(entry, saved), result: entry };
    }, mutation?.expectedRevision);
  }
  async restore(key: string, revision: number, mutation?: PersonalMemoryMutationContext): Promise<PersonalMemoryEntry> {
    key = text(200).parse(key);
    z.number().int().positive().parse(revision);
    return this.options.memory.updateSharedFact(key, saved => {
      const mutationSource = this.mutationSource(mutation, { action: 'restore', key });
      if (!saved) throw new Error('记忆不存在。'); const existing = this.entry(saved);
      const selected = existing.revision === revision ? this.snapshot(existing) : existing.history.find(version => version.revision === revision);
      if (!selected) throw new Error('该版本不在保留的历史中。');
      if (selected.subject !== existing.subject) throw new Error('不能通过历史恢复更换记忆主体。');
      const { revision: _revision, updatedAt: _updated, ...content } = selected;
      const entry = this.next(existing, { ...content, key, mutationSource, origin: 'owner', evidenceIds: [], evidence: [], validFrom: new Date().toISOString() });
      return { fact: this.fact(entry, saved), result: entry };
    }, mutation?.expectedRevision);
  }
}
