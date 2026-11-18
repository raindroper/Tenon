import { createHash } from 'node:crypto';
import { z } from 'zod';
import { meetingReminderDetailsSchema, meetingReminderSchema, type MeetingReminder } from '../../shared/reminders.js';
import type { TaskSpec, TaskState } from '../../shared/task-consent.js';
import type { WeChatMessageView } from '../../shared/wechat-observation.js';
import type { EventInbox, InboxEvent, StoredEvent } from './events.js';
import { TASK_SOURCE_KINDS } from './task-context.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(text(300)).min(1).max(60);
const materialChangeSchema = z.object({ kind: z.enum(['new', 'answer', 'scope', 'deadline', 'status', 'correction', 'question']),
  fields: z.record(text(100), text(1000)).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16) }).strict();
export const reviewSituationSchema = z.object({
  title: text(200), summary: text(2000), status: z.enum(['watching', 'ready', 'resolved']),
  help: z.object({ description: text(1000), benefit: text(1000) }).strict().optional(),
  unknowns: z.array(text(500)).max(8),
  missingInputs: z.array(text(500)).max(8).optional().describe('开始拟议工作必需、但当前未取得或无权读取的资料。项目目标包含梳理与澄清时，后续实现阶段才需要的未知项放在unknowns，并说明须先解决才能开发。'),
  dueAt: z.string().datetime({ offset: true }).optional(),
  reviewAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ReviewSituation = z.infer<typeof reviewSituationSchema>;
export const ownerRelationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirmed_alias'), evidenceId: text(300), alias: text(200) }).strict(),
  z.object({ kind: z.literal('owner_statement'), evidenceId: text(300), alias: text(200), memoryKey: text(200) }).strict(),
  z.object({ kind: z.literal('owner_participation'), evidenceId: text(300), ownerMemoryKey: text(200).optional() }).strict(),
  z.object({ kind: z.literal('inferred_reply'), questionEventId: text(300), answerEventIds: ids, rationale: text(1500), ownerMemoryKey: text(200).optional() }).strict(),
  z.object({ kind: z.literal('work_dependency'), contextKeys: z.array(text(200)).min(1).max(16), rationale: text(1500) }).strict(),
]);
const visible = { evidenceIds: ids, ownerRelation: ownerRelationSchema, whyOwnerNeedsToKnow: text(1500),
  anchorEventId: text(300).optional(), relatedItemId: text(300).optional(), materialChange: materialChangeSchema,
  situation: reviewSituationSchema.optional(), decisionReason: text(1500).optional() };
const meetingReminderInput = meetingReminderDetailsSchema.extend({ inviteEvidenceId: text(300) }).optional().catch(undefined);
export const reviewDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('silent'), evidenceIds: z.array(text(300)).max(60).default([]), decisionReason: text(1500).optional() }).strict(),
  z.object({ outcome: z.literal('observe'), ...visible, situation: reviewSituationSchema }).strict(),
  z.object({ outcome: z.literal('notify'), ...visible, message: text(4000), reminder: meetingReminderInput }).strict(),
  z.object({ outcome: z.literal('needs_input'), ...visible, message: text(4000) }).strict(),
  z.object({ outcome: z.literal('propose'), ...visible, message: text(4000).optional(),
    situation: reviewSituationSchema.extend({ status: z.literal('ready'), missingInputs: z.array(text(500)).max(8) }),
    proposal: z.object({ title: text(200), objective: text(2000), expectedOutput: text(2000),
      execution: z.enum(['artifact', 'project']).optional(),
      acceptance: z.object({ mode: z.enum(['delivery', 'owner']), criteria: z.array(text(1000)).max(30) }).strict().optional(),
    }).strict() }).strict(),
]);
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;
export function reviewProposalSpec(caseId: string, proposal: { title: string; objective: string; expectedOutput: string;
  execution?: 'artifact' | 'project'; acceptance?: TaskSpec['acceptance'] }): TaskSpec {
  const { execution, ...description } = proposal;
  return { ...description, caseId, capabilities: execution === 'project' ? [] : ['artifact'],
    ...(execution === 'project' ? { projectSelection: { reason: '请确认执行设备、项目工作区及资源范围。' } } : {}) };
}
type RecordedReviewDecisionInput = ReviewDecisionInput
  | (Omit<Extract<ReviewDecisionInput, { outcome: 'propose' }>, 'situation'> & { situation?: ReviewSituation });
export interface ReviewOwnerDependency { key: string; revision: number; valueHash?: string; purpose?: 'identity' | 'interaction_policy' | 'fact'; scope?: { caseId: string; domain: string } }
export interface ReviewAlias { value: string; key: string; revision: number }
export interface ReviewEvidenceSnapshot {
  eventId: string; caseId: string; sourceId: string; sourceGeneration?: string; eventHash: string;
}
export interface ReviewDecisionRecord {
  id: string; reviewEventId: string; caseId: string; runId: string; createdAt: string;
  contextFingerprint: string; revision: number; reassessmentOf?: string;
  input: RecordedReviewDecisionInput; inputHash: string; analyzedEventIds: string[]; evidence: ReviewEvidenceSnapshot[];
  ownerDependencies: ReviewOwnerDependency[]; conversationId: string; itemId?: string; stateHash?: string;
  publication: 'silent' | 'pending' | 'duplicate'; messageId?: string; contentHash?: string; reminder?: MeetingReminder;
}
export interface ReviewAttentionItem {
  id: string; caseId: string; conversationId: string; anchorEventId: string; revision: number;
  decisionId: string; publicationDecisionId: string; stateHash: string; fields: Record<string, string>; evidence: ReviewEvidenceSnapshot[];
  ownerDependencies: ReviewOwnerDependency[]; updatedAt: string;
  situation?: ReviewSituation;
  /** The actual task is resolved through this decision's original publication receipt. */
  proposalDecisionId?: string;
}
export type ReviewAttentionContext = ReviewAttentionItem & {
  contextStatus: 'current' | 'historical_delivered' | 'needs_reassessment';
  contextMeaning?: string;
};
export interface ReviewOutboxRecord {
  decisionId: string; messageId: string; contentHash: string;
  state: 'pending' | 'delivered' | 'invalidated' | 'needs_reassessment';
  receipt?: { messageId?: string; contentHash?: string; taskId?: string; proposalHash?: string };
  reason?: string;
}
export interface ReviewDecisionValidation {
  isAllowed(event: InboxEvent): boolean;
  ownerDependenciesCurrent(dependencies: readonly ReviewOwnerDependency[]): boolean;
  sameConversation?(first: InboxEvent, second: InboxEvent): boolean;
  conversationIdFor?(event: InboxEvent): string | undefined;
  meetingSource?(event: InboxEvent): WeChatMessageView | undefined;
  resolveOwnerAlias?(alias: string, memoryKey: string, event?: InboxEvent): ReviewAlias | undefined;
  /** Verify owner-chat attribution against the original durable public message, not payload identity fields. */
  isOwnerMessage?(event: InboxEvent): boolean;
  proposalTaskState?(taskId: string): TaskState | undefined;
  /** Server-owned persisted run lineage check; no model argument can grant a new passive budget. */
  canReassess?(previous: ReviewDecisionRecord, currentRunId: string): boolean;
}
export interface CommitReviewDecision {
  reviewEvent: StoredEvent; runId: string; input: ReviewDecisionInput; exposedEventIds: readonly string[];
  exposedEvidence?: readonly ReviewEvidenceSnapshot[];
  ownerDependencies: readonly ReviewOwnerDependency[]; ownerAliases?: readonly ReviewAlias[];
  conversationId?: string; exposedItemIds?: readonly string[];
  /** Explicit bounded reassessment within the original run; this option never grants a fresh budget. */
  reassessmentOf?: string;
}
export class ReviewDecisionError extends Error {
  constructor(readonly code: 'invalid_scope' | 'stale_owner_context' | 'source_unavailable' | 'conflict' | 'superseded', message: string) { super(message); this.name = 'ReviewDecisionError'; }
}
export function reviewCanonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, canonical(field)])) : item;
  return JSON.stringify(canonical(value));
}
export const reviewContentHash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : reviewCanonicalJson(value)).digest('hex');
// Text-only decisions retain their original digest across upgrades and recovery.
export const reviewPublicationHash = (content: string, reminder?: MeetingReminder): string =>
  reviewContentHash(reminder ? { content, reminder } : content);

const identity = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function containsAlias(value: string, alias: string): boolean {
  const escaped = escapeRegex(identity(alias));
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(identity(value));
}
function sourcedMeetingTimes(original: string, startsAt: string, endsAt?: string): Pick<MeetingReminder, 'startsAt' | 'endsAt'> | undefined {
  const instant = meetingReminderDetailsSchema.shape.startsAt;
  const startCandidates = new Set<number>();
  let matched: Pick<MeetingReminder, 'startsAt' | 'endsAt'> | undefined;
  const consider = (start: string, end?: string) => {
    if (!instant.safeParse(start).success) return;
    const at = Date.parse(start);
    startCandidates.add(at);
    if (at === Date.parse(startsAt) && (!endsAt || end && instant.safeParse(end).success && Date.parse(end) === Date.parse(endsAt))) {
      matched = { startsAt: start, ...(endsAt ? { endsAt: end } : {}) };
    }
  };
  const iso = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})`;
  const explicitIso = new RegExp(String.raw`(?<!\d)(${iso})(?:[\p{Zs}\t]*[–—~至-][\p{Zs}\t]*(${iso}))?(?![\d:])`, 'gu');
  for (const [, start, end] of original.matchAll(explicitIso)) {
    consider(start, end);
  }
  // Only promote explicit invitation times. Local/relative or otherwise ambiguous text stays in the notice body.
  const localRange = /(?<!\d)(\d{4})[\/.-年](\d{1,2})[\/.-月](\d{1,2})日?[\p{Zs}\t]+(\d{1,2}:\d{2}(?::\d{2})?)(?:[\p{Zs}\t]*[–—~至-][\p{Zs}\t]*(\d{1,2}:\d{2}(?::\d{2})?))?[\p{Zs}\t]*\(?[\p{Zs}\t]*(?:(?:UTC|GMT)[\p{Zs}\t]*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?(?![\w:+-])|(北京时间|中国标准时间))/giu;
  const pad = (value: string) => value.padStart(2, '0');
  for (const [, year, month, day, from, to, sign, offsetHours, offsetMinutes, chinaTime] of original.matchAll(localRange)) {
    const offset = chinaTime ? '+08:00' : sign ? `${sign}${pad(offsetHours)}:${offsetMinutes ?? '00'}` : 'Z';
    const resolve = (clock: string) => {
      const [hour, minute, second = '00'] = clock.split(':');
      return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${second}${offset}`;
    };
    consider(resolve(from), to ? resolve(to) : undefined);
  }
  // One source row may list multiple meetings, with no reliable title-to-time mapping.
  return startCandidates.size === 1 ? matched : undefined;
}

function eventHash(event: InboxEvent): string {
  return reviewContentHash({ id: event.id, caseId: event.caseId, sourceId: event.sourceId, sourceGeneration: event.sourceGeneration,
    kind: event.kind, actor: event.actor, externalId: event.externalId, occurredAt: event.occurredAt, receivedAt: event.receivedAt, payload: event.payload });
}

/** A source review can publish only its immutable, evidence-bound decision. This service never approves or executes tasks. */
export class ReviewDecisions {
  constructor(private readonly inbox: EventInbox) {}
  get(id: string) { return this.inbox.reviewDecision(id); }
  byReviewEvent(id: string) { return this.inbox.reviewDecision(id); }
  pending() { return this.inbox.pendingReviewOutbox(); }
  reassessments() { return this.inbox.reviewReassessments(); }
  attention(caseId: string, conversationId?: string, options?: { query?: string; offset?: number; limit?: number }) {
    return this.inbox.reviewAttentionForCase(caseId, conversationId, options);
  }
  export() { return this.inbox.exportReviewJournal(); }
  capture(eventIds: readonly string[], caseId: string, isAllowed: ReviewDecisionValidation['isAllowed']): ReviewEvidenceSnapshot[] {
    if (eventIds.length > 512) throw new ReviewDecisionError('invalid_scope', '本轮证据引用过多。');
    return [...new Set(eventIds)].map(eventId => {
      const event = this.inbox.get(eventId);
      if (!event || event.caseId !== caseId || !isAllowed(event)) throw new ReviewDecisionError('source_unavailable', '回顾证据不存在、已失效或不属于当前场景。');
      return { eventId, caseId, sourceId: event.sourceId, ...(event.sourceGeneration ? { sourceGeneration: event.sourceGeneration } : {}), eventHash: eventHash(event) };
    });
  }
  private assertEvidence(evidence: readonly ReviewEvidenceSnapshot[], validation: ReviewDecisionValidation): void {
    for (const snapshot of evidence) {
      const event = this.inbox.get(snapshot.eventId);
      if (!event || event.caseId !== snapshot.caseId || event.sourceId !== snapshot.sourceId || event.sourceGeneration !== snapshot.sourceGeneration
        || eventHash(event) !== snapshot.eventHash || !validation.isAllowed(event)) throw new ReviewDecisionError('source_unavailable', '原始回顾证据已撤回、替换或不再可读。');
    }
  }
  private assertCommitted(record: ReviewDecisionRecord): void {
    const committed = this.get(record.id);
    if (!committed || reviewContentHash(committed) !== reviewContentHash(record)) throw new ReviewDecisionError('conflict', '待公开决定与持久记录不一致。');
  }
  /** A past delivery is a fact, not a claim that the old owner interpretation is still current. */
  private assertHistoricalDelivery(record: ReviewDecisionRecord, validation: ReviewDecisionValidation): void {
    this.assertCommitted(record);
    this.assertEvidence(record.evidence, validation);
    const delivery = this.inbox.reviewOutbox(record.id), receipt = delivery?.receipt;
    if (delivery?.state !== 'delivered' || !receipt || record.publication !== 'pending' || record.input.outcome === 'silent' || record.input.outcome === 'observe') {
      throw new ReviewDecisionError('conflict', '没有可核验的历史投递回执。');
    }
    if (record.input.message && (receipt.messageId !== record.messageId || receipt.contentHash !== record.contentHash)
      || record.input.outcome === 'propose' && (!receipt.taskId || receipt.proposalHash !== reviewContentHash(record.input.proposal))) {
      throw new ReviewDecisionError('conflict', '历史投递回执与原决定不符。');
    }
  }
  /** Only source-valid history may supply receipt awareness after owner context changes. New conclusions still need fresh relations. */
  attentionContext(item: ReviewAttentionItem, validation: ReviewDecisionValidation): ReviewAttentionContext {
    const saved = this.inbox.reviewAttention(item.id);
    if (!saved || reviewContentHash(saved) !== reviewContentHash(item)) throw new ReviewDecisionError('conflict', '议题投影与当前持久记录不符。');
    this.assertEvidence(item.evidence, validation);
    const record = this.get(item.decisionId);
    if (!record) throw new ReviewDecisionError('conflict', '议题的原始决定不存在。');
    try { this.assertCurrent(record, validation); return { ...item, contextStatus: 'current' }; }
    catch (error) {
      if (!(error instanceof ReviewDecisionError) || error.code !== 'stale_owner_context') throw error;
      const reassess = (): ReviewAttentionContext => ({ ...item, contextStatus: 'needs_reassessment',
        contextMeaning: '原始证据仍有效，本人背景已更新；这些事项作为待核对线索，关联与帮助价值须按本轮本人要求重新判断。' });
      if (record.input.outcome === 'observe') return reassess();
      const published = this.get(item.publicationDecisionId ?? item.decisionId);
      if (!published || published.stateHash !== item.stateHash) return reassess();
      this.assertHistoricalDelivery(published, validation);
      return { ...item, contextStatus: 'historical_delivered',
        contextMeaning: '这些相同字段已经向本人投递，只用于避免重复打扰；旧身份和交流口径不作为当前判断依据，新关系与信息增量须用本轮有效背景和证据重新核对。' };
    }
  }
  /** Synchronous validation; caller keeps this check and public Store.put in the same lifecycle publication barrier. */
  assertCurrent(record: ReviewDecisionRecord, validation: ReviewDecisionValidation): void {
    this.assertCommitted(record);
    this.assertEvidence(record.evidence, validation);
    if (!validation.ownerDependenciesCurrent(record.ownerDependencies)) throw new ReviewDecisionError('stale_owner_context', '本人身份或通知口径已经改变，需要重新核对原判断。');
    if (record.itemId) {
      const item = this.inbox.reviewAttention(record.itemId);
      if (item && item.decisionId !== record.id && item.stateHash !== record.stateHash) throw new ReviewDecisionError('superseded', '议题已有新的决定，旧通知不再投递。');
    }
  }
  commit(options: CommitReviewDecision, validation: ReviewDecisionValidation): ReviewDecisionRecord {
    const input = reviewDecisionSchema.parse(options.input), review = this.inbox.get(options.reviewEvent.id);
    if (!review || review.caseId !== options.reviewEvent.caseId || review.kind !== 'growth.observation' || !review.caseId
      || !validation.isAllowed(review)) throw new ReviewDecisionError('invalid_scope', '只有当前仍获授权的来源回顾能够提交决定。');
    const ownerDependencies = structuredClone([...options.ownerDependencies]);
    const contextFingerprint = reviewContentHash([...ownerDependencies].sort((a, b) => a.key.localeCompare(b.key)));
    const inputHash = reviewContentHash(input), existing = this.get(review.id);
    if (existing) {
      const existingFingerprint = existing.contextFingerprint ?? reviewContentHash([...existing.ownerDependencies].sort((a, b) => a.key.localeCompare(b.key)));
      if (existingFingerprint === contextFingerprint) {
        if (existing.inputHash !== inputHash) throw new ReviewDecisionError('conflict', '已经提交的回顾决定不可替换。');
        return existing;
      }
      if (options.reassessmentOf !== existing.id || this.inbox.reviewOutbox(existing.id)?.state !== 'needs_reassessment'
        || options.runId !== existing.runId && !validation.canReassess?.(existing, options.runId)) {
        throw new ReviewDecisionError('conflict', '新的本人背景只能在原运行预算内显式复核待重新判断的决定。');
      }
    }
    if (!validation.ownerDependenciesCurrent(ownerDependencies)) throw new ReviewDecisionError('stale_owner_context', '本轮本人背景已更新，旧判断未公开。');
    if (input.outcome !== 'silent' && input.outcome !== 'propose' && input.situation?.status === 'ready') {
      throw new ReviewDecisionError('invalid_scope', '具体帮助已就绪时请用propose保存目标与预期成果，让本人能决定；仍需调研的帮助使用watching并写明未知项。');
    }
    if (input.outcome === 'propose' && input.situation.missingInputs.length) {
      throw new ReviewDecisionError('invalid_scope', '拟做工作仍缺必要资料时先调研或用needs_input询问，并以watching保存事项；取得所需输入后再提出可执行的提案。');
    }
    const reviewAt = input.outcome !== 'silent' ? input.situation?.reviewAt : undefined;
    if (reviewAt && (review.payload.reviewItemId || Date.parse(reviewAt) <= Date.now()
      || Date.parse(reviewAt) > Date.now() + 366 * 86400000)) {
      throw new ReviewDecisionError('invalid_scope', '事项回访须由新信息触发并指定未来一年内的具体时刻；到期回顾不能自行续排。');
    }
    const analyzedEventIds = Array.isArray(review.payload.eventIds) ? review.payload.eventIds.filter((id): id is string => typeof id === 'string') : [];
    const exposed = new Set(options.exposedEventIds);
    if (analyzedEventIds.some(id => !exposed.has(id)) || input.evidenceIds.some(id => !exposed.has(id))) throw new ReviewDecisionError('invalid_scope', '决定只能引用本轮实际暴露的证据，完整批次必须已提供。');
    let evidence = options.exposedEvidence ? [...options.exposedEvidence].map(value => ({ ...value }))
      : this.capture([...options.exposedEventIds], review.caseId, validation.isAllowed);
    if (evidence.length !== exposed.size || evidence.some(value => !exposed.has(value.eventId) || value.caseId !== review.caseId)
      || new Set(evidence.map(value => value.eventId)).size !== exposed.size) throw new ReviewDecisionError('invalid_scope', '原始暴露快照必须精确覆盖本轮所有证据。');
    this.assertEvidence(evidence, validation);
    const id = reviewContentHash(['review-decision', review.id, contextFingerprint]);
    let conversationId = options.conversationId ?? review.sourceId;
    const record: ReviewDecisionRecord = { id, reviewEventId: review.id, caseId: review.caseId, runId: options.runId, createdAt: new Date().toISOString(),
      contextFingerprint, revision: (existing?.revision ?? 0) + 1, ...(existing ? { reassessmentOf: existing.id } : {}),
      input, inputHash, analyzedEventIds, evidence, ownerDependencies, conversationId, publication: 'silent' };
    if (input.outcome === 'silent') { this.inbox.commitReviewDecision(record); return record; }
    if (!input.anchorEventId && !input.relatedItemId) throw new ReviewDecisionError('invalid_scope', '请引用本轮议题锚点或已返回的议题标识。');
    if (input.anchorEventId) {
      if (!exposed.has(input.anchorEventId)) throw new ReviewDecisionError('invalid_scope', '议题锚点未在本轮提供。');
      const anchor = this.inbox.get(input.anchorEventId)!;
      conversationId = validation.conversationIdFor?.(anchor) ?? conversationId;
      record.conversationId = conversationId;
    }
    let previous: ReviewAttentionItem | undefined;
    if (input.relatedItemId) {
      previous = this.inbox.reviewAttention(input.relatedItemId);
      if (!options.exposedItemIds?.includes(input.relatedItemId) || !previous || previous.caseId !== review.caseId) {
        throw new ReviewDecisionError('invalid_scope', '只能接续本轮实际返回的当前授权场景议题。');
      }
      conversationId = previous.conversationId; record.conversationId = conversationId;
      this.assertEvidence(previous.evidence, validation);
      evidence = [...new Map([...previous.evidence, ...evidence].map(value => [value.eventId, value])).values()];
      record.evidence = evidence;
    }
    const anchorEventId = previous?.anchorEventId ?? input.anchorEventId!;
    if (!previous && (!exposed.has(anchorEventId) || !input.evidenceIds.includes(anchorEventId))) throw new ReviewDecisionError('invalid_scope', '新议题锚点必须来自本轮引用的原始证据。');
    const anchor = this.inbox.get(anchorEventId)!;
    const itemId = previous?.id ?? reviewContentHash(['attention', review.caseId, conversationId, anchor.payload.messageId ?? anchor.id]);
    previous ??= this.inbox.reviewAttention(itemId);
    if (previous) {
      this.assertEvidence(previous.evidence, validation);
      evidence = [...new Map([...previous.evidence, ...evidence].map(value => [value.eventId, value])).values()];
      record.evidence = evidence;
    }
    this.assertRelation(input, options, exposed, validation);
    const newInputEvidence = input.evidenceIds.filter(id => {
      const event = this.inbox.get(id);
      return event && TASK_SOURCE_KINDS.has(event.kind);
    });
    const previousMissing = previous?.situation?.missingInputs ?? [];
    const reportedMissing = input.situation?.missingInputs;
    if (reportedMissing && previousMissing.some(requirement => !reportedMissing.includes(requirement))
      && !newInputEvidence.some(id => !previous?.evidence.some(value => value.eventId === id))) {
      throw new ReviewDecisionError('invalid_scope', '事项仍缺已记录的必要资料；清除缺项前请引用新取得的依据。');
    }
    let situation = input.situation ?? previous?.situation;
    if (input.situation && reportedMissing === undefined && previousMissing.length) {
      situation = { ...input.situation, missingInputs: previousMissing };
    }
    const stateHash = reviewContentHash({ outcome: input.outcome, kind: input.materialChange.kind, fields: input.materialChange.fields,
      ...(input.situation ? { situation } : {}), ...(input.outcome === 'propose' ? { proposal: input.proposal } : {}) });
    let duplicate = false;
    let duplicatePublicationId: string | undefined;
    const priorProposalId = previous?.proposalDecisionId ?? previous?.publicationDecisionId;
    const previousProposal = priorProposalId ? this.get(priorProposalId) : undefined;
    let repeatedProposal = false;
    let previouslyDeclined = false;
    if (input.outcome === 'propose' && previousProposal?.input.outcome === 'propose') {
      const earlier = previousProposal.input;
      const taskId = this.inbox.reviewOutbox(previousProposal.id)?.receipt?.taskId;
      const state = taskId ? validation.proposalTaskState?.(taskId) : undefined;
      previouslyDeclined = state === 'rejected' || state === 'revoked';
      const sameScope = input.proposal.objective === earlier.proposal.objective
        && input.proposal.expectedOutput === earlier.proposal.expectedOutput
        && (input.proposal.execution ?? 'artifact') === (earlier.proposal.execution ?? 'artifact')
        && JSON.stringify(input.proposal.acceptance) === JSON.stringify(earlier.proposal.acceptance);
      const changedFacts = reviewContentHash(input.materialChange.fields) !== reviewContentHash(earlier.materialChange.fields)
        && newInputEvidence.some(id => !earlier.evidenceIds.includes(id));
      repeatedProposal = sameScope || previouslyDeclined && !changedFacts;
    }
    if (previous?.stateHash === stateHash || repeatedProposal) {
      const prior = repeatedProposal ? previousProposal : this.get(previous!.publicationDecisionId ?? previous!.decisionId);
      const delivery = prior ? this.inbox.reviewOutbox(prior.id) : undefined;
      if (prior && delivery && (delivery.state === 'pending' || delivery.state === 'delivered')) {
        try {
          if (delivery.state === 'delivered') this.assertHistoricalDelivery(prior, validation);
          else this.assertCurrent(prior, validation);
          duplicate = true; duplicatePublicationId = prior.id;
        } catch { /* A pending stale decision or unavailable original evidence cannot suppress a new valid decision. */ }
      }
    }
    if (duplicate && previouslyDeclined && situation?.reviewAt) {
      const { reviewAt: _reviewAt, ...withoutWake } = situation;
      situation = withoutWake;
    }
    const content = 'message' in input ? input.message ?? '' : '', messageId = reviewContentHash(`review-notification:${id}`);
    const reminder = input.outcome === 'notify' ? this.meetingReminder(input, conversationId, validation) : undefined;
    Object.assign(record, { itemId, stateHash, publication: input.outcome === 'observe' ? 'silent' : duplicate ? 'duplicate' : 'pending',
      ...(input.outcome !== 'observe' ? { messageId, contentHash: reviewPublicationHash(content, reminder), ...(reminder ? { reminder } : {}) } : {}) });
    const item: ReviewAttentionItem = { id: itemId, caseId: record.caseId, conversationId, anchorEventId, revision: (previous?.revision ?? 0) + 1,
      decisionId: id, publicationDecisionId: duplicatePublicationId ?? id,
      stateHash, fields: input.materialChange.fields,
      evidence: [...new Map([...(previous?.evidence ?? []), ...this.capture(input.evidenceIds, record.caseId, validation.isAllowed)].map(value => [value.eventId, value])).values()],
      ownerDependencies, updatedAt: record.createdAt,
      ...(situation ? { situation } : {}),
      ...(input.outcome === 'propose' ? { proposalDecisionId: duplicatePublicationId ?? id }
        : previousProposal?.input.outcome === 'propose' ? { proposalDecisionId: previousProposal.id } : {}) };
    this.inbox.commitReviewDecision(record, item, record.publication === 'pending'
      ? { decisionId: id, messageId, contentHash: record.contentHash!, state: 'pending' } : undefined, previous?.revision ?? 0);
    return record;
  }
  private meetingReminder(input: Extract<ReviewDecisionInput, { outcome: 'notify' }>, conversationId: string,
    validation: ReviewDecisionValidation): MeetingReminder | undefined {
    if (!input.reminder) return undefined;
    const { inviteEvidenceId, meetingNumber, password, ...details } = input.reminder;
    if (!input.evidenceIds.includes(inviteEvidenceId)) return undefined;
    const invite = this.inbox.get(inviteEvidenceId);
    if (!invite || validation.conversationIdFor?.(invite) !== conversationId) return undefined;
    const source = validation.meetingSource?.(invite);
    if (!source) return undefined;
    const original = source.content.normalize('NFKC');
    const compact = (value: string) => value.normalize('NFKC').replace(/\s/gu, '');
    if (!compact(original).includes(compact(details.title))) return undefined;
    const times = sourcedMeetingTimes(original, details.startsAt, details.endsAt);
    if (!times) return undefined;

    const relation = input.ownerRelation;
    const ownerMentioned = (relation.kind === 'confirmed_alias' || relation.kind === 'owner_statement')
      && relation.evidenceId === inviteEvidenceId
      && new RegExp(`(?:^|[^a-z0-9_.+-])@[\\p{Zs}\\t]*${escapeRegex(identity(relation.alias))}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(identity(original));
    const numberDigits = meetingNumber?.replace(/\D/gu, '');
    const numberPresent = numberDigits && numberDigits.length >= 6
      && [...original.matchAll(/(?:会议号(?:码)?|会议\s*ID|Meeting\s*ID)[\p{Zs}\t]*:[\p{Zs}\t]*(\d(?:[\d\p{Zs}\t-]*\d)?)/giu)]
        .some(match => match[1].replace(/\D/gu, '') === numberDigits);
    const passwordPresent = password?.kind === 'none' ? /(?:密码\s*:\s*(?:无|无需|不需要)(?=$|[\s,。;])|无需(?:输入)?(?:会议)?密码)/mu.test(original)
      : password?.kind === 'provided' && new RegExp(`密码\\s*:\\s*${escapeRegex(password.value.normalize('NFKC'))}(?=$|[\\s,。;])`, 'mu').test(original);

    const reminder = meetingReminderSchema.safeParse({ ...details, ...times,
      ...(numberPresent ? { meetingNumber } : {}), ...(passwordPresent ? { password } : {}), ownerMentioned,
      reason: ownerMentioned ? '会议邀请中 @ 了你。' : input.whyOwnerNeedsToKnow,
      source: { ...(source.title ? { conversationTitle: source.title } : {}), ...(source.senderName ? { senderName: source.senderName } : {}),
        ...(source.sentAt ? { sentAt: source.sentAt } : {}) } });
    return reminder.success ? reminder.data : undefined;
  }
  private assertRelation(input: Exclude<ReviewDecisionInput, { outcome: 'silent' }>, options: CommitReviewDecision,
    exposed: ReadonlySet<string>, validation: ReviewDecisionValidation): void {
    const relation = input.ownerRelation, cited = new Set(input.evidenceIds);
    const get = (id: string): StoredEvent => {
      if (!exposed.has(id) || !cited.has(id)) throw new ReviewDecisionError('invalid_scope', '本人关联必须引用本轮已提供的原始证据。');
      const event = this.inbox.get(id); if (!event || event.caseId !== options.reviewEvent.caseId) throw new ReviewDecisionError('invalid_scope', '关联证据不属于当前场景。');
      return event;
    };
    const aliases = (options.ownerAliases ?? []).filter(alias => options.ownerDependencies.some(dep => dep.key === alias.key && dep.revision === alias.revision));
    const resolve = (value: string, memoryKey?: string, event?: InboxEvent) => {
      if (!identity(value)) return undefined;
      const known = aliases.find(alias => identity(alias.value) === identity(value) && (!memoryKey || alias.key === memoryKey));
      if (known && !validation.resolveOwnerAlias) return known;
      const key = memoryKey ?? known?.key;
      if (!key) return undefined;
      const resolved = validation.resolveOwnerAlias?.(value, key, event);
      return resolved && identity(resolved.value) === identity(value) && options.ownerDependencies.some(dep => dep.key === resolved.key && dep.revision === resolved.revision) ? resolved : undefined;
    };
    const owns = (event: StoredEvent, memoryKey?: string) => event.kind === 'owner.message' || event.sourceId === 'owner-chat'
      ? validation.isOwnerMessage?.(event) === true
      : event.payload.isSelf === true || Boolean(resolve(String(event.payload.senderName ?? ''), memoryKey, event));
    if (relation.kind === 'confirmed_alias' || relation.kind === 'owner_statement') {
      const event = get(relation.evidenceId);
      const sourceAlias = resolve(relation.alias, relation.kind === 'owner_statement' ? relation.memoryKey : undefined, event);
      if (!sourceAlias || !(identity(String(event.payload.senderName ?? '')) === identity(sourceAlias.value) || containsAlias(String(event.payload.content ?? ''), sourceAlias.value))) {
        throw new ReviewDecisionError('invalid_scope', '原文没有本轮有效身份记录对应的称呼。');
      }
    } else if (relation.kind === 'owner_participation') {
      if (!owns(get(relation.evidenceId), relation.ownerMemoryKey)) throw new ReviewDecisionError('invalid_scope', '没有明确方向字段或已确认显示名证明本人参与。');
    } else if (relation.kind === 'inferred_reply') {
      const question = get(relation.questionEventId);
      if (!owns(question, relation.ownerMemoryKey)) throw new ReviewDecisionError('invalid_scope', '推断答复前须核对本人发言。');
      for (const id of relation.answerEventIds) {
        const answer = get(id);
        const same = validation.sameConversation ? validation.sameConversation(question, answer)
          : answer.sourceId === question.sourceId && answer.sourceGeneration === question.sourceGeneration;
        if (id === question.id || !same) {
          throw new ReviewDecisionError('invalid_scope', '答复推断必须来自同一会话的不同消息。');
        }
        if (typeof question.payload.sentAt === 'string' && typeof answer.payload.sentAt === 'string'
          && Date.parse(answer.payload.sentAt) < Date.parse(question.payload.sentAt)) throw new ReviewDecisionError('invalid_scope', '答复的原始发送时间不能早于所引用的问题。');
      }
    } else if (!relation.contextKeys.every(key => options.ownerDependencies.some(dep => dep.key === key && dep.purpose === 'fact'))) {
      throw new ReviewDecisionError('invalid_scope', '工作依赖须绑定本轮适用的本人事实。');
    }
  }
  delivered(id: string, receipt: NonNullable<ReviewOutboxRecord['receipt']>) {
    const record = this.get(id); if (!record || record.publication !== 'pending') throw new ReviewDecisionError('conflict', '没有待投递的决定。');
    if (receipt.messageId !== undefined && (receipt.messageId !== record.messageId || receipt.contentHash !== record.contentHash)) throw new ReviewDecisionError('conflict', '公开消息身份或正文摘要与决定不符。');
    if (record.input.outcome === 'propose' && (!receipt.taskId || receipt.proposalHash !== reviewContentHash(record.input.proposal))) throw new ReviewDecisionError('conflict', '提案回执必须匹配原范围。');
    if (record.input.outcome === 'propose' && record.input.message && !receipt.messageId) throw new ReviewDecisionError('conflict', '提案附带的通知正文也须有实际保存回执。');
    if (record.input.outcome !== 'propose' && !receipt.messageId) throw new ReviewDecisionError('conflict', '通知须有实际保存的消息回执。');
    return this.inbox.transitionReviewOutbox(record.id, 'delivered', receipt);
  }
  invalidate(id: string, reason: 'source_unavailable' | 'stale_owner_context' | 'superseded') {
    return this.inbox.transitionReviewOutbox(id, reason === 'stale_owner_context' ? 'needs_reassessment' : 'invalidated', undefined, reason);
  }
}
