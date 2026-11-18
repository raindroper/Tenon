import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { SourceReviewSession } from '../server/v2/source-review.js';
import { ReviewDecisions, type ReviewDecisionRecord } from '../server/v2/review-decisions.js';
import type { ConnectorService } from '../server/connectors/service.js';
import type { ObservationContext } from '../server/v2/observation-context.js';
import { exportRuntimeData } from '../server/index.js';
import { routeRuntime } from '../server/v2/http.js';
import type { PersonalMemoryPage } from '../shared/personal-memory.js';
import { MockLanguageModelV4 } from './support/model.js';

async function fixture(directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'rae-review-publication-'));
  const store = new Store(join(root, 'store')); store.getApiKey = () => undefined;
  let modelCalls = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: join(root, 'native'),
    model: new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('Publication must not invoke inference'); } }) });
  const internal = runtime as unknown as { connectors: ConnectorService; observations: ObservationContext; publishReviewDecision(record: ReviewDecisionRecord): void; flushReviewOutbox(): void };
  return { root, store, runtime, internal, get modelCalls() { return modelCalls; }, async close() { await runtime.close(); store.close(); } };
}
async function pendingNotice(f: Awaited<ReturnType<typeof fixture>>, onDecision: (record: ReviewDecisionRecord) => void) {
  const item = await f.runtime.createCase({ title: '工作场景', objective: '只关注需要本人知道的变化', domain: 'fixture' });
  await f.runtime.correctPersonalMemory('owner.role', { value: '本人负责该项目的页面交互。', scope: 'case', caseIds: [item.id] });
  const source = f.runtime.inbox.ingestProcessed({ sourceId: 'upload:review-fixture', externalId: item.id, kind: 'owner.source', actor: 'owner',
    operation: 'create', caseId: item.id, occurredAt: '2026-11-10T07:47:05.000Z', payload: { content: '页面交互口径已补充，需要本人知情。' } });
  const review = f.runtime.inbox.ingestProcessed({ sourceId: source.sourceId, externalId: `review:${item.id}`, kind: 'growth.observation', actor: 'system',
    operation: 'create', caseId: item.id, occurredAt: '2026-11-10T07:49:00.000Z', payload: { eventIds: [source.id] } });
  const session = await SourceReviewSession.create({ event: review, runId: `review-run:${item.id}`, item, inbox: f.runtime.inbox,
    connectors: f.internal.connectors, sources: f.runtime.sources, personal: f.runtime.personal,
    observations: f.internal.observations, timezone: () => 'Asia/Shanghai', guard: () => {}, onDecision });
  return { item, source, review, session, input: { outcome: 'notify' as const, evidenceIds: [source.id], anchorEventId: source.id,
    ownerRelation: { kind: 'work_dependency' as const, contextKeys: ['owner.role'], rationale: '这条资料影响本人负责的页面交互。' },
    whyOwnerNeedsToKnow: '需要采用新增交互口径。', materialChange: { kind: 'scope' as const, fields: { interaction: '新增首屏规则' } },
    message: '页面交互口径已补充，请按新的首屏规则核对。' } };
}

async function pendingMeeting(f: Awaited<ReturnType<typeof fixture>>, onDecision: (record: ReviewDecisionRecord) => void, extra = '') {
  const item = await f.runtime.createCase({ title: '合成会议场景', objective: '接收相关会议提醒', domain: 'fixture' });
  await f.runtime.correctPersonalMemory('owner.wechat_alias', { value: '微信称呼为 FixtureOwner', purpose: 'identity',
    identity: { kind: 'alias', platform: 'wechat', value: 'FixtureOwner' } });
  const { device } = f.runtime.devices.enroll({ pairingToken: f.runtime.devices.createPairing().token, name: '合成设备', platform: 'win32' });
  const grant = await f.runtime.weChatObservations.start({ caseId: item.id, deviceId: device.id, windowId: randomUUID(),
    title: '合成讨论群', chatType: 'group', analysisIntervalMinutes: 10 });
  const rowId = randomUUID();
  await f.runtime.weChatObservations.ingest(device.id, { grantId: grant.id, windowId: grant.windowId, rows: [{ id: rowId,
    text: '@FixtureOwner 会议主题：合成评审\n会议时间：2026年11月11日 14:00–15:00（北京时间）\n会议号：123 456 789' + extra,
    senderName: '合成发起人', sentAt: '2026-11-11T05:55:00Z', messageType: 'text' }] });
  const source = f.runtime.inbox.list().find(event => event.externalId === rowId)!;
  const review = f.runtime.inbox.ingestProcessed({ sourceId: source.sourceId, sourceGeneration: source.sourceGeneration,
    externalId: `review:${item.id}`, kind: 'growth.observation', actor: 'system', operation: 'create', caseId: item.id,
    occurredAt: '2026-11-11T05:56:00Z', payload: { provider: 'wechat-desktop', eventIds: [source.id] } });
  const session = await SourceReviewSession.create({ event: review, runId: `review-run:${item.id}`, item, inbox: f.runtime.inbox,
    connectors: f.internal.connectors, sources: f.runtime.sources, personal: f.runtime.personal,
    observations: f.internal.observations, timezone: () => 'Asia/Shanghai', guard: () => {}, onDecision });
  return { session, input: { outcome: 'notify' as const, evidenceIds: [source.id], anchorEventId: source.id,
    ownerRelation: { kind: 'confirmed_alias' as const, evidenceId: source.id, alias: 'FixtureOwner' },
    whyOwnerNeedsToKnow: '会议邀请提到了本人。', materialChange: { kind: 'new' as const, fields: { title: '合成评审' } },
    message: '合成评审 11 月 11 日 14:00（北京时间）开始。', reminder: { kind: 'meeting' as const, inviteEvidenceId: source.id,
      title: '合成评审', startsAt: '2026-11-11T14:00:00+08:00', endsAt: '2026-11-11T15:00:00+08:00', meetingNumber: '123 456 789' } } };
}

test('committed review awaiting publication recovers locally while inference remains paused', async () => {
  const f = await fixture(); let decision!: ReviewDecisionRecord;
  try {
    const pending = await pendingNotice(f, record => { decision = record; throw new Error('fault: after decision commit'); });
    await assert.rejects(pending.session.finish(pending.input), /after decision commit/);
    assert.equal(f.store.get('messages', decision.messageId!), undefined);
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'pending');
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
  const restored = await fixture(f.root);
  try {
    assert.equal(restored.store.getSettings().enabled, false);
    const message = restored.store.get('messages', decision.messageId!);
    assert.equal(message?.content, decision.input.outcome === 'notify' ? decision.input.message : 'invalid fixture');
    assert.equal(message?.outputState, 'complete');
    assert.equal(restored.runtime.inbox.reviewOutbox(decision.id)?.state, 'delivered');
    restored.internal.flushReviewOutbox();
    assert.equal(restored.store.list('messages').filter(value => value.id === decision.messageId).length, 1);
    assert.equal(restored.modelCalls, 0);
  } finally { await restored.close(); }
});

test('recovery reconciles an accepted proposal decision with its already released attention wake', async () => {
  const f = await fixture();
  let taskId = '', wakeId = '';
  try {
    const pending = await pendingNotice(f, record => f.internal.publishReviewDecision(record));
    const at = Date.now() + 60000;
    await pending.session.finish({ ...pending.input, outcome: 'propose',
      proposal: { title: '准备页面交互清单', objective: '整理已保存的首屏规则', expectedOutput: '一页对齐清单' },
      situation: { title: '页面交互对齐', summary: '原始资料已齐备。', status: 'ready', unknowns: [], missingInputs: [], reviewAt: new Date(at).toISOString() } });
    const task = f.runtime.consent.list(pending.item.id)[0]; taskId = task.id;
    assert.equal(f.runtime.inbox.releaseDueWakes(at), 1);
    const wake = f.runtime.inbox.list().find(event => typeof event.payload.reviewItemId === 'string')!;
    wakeId = wake.id; assert.equal(wake.status, 'pending');
    f.runtime.consent.approve(task.id, task.revision);
    assert.equal(f.runtime.inbox.get(wakeId)?.status, 'pending', 'simulate exit between consent commit and local cancellation');
  } finally { await f.close(); }
  const reopened = await fixture(f.root);
  try {
    assert.equal(reopened.runtime.consent.get(taskId)?.state, 'approved');
    assert.equal(reopened.runtime.inbox.get(wakeId)?.status, 'processed');
    assert.equal(reopened.modelCalls, 0);
    assert.equal(reopened.runtime.inbox.claim(1, 60000, [wakeId]).length, 0);
  } finally { await reopened.close(); }
});

test('message saved before outbox acknowledgement is verified on recovery without overwriting or duplicate inference', async () => {
  const f = await fixture(); let decision!: ReviewDecisionRecord;
  const original = f.runtime.inbox.transitionReviewOutbox.bind(f.runtime.inbox);
  try {
    const pending = await pendingNotice(f, record => { decision = record; f.internal.publishReviewDecision(record); });
    f.runtime.inbox.transitionReviewOutbox = (...args) => {
      if (args[1] === 'delivered') throw new Error('fault: public message saved before acknowledgement');
      return original(...args);
    };
    await assert.rejects(pending.session.finish(pending.input), /before acknowledgement/);
    assert.equal(f.store.get('messages', decision.messageId!)?.content, pending.input.message);
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'pending');
  } finally { f.runtime.inbox.transitionReviewOutbox = original; await f.close(); }
  const restored = await fixture(f.root);
  try {
    assert.equal(restored.runtime.inbox.reviewOutbox(decision.id)?.state, 'delivered');
    assert.equal(restored.store.list('messages').filter(value => value.id === decision.messageId).length, 1);
    assert.equal(restored.modelCalls, 0);
  } finally { await restored.close(); }
});

test('an accepted meeting card survives a recovery before outbox acknowledgement and its digest protects the saved projection', async () => {
  const f = await fixture(); let decision!: ReviewDecisionRecord;
  const transition = f.runtime.inbox.transitionReviewOutbox.bind(f.runtime.inbox);
  try {
    const pending = await pendingMeeting(f, record => { decision = record; f.internal.publishReviewDecision(record); });
    f.runtime.inbox.transitionReviewOutbox = (...args) => {
      if (args[1] === 'delivered') throw new Error('fault: meeting saved before acknowledgement');
      return transition(...args);
    };
    await assert.rejects(pending.session.finish(pending.input), /meeting saved before acknowledgement/);
    assert.ok(decision.reminder);
    assert.deepEqual(f.store.get('messages', decision.messageId!)?.reminder, decision.reminder);
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'pending');
  } finally { f.runtime.inbox.transitionReviewOutbox = transition; await f.close(); }

  const restored = await fixture(f.root);
  try {
    assert.equal(restored.store.getSettings().enabled, false);
    assert.equal(restored.modelCalls, 0);
    assert.equal(restored.runtime.inbox.reviewOutbox(decision.id)?.state, 'delivered');
    assert.equal(restored.store.list('messages').filter(value => value.id === decision.messageId).length, 1);
    const saved = restored.store.get('messages', decision.messageId!)!;
    assert.deepEqual(saved.reminder, decision.reminder);
    const changed = { ...saved, reminder: { ...saved.reminder!, meetingNumber: '987 654 321' } };
    restored.store.put('messages', changed);
    assert.throws(() => restored.internal.publishReviewDecision(decision), /已投递回执与公开消息不一致/);
    assert.deepEqual(restored.store.get('messages', changed.id), changed);
  } finally { await restored.close(); }
});

test('a wrong offset or multiple meeting starts falls back to the notice body with its legacy text digest', async t => {
  for (const { name, startsAt, extra } of [
    { name: 'wrong offset', startsAt: '2026-11-11T14:00:00Z' },
    { name: 'two meeting starts in the same message', extra: '\n另一场讨论 2026/11/11 16:00–17:00（UTC+8）' },
  ]) await t.test(name, async () => {
    const f = await fixture(); let decision!: ReviewDecisionRecord;
    try {
      const pending = await pendingMeeting(f, record => { decision = record; f.internal.publishReviewDecision(record); }, extra);
      await pending.session.finish({ ...pending.input, reminder: { ...pending.input.reminder,
        startsAt: startsAt ?? pending.input.reminder.startsAt } });
      assert.equal(decision.reminder, undefined);
      assert.equal(decision.contentHash, createHash('sha256').update(pending.input.message).digest('hex'));
      const message = f.store.get('messages', decision.messageId!);
      assert.equal(message?.content, pending.input.message);
      assert.equal(message?.reminder, undefined);
      assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'delivered');
      assert.equal(f.modelCalls, 0);
    } finally { await f.close(); }
  });
});

test('same publication ID with a different body is quarantined instead of overwritten or reported delivered', async () => {
  const f = await fixture(); let decision!: ReviewDecisionRecord;
  try {
    const pending = await pendingNotice(f, record => {
      decision = record;
      f.store.put('messages', { id: record.messageId!, role: 'assistant', content: 'DIFFERENT_PRIVATE_BODY', caseId: record.caseId,
        runId: record.runId, createdAt: record.createdAt, outputState: 'complete' });
      f.internal.publishReviewDecision(record);
    });
    await assert.rejects(pending.session.finish(pending.input), /不同正文/);
    f.internal.flushReviewOutbox();
    assert.equal(f.store.get('messages', decision.messageId!)?.content, 'DIFFERENT_PRIVATE_BODY');
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'invalidated');
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.reason, 'publication_conflict');
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('full export includes the canonical ledger versions, legacy archive and complete review journal', async () => {
  const f = await fixture();
  try {
    const pending = await pendingNotice(f, record => f.internal.publishReviewDecision(record));
    await pending.session.finish(pending.input);
    const output = await exportRuntimeData(f.store, f.runtime);
    const state = output.contextState as { personalMemory: { versions: unknown[]; archive: unknown }; sourceReviews: ReturnType<ReviewDecisions['export']> };
    assert.ok(state.personalMemory);
    assert.ok(JSON.stringify(state.personalMemory).includes('owner-command'));
    assert.ok(JSON.stringify(state.personalMemory).includes('owner.role'));
    assert.equal(state.sourceReviews.decisions.length, 1);
    assert.equal(state.sourceReviews.publications[0].state, 'delivered');
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('an invalidated decision is never resurrected by replaying its immutable prepared record', async () => {
  const f = await fixture(); let decision!: ReviewDecisionRecord;
  try {
    const pending = await pendingNotice(f, record => { decision = record; throw new Error('defer publication'); });
    await assert.rejects(pending.session.finish(pending.input), /defer publication/);
    f.runtime.inbox.transitionReviewOutbox(decision.id, 'invalidated', undefined, 'source_unavailable');
    f.internal.publishReviewDecision(decision);
    f.internal.flushReviewOutbox();
    assert.equal(f.store.get('messages', decision.messageId!), undefined);
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'invalidated');
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('cancellation settles already accepted local publication before acknowledging the drain', async () => {
  const f = await fixture(); let decision!: ReviewDecisionRecord;
  try {
    const pending = await pendingNotice(f, record => { decision = record; throw new Error('defer publication'); });
    await assert.rejects(pending.session.finish(pending.input), /defer publication/);
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'pending');
    await f.runtime.cancel();
    assert.equal(f.store.get('messages', decision.messageId!)?.content, pending.input.message);
    assert.equal(f.runtime.inbox.reviewOutbox(decision.id)?.state, 'delivered');
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('stale owner API edits return a concrete conflict and all accepted audit events stay outside inference', async () => {
  const f = await fixture();
  try {
    const first = await f.runtime.correctPersonalMemory('owner.identity', { value: 'Owner_A', purpose: 'identity',
      identity: { kind: 'alias', value: 'Owner_A', platform: 'wechat' }, scope: 'global', expectedRevision: 0 });
    const second = await f.runtime.correctPersonalMemory(first.key, { value: 'Owner_B', expectedRevision: first.revision });
    await assert.rejects(f.runtime.correctPersonalMemory(first.key, { value: 'STALE_VALUE', expectedRevision: first.revision }),
      error => error instanceof Error && 'status' in error && error.status === 409);
    const current = (await f.runtime.listPersonalMemory()).find(value => value.key === first.key)!;
    assert.equal(current.value, second.value);
    assert.equal(current.identity, undefined, 'a generic correction cannot silently retain the old structured alias');
    const audits = f.runtime.inbox.list().filter(value => value.kind === 'owner.memory');
    assert.equal(audits.length, 3);
    assert.ok(audits.every(value => value.status === 'processed'));
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('live state stays bounded while subject pages and full export retain older owner identity and all methods', async () => {
  const f = await fixture();
  try {
    const owner = await f.runtime.correctPersonalMemory('owner.old-alias', { value: 'Owner_A', purpose: 'identity',
      identity: { kind: 'alias', value: 'Owner_A', platform: 'wechat' }, scope: 'global' });
    for (let index = 0; index < 105; index++) await f.runtime.correctPersonalMemory(`method.${index}`, {
      value: `Synthetic method ${index}`, subject: 'agent', kind: 'experience', scope: 'global' });
    const view = await f.runtime.snapshot();
    assert.equal(view.understanding.length, 100);
    assert.equal(view.understandingPage?.total, 106);
    assert.equal(view.understandingPage?.nextOffset, 100);
    assert.equal(view.understanding.some(value => value.key === owner.key), false, 'the oldest entry is outside the mixed live page');
    const ownerResponse = await routeRuntime(f.runtime, '/api/personal-memory', 'GET', undefined,
      new URLSearchParams({ offset: '0', limit: '7', subject: 'owner' }));
    const ownerPage = ownerResponse.body as PersonalMemoryPage;
    assert.equal(ownerPage.total, 1);
    assert.equal(ownerPage.entries[0].key, owner.key);
    assert.equal(ownerPage.nextOffset, null);
    const methodKeys: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const response = await routeRuntime(f.runtime, '/api/personal-memory', 'GET', undefined,
        new URLSearchParams({ offset: String(offset), limit: '17', subject: 'agent' }));
      const page = response.body as PersonalMemoryPage;
      assert.equal(page.total, 105); assert.ok(page.entries.length <= 17);
      methodKeys.push(...page.entries.map(value => value.key)); offset = page.nextOffset;
    }
    assert.equal(new Set(methodKeys).size, 105);
    const output = await exportRuntimeData(f.store, f.runtime);
    assert.equal(output.understanding.length, 106, 'explicit export is complete even though the live projection is bounded');
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});
