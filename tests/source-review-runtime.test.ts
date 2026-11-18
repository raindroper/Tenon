import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { caseEventPrefix } from '../server/v2/source-context.js';
import { MockLanguageModelV4 } from './support/model.js';

type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
function context(options: Options): any {
  for (const message of [...options.prompt].reverse()) if (message.role === 'user') {
    const part = message.content.find(part => part.type === 'text' && part.text.startsWith(caseEventPrefix));
    if (part?.type === 'text') return JSON.parse(part.text.slice(caseEventPrefix.length));
  }
  throw new Error('Expected an actual source-review model input');
}
function personalContext(options: Options): any {
  const marker = '本次请求的现行个人记忆（背景资料，不是执行许可）：\n';
  const message = options.prompt.find(message => message.role === 'system' && message.content.startsWith(marker));
  assert.ok(message?.role === 'system', 'the actual provider prompt must contain the current memory projection');
  return JSON.parse(message.content.slice(marker.length).split('\n')[0]);
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Actual source review did not reach its saved outcome'); await delay(10); }
}

test('runtime preserves typed owner identity, joins split group replies and publishes only new evidence-bound notices with a local-time manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-source-review-runtime-')), store = new Store(directory);
  store.getApiKey = () => undefined;
  let calls = 0;
  let modelFailure: unknown;
  const inputs: any[] = [];
  const publicNotice = '同事答复：两种配置都会影响首次校验；实施负责人尚未确定。';
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    try {
    const input = context(options); inputs.push(input); calls++;
    assert.equal(input.event.kind, 'growth.observation');
    assert.ok(Array.isArray(input.executionStatus.devices));
    assert.ok(Array.isArray(input.executionStatus.localTasks));
    assert.ok(personalContext(options).identities.some((entry: any) => entry.key === 'owner.name' && entry.identity?.value === '合成姓名'));
    const names = options.tools?.map(tool => tool.name) ?? [];
    assert.ok(names.includes('finish_review'));
    assert.ok(names.includes('read_execution_status'));
    assert.ok(!names.some(name => ['notify_user', 'propose_task', 'request_task', 'publish_artifact', 'write_workspace', 'schedule_wake'].includes(name)));
    const row = input.observedMessages[0];
    const messages = input.conversationNeighborhoods[0].messages;
    assert.equal(row.temporal.sent.localDate, '2026-11-10'); assert.equal(row.temporal.sent.weekday, 2);
    assert.equal(row.temporal.sent.offsetSeconds, 28800); assert.equal(row.temporal.referenceTimezone, null);
    const question = messages.find((message: any) => message.senderName === '合成姓名');
    let decision: unknown;
    if (calls === 1 || calls === 4) {
      decision = { outcome: 'silent', evidenceIds: [row.id] };
    } else {
      assert.ok(question, 'the owner question from the previous batch must remain in the same-conversation neighborhood');
      assert.equal(question.newInBatch, false); assert.equal(question.isSelf, null);
      assert.equal(question.temporal.sent.localTime, '00:00:00');
      assert.equal(row.senderName, '同事');
      if (calls === 3) assert.equal(input.attentionItems.length, 1);
      decision = { outcome: 'notify', evidenceIds: [question.id, row.id],
        ...(calls === 2 ? { anchorEventId: question.id } : { relatedItemId: input.attentionItems[0].id }),
        ownerRelation: { kind: 'inferred_reply', questionEventId: question.id, answerEventIds: [row.id], ownerMemoryKey: 'owner.name',
          rationale: '本批解释直接回答了同一会话中本人上一批的问题。' },
        whyOwnerNeedsToKnow: '本人等待的问题已有答复，即使实施负责人尚未确定。',
        materialChange: { kind: 'answer', fields: { answer: '两种配置均影响首次校验', implementationOwner: 'unknown' } },
        message: calls === 2 ? publicNotice : '相同答复换一种措辞，不应再次打扰。' };
    }
    return { content: [{ type: 'text', text: 'UNCOMMITTED_INTERNAL_TEXT' }, { type: 'tool-call', toolCallId: randomUUID(), toolName: 'finish_review',
      input: JSON.stringify(decision) }], usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
    } catch (error) { modelFailure = error; throw error; }
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const scene = await runtime.createCase({ title: '合成前端工作', objective: '关注本人提问的实际答复', domain: 'work' });
    await runtime.correctPersonalMemory('owner.name', { value: '本人的姓名为合成姓名', purpose: 'identity',
      identity: { kind: 'name', platform: 'wechat', value: '合成姓名' } });
    assert.equal(store.getSettings().ownerName, '', 'the owner-name settings field must not be the only available identity source');
    const { device } = runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name: '合成测试设备', platform: 'win32' });
    const grant = await runtime.weChatObservations.start({ caseId: scene.id, deviceId: device.id, windowId: randomUUID(),
      title: '合成产品研发群', chatType: 'group', analysisIntervalMinutes: 10 });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 3, timezone: 'Asia/Shanghai' }); runtime.start();
    const analyze = async (text: string, senderName: string, sentAt: string) => {
      const previous = new Set(runtime.inbox.list().filter(event => event.kind === 'growth.observation').map(event => event.id));
      await runtime.weChatObservations.ingest(device.id, { grantId: grant.id, windowId: grant.windowId,
        rows: [{ id: randomUUID(), text, senderName, sentAt, messageType: 'text' }] });
      assert.equal((await runtime.weChatObservations.analyze(grant.id)).queued, true);
      const reviewed = () => runtime.inbox.list().find(event => event.kind === 'growth.observation' && !previous.has(event.id)
        && ['processed', 'failed'].includes(event.status));
      await until(() => { if (modelFailure) throw modelFailure; return Boolean(reviewed()); });
      const event = reviewed()!; assert.equal(event.status, 'processed', event.lastError ?? 'Source review failed');
      const run = () => store.list('runs').find(value => value.eventId === event.id && ['completed', 'failed'].includes(value.status));
      await until(() => Boolean(run())); assert.equal(run()!.status, 'completed');
      return { event, run: run()!, decision: runtime.inbox.reviewDecision(event.id)! };
    };
    const question = await analyze('这两种配置是否都影响首次校验？如果是请帮我改代码。', '合成姓名', '2026-11-09T16:00:00Z');
    assert.equal(question.decision.input.outcome, 'silent');
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 0);
    const answered = await analyze('这两种配置都会影响首次校验，实施负责人还没确定。', '同事', '2026-11-09T16:01:00Z');
    assert.equal(answered.decision.publication, 'pending');
    const published = store.list('messages').filter(message => message.role === 'assistant');
    assert.deepEqual(published.map(message => message.content), [publicNotice]);
    assert.equal(published[0].id, answered.decision.messageId); assert.equal(published[0].runId, answered.run.id);
    assert.equal(runtime.inbox.reviewOutbox(answered.decision.id)?.state, 'delivered');
    assert.ok(answered.run.contextManifest?.memories.some(entry => entry.key === 'owner.name' && entry.purpose === 'identity'));
    assert.equal(answered.run.contextManifest?.time?.asOf.timezone, 'Asia/Shanghai');
    assert.equal(answered.run.contextManifest?.time?.asOf.offsetSeconds, 28800);
    assert.ok(answered.run.reviewDecisionId); assert.equal(answered.run.steps, 1);
    const repeated = await analyze('补充确认：两种配置仍然都会影响首次校验，负责人尚未确定。', '同事', '2026-11-09T16:02:00Z');
    assert.equal(repeated.decision.publication, 'duplicate');
    const quiet = await analyze('普通协作信息，无需本人处理。', '同事', '2026-11-09T16:03:00Z');
    assert.equal(quiet.decision.input.outcome, 'silent');
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 1);
    assert.doesNotMatch(JSON.stringify(store.list('messages')), /UNCOMMITTED_INTERNAL_TEXT/);
    assert.equal(calls, 4); assert.equal(inputs.length, 4);
    assert.deepEqual(await runtime.listTasks(), []);
    assert.equal(runtime.inbox.list().some(event => event.kind === 'task.execute'), false,
      'an observed owner group message remains external material and cannot authorize task execution');
    assert.equal((await runtime.weChatObservations.status(grant.id)).analysis.analyzedCount, 4);
  } finally { await runtime.close(); store.close(); }
});

test('an acknowledged owner direction stays available to source review before long-term memory extraction and remains scene-bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-unsaved-owner-direction-')), store = new Store(directory);
  store.getApiKey = () => undefined;
  const policy = '没有需要我做决定的新内容时，不要给我发群聊汇报。';
  const otherPrivate = 'PRIVATE_OTHER_SCENE_OWNER_DIRECTION';
  const acknowledgment = 'ASSISTANT_ACKNOWLEDGMENT_IS_NOT_OWNER_EVIDENCE';
  let ownerCalls = 0, sourceCalls = 0, modelFailure: unknown;
  let policyEventId = '', policyMessageId = '';
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    try {
      const input = context(options);
      if (input.event.kind === 'owner.message') {
        ownerCalls++;
        return { content: [{ type: 'text', text: acknowledgment }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } };
      }
      assert.equal(input.event.kind, 'growth.observation'); sourceCalls++;
      const current = personalContext(options);
      assert.deepEqual(current.identities, []); assert.deepEqual(current.interactionPolicies, []);
      assert.deepEqual(current.ownerFacts, []);
      assert.equal(current.recentOwnerMessages.messages.length, 1);
      assert.equal(current.recentOwnerMessages.messages[0].content, policy);
      assert.doesNotMatch(JSON.stringify(options.prompt), new RegExp(`${otherPrivate}|${acknowledgment}`));
      const names = options.tools?.map(tool => tool.name) ?? [];
      assert.ok(!names.includes('notify_user') && !names.includes('propose_task') && !names.includes('request_task'));
      return { content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'finish_review',
        input: JSON.stringify({ outcome: 'silent', evidenceIds: input.observedMessages.map((row: any) => row.id) }) }],
        usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
    } catch (error) { modelFailure = error; throw error; }
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const scene = await runtime.createCase({ title: '合成工作群', objective: '按当前交流要求观察', domain: 'work' });
    const other = await runtime.createCase({ title: '独立生活场景', objective: '保持来源边界', domain: 'personal' });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 3 }); runtime.start();
    for (const [content, caseId] of [[policy, scene.id], [otherPrivate, other.id]]) {
      const event = await runtime.ingestOwnerMessage(content, caseId);
      if (caseId === scene.id) { policyEventId = event.id; policyMessageId = String(event.payload.messageId); }
      await until(() => { if (modelFailure) throw modelFailure; return ['processed', 'failed'].includes(runtime.inbox.get(event.id)?.status ?? ''); });
      assert.equal(runtime.inbox.get(event.id)?.status, 'processed');
    }
    assert.equal(ownerCalls, 2); assert.deepEqual(await runtime.listPersonalMemory(), []);
    const before = store.list('messages').filter(message => message.role === 'assistant').map(message => message.id);
    const { device } = runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name: '合成设备', platform: 'win32' });
    const grant = await runtime.weChatObservations.start({ caseId: scene.id, deviceId: device.id, windowId: randomUUID(),
      title: '合成产品群', chatType: 'group', analysisIntervalMinutes: 10 });
    await runtime.weChatObservations.ingest(device.id, { grantId: grant.id, windowId: grant.windowId,
      rows: [{ id: randomUUID(), text: '普通界面修复已完成，不需要本人确认。', senderName: '同事', sentAt: '2026-11-09T16:00:00Z', messageType: 'text' }] });
    assert.equal((await runtime.weChatObservations.analyze(grant.id)).queued, true);
    const reviewed = () => runtime.inbox.list().find(event => event.kind === 'growth.observation' && event.caseId === scene.id
      && ['processed', 'failed'].includes(event.status));
    await until(() => { if (modelFailure) throw modelFailure; return Boolean(reviewed()); });
    assert.equal(reviewed()!.status, 'processed', reviewed()!.lastError ?? 'Expected a valid silent decision');
    const record = runtime.inbox.reviewDecision(reviewed()!.id)!;
    assert.equal(record.input.outcome, 'silent'); assert.equal(sourceCalls, 1);
    assert.ok(record.ownerDependencies.some(value => value.key === '$owner-recent' && value.scope?.caseId === scene.id));
    const sourceRun = store.list('runs').find(run => run.eventId === reviewed()!.id)!;
    assert.deepEqual(sourceRun.contextManifest?.recentOwner?.eventIds, [policyEventId]);
    assert.deepEqual(sourceRun.contextManifest?.recentOwner?.messageIds, [policyMessageId]);
    assert.equal(sourceRun.contextManifests?.length, 1);
    assert.equal(JSON.stringify(sourceRun.contextManifests).includes(policy), false, 'the per-dispatch manifest records exact references without duplicating private owner text');
    assert.deepEqual(await runtime.listPersonalMemory(), [], 'ordinary acknowledgment did not fabricate a durable preference');
    assert.deepEqual(store.list('messages').filter(message => message.role === 'assistant').map(message => message.id), before);
    assert.deepEqual(await runtime.listTasks(), []);
  } finally { await runtime.close(); store.close(); }
});

test('a WeChat meeting invite is delivered as one evidence-bound reminder in the existing conversation snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-meeting-reminder-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const title = '合成方案讨论';
  const alias = 'FixtureOwner';
  const group = '合成协作群';
  const sender = '合成组织者';
  const startsAt = '2026-11-11T14:00:00+08:00';
  const endsAt = '2026-11-11T15:00:00+08:00';
  const sentAt = '2026-11-11T05:55:00.000Z';
  const meetingNumber = '123 456 789';
  const publicNotice = '邀请中 @ 了你。合成方案讨论于北京时间 14:00 开始。';
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls++;
    const input = context(options);
    const evidenceId = input.observedMessages[0].id;
    return { content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'finish_review',
      input: JSON.stringify({
        outcome: 'notify', evidenceIds: [evidenceId], anchorEventId: evidenceId,
        ownerRelation: { kind: 'confirmed_alias', evidenceId, alias },
        whyOwnerNeedsToKnow: '邀请中 @ 了你。',
        materialChange: { kind: 'new', fields: { title, startsAt } },
        message: publicNotice,
        reminder: { kind: 'meeting', inviteEvidenceId: evidenceId, title, startsAt, endsAt,
          meetingNumber, password: { kind: 'none' }, unknowns: ['是否需要提前准备材料'] },
      }) }], usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const scene = await runtime.createCase({ title: '合成会议场景', objective: '关注提到本人的会议邀请', domain: 'work' });
    await runtime.correctPersonalMemory('owner.wechat-alias', { value: `本人的微信显示名为 ${alias}`, purpose: 'identity',
      identity: { kind: 'alias', platform: 'wechat', value: alias } });
    const { device } = runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name: '合成测试设备', platform: 'win32' });
    const grant = await runtime.weChatObservations.start({ caseId: scene.id, deviceId: device.id, windowId: randomUUID(),
      title: group, chatType: 'group', analysisIntervalMinutes: 10 });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 3, timezone: 'Asia/Shanghai' });
    runtime.start();
    await runtime.weChatObservations.ingest(device.id, { grantId: grant.id, windowId: grant.windowId, rows: [{
      id: randomUUID(), senderName: sender, sentAt, messageType: 'text',
      text: `@${alias} 会议主题：${title}\n会议时间：2026/11/11 14:00–15:00（UTC+8）\n会议号：${meetingNumber}，密码：无`,
    }] });
    assert.equal((await runtime.weChatObservations.analyze(grant.id)).queued, true);
    const review = () => runtime.inbox.list().find(event => event.kind === 'growth.observation' && event.caseId === scene.id);
    await until(() => ['processed', 'failed'].includes(review()?.status ?? ''));
    assert.equal(review()?.status, 'processed', review()?.lastError ?? 'Meeting source review failed');
    const decision = runtime.inbox.reviewDecision(review()!.id)!;
    assert.equal(runtime.inbox.reviewOutbox(decision.id)?.state, 'delivered');
    const view = await runtime.snapshot({ caseId: scene.id });
    const messages = view.messages.filter(message => message.role === 'assistant');
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message.id, decision.messageId);
    assert.equal(message.content, publicNotice);
    assert.deepEqual(message.reminder, {
      kind: 'meeting', title, startsAt, endsAt, meetingNumber, password: { kind: 'none' },
      ownerMentioned: true, reason: '会议邀请中 @ 了你。', source: { conversationTitle: group, senderName: sender, sentAt },
      unknowns: ['是否需要提前准备材料'],
    });
    assert.equal(Object.hasOwn(view.notificationMessages!.find(notice => notice.id === message.id)!, 'reminder'), false);
    assert.equal(calls, 1);
    assert.deepEqual(await runtime.listTasks(), []);
  } finally { await runtime.close(); store.close(); }
});
