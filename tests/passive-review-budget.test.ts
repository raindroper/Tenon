import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Run } from '../shared/types.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { SourceReviewSession } from '../server/v2/source-review.js';
import { ReviewDecisions, type ReviewDecisionRecord } from '../server/v2/review-decisions.js';
import type { ObservationContext } from '../server/v2/observation-context.js';
import type { ConnectorService } from '../server/connectors/service.js';
import { caseEventPrefix } from '../server/v2/source-context.js';

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const invalidDecision = () => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'finish_review', input: JSON.stringify({ outcome: 'invalid' }) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
async function until(check: () => boolean) {
  const start = performance.now();
  while (!check()) { assert.ok(performance.now() - start < 15_000, 'Passive review fixture did not settle'); await delay(5); }
}
async function fixture(respond?: (options: Parameters<MockLanguageModelV4['doGenerate']>[0]) => Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-passive-budget-')), store = new Store(directory);
  store.getApiKey = () => undefined;
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => { calls++; return respond ? respond(options) : invalidDecision(); } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: {}, model });
  const scene = await runtime.createCase({ title: 'Bounded passive observation', objective: 'Observe only this authorized conversation', domain: 'work' });
  const { device } = runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name: 'Offline test device', platform: 'win32' });
  const grant = await runtime.weChatObservations.start({ deviceId: device.id, windowId: 'test-group', caseId: scene.id, title: 'Test group', chatType: 'group' });
  await runtime.weChatObservations.ingest(device.id, { grantId: grant.id, windowId: grant.windowId, rows: [
    { id: 'source-message', text: 'The owner asked a question in the authorized group.', isSelf: true, senderName: 'Owner', sentAt: '2026-11-10T07:56:10Z' },
  ] });
  runtime.inbox.captureObservations(event => runtime.sources.isEventAllowed(event));
  const event = runtime.inbox.releaseObservation(value => runtime.sources.isEventAllowed(value), Date.now(), true, { caseId: scene.id, sourceGenerations: [grant.id] });
  assert.ok(event);
  const records = () => store.list('runs').filter(run => run.eventId === event.id);
  return { scene, store, grant, event, get runtime() { return runtime; }, calls: () => calls, records,
    async reopen() { await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: {}, model }); },
    async close() { await runtime.close(); store.close(); } };
}

test('an exhausted passive review keeps its original eight requests and deadline through explicit retries', async () => {
  const f = await fixture();
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 8 }); f.runtime.start();
    await until(() => f.runtime.inbox.get(f.event.id)?.status === 'failed' && f.records().some(run => run.status === 'failed'));
    const first = f.records().at(-1)!;
    assert.equal(f.calls(), 8); assert.equal(first.reviewBudget?.usedSteps, 8); assert.equal(first.reviewBudget?.stepLimit, 8);
    assert.ok(first.reviewBudget!.deadline > Date.parse(first.startedAt));
    await f.store.updateSettings({ maxStepsPerRun: 50 });
    for (let retry = 0; retry < 2; retry++) {
      const before = f.records().length;
      assert.equal((await f.runtime.weChatObservations.analyze(f.grant.id)).queued, false);
      const latest = f.records().at(-1)!;
      assert.deepEqual(latest.reviewBudget, first.reviewBudget);
      assert.equal(f.records().length, before); assert.equal(f.calls(), 8, 'retry/settings changes cannot buy new requests for the old passive event');
    }
    assert.equal((f.runtime.inbox.get(f.event.id)?.payload.analysisTerminal as { reason?: string })?.reason, 'step_limit');
    assert.deepEqual(await f.runtime.listTasks(), []); assert.deepEqual(f.store.list('messages'), []);
  } finally { await f.close(); }
});

test('a captured finite passive deadline stays expired across recovery and manual retry without clock mutation', async () => {
  const f = await fixture();
  try {
    const budget = { deadline: Date.now() - 1000, stepLimit: 8, usedSteps: 3 };
    f.store.insert('runs', { id: 'old-finite-review', caseId: f.scene.id, eventId: f.event.id, trigger: 'source', mode: 'growth', status: 'interrupted',
      startedAt: new Date(budget.deadline - 1000).toISOString(), steps: 3, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', reviewBudget: budget } satisfies Run);
    await f.reopen(); await f.store.updateSettings({ enabled: true, maxStepsPerRun: 50 }); f.runtime.start();
    await until(() => f.runtime.inbox.get(f.event.id)?.status === 'failed' && f.records().at(-1)?.status === 'failed');
    assert.equal(f.calls(), 0); assert.deepEqual(f.records().at(-1)?.reviewBudget, budget);
    const count = f.records().length;
    assert.equal((await f.runtime.weChatObservations.analyze(f.grant.id)).queued, false);
    assert.equal(f.records().length, count);
    assert.equal(f.calls(), 0); assert.deepEqual(f.records().at(-1)?.reviewBudget, budget);
  } finally { await f.close(); }
});

test('an accepted source decision settles its local outbox after the passive deadline with zero model requests', async () => {
  const f = await fixture();
  try {
    let record: ReviewDecisionRecord | undefined;
    const internals = f.runtime as unknown as { connectors: ConnectorService; observations: ObservationContext };
    const session = await SourceReviewSession.create({ event: f.event, runId: 'accepted-source-run', item: f.scene, inbox: f.runtime.inbox,
      connectors: internals.connectors, sources: f.runtime.sources, personal: f.runtime.personal, observations: internals.observations,
      timezone: () => 'Asia/Shanghai', guard: () => {}, onDecision: value => { record = value; } });
    const sourceId = (f.event.payload.eventIds as string[])[0];
    await session.finish({ outcome: 'notify', evidenceIds: [sourceId], anchorEventId: sourceId,
      ownerRelation: { kind: 'owner_participation', evidenceId: sourceId }, whyOwnerNeedsToKnow: 'There is an answer to the owner question.',
      materialChange: { kind: 'answer', fields: { answer: 'Configuration clarified' } }, message: 'The requested configuration is now clarified.' });
    assert.ok(record);
    const budget = { deadline: Date.now() - 1000, stepLimit: 8, usedSteps: 8 };
    f.store.insert('runs', { id: 'accepted-source-run', caseId: f.scene.id, eventId: f.event.id, trigger: 'source', mode: 'growth', status: 'interrupted',
      startedAt: new Date(budget.deadline - 1000).toISOString(), steps: 8, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', reviewBudget: budget } satisfies Run);
    await f.reopen();
    await until(() => f.store.get('messages', record!.messageId!) !== undefined);
    assert.equal(f.calls(), 0); assert.equal(new ReviewDecisions(f.runtime.inbox).pending().length, 0);
    assert.equal(f.store.getSettings().enabled, false, 'local receipt settlement does not enable inference');
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 50 }); f.runtime.start();
    await until(() => f.runtime.inbox.get(f.event.id)?.status === 'processed' && f.records().at(-1)?.status === 'completed');
    assert.equal(f.calls(), 0); assert.deepEqual(f.records().at(-1)?.reviewBudget, budget);
    assert.equal(f.store.list('messages').length, 1);
    assert.equal(f.store.list('messages')[0].content, 'The requested configuration is now clarified.');
  } finally { await f.close(); }
});

test('explicit owner correction reopens a stale pending decision in a new actual run using the remaining original passive budget', async () => {
  const newText = 'Current-policy answer after the explicit reassessment.';
  const oldText = 'Outdated text that must never become public.';
  const f = await fixture(options => {
    const last = options.prompt.filter(message => message.role === 'user').at(-1)!;
    const text = (last.content as Array<{ type: string; text?: string }>).find(part => part.type === 'text' && part.text?.startsWith(caseEventPrefix))!.text!;
    const context = JSON.parse(text.slice(caseEventPrefix.length));
    const evidenceId = context.observedMessages[0].evidenceId;
    return { ...invalidDecision(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'finish_review', input: JSON.stringify({
      outcome: 'notify', evidenceIds: [evidenceId], anchorEventId: evidenceId, ownerRelation: { kind: 'owner_participation', evidenceId },
      whyOwnerNeedsToKnow: 'The current policy permits this specific answer.', materialChange: { kind: 'answer', fields: { answer: 'Current interpretation' } }, message: newText,
    }) }] };
  });
  try {
    const firstPolicy = await f.runtime.correctPersonalMemory('review.policy', { value: 'Only relevant current information.', purpose: 'interaction', scope: 'case', caseIds: [f.scene.id] });
    const internals = f.runtime as unknown as { connectors: ConnectorService; observations: ObservationContext; flushReviewOutbox(): void };
    const reviews = new ReviewDecisions(f.runtime.inbox);
    let previous: ReviewDecisionRecord | undefined;
    const session = await SourceReviewSession.create({ event: f.event, runId: 'original-source-run', item: f.scene, inbox: f.runtime.inbox,
      connectors: internals.connectors, sources: f.runtime.sources, personal: f.runtime.personal, observations: internals.observations,
      timezone: () => 'Asia/Shanghai', guard: () => {}, onDecision: record => { previous = record; } });
    const evidenceId = (f.event.payload.eventIds as string[])[0];
    await session.finish({ outcome: 'notify', evidenceIds: [evidenceId], anchorEventId: evidenceId,
      ownerRelation: { kind: 'owner_participation', evidenceId }, whyOwnerNeedsToKnow: 'Prior interpretation before the owner correction.',
      materialChange: { kind: 'answer', fields: { answer: 'Prior interpretation' } }, message: oldText });
    assert.ok(previous); assert.equal(reviews.pending().length, 1); assert.equal(f.store.list('messages').length, 0);
    const originalBudget = { deadline: Date.now() + 5 * 60000, stepLimit: 8, usedSteps: 1 };
    f.store.insert('runs', { id: 'original-source-run', caseId: f.scene.id, eventId: f.event.id, trigger: 'source', mode: 'growth', status: 'completed',
      startedAt: new Date().toISOString(), steps: 1, inputTokens: 5, outputTokens: 2, usageStatus: 'reported', reviewBudget: originalBudget,
      reviewDecisionId: previous.id } satisfies Run);
    const originalClaim = f.runtime.inbox.claim(1, 60_000, [f.event.id])[0];
    f.runtime.inbox.ack(f.event.id, originalClaim.leaseToken!);
    await f.runtime.correctPersonalMemory('review.policy', { value: 'Only current-policy interpretations may be reported.', purpose: 'interaction', expectedRevision: firstPolicy.revision });
    internals.flushReviewOutbox();
    assert.equal(f.store.list('messages').some(message => message.content === oldText), false);
    assert.equal(f.runtime.inbox.reviewOutbox(previous.id)?.state, 'needs_reassessment');
    assert.equal(f.runtime.inbox.get(f.event.id)?.status, 'failed');
    assert.equal(f.calls(), 0, 'a correction stages manual reconsideration without an idle model call');
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 50 }); f.runtime.start();
    assert.equal((await f.runtime.weChatObservations.analyze(f.grant.id)).queued, true);
    await until(() => f.runtime.inbox.get(f.event.id)?.status === 'processed' && f.records().at(-1)?.status === 'completed');
    const actual = f.records().at(-1)!;
    assert.notEqual(actual.id, 'original-source-run'); assert.equal(f.calls(), 1);
    assert.deepEqual(actual.reviewBudget, { ...originalBudget, usedSteps: 2 }); assert.equal(actual.steps, 1);
    const current = reviews.byReviewEvent(f.event.id)!;
    assert.equal(current.revision, 2); assert.equal(current.reassessmentOf, previous.id); assert.equal(current.runId, actual.id);
    assert.equal(f.runtime.inbox.reviewOutbox(previous.id)?.state, 'invalidated');
    assert.equal(f.runtime.inbox.reviewOutbox(current.id)?.state, 'delivered');
    assert.deepEqual(f.store.list('messages').map(message => message.content), [newText]);
    assert.deepEqual(await f.runtime.listTasks(), []);
  } finally { await f.close(); }
});

test('a harmless owner reply preserves delivered-state dedup for later same-anchor messages without reusing stale owner assumptions', async () => {
  let anchor: string | undefined, nextAttention: Array<{ contextStatus?: string }> = [], sourceCalls = 0;
  const notice = 'SOURCE_NOTICE: The configuration has been clarified.';
  const f = await fixture(options => {
    const last = options.prompt.filter(message => message.role === 'user').at(-1)!;
    const text = (last.content as Array<{ type: string; text?: string }>).find(part => part.type === 'text' && part.text?.startsWith(caseEventPrefix))!.text!;
    const context = JSON.parse(text.slice(caseEventPrefix.length));
    if (context.event.kind === 'owner.message') return { content: [{ type: 'text', text: '不客气。' }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } };
    sourceCalls++;
    const current = context.observedMessages[0].evidenceId;
    anchor ??= current;
    if (sourceCalls > 1) nextAttention = context.attentionItems;
    const previous = context.attentionItems[0];
    return { ...invalidDecision(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'finish_review', input: JSON.stringify({
      outcome: 'notify', evidenceIds: [...new Set([anchor, current])], ...(previous ? { relatedItemId: previous.id } : { anchorEventId: anchor }),
      ownerRelation: { kind: 'owner_participation', evidenceId: current }, whyOwnerNeedsToKnow: 'The latest source confirms the already reported answer.',
      materialChange: { kind: 'answer', fields: { answer: 'Configuration clarified' } }, message: notice,
    }) }] };
  });
  try {
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 8 }); f.runtime.start();
    await until(() => f.runtime.inbox.get(f.event.id)?.status === 'processed' && f.records().at(-1)?.status === 'completed');
    const owner = await f.runtime.ingestOwnerMessage('谢谢', f.scene.id);
    await until(() => f.runtime.inbox.get(owner.id)?.status === 'processed');
    await f.runtime.weChatObservations.ingest(f.grant.deviceId, { grantId: f.grant.id, windowId: f.grant.windowId, rows: [
      { id: 'same-state-later-message', text: 'The same configuration is still clarified.', isSelf: true, senderName: 'Owner', sentAt: '2026-11-10T07:58:10Z' },
    ] });
    assert.equal((await f.runtime.weChatObservations.analyze(f.grant.id)).queued, true);
    const next = () => f.runtime.inbox.list().find(event => event.kind === 'growth.observation' && event.id !== f.event.id);
    await until(() => next()?.status === 'processed' && f.store.list('runs').some(run => run.eventId === next()!.id && run.status === 'completed'));
    assert.equal(sourceCalls, 2);
    assert.equal(f.store.list('messages').filter(message => message.content === notice).length, 1, 'a raw owner thanks cannot make an already delivered state new again');
    assert.ok(nextAttention.some(item => item.contextStatus === 'historical_delivered'), 'receipt awareness remains available separately from current owner assumptions');
    assert.equal(new ReviewDecisions(f.runtime.inbox).byReviewEvent(next()!.id)?.publication, 'duplicate');
    assert.deepEqual(await f.runtime.listTasks(), []);
  } finally { await f.close(); }
});
