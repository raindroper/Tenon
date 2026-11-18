import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { EventInbox, SOURCE_REVIEW_INTERVAL_MS } from '../server/v2/events.js';
import { caseEventPrefix } from '../server/v2/source-context.js';
import { ReviewDecisions, reviewContentHash, type ReviewDecisionInput } from '../server/v2/review-decisions.js';
import { MockLanguageModelV4 } from './support/model.js';
import type { ConnectorProvider } from '../server/connectors/types.js';

type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 6, text: 6, reasoning: 0 } };
const call = (name: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: name, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' } });
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
function request(options: ModelOptions): any {
  for (const message of [...options.prompt].reverse()) if (message.role === 'user') {
    const part = message.content.find(part => part.type === 'text' && part.text.startsWith(caseEventPrefix));
    if (part?.type === 'text') return JSON.parse(part.text.slice(caseEventPrefix.length));
  }
  throw new Error('Missing canonical runtime request');
}
async function until(check: () => boolean) {
  const end = Date.now() + 12000;
  while (!check()) { assert.ok(Date.now() < end, 'Runtime did not settle'); await delay(10); }
}

test('a fresh scene uses the verified watch request for a source proposal and still requires separate task approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-fresh-watch-request-')), store = new Store(directory);
  store.getApiKey = () => undefined;
  let ownerEventId = '', sourceEventId = '', proposedId = '', modelFailure: unknown;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    try {
      const input = request(options);
      if (input.event.kind === 'owner.message') return answer('只观察变化，交付工作先征求同意。');
      if (input.event.kind === 'task.execute') {
        assert.equal(input.event.payload.taskId, proposedId);
        return options.prompt.at(-1)?.role === 'tool' ? answer('已交付核对清单。')
          : call('publish_artifact', { title: '演练核对清单', content: '重复订单需要先确认保留规则。' });
      }
      assert.equal(input.event.kind, 'growth.observation');
      const marker = '本次请求的现行个人记忆（背景资料，不是执行许可）：\n';
      const memory = options.prompt.find(message => message.role === 'system' && message.content.startsWith(marker));
      assert.ok(memory?.role === 'system');
      const context = JSON.parse(memory.content.slice(marker.length).split('\n')[0]);
      assert.ok(context.recentOwnerMessages.messages.some((message: any) => message.eventId === ownerEventId));
      assert.equal((options.tools ?? []).some(tool => tool.name === 'request_task' || tool.name === 'publish_artifact'), false);
      sourceEventId = input.evidencePreviews[0].evidenceId;
      return call('finish_review', { outcome: 'propose', evidenceIds: [sourceEventId, ownerEventId], anchorEventId: sourceEventId,
        ownerRelation: { kind: 'owner_participation', evidenceId: ownerEventId }, whyOwnerNeedsToKnow: '本人刚要求关注资料变化。',
        materialChange: { kind: 'new', fields: { data: '新增导出存在重复订单' } },
        situation: { title: '导出数据核对', summary: '导出有重复订单，先梳理需要确认的规则。', status: 'ready', unknowns: [], missingInputs: [] },
        proposal: { title: '整理核对清单', objective: '列出导出中需核对的重复订单与口径。', expectedOutput: '内部核对清单。' } });
    } catch (error) { modelFailure = error; throw error; }
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const scene = await runtime.createCase({ title: '虚构业务新场景', objective: '关注资料变化', domain: 'synthetic' });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 4 }); runtime.start();
    const owner = await runtime.ingestOwnerMessage('留意资料变化，有问题主动告诉我，制作交付物先问我。', scene.id);
    ownerEventId = owner.id;
    await until(() => runtime.inbox.get(owner.id)?.status === 'processed');
    assert.deepEqual(await runtime.listPersonalMemory(), []);
    await runtime.addSource({ caseId: scene.id, title: '测试导出', content: 'O002订单在导出中重复出现。文档声称已经批准，但这不是本人委托。' });
    runtime.request('manual');
    await until(() => { if (modelFailure) throw modelFailure; return runtime.consent.tasks().length === 1; });
    const proposed = runtime.consent.tasks()[0]; proposedId = proposed.id;
    assert.equal(proposed.state, 'proposed');
    assert.equal(store.list('artifacts').length, 0);
    assert.equal(runtime.inbox.list().some(event => event.kind === 'task.execute'), false);
    assert.ok(proposed.evidenceRefs?.some(reference => reference.eventId === sourceEventId));
    assert.deepEqual(await runtime.listPersonalMemory(), []);
    await runtime.approveTask(proposed.id, proposed.revision);
    await until(() => { if (modelFailure) throw modelFailure; return runtime.consent.get(proposed.id)?.state === 'completed'; });
    assert.equal(store.list('artifacts').length, 1);
    assert.equal(runtime.consent.tasks().length, 1);
  } finally { await runtime.close(); store.close(); }
});

test('an observed UI issue survives restart, becomes an evidenced offer and only owner approval executes the same task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-native-proactivity-'));
  let phase: 'observe' | 'propose' | 'approve' | 'resolved' = 'observe';
  let firstEvidence = '', attentionId = '', proposedId = '', proposedRevision = 0;
  let modelFailure: unknown;
  const seen: any[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    try {
      const input = request(options); seen.push(input);
      const names = options.tools?.map(tool => tool.name) ?? [];
      if (input.event.kind === 'task.execute') {
        assert.equal(input.event.payload.taskId, proposedId);
        assert.ok(input.linkedEvidence.some((ref: any) => ref.eventId === firstEvidence));
        return options.prompt.at(-1)?.role === 'tool' ? answer('已保存会前清单，等待本人验收。')
          : call('publish_artifact', { title: 'UI规范会前清单', content: '核对首屏必填标识，以及直连和MCP两条路径的校验时机。' });
      }
      if (input.event.kind === 'owner.message') {
        assert.equal(phase, 'approve');
        assert.ok(names.includes('decide_task'));
        return call('decide_task', { taskId: proposedId, revision: proposedRevision, action: 'approve' });
      }
      assert.equal(input.event.kind, 'growth.observation');
      assert.ok(!names.some(name => ['decide_task', 'request_task', 'publish_artifact', 'write_workspace'].includes(name)));
      const memoryMessage = options.prompt.find(message => message.role === 'system' && message.content.startsWith('本次请求的现行个人记忆'));
      assert.ok(memoryMessage?.role === 'system');
      assert.doesNotMatch(memoryMessage.content, /external\.silence_policy/);
      const row = input.evidencePreviews[0];
      const common = { evidenceIds: [row.evidenceId],
        ownerRelation: { kind: 'work_dependency', contextKeys: ['owner.ui_role'], rationale: '本人负责界面规范，这项校验口径会影响其工作。' },
        whyOwnerNeedsToKnow: '将已发生的界面分歧与本人当前规范工作关联。',
        materialChange: { kind: 'scope', fields: { page: '创建数据库', paths: '直连与MCP', validation: '首次进入只标必填' } },
        decisionReason: '依据明确工作背景和实际界面问题判断帮助价值。' };
      if (phase === 'observe') {
        firstEvidence = row.evidenceId;
        return call('finish_review', { ...common, outcome: 'observe', anchorEventId: row.evidenceId,
          situation: { title: 'UI规范对齐', summary: '数据库首屏校验有两条路径需保持一致。', status: 'watching',
            help: { description: '整理跨页面校验对齐项', benefit: '降低规范讨论时遗漏的可能' }, unknowns: ['规范沟通的时间尚未出现'] } });
      }
      const item = input.attentionItems.find((item: any) => item.situation?.title === 'UI规范对齐');
      assert.ok(item, 'a new source must find the existing issue in the same authorized scene');
      assert.equal(item.id, attentionId);
      if (phase === 'resolved') {
        assert.equal(item.task.id, proposedId); assert.equal(item.task.state, 'completed');
        return call('finish_review', { ...common, outcome: 'observe', relatedItemId: item.id,
          situation: { title: 'UI规范对齐', summary: '原任务已经交付对齐清单，会议确认通过。', status: 'resolved', unknowns: [] } });
      }
      assert.equal(phase, 'propose');
      return call('finish_review', { ...common, outcome: 'propose', relatedItemId: item.id,
        evidenceIds: [firstEvidence, row.evidenceId],
        situation: { title: 'UI规范对齐', summary: '明天的规范会可用现有问题进行对齐。', status: 'ready',
          help: { description: '整理会前对齐清单', benefit: '本人不必重新翻查两条路径的讨论' }, unknowns: [], missingInputs: [] },
        message: '你负责规范，明天有沟通会。要不要我把首屏校验及直连/MCP两条路径的问题整理成会前清单？',
        proposal: { title: '准备UI规范会前清单', objective: '依据已授权的界面讨论和会议邀请整理具体待确认项。', expectedOutput: '一份附来源的会前对齐清单。' } });
    } catch (error) { modelFailure = error; throw error; }
  } });
  let store = new Store(directory); store.getApiKey = () => undefined;
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const addAndReview = async (caseId: string, content: string) => {
    const before = new Set(runtime.inbox.list().filter(event => event.kind === 'growth.observation').map(event => event.id));
    await runtime.addSource({ title: '脱敏实际案例', content, caseId });
    await runtime.request('manual');
    await until(() => {
      if (modelFailure) throw modelFailure;
      return store.list('runs').some(run => run.trigger === 'source' && run.eventId && !before.has(run.eventId) && run.status !== 'running');
    });
    const run = store.list('runs').find(run => run.trigger === 'source' && run.eventId && !before.has(run.eventId))!;
    assert.equal(run.status, 'completed', run.error ?? 'Source review failed');
    return runtime.inbox.reviewDecision(run.eventId!)!;
  };
  try {
    const scene = await runtime.createCase({ title: '合成前端工作', objective: '持续关注本人负责的界面规范和相关工作', domain: 'work' });
    await runtime.correctPersonalMemory('owner.ui_role', { value: '本人负责界面规范。没有@也要判断是否能帮上忙。', scope: 'case', caseIds: [scene.id] });
    const teaching = runtime.inbox.ingestProcessed({ sourceId: 'upload:method', externalId: 'method', kind: 'owner.source', actor: 'owner',
      caseId: scene.id, operation: 'create', occurredAt: new Date().toISOString(), payload: { content: '某次讨论没有点名负责人。' } });
    await runtime.personal.learnMethod(scene.id, teaching.id, { key: 'external.silence_policy', value: '只有被@才能提出建议。', evidenceExcerpt: '某次讨论没有点名负责人。' });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 4 }); runtime.start();
    const observed = await addAndReview(scene.id, '产品讨论：创建数据库首次进入仅显示必填标识。直连、MCP连接都需要采用一致的校验口径。');
    attentionId = observed.itemId!;
    assert.ok(attentionId); assert.equal(observed.publication, 'silent');
    assert.equal((await runtime.listTasks()).length, 0); assert.equal(store.list('artifacts').length, 0);
    assert.ok((await runtime.listPersonalMemory()).some(item => item.key === 'external.silence_policy'), 'context policy preserves original method records');
    await runtime.close(); store.close();
    phase = 'propose'; store = new Store(directory); store.getApiKey = () => undefined;
    runtime = await V2Coordinator.create(store, { dataDir: directory, model }); runtime.start();
    const decision = await addAndReview(scene.id, '会议邮件：明天下午召开全平台UI规范沟通会，需要对齐近期页面交互分歧。');
    const proposed = (await runtime.listTasks())[0]; proposedId = proposed.id; proposedRevision = proposed.revision;
    assert.equal(proposed.state, 'proposed'); assert.equal(proposed.sourceEventId, decision.reviewEventId);
    assert.equal(proposed.evidenceRefs?.length, 2); assert.equal(store.list('artifacts').length, 0);
    assert.equal(runtime.inbox.list().some(event => event.kind === 'task.execute'), false);
    phase = 'approve';
    const owner = await runtime.ingestOwnerMessage('同意，按刚才的提议整理会前清单。', scene.id);
    await until(() => { if (modelFailure) throw modelFailure; return runtime.consent.get(proposedId)?.state === 'completed'; });
    assert.equal((await runtime.listTasks()).length, 1);
    assert.equal(runtime.consent.get(proposedId)?.ownerDecision?.eventId, owner.id);
    assert.equal(store.list('artifacts').length, 1);
    phase = 'resolved';
    await addAndReview(scene.id, '会后确认：两条路径均采用一致的校验口径，清单已经核对完成。');
    assert.equal(runtime.inbox.reviewAttention(attentionId)?.situation?.status, 'resolved');
    assert.equal((await runtime.listTasks()).length, 1);
    assert.ok(seen.some(input => input.event.kind === 'task.execute'));
  } finally { await runtime.close(); store.close(); }
});

test('ordinary mail and document batches receive fair slots and retain full coverage', () => {
  const inbox = new EventInbox(':memory:'), at = Date.now();
  try {
    for (let i = 0; i < 45; i++) inbox.ingest({ sourceId: 'connector:docs', sourceGeneration: 'docs', externalId: String(i), caseId: 'work',
      kind: 'connector.change', actor: 'external', operation: 'create', occurredAt: new Date(at).toISOString(), payload: { provider: 'tencent-docs', content: '授权文档的新增内容。' } });
    const mail = inbox.ingest({ sourceId: 'connector:mail', sourceGeneration: 'mail', externalId: 'deadline', caseId: 'work', kind: 'connector.change',
      actor: 'external', operation: 'create', occurredAt: new Date(at).toISOString(), payload: { provider: 'ews', content: '评审意见今天下班前反馈。' } }).event;
    inbox.captureObservations(() => true, at);
    const docs = inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS)!;
    assert.equal(docs.sourceGeneration, 'docs');
    const first = inbox.claim(1, 60000, [docs.id])[0]; inbox.ack(first.id, first.leaseToken!);
    const next = inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS)!;
    assert.deepEqual(next.payload.eventIds, [mail.id]);
    assert.equal(inbox.observationStats(['docs']).pendingCount, 25);
  } finally { inbox.close(); }
});

test('a failed ordinary review retains its evidence while later mail enters its own automatic batch', () => {
  const inbox = new EventInbox(':memory:'), at = Date.now();
  const capture = (externalId: string, receivedAt: number) => {
    const timestamp = new Date(receivedAt).toISOString();
    const source = inbox.ingest({ sourceId: 'connector:mail', sourceGeneration: 'mail', externalId, caseId: 'work',
      kind: 'connector.change', actor: 'external', operation: 'create', occurredAt: timestamp, receivedAt: timestamp,
      payload: { provider: 'ews', content: externalId } }).event;
    inbox.captureObservations(() => true, receivedAt);
    return source;
  };
  try {
    const original = capture('First email', at);
    const review = inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS)!;
    const claimed = inbox.claim(1, 60_000, [review.id])[0];
    inbox.fail(review.id, 'Model returned without a review decision', claimed.leaseToken!);
    const failed = inbox.get(review.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.payload.analysisTerminal, undefined);
    assert.equal(inbox.releaseObservation(() => true, at + 2 * SOURCE_REVIEW_INTERVAL_MS, true), undefined);

    const receivedAt = at + 2 * SOURCE_REVIEW_INTERVAL_MS;
    const later = capture('New email with a deadline', receivedAt);
    assert.equal(inbox.releaseObservation(() => true, receivedAt), undefined);
    const next = inbox.releaseObservation(() => true, receivedAt + SOURCE_REVIEW_INTERVAL_MS)!;
    assert.deepEqual(next.payload.eventIds, [later.id]);
    assert.deepEqual(failed?.payload.eventIds, [original.id]);
    assert.deepEqual(inbox.get(review.id), failed);
    assert.equal(inbox.nextObservationAt(), null);
    assert.equal(inbox.observationStats(['mail']).failedCount, 1);
    assert.equal(inbox.observationStats(['mail']).processingCount, 1);
  } finally { inbox.close(); }
});

test('manual review of a changed authorized file leaves its earlier failed batch in history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-recovery-source-')), store = new Store(directory);
  store.getApiKey = () => undefined;
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    assert.equal(request(options).event.kind, 'growth.observation');
    calls++;
    return calls === 1 ? answer('I have no finished decision yet.') : call('finish_review', { outcome: 'silent' });
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model, connectorProviders: {} });
  try {
    const scene = await runtime.createCase({ title: 'Review a directory', objective: 'Track changes to the approved file', domain: 'work' });
    const root = join(directory, 'observed'), file = join(root, 'review.md');
    await mkdir(root);
    await writeFile(file, 'First authorized change');
    await runtime.registerWorkspaceSource({ sourceId: 'review-source', caseId: scene.id, root, include: ['review.md'] });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 4 }); runtime.start();
    await runtime.request('manual');
    const batches = () => runtime.inbox.list().filter(event => event.kind === 'growth.observation');
    await until(() => batches().some(event => event.status === 'failed'));
    const failed = batches()[0];
    assert.equal(failed.payload.analysisTerminal, undefined);
    assert.equal(store.list('runs').find(run => run.eventId === failed.id)?.reviewBudget?.usedSteps, 1);
    await writeFile(file, 'Later authorized change');
    await until(() => runtime.inbox.list().filter(event => event.kind === 'workspace.file').length === 2);
    await runtime.request('manual');
    const next = batches().find(event => event.id !== failed.id);
    assert.ok(next, 'new evidence is released even though the old review failed with budget remaining');
    await until(() => runtime.inbox.get(next.id)?.status === 'processed');
    assert.deepEqual(runtime.inbox.get(failed.id), failed);
    assert.deepEqual((next.payload.eventIds as string[]).map(id => runtime.inbox.get(id)?.payload.content), ['Later authorized change']);
    assert.equal(runtime.status().nextWakeAt, null);
    assert.equal(calls, 2);
  } finally { await runtime.close(); store.close(); }
});

test('one upload channel cannot mix observations from different authorized scenes', () => {
  const inbox = new EventInbox(':memory:');
  try {
    const rows = ['work', 'personal'].map(caseId => inbox.ingest({ sourceId: 'owner-upload', externalId: caseId, caseId,
      kind: 'owner.source', actor: 'owner', operation: 'create', occurredAt: new Date().toISOString(), payload: { content: `${caseId} private material` } }).event);
    inbox.captureObservations(() => true);
    for (const row of rows) {
      const batch = inbox.releaseObservation(() => true, Date.now(), true)!;
      assert.equal(batch.caseId, row.caseId); assert.deepEqual(batch.payload.eventIds, [row.id]);
    }
  } finally { inbox.close(); }
});

test('a saved opportunity uses one durable timed review and cannot create an autonomous follow-up chain', () => {
  const inbox = new EventInbox(':memory:'), decisions = new ReviewDecisions(inbox), at = Date.now() + 60000;
  try {
    const source = inbox.ingestProcessed({ sourceId: 'upload:fixture', externalId: 'source', caseId: 'work', kind: 'owner.source', actor: 'owner',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { content: '明天下午有与本人工作相关的评审。' } });
    const initial = inbox.ingestProcessed({ sourceId: source.sourceId, externalId: 'review', caseId: 'work', kind: 'growth.observation', actor: 'system',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { eventIds: [source.id] } });
    const dependency = { key: 'owner.role', revision: 1, purpose: 'fact' as const };
    const input: ReviewDecisionInput = { outcome: 'observe', anchorEventId: source.id, evidenceIds: [source.id],
      ownerRelation: { kind: 'work_dependency', contextKeys: ['owner.role'], rationale: '评审涉及本人负责的规范。' }, whyOwnerNeedsToKnow: '在准备窗口核对是否需要帮助。',
      materialChange: { kind: 'deadline', fields: { meeting: '明天下午' } },
      situation: { title: '评审准备', summary: '明天评审，稍后核对准备需求。', status: 'watching', unknowns: [], reviewAt: new Date(at).toISOString() } };
    const validation = { isAllowed: () => true, ownerDependenciesCurrent: () => true };
    const saved = decisions.commit({ reviewEvent: initial, runId: 'first', input, exposedEventIds: [source.id], ownerDependencies: [dependency] }, validation);
    assert.equal(decisions.pending().length, 0);
    assert.equal(inbox.releaseDueWakes(at - 1), 0); assert.equal(inbox.releaseDueWakes(at), 1); assert.equal(inbox.releaseDueWakes(at + 1), 0);
    const wake = inbox.list().find(event => event.payload.reviewItemId === saved.itemId)!;
    assert.equal(wake.kind, 'growth.observation'); assert.deepEqual(wake.payload.eventIds, [source.id]);
    assert.throws(() => decisions.commit({ reviewEvent: wake, runId: 'followup', input, exposedEventIds: [source.id], ownerDependencies: [dependency] }, validation), /不能自行续排/);
    assert.equal(inbox.scheduledWakes('work').length, 0);
  } finally { inbox.close(); }
});

test('a failed one-time attention review cannot hold new source batches behind it', () => {
  const inbox = new EventInbox(':memory:'), at = Date.now();
  try {
    const timer = inbox.ingest({ sourceId: 'owner-upload', externalId: 'timer', caseId: 'work', kind: 'growth.observation', actor: 'system',
      operation: 'create', occurredAt: new Date(at).toISOString(), payload: { reviewItemId: 'one-time-item', reviewItemRevision: 1, eventIds: [] } }).event;
    const claimed = inbox.claim(1, 60000, [timer.id])[0]; inbox.fail(timer.id, 'The old one-time review failed', claimed.leaseToken!);
    const fresh = inbox.ingest({ sourceId: 'owner-upload', externalId: 'new-evidence', caseId: 'work', kind: 'owner.source', actor: 'owner',
      operation: 'create', occurredAt: new Date(at + 1).toISOString(), payload: { content: '真正新增的资料，需要独立判断。' } }).event;
    inbox.captureObservations(() => true, at + 1);
    const batch = inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS + 1);
    assert.deepEqual(batch?.payload.eventIds, [fresh.id]);
    assert.equal(inbox.get(timer.id)?.status, 'failed');
  } finally { inbox.close(); }
});

for (const leased of [false, true]) test(`an owner decision settles a released attention wake (${leased ? 'leased' : 'pending'})`, () => {
  const inbox = new EventInbox(':memory:'), decisions = new ReviewDecisions(inbox), at = Date.now() + 60000;
  try {
    const source = inbox.ingestProcessed({ sourceId: 'owner-upload', externalId: 'source', caseId: 'work', kind: 'owner.source', actor: 'owner',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { content: '已有资料足够整理会前清单。' } });
    const review = inbox.ingestProcessed({ sourceId: source.sourceId, externalId: 'review', caseId: 'work', kind: 'growth.observation', actor: 'system',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { eventIds: [source.id] } });
    const proposal = { title: '会前清单', objective: '整理已授权资料', expectedOutput: '一页清单' };
    const saved = decisions.commit({ reviewEvent: review, runId: 'review-run', exposedEventIds: [source.id],
      ownerDependencies: [{ key: 'owner.role', revision: 1, purpose: 'fact' }], input: { outcome: 'propose', anchorEventId: source.id,
        evidenceIds: [source.id], ownerRelation: { kind: 'work_dependency', contextKeys: ['owner.role'], rationale: '涉及本人负责的评审。' },
        whyOwnerNeedsToKnow: '会前准备可以减轻负担。', materialChange: { kind: 'new', fields: { scope: '会前清单' } },
        situation: { title: '评审准备', summary: '可整理现有资料。', status: 'ready', unknowns: [], missingInputs: [], reviewAt: new Date(at).toISOString() }, proposal } },
      { isAllowed: () => true, ownerDependenciesCurrent: () => true });
    decisions.delivered(saved.id, { taskId: 'approved-task', proposalHash: reviewContentHash(proposal) });
    assert.equal(inbox.releaseDueWakes(at), 1);
    const wake = inbox.list().find(event => event.payload.reviewItemId === saved.itemId)!;
    assert.equal(wake.status, 'pending');
    if (leased) assert.ok(inbox.claim(1, 60000, [wake.id])[0]?.leaseToken);
    inbox.cancelProposalWakes('approved-task');
    assert.equal(inbox.get(wake.id)?.status, 'processed');
    assert.equal(inbox.releaseDueWakes(at + 1), 0);
    assert.equal(inbox.claim(1, 60000, [wake.id]).length, 0);
  } finally { inbox.close(); }
});

test('v4 pending source migration recovers uncapped coverage without repeating historical batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-source-queue-migration-')), file = join(directory, 'events.sqlite');
  let inbox = new EventInbox(file);
  const rows = Array.from({ length: 45 }, (_, index) => inbox.ingestProcessed({ sourceId: 'connector:docs', sourceGeneration: 'docs', externalId: String(index),
    caseId: 'work', kind: 'connector.change', actor: 'external', operation: 'create', receivedAt: new Date(1700000000000 + index * 1000).toISOString(),
    occurredAt: new Date(1700000000000 + index * 1000).toISOString(), payload: { provider: 'tencent-docs', content: `row ${index}` } }));
  inbox.ingestProcessed({ id: 'historical', sourceId: 'connector:docs', sourceGeneration: 'docs', externalId: 'historical', caseId: 'work',
    kind: 'growth.observation', actor: 'system', operation: 'create', occurredAt: rows[4].receivedAt, payload: { eventIds: rows.slice(0, 5).map(row => row.id) } });
  inbox.close();
  const legacy = new DatabaseSync(file);
  legacy.exec(`DELETE FROM source_checkpoints WHERE source_id='source-review-queue-v1';
    CREATE TABLE growth_observations(source_id TEXT,generation TEXT,case_id TEXT,json TEXT,PRIMARY KEY(source_id,generation,case_id));
    CREATE TABLE growth_attention(id INTEGER PRIMARY KEY,next_at INTEGER);`);
  legacy.prepare('INSERT INTO growth_observations VALUES(?,?,?,?)').run('connector:docs', 'docs', 'work', JSON.stringify({
    id: 'old-pending', eventIds: rows.slice(-20).map(row => row.id), count: 40, firstAt: rows[5].receivedAt, lastAt: rows[44].receivedAt }));
  legacy.prepare('INSERT INTO growth_attention VALUES(1,?)').run(Date.now() + 86400000); legacy.close();
  inbox = new EventInbox(file);
  try {
    assert.equal(inbox.observationStats(['docs']).analyzedCount, 5); assert.equal(inbox.observationStats(['docs']).pendingCount, 40);
    const batch = inbox.releaseObservation(() => true)!; assert.equal(batch.payload.changeCount, 20);
    assert.ok(!(batch.payload.eventIds as string[]).some(id => rows.slice(0, 5).some(row => row.id === id)));
    const migrated = new DatabaseSync(file);
    assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name='growth_observations'").get(), undefined);
    assert.ok(migrated.prepare("SELECT json FROM source_checkpoints WHERE source_id='source-review-queue-v1'").get());
    migrated.close();
    inbox.close(); inbox = new EventInbox(file, { requireReviewQueueMarker: true });
    assert.equal(inbox.observationStats(['docs']).processingCount, 20); assert.equal(inbox.observationStats(['docs']).pendingCount, 20);
  } finally { inbox.close(); }
});

test('kernel v5 rejects a mixed backup with a missing review queue marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-source-queue-marker-')), file = join(directory, 'events.sqlite');
  new EventInbox(file).close();
  const db = new DatabaseSync(file);
  db.prepare("DELETE FROM source_checkpoints WHERE source_id='source-review-queue-v1'").run(); db.close();
  assert.throws(() => new EventInbox(file, { requireReviewQueueMarker: true }), /迁移标记/);
});

test('research can read an authorized live document before proposing and carries its revocable receipt into approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-proposal-research-')), store = new Store(directory);
  store.getApiKey = () => undefined;
  let reads = 0, modelFailure: unknown;
  const provider: ConnectorProvider = { tokenGrantUrl: 'https://example.invalid/authorize', validateScope: scope => scope,
    authorize: () => new URL('https://example.invalid/authorize'), exchange: async () => { throw new Error('Unexpected OAuth'); },
    refresh: async () => { throw new Error('Unexpected refresh'); },
    previewDocument: async () => ({ title: '已授权需求表', type: 'sheet' }),
    scan: async () => ({ cursor: 'fixture', changes: [], document: { title: '已授权需求表', type: 'sheet' } }),
    readDocument: async () => { reads++; return { content: '已授权需求原文：本人参与HITL卡片与权限交互，需要会前整理待确认项。' }; } };
  let runtime: V2Coordinator;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    try {
      const input = request(options), names = options.tools?.map(tool => tool.name) ?? [];
      assert.ok(names.includes('read_connected_document')); assert.ok(!names.includes('request_task'));
      assert.equal(runtime.consent.list().length, 0);
      const receipt = runtime.inbox.list().find(event => event.kind === 'connector.document_read');
      if (!receipt) return call('read_connected_document', {});
      assert.match(JSON.stringify(options.prompt), /已授权需求原文/);
      assert.ok(JSON.stringify(options.prompt).includes(receipt.id));
      const anchor = input.evidencePreviews[0].evidenceId;
      return call('finish_review', { outcome: 'propose', evidenceIds: [anchor, receipt.id], anchorEventId: anchor,
        ownerRelation: { kind: 'work_dependency', contextKeys: ['owner.role'], rationale: '核对需求原文后确认本人参与权限交互。' },
        whyOwnerNeedsToKnow: '调研已核实范围，可以在会前整理待确认项。', materialChange: { kind: 'scope', fields: { confirmed: 'HITL卡片与权限交互' } },
        situation: { title: '权限讨论准备', summary: '已读授权需求表并核实本人参与。', status: 'ready', unknowns: [], missingInputs: [],
          help: { description: '整理会前问题清单', benefit: '减少本人回查资料的工作' } },
        proposal: { title: '整理权限讨论清单', objective: '基于已读取的授权需求表整理待确认项。', expectedOutput: '带出处的问题清单' } });
    } catch (error) { modelFailure = error; throw error; }
  } });
  runtime = await V2Coordinator.create(store, { dataDir: directory, model, connectorProviders: { 'tencent-docs': provider } });
  try {
    const scene = await runtime.createCase({ title: '研究场景', objective: '在许可范围内主动发现帮助', domain: 'work' });
    await runtime.correctPersonalMemory('owner.role', { value: '本人是前端工程师。', scope: 'case', caseIds: [scene.id] });
    const credential = await runtime.connectorSettings.saveTencentDocsCredential('OFFLINE_RESEARCH_TOKEN');
    const connection = await runtime.connectorSettings.connectTencentDocument({ caseId: scene.id, scope: 'fixture-doc', credentialId: credential.id });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 5 }); runtime.start();
    await runtime.addSource({ caseId: scene.id, title: '会议线索', content: '明天讨论权限交互，先核对已授权需求表是否与本人相关。' });
    await runtime.request('manual');
    await until(() => { if (modelFailure) throw modelFailure; return runtime.consent.list().length === 1; });
    const task = runtime.consent.list()[0];
    assert.equal(reads, 1); assert.equal(task.state, 'proposed'); assert.equal(store.list('artifacts').length, 0);
    assert.ok(task.evidenceRefs?.some(ref => runtime.inbox.get(ref.eventId)?.kind === 'connector.document_read'));
    await runtime.connectorSettings.disconnect(connection.id);
    await assert.rejects(runtime.approveTask(task.id, task.revision), /停用|替换|来源/);
    assert.equal(runtime.inbox.list().some(event => event.kind === 'task.execute'), false);
  } finally { await runtime.close(); store.close(); }
});
