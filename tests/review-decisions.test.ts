import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EventInbox, type StoredEvent } from '../server/v2/events.js';
import { TaskConsent } from '../server/v2/consent.js';
import { ReviewDecisions, ReviewDecisionError, reviewContentHash, reviewDecisionSchema,
  type ReviewDecisionInput, type ReviewOwnerDependency } from '../server/v2/review-decisions.js';
import { weChatReviewContext } from '../server/v2/review-context.js';

const caseId = 'work', generation = 'grant-one';
function fixture(file = ':memory:') {
  const inbox = new EventInbox(file);
  const decisions = new ReviewDecisions(inbox), revoked = new Set<string>();
  let ownerCurrent = true;
  const dependency: ReviewOwnerDependency = { key: 'identity.chat', revision: 1, purpose: 'identity' };
  const validation = { isAllowed: (event: { sourceGeneration?: string }) => !revoked.has(event.sourceGeneration ?? ''),
    ownerDependenciesCurrent: () => ownerCurrent,
    resolveOwnerAlias: (value: string, key: string) => key === dependency.key && value.toLowerCase() === 'owner_chat'
      ? { value: 'owner_chat', key: dependency.key, revision: dependency.revision } : undefined };
  let sequence = 0;
  const message = (content: string, extra: Record<string, unknown> = {}, selectedGeneration = generation) => inbox.ingestProcessed({
    sourceId: `connector:${selectedGeneration}`, sourceGeneration: selectedGeneration, externalId: `message-${++sequence}`, kind: 'connector.change',
    actor: 'external', operation: 'create', caseId, occurredAt: '2026-11-10T07:59:00.000Z',
    payload: { provider: 'wechat-desktop', title: 'Test group', content, sentAt: '2026-11-10T07:57:00.000Z', ...extra } });
  const review = (messages: StoredEvent[]) => inbox.ingestProcessed({ sourceId: `connector:${generation}`, sourceGeneration: generation,
    externalId: `review-${++sequence}`, kind: 'growth.observation', actor: 'system', operation: 'create', caseId,
    occurredAt: '2026-11-10T08:00:00.000Z', payload: { provider: 'wechat-desktop', eventIds: messages.map(value => value.id) } });
  const notify = (anchor: StoredEvent, overrides: Record<string, unknown> = {}): ReviewDecisionInput => ({ outcome: 'notify', evidenceIds: [anchor.id],
    anchorEventId: anchor.id, ownerRelation: { kind: 'confirmed_alias', evidenceId: anchor.id, alias: 'owner_chat' },
    whyOwnerNeedsToKnow: 'A colleague is asking the owner to decide.', materialChange: { kind: 'new', fields: { issue: 'initial validation', status: 'needs_owner' } },
    message: 'A colleague asks when first-load validation should appear.', ...overrides } as ReviewDecisionInput);
  const commit = (event: StoredEvent, input: ReviewDecisionInput, exposed = input.evidenceIds, extra: Record<string, unknown> = {}) => decisions.commit({
    reviewEvent: event, runId: 'run', input, exposedEventIds: [...new Set([...(event.payload.eventIds as string[]), ...exposed])],
    conversationId: 'conversation-one', ownerDependencies: [dependency], ownerAliases: [{ value: 'owner_chat', key: dependency.key, revision: 1 }], ...extra }, validation);
  return { inbox, decisions, revoked, validation, dependency, message, review, notify, commit, setOwnerCurrent: (value: boolean) => { ownerCurrent = value; } };
}

test('source review has one immutable silent decision and no publication intent', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  assert.equal(reviewDecisionSchema.safeParse({ outcome: 'silent', evidenceIds: [], message: 'No news' }).success, false);
  const source = f.message('Ordinary coordination'), event = f.review([source]);
  const input = { outcome: 'silent' as const, evidenceIds: [] };
  const record = f.commit(event, input);
  assert.equal(record.publication, 'silent'); assert.deepEqual(record.analyzedEventIds, [source.id]);
  assert.deepEqual(f.decisions.pending(), []);
  assert.deepEqual(f.commit(event, input), record);
  assert.deepEqual(f.decisions.byReviewEvent(event.id), record);
  assert.throws(() => f.commit(event, f.notify(source)), /不可替换/);
});

test('a legacy proposal remains linked after an observation update and suppresses the same proposal later', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-legacy-proposal-link-'));
  const file = join(directory, 'events.sqlite');
  const f = fixture(file); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat a review would help');
  const proposal = { title: '整理评审清单', objective: '整理已授权的评审资料', expectedOutput: '带出处的清单' };
  const situation = { title: '评审准备', summary: '已有授权资料。', status: 'ready', unknowns: [], missingInputs: [] };
  const original = f.commit(f.review([source]), f.notify(source, { outcome: 'propose', proposal, situation }));
  f.decisions.delivered(original.id, { taskId: 'original-task', proposalHash: reviewContentHash(proposal),
    messageId: original.messageId, contentHash: original.contentHash });
  const db = new DatabaseSync(file);
  db.prepare("UPDATE review_attention_items SET json=json_remove(json,'$.proposalDecisionId') WHERE id=?").run(original.itemId!);
  db.prepare("UPDATE review_decisions SET json=json_remove(json,'$.input.situation') WHERE id=?").run(original.id);
  db.close();
  const update = f.message('@owner_chat one more fact');
  f.commit(f.review([update]), f.notify(update, { relatedItemId: original.itemId, anchorEventId: undefined,
    materialChange: { kind: 'status', fields: { status: 'still relevant' } } }), [update.id], { exposedItemIds: [original.itemId] });
  assert.equal(f.inbox.reviewAttention(original.itemId!)?.proposalDecisionId, original.id);
  const later = f.message('@owner_chat the same proposed scope');
  const repeated = f.commit(f.review([later]), f.notify(later, { outcome: 'propose', proposal, situation,
    relatedItemId: original.itemId, anchorEventId: undefined }), [later.id], { exposedItemIds: [original.itemId] });
  assert.equal(repeated.publication, 'duplicate');
  assert.equal(f.inbox.reviewAttention(original.itemId!)?.proposalDecisionId, original.id);
});

test('an earlier refusal suppresses renamed or reworded work while new evidence can support a changed scope', t => {
  const f = fixture(), consent = new TaskConsent({ file: ':memory:', inbox: f.inbox });
  t.after(() => { consent.close(); f.inbox.close(); });
  const source = f.message('@owner_chat the original review covers only the sign-in form');
  const originalEvent = f.review([source]);
  const proposal = { title: 'Prepare a checklist', objective: 'Compare the sign-in form rules', expectedOutput: 'A one-page checklist' };
  const situation = { title: 'Review preparation', summary: 'Current form requirements are available.', status: 'ready', unknowns: [], missingInputs: [] };
  const original = f.commit(originalEvent, f.notify(source, { outcome: 'propose', proposal, situation }));
  const task = consent.propose({ ...proposal, capabilities: ['artifact'], caseId }, originalEvent.id);
  f.decisions.delivered(original.id, { taskId: task.id, proposalHash: reviewContentHash(proposal),
    messageId: original.messageId, contentHash: original.contentHash });
  consent.reject(task.id, task.revision);
  const validation = { ...f.validation, proposalTaskState: (id: string) => consent.get(id)?.state };
  const continuation = (evidence: StoredEvent, overrides: Record<string, unknown>) => f.decisions.commit({
    reviewEvent: f.review([evidence]), runId: 'run', exposedEventIds: [evidence.id], exposedItemIds: [original.itemId!],
    ownerDependencies: [f.dependency], ownerAliases: [{ value: 'owner_chat', key: f.dependency.key, revision: 1 }],
    input: f.notify(evidence, { outcome: 'propose', anchorEventId: undefined, relatedItemId: original.itemId, proposal, situation, ...overrides }),
  }, validation);
  const renamed = continuation(source, { proposal: { ...proposal, title: 'Make the form checklist' } });
  assert.equal(renamed.publication, 'duplicate');
  const reconfirmed = f.message('@owner_chat the form rules have been confirmed for tomorrow');
  const reaffirmed = continuation(reconfirmed, {
    proposal: { ...proposal, title: 'Checklist for tomorrow' },
    materialChange: { kind: 'deadline', fields: { date: 'tomorrow' } },
  });
  assert.equal(reaffirmed.publication, 'duplicate');
  const rephrased = continuation(source, {
    proposal: { ...proposal, objective: 'Put sign-in form rules side by side' },
    materialChange: { kind: 'scope', fields: { reworded: 'compare sign-in form rules' } },
    situation: { ...situation, reviewAt: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.equal(rephrased.publication, 'duplicate');
  assert.equal(f.inbox.reviewAttention(original.itemId!)?.proposalDecisionId, original.id);
  assert.equal(f.inbox.scheduledWakes(caseId).length, 0);
  const expanded = f.message('@owner_chat the approved review now also covers the account recovery form');
  const changed = continuation(expanded, {
    proposal: { ...proposal, objective: 'Compare the sign-in and account recovery forms' },
    materialChange: { kind: 'scope', fields: { newForm: 'account recovery' } },
  });
  assert.equal(changed.publication, 'pending');
  assert.equal(f.inbox.reviewAttention(original.itemId!)?.proposalDecisionId, changed.id);
  assert.equal(consent.get(task.id)?.state, 'rejected');
});

test('attention deadlines compare instants across different explicit timezone offsets', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const items: string[] = [];
  for (const [title, dueAt] of [['earlier', '2026-11-12T09:30:00+08:00'], ['later', '2026-11-12T03:00:00Z']]) {
    const source = f.message(`@owner_chat ${title}`);
    const saved = f.commit(f.review([source]), f.notify(source, {
      situation: { title, summary: title, status: 'watching', unknowns: [], dueAt },
    }));
    items.push(saved.itemId!);
  }
  assert.deepEqual(f.decisions.attention(caseId).map(item => item.id), items);
});

test('a concrete ready offer must be a proposal and missing essential inputs keep it in research', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat the assessment requires an unread attachment'), review = f.review([source]);
  const situation = { title: '评审准备', summary: '邮件要求评审附件中的条目。', status: 'ready' as const,
    help: { description: '筛选附件条目', benefit: '减少本人筛选时间' }, unknowns: [], missingInputs: ['尚未取得附件中的条目'] };
  const proposal = { title: '筛选条目', objective: '筛选附件的所有条目', expectedOutput: '分组清单' };
  assert.equal(reviewDecisionSchema.safeParse(f.notify(source, { outcome: 'propose', proposal })).success, false);
  assert.equal(reviewDecisionSchema.safeParse(f.notify(source, {
    outcome: 'propose', situation: { ...situation, missingInputs: undefined }, proposal,
  })).success, false);
  assert.throws(() => f.commit(review, f.notify(source, { situation })), /请用propose/);
  assert.throws(() => f.commit(review, f.notify(source, { outcome: 'propose', situation, proposal })), /缺必要资料/);
  const result = f.commit(review, f.notify(source, { outcome: 'needs_input', situation: { ...situation, status: 'watching' },
    message: '我可以帮你筛选评审范围，需要先取得可读的附件清单。' }));
  assert.equal(result.input.outcome, 'needs_input');
  assert.equal(f.inbox.reviewAttention(result.itemId!)?.situation?.status, 'watching');
  const existing = { anchorEventId: undefined, relatedItemId: result.itemId };
  const options = { exposedItemIds: [result.itemId!] };
  const { message: _notice, ...reviewContext } = f.notify(source) as Extract<ReviewDecisionInput, { outcome: 'notify' }>;
  f.commit(f.review([source]), { ...reviewContext, ...existing, outcome: 'observe',
    situation: { ...situation, status: 'watching', missingInputs: undefined } }, [source.id], options);
  assert.deepEqual(f.inbox.reviewAttention(result.itemId!)?.situation?.missingInputs, situation.missingInputs);
  const ready = { ...existing, outcome: 'propose', situation: { ...situation, missingInputs: [] }, proposal };
  assert.throws(() => f.commit(f.review([source]), f.notify(source, ready), [source.id], options), /清除缺项前/);
  const document = f.message('@owner_chat the readable source now contains all attachment entries');
  const valid = f.commit(f.review([document]), f.notify(document, ready), [document.id], options);
  assert.equal(valid.publication, 'pending');
  assert.deepEqual(f.inbox.reviewAttention(result.itemId!)?.situation?.missingInputs, []);
});

test('visible decisions require exposed evidence, authentic alias boundaries and complete batch coverage', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat please decide'), hidden = f.message('hidden'), event = f.review([source]);
  assert.throws(() => f.decisions.commit({ reviewEvent: event, runId: 'run', input: f.notify(source), exposedEventIds: [], ownerDependencies: [f.dependency] }, f.validation), /实际暴露/);
  assert.throws(() => f.commit(event, f.notify(hidden), [source.id]), /实际暴露/);
  const partialName = f.message('@owner_chat_other is someone else');
  assert.throws(() => f.commit(f.review([partialName]), f.notify(partialName)), /没有.*称呼/);
  const actual = f.commit(event, f.notify(source));
  assert.equal(actual.publication, 'pending'); assert.equal(f.decisions.pending().length, 1);
  assert.throws(() => f.decisions.delivered(actual.id, { messageId: actual.messageId, contentHash: 'wrong' }), /摘要/);
  f.decisions.delivered(actual.id, { messageId: actual.messageId, contentHash: actual.contentHash });
  assert.deepEqual(f.decisions.pending(), []);
});

test('legacy owner statements support nullable isSelf while reply inference stays same-conversation evidence', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const question = f.message('Which issue is this?', { senderName: 'Owner_Chat' });
  const answer = f.message('Both configurations share the same problem.', { senderName: 'Colleague' });
  const event = f.review([answer]);
  const input = f.notify(question, { evidenceIds: [question.id, answer.id], ownerRelation: { kind: 'inferred_reply', questionEventId: question.id,
    answerEventIds: [answer.id], ownerMemoryKey: f.dependency.key, rationale: 'The reply explains the issue the owner just asked about.' } });
  const record = f.commit(event, input, [question.id, answer.id], { ownerAliases: [] });
  assert.equal(record.input.outcome, 'notify'); assert.equal(question.actor, 'external', 'owner participation never becomes task consent');
  const other = f.message('Different conversation', { senderName: 'Colleague' }, 'other-grant');
  assert.throws(() => f.commit(f.review([other]), { ...input, evidenceIds: [question.id, other.id], ownerRelation: { kind: 'inferred_reply',
    questionEventId: question.id, answerEventIds: [other.id], ownerMemoryKey: f.dependency.key, rationale: 'not sufficient' } } as ReviewDecisionInput, [question.id, other.id], { ownerAliases: [] }), /同一会话/);
  const direct = f.message('@OWNER_CHAT please decide');
  const ownerStatement = f.commit(f.review([direct]), f.notify(direct, { ownerRelation: { kind: 'owner_statement', evidenceId: direct.id,
    alias: 'owner_chat', memoryKey: f.dependency.key } }), [direct.id], { ownerAliases: [] });
  assert.equal(ownerStatement.publication, 'pending');
  const unknown = f.message('Unknown sender');
  assert.throws(() => f.commit(f.review([unknown]), f.notify(unknown, { ownerRelation: { kind: 'owner_participation',
    evidenceId: unknown.id, ownerMemoryKey: f.dependency.key } })), /没有明确方向/);
});

test('exact structured-state duplicates and repeated questions stay quiet across batches, changed fields notify', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat please decide'), first = f.commit(f.review([source]), f.notify(source));
  f.decisions.delivered(first.id, { messageId: first.messageId, contentHash: first.contentHash });
  const again = () => { const next = f.message('@owner_chat same information'); return f.commit(f.review([next]), f.notify(next, {
    anchorEventId: undefined, relatedItemId: first.itemId, message: 'The same state with different wording.' }), [next.id], { exposedItemIds: [first.itemId] }); };
  assert.equal(again().publication, 'duplicate'); assert.equal(again().publication, 'duplicate', 'a duplicate does not forget the original published decision');
  const update = f.message('@owner_chat deadline is tomorrow');
  const changed = f.commit(f.review([update]), f.notify(update, { anchorEventId: undefined, relatedItemId: first.itemId,
    materialChange: { kind: 'deadline', fields: { deadline: '2026-11-11', status: 'needs_owner' } } }), [update.id], { exposedItemIds: [first.itemId] });
  assert.equal(changed.publication, 'pending');
  const question = f.message('@owner_chat needs one essential answer');
  const ask = f.commit(f.review([question]), f.notify(question, { outcome: 'needs_input', materialChange: { kind: 'question', fields: { gap: 'which configuration' } } }));
  const repeated = f.message('@owner_chat same gap');
  assert.equal(f.commit(f.review([repeated]), f.notify(repeated, { outcome: 'needs_input', anchorEventId: undefined, relatedItemId: ask.itemId,
    materialChange: { kind: 'question', fields: { gap: 'which configuration' } } }), [repeated.id], { exposedItemIds: [ask.itemId] }).publication, 'duplicate');
});

test('a pending decision with obsolete owner context cannot suppress a current same-state decision', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const original = f.message('@owner_chat please decide'), first = f.commit(f.review([original]), f.notify(original));
  const later = f.message('The same fact is now independently current.', { isSelf: true });
  const review = f.review([later]), ownerDependencies: ReviewOwnerDependency[] = [{ ...f.dependency, revision: 2 }];
  const validation = { ...f.validation, ownerDependenciesCurrent: (dependencies: readonly ReviewOwnerDependency[]) => dependencies.every(value => value.revision === 2) };
  const item = f.decisions.attention(caseId)[0];
  assert.throws(() => f.decisions.attentionContext(item, validation), /历史投递回执/);
  const current = f.decisions.commit({ reviewEvent: review, runId: 'new-run', input: f.notify(later, { anchorEventId: undefined,
    relatedItemId: first.itemId, ownerRelation: { kind: 'owner_participation', evidenceId: later.id } }),
    exposedEventIds: [later.id], ownerDependencies, conversationId: 'conversation-one', exposedItemIds: [first.itemId!] }, validation);
  assert.equal(current.publication, 'pending'); assert.equal(f.inbox.reviewOutbox(first.id)?.state, 'pending');
});

test('historical delivery cannot reintroduce revoked source evidence through a later valid source', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const original = f.message('@owner_chat original source'), first = f.commit(f.review([original]), f.notify(original));
  f.decisions.delivered(first.id, { messageId: first.messageId, contentHash: first.contentHash });
  f.revoked.add(generation);
  const later = f.message('@owner_chat independent current source', {}, 'other-grant');
  const review = f.inbox.ingestProcessed({ sourceId: later.sourceId, sourceGeneration: later.sourceGeneration, externalId: 'other-source-review',
    kind: 'growth.observation', actor: 'system', operation: 'create', caseId, occurredAt: '2026-11-10T08:00:00Z',
    payload: { provider: 'wechat-desktop', eventIds: [later.id] } });
  assert.throws(() => f.decisions.attentionContext(f.decisions.attention(caseId)[0], f.validation), /撤回|不再可读/);
  assert.throws(() => f.commit(review, f.notify(later, { anchorEventId: undefined, relatedItemId: first.itemId }), [later.id],
    { exposedItemIds: [first.itemId] }), /撤回|不再可读/);
  assert.equal(f.decisions.pending().length, 0);
  const independent = f.commit(review, f.notify(later));
  assert.equal(independent.publication, 'pending'); assert.notEqual(independent.itemId, first.itemId);
  assert.deepEqual(independent.evidence.map(value => value.eventId), [later.id]);
});

test('source dependency closure and changed owner context invalidate pending publication without inventing a model retry', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat please decide'), extra = f.message('Context actually read', {}, 'other-grant');
  const record = f.commit(f.review([source]), f.notify(source), [source.id, extra.id]);
  f.revoked.add('other-grant');
  assert.throws(() => f.decisions.assertCurrent(record, f.validation), (error: unknown) => error instanceof ReviewDecisionError && error.code === 'source_unavailable');
  f.decisions.invalidate(record.id, 'source_unavailable');
  assert.equal(f.inbox.reviewOutbox(record.id)?.state, 'invalidated'); assert.equal(f.decisions.get(record.id)?.id, record.id);
  f.revoked.clear();
  const next = f.message('@owner_chat current question'), second = f.commit(f.review([next]), f.notify(next));
  f.setOwnerCurrent(false);
  assert.throws(() => f.decisions.assertCurrent(second, f.validation), (error: unknown) => error instanceof ReviewDecisionError && error.code === 'stale_owner_context');
  f.decisions.invalidate(second.id, 'stale_owner_context');
  assert.equal(f.inbox.reviewOutbox(second.id)?.state, 'needs_reassessment');
  assert.deepEqual(f.decisions.pending(), []);
});

test('a stale owner decision can be explicitly reassessed only in the original run with a new context revision', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat needs an answer'), event = f.review([source]);
  const original = f.commit(event, f.notify(source));
  f.decisions.invalidate(original.id, 'stale_owner_context');
  f.dependency.revision = 2;
  const dependencies = [{ ...f.dependency, revision: 2 }];
  const extra = { ownerDependencies: dependencies, ownerAliases: [{ value: 'owner_chat', key: f.dependency.key, revision: 2 }] };
  assert.throws(() => f.commit(event, f.notify(source), [source.id], extra), /原运行预算/);
  assert.throws(() => f.commit(event, f.notify(source), [source.id], { ...extra, reassessmentOf: original.id, runId: 'new-run' }), /原运行预算/);
  const next = f.commit(event, f.notify(source), [source.id], { ...extra, reassessmentOf: original.id });
  assert.equal(next.revision, 2); assert.notEqual(next.id, original.id); assert.equal(next.reassessmentOf, original.id);
  assert.equal(f.decisions.byReviewEvent(event.id)?.id, next.id);
  assert.equal(f.inbox.reviewOutbox(original.id)?.state, 'invalidated');
  assert.equal(f.decisions.reassessments().length, 0);
  assert.equal(f.decisions.pending()[0].decisionId, next.id);
});

test('captured exposure snapshots reject source mutation between model read and decision commit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-review-snapshot-'));
  const file = join(directory, 'events.sqlite'), f = fixture(file);
  t.after(() => f.inbox.close());
  const source = f.message('@owner_chat original question'), event = f.review([source]);
  const snapshots = f.decisions.capture([source.id], caseId, f.validation.isAllowed);
  const db = new DatabaseSync(file);
  db.prepare("UPDATE events SET json=json_set(json,'$.payload.content',?) WHERE id=?").run('@owner_chat changed after exposure', source.id);
  db.close();
  assert.throws(() => f.commit(event, f.notify(source), [source.id], { exposedEvidence: snapshots }), /替换/);
  assert.equal(f.decisions.pending().length, 0); assert.equal(f.decisions.byReviewEvent(event.id), undefined);
});

test('proposal decision stages bounded presentation only, and receipt must match the original proposal', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const source = f.message('@owner_chat a bounded analysis may help');
  const proposal = { title: 'Analyze findings', objective: 'Compare the authorized messages', expectedOutput: 'A short internal summary' };
  const situation = { title: 'Compare findings', summary: 'The authorized messages are available.', status: 'ready', unknowns: [], missingInputs: [] };
  const record = f.commit(f.review([source]), f.notify(source, { outcome: 'propose', proposal, situation, message: undefined }));
  assert.equal(record.publication, 'pending'); assert.equal(f.inbox.reviewOutbox(record.id)?.receipt, undefined);
  assert.throws(() => f.decisions.delivered(record.id, { taskId: 'task', proposalHash: 'different' }), /原范围/);
  f.decisions.delivered(record.id, { taskId: 'task', proposalHash: reviewContentHash(proposal) });
  assert.equal(f.inbox.reviewOutbox(record.id)?.state, 'delivered');
});

test('durable publication intent survives process-owned repository reopen and acknowledgements are idempotent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-review-journal-'));
  const file = join(directory, 'events.sqlite');
  let inbox = new EventInbox(file), decisions = new ReviewDecisions(inbox);
  t.after(() => inbox.close());
  const source = inbox.ingestProcessed({ sourceId: 'connector:g', sourceGeneration: 'g', externalId: 'm', kind: 'connector.change', actor: 'external',
    operation: 'create', caseId, occurredAt: '2026-11-10T07:57:00.000Z', payload: { content: '@owner_chat', provider: 'wechat-desktop', isSelf: true } });
  const event = inbox.ingestProcessed({ sourceId: 'connector:g', sourceGeneration: 'g', externalId: 'r', kind: 'growth.observation', actor: 'system',
    operation: 'create', caseId, occurredAt: '2026-11-10T08:00:00.000Z', payload: { eventIds: [source.id] } });
  const input: ReviewDecisionInput = { outcome: 'notify', evidenceIds: [source.id], anchorEventId: source.id,
    ownerRelation: { kind: 'owner_participation', evidenceId: source.id }, whyOwnerNeedsToKnow: 'test',
    materialChange: { kind: 'new', fields: { status: 'new' } }, message: 'Notice' };
  const record = decisions.commit({ reviewEvent: event, runId: 'run', input, exposedEventIds: [source.id], ownerDependencies: [] },
  { isAllowed: () => true, ownerDependenciesCurrent: () => true });
  inbox.close(); inbox = new EventInbox(file); decisions = new ReviewDecisions(inbox);
  assert.equal(decisions.pending()[0].messageId, record.messageId);
  const receipt = { messageId: record.messageId, contentHash: record.contentHash };
  decisions.delivered(record.id, receipt); decisions.delivered(record.id, receipt);
  assert.equal(decisions.pending().length, 0);
});

test('conversation context joins a prior owner question to the new answer without advancing old coverage', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const question = f.message('Which issue is this?', { senderName: 'owner_chat', sentAt: '2026-11-10T07:56:10.000Z' });
  f.review([question]);
  const answer = f.message('These are the same issue.', { senderName: 'Colleague', sentAt: '2026-11-10T07:57:50.000Z' });
  const event = f.review([answer]);
  const connectors = { listWeChatConversations: () => [{ conversationId: 'stable', grantId: generation, title: 'Group' }],
    localWeChatGenerations: () => ({ caseId, sourceGenerations: [generation] }),
    weChatMessageView: (source: StoredEvent) => ({ id: source.id, messageId: source.id, content: source.payload.content, senderName: source.payload.senderName,
      sentAt: source.payload.sentAt, receivedAt: source.receivedAt, isSelf: null, messageType: 'text', partCount: null, partIndex: null }) };
  const result = weChatReviewContext({ event, inbox: f.inbox, connectors: connectors as never, isAllowed: () => true, timezone: 'Asia/Shanghai' })!;
  assert.deepEqual(result.observedMessages.map(value => value.id), [answer.id]);
  assert.deepEqual(result.conversationNeighborhoods[0].messages.map(value => value.id), [question.id, answer.id]);
  assert.deepEqual(result.conversationNeighborhoods[0].coverage.contextEventIds, [question.id]);
  assert.equal(result.observedMessages[0].temporal.sent?.localTime, '15:57:50');
  assert.equal(question.actor, 'external');
});

test('conversation windows preserve same-second order and explicitly mark incomplete logical messages', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const first = f.message('First turn', { senderName: 'owner_chat' });
  const next = f.message('First fragment', { messageId: 'logical', partIndex: 0, partCount: 2 });
  const event = f.review([next]);
  const neighborhood = f.inbox.weChatNeighborhood(caseId, [generation], [next.id], () => true);
  assert.deepEqual(neighborhood.events.map(value => value.id), [first.id, next.id]);
  const connectors = { listWeChatConversations: () => [{ conversationId: 'stable', grantId: generation, title: 'Group' }],
    localWeChatGenerations: () => ({ caseId, sourceGenerations: [generation] }), weChatMessageView: (source: StoredEvent) => ({ id: source.id,
      messageId: source.payload.messageId ?? source.id, content: source.payload.content, senderName: source.payload.senderName, sentAt: source.payload.sentAt,
      receivedAt: source.receivedAt, isSelf: null, messageType: 'text', partCount: source.payload.partCount ?? null, partIndex: source.payload.partIndex ?? null }) };
  const context = weChatReviewContext({ event, inbox: f.inbox, connectors: connectors as never, isAllowed: () => true, timezone: 'Asia/Shanghai' })!;
  assert.deepEqual(context.conversationNeighborhoods[0].coverage.incompleteMessages, [{ messageId: 'logical', expected: 2, received: [0] }]);
});

test('WeChat query keeps sender matching separate and uses an exclusive time-range end', t => {
  const f = fixture(); t.after(() => f.inbox.close());
  const earlier = f.message('No owner handle in the body', { senderName: 'owner_chat', sentAt: '2026-11-10T07:56:10.000Z' });
  f.message('Exactly on excluded end', { senderName: 'owner_chat', sentAt: '2026-11-10T08:00:00.000Z' });
  assert.equal(f.inbox.queryWeChatEvidence(caseId, [generation], { query: 'owner_chat', limit: 20 }).events.length, 0);
  const result = f.inbox.queryWeChatEvidence(caseId, [generation], { sender: 'owner_chat', from: '2026-11-10T07:00:00Z', until: '2026-11-10T08:00:00Z', limit: 20 });
  assert.deepEqual(result.events.map(value => value.id), [earlier.id]);
});

test('an exhausted failed WeChat batch stays failed while genuinely later messages get a separate bounded batch', t => {
  const inbox = new EventInbox(':memory:'); t.after(() => inbox.close());
  const submit = (id: string) => inbox.ingest({ id, sourceId: 'connector:g', sourceGeneration: 'g', caseId: 'scene', externalId: id,
    kind: 'connector.change', actor: 'external', operation: 'create', occurredAt: '2026-11-10T08:00:00Z', payload: { provider: 'wechat-desktop', content: id } }).event;
  const first = submit('first'); inbox.captureObservations(() => true);
  const scope = { caseId: 'scene', sourceGenerations: ['g'] };
  const old = inbox.releaseObservation(() => true, Date.now(), true, scope)!;
  const claim = inbox.claim(1, 60_000, [old.id])[0]; inbox.fail(old.id, 'Original eight steps spent', claim.leaseToken!);
  assert.equal(inbox.markReviewTerminal(old.id, 'step_limit'), true);
  assert.equal(inbox.releaseObservation(() => true, Date.now(), true, scope), undefined, 'manual review cannot reactivate a spent batch');
  const later = submit('later'); inbox.captureObservations(() => true);
  const next = inbox.releaseObservation(() => true, Date.now() + 600001)!;
  assert.deepEqual(next.payload.eventIds, [later.id]); assert.notEqual(next.id, old.id);
  assert.equal(inbox.get(old.id)?.status, 'failed'); assert.deepEqual(inbox.get(old.id)?.payload.eventIds, [first.id]);
  assert.equal(inbox.observationStats(['g']).failedCount, 1); assert.equal(inbox.observationStats(['g']).processingCount, 1);
});

test('an owner-context reassessment marker reopens only on explicit analysis without erasing the original membership', t => {
  const inbox = new EventInbox(':memory:'); t.after(() => inbox.close());
  const source = inbox.ingest({ sourceId: 'connector:g', sourceGeneration: 'g', caseId: 'scene', externalId: 'message', kind: 'connector.change',
    actor: 'external', operation: 'create', occurredAt: '2026-11-10T08:00:00Z', payload: { provider: 'wechat-desktop', content: 'question' } }).event;
  inbox.captureObservations(() => true);
  const scope = { caseId: 'scene', sourceGenerations: ['g'] }, original = inbox.releaseObservation(() => true, Date.now(), true, scope)!;
  const claim = inbox.claim(1, 60_000, [original.id])[0]; inbox.ack(original.id, claim.leaseToken!);
  assert.equal(inbox.markReviewNeedsReassessment(original.id), true);
  assert.equal(inbox.get(original.id)?.status, 'failed'); assert.deepEqual(inbox.ready(10), []);
  assert.equal(inbox.releaseObservation(() => true, Date.now() + 600001), undefined, 'a correction does not create idle model polling');
  const reopened = inbox.releaseObservation(() => true, Date.now(), true, scope)!;
  assert.equal(reopened.id, original.id); assert.deepEqual(reopened.payload.eventIds, [source.id]);
  assert.equal(reopened.payload.analysisNeedsReassessment, undefined); assert.equal(reopened.attempts, 1);
});
