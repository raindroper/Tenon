import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { WeChatObservationGrant } from '../shared/wechat-observation.js';
import { caseEventPrefix, caseSourceContext } from '../server/v2/source-context.js';

const usage = { inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const tool = (name: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: name, input: JSON.stringify(input) }], usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), 'Expected the real runtime to reach its saved outcome');
}
function lastResult(prompt: any[], name: string): any {
  return prompt.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === 'tool-result' && part.toolName === name).at(-1)?.output.value;
}
async function setup(respond: MockLanguageModelV4['doGenerate']) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-wechat-complete-flow-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, connectorProviders: {}, model: new MockLanguageModelV4({ doGenerate: respond }) });
  const { device } = runtime.devices.enroll({ pairingToken: runtime.devices.createPairing().token, name: 'Offline fixture computer', platform: 'win32' });
  const add = (caseId: string, title: string) => runtime.weChatObservations.start({ deviceId: device.id,
    caseId, title, windowId: randomUUID(), chatType: 'group', analysisIntervalMinutes: 10 });
  const send = async (grant: WeChatObservationGrant, texts: string[]) => {
    for (let offset = 0; offset < texts.length; offset += 20) {
      await runtime.weChatObservations.ingest(device.id, { grantId: grant.id, windowId: grant.windowId,
        rows: texts.slice(offset, offset + 20).map((text, index) => ({ id: `${offset + index}`, text,
          senderName: '离线测试同事', isSelf: false, sentAt: new Date(Date.UTC(2026, 10, 6, 1, offset + index)).toISOString(), messageType: 'text' })) });
    }
  };
  return { store, runtime, add, send, async close() { await runtime.close(); store.close(); } };
}

test('normal owner dialogue discovers group provenance and paginates original messages before automatic review', async t => {
  let calls = 0;
  let conversationId = '';
  const readIds = new Set<string>();
  const f = await setup(async options => {
    calls++;
    const serialized = JSON.stringify(options.prompt);
    assert.doesNotMatch(serialized, /PRIVATE_OTHER_TOPIC_BODY|UNRELATED_GROUP_BODY/);
    assert.ok(options.tools?.some(value => value.name === 'list_wechat_conversations'));
    if (calls === 1) return tool('list_wechat_conversations', {});
    if (calls === 2) {
      const result = lastResult(options.prompt, 'list_wechat_conversations');
      assert.equal(result.conversations.length, 3);
      assert.equal(result.otherTopics.length, 1);
      assert.equal(result.otherTopics[0].title, '其他主题研发群');
      assert.equal(result.otherTopics[0].caseTitle, '另一个主题');
      const selected = result.conversations.find((value: { title: string }) => value.title === 'EPAI-产品-研发沟通群');
      assert.equal(selected.totalMessages, 23);
      assert.equal(selected.analysis.analyzedCount, 0);
      conversationId = selected.conversationId;
      return tool('query_wechat_messages', { conversation: conversationId, limit: 20 });
    }
    const result = lastResult(options.prompt, 'query_wechat_messages');
    assert.equal(result.matched, true);
    for (const row of result.events) {
      assert.match(row.content, /^PRODUCT_MESSAGE_/);
      assert.equal(row.title, 'EPAI-产品-研发沟通群');
      assert.equal(row.senderName, '离线测试同事');
      assert.ok(row.sentAt); assert.equal(row.isSelf, false);
      assert.ok(!readIds.has(row.id)); readIds.add(row.id);
    }
    if (result.nextBefore) return tool('query_wechat_messages', { conversation: conversationId, limit: 20, before: result.nextBefore });
    assert.equal(readIds.size, 23);
    return answer('已核对产品研发沟通群的 23 条已接收文字，消息带有发送人与原始时间。');
  });
  t.after(() => f.close());
  const topic = await f.runtime.createCase({ title: '相处与成长', objective: '理解选定群聊中的产品进展', domain: 'work' });
  const other = await f.runtime.createCase({ title: '另一个主题', objective: '隔离另一个项目', domain: 'other' });
  const target = await f.add(topic.id, 'EPAI-产品-研发沟通群');
  const unrelated = await f.add(topic.id, '测试群');
  await f.add(topic.id, '尚无新消息群');
  const separate = await f.add(other.id, '其他主题研发群');
  await f.send(target, Array.from({ length: 23 }, (_, index) => `PRODUCT_MESSAGE_${index}`));
  await f.send(unrelated, ['UNRELATED_GROUP_BODY']);
  await f.send(separate, ['PRIVATE_OTHER_TOPIC_BODY']);
  await f.store.updateSettings({ enabled: true, maxStepsPerRun: 6 });
  f.runtime.start();
  const message = await f.runtime.ingestOwnerMessage('产品研发群今天有什么重要事情？', topic.id);
  await until(() => f.runtime.inbox.get(message.id)?.status === 'processed');
  assert.equal(calls, 4);
  assert.ok(f.store.list('messages').some(value => value.role === 'assistant' && value.content.includes('23 条')));
  assert.equal((await f.runtime.weChatObservations.status(target.id)).analysis.analyzedCount, 0,
    'an ordinary read does not falsely advance automatic analysis coverage');
  assert.deepEqual(await f.runtime.listTasks(), []);
});

test('source reviews use the configured budget, investigate before a single evidence-bound decision and finish explicitly', async t => {
  const oldOwnerText = 'RECENT_OWNER_INSTRUCTION_IS_READ_ONLY_CONTEXT';
  const oldReply = 'ASSISTANT_HISTORY_MUST_NOT_ENTER_BACKGROUND_REVIEW';
  const notice = '研发沟通群确认了本轮测试范围。';
  const sentAt = '2026-11-06T01:30:00.000Z';
  const reviewCalls: string[] = [];
  const callsByPage = new Map<string, number>();
  const f = await setup(async options => {
    const message = options.prompt.filter(value => value.role === 'user').at(-1);
    const current = (message?.content as Array<{ type: string; text?: string }> | undefined)
      ?.find(part => part.type === 'text' && part.text?.startsWith(caseEventPrefix))?.text;
    assert.ok(current);
    const context = JSON.parse(current.slice(caseEventPrefix.length));
    if (context.event.kind === 'owner.message') return answer(oldReply);

    assert.equal(context.event.kind, 'growth.observation');
    const names = options.tools?.map(value => value.name) ?? [];
    assert.ok(names.includes('finish_review'));
    assert.ok(!names.includes('remember_personal_memory'));
    for (const removed of ['notify_user', 'save_working_state', 'read_working_state', 'propose_task']) assert.ok(!names.includes(removed));
    assert.ok(!names.includes('write_workspace') && !names.includes('publish_artifact'));
    assert.doesNotMatch(JSON.stringify(options.prompt), new RegExp(oldReply));
    assert.match(JSON.stringify(options.prompt), new RegExp(oldOwnerText), 'bounded genuine owner statements remain available without importing assistant history');
    assert.equal(context.observedMessages.length, 1);
    const [observed] = context.observedMessages;
    assert.ok(observed.evidenceId);
    assert.equal(observed.senderName, '离线测试同事');
    assert.equal(observed.title, '研发沟通群');
    assert.equal(observed.sentAt, sentAt);
    const label = observed.content.replace('@Owner_Chat ', '');
    reviewCalls.push(label);
    const call = (callsByPage.get(label) ?? 0) + 1;
    callsByPage.set(label, call);
    const visible = (outcome: 'notify' | 'needs_input', message: string) => ({ outcome, message, evidenceIds: [observed.evidenceId], anchorEventId: observed.evidenceId,
      ownerRelation: { kind: 'confirmed_alias', evidenceId: observed.evidenceId, alias: 'Owner_Chat' }, whyOwnerNeedsToKnow: '同事直接请求本人确认本批测试事项。',
      materialChange: { kind: outcome === 'notify' ? 'status' : 'question', fields: { issue: label, status: outcome === 'notify' ? 'confirmed' : 'needs_owner' } } });
    if (label === '确认测试范围') {
      assert.ok(names.includes('read_event') && names.includes('learn_method'));
      if (call === 1) return tool('read_event', { eventId: observed.evidenceId });
      if (call === 2) return tool('learn_method', { key: 'method.review', value: '先确认范围，再核对负责人。',
        evidenceExcerpt: '确认测试范围', evidenceEventId: observed.evidenceId, scope: 'case', mode: 'observe' });
      if (call === 3) return tool('read_event', { eventId: observed.evidenceId });
      return tool('finish_review', visible('notify', notice));
    }
    assert.ok(context.attentionItems.some((item: { fields: { issue?: string } }) => item.fields.issue === '确认测试范围') || label === '重复读取夹具');
    assert.doesNotMatch(JSON.stringify(options.prompt), /研发沟通群确认了本轮测试范围/);
    if (label === '普通问候') return tool('finish_review', { outcome: 'silent', evidenceIds: [observed.evidenceId] });
    if (label === '待本人确认') return tool('finish_review', visible('needs_input', '需要确认本次负责人。'));
    if (label === '重复读取夹具') return tool('read_event', { eventId: observed.evidenceId });
    assert.equal(label, '预算耗尽夹具');
    if (call === 8) assert.deepEqual(names, ['finish_review'], 'the last in-budget step only closes the review');
    return tool('finish_review', { outcome: 'invalid' });
  });
  t.after(() => f.close());
  const topic = await f.runtime.createCase({ title: '后台汇报', objective: '了解选定群聊的真实决定', domain: 'work' });
  await f.runtime.correctPersonalMemory('fixture.alias', { value: '本人微信别名是 Owner_Chat', scope: 'domain', domains: ['work'], purpose: 'identity',
    identity: { kind: 'alias', value: 'Owner_Chat', platform: 'wechat' } });
  const grant = await f.add(topic.id, '研发沟通群');
  const notes = () => f.store.list('messages').filter(message => message.role === 'assistant' && message.content !== oldReply);
  await f.store.updateSettings({ enabled: true, maxStepsPerRun: 8 });
  f.runtime.start();
  const owner = await f.runtime.ingestOwnerMessage(oldOwnerText, topic.id);
  await until(() => f.runtime.inbox.get(owner.id)?.status === 'processed');
  assert.ok(f.store.list('messages').some(message => message.content === oldReply));

  const analyze = async (text: string, selectedGrant = grant) => {
    const previous = new Set(f.runtime.inbox.list().filter(event => event.kind === 'growth.observation').map(event => event.id));
    await f.runtime.weChatObservations.ingest(selectedGrant.deviceId, { grantId: selectedGrant.id, windowId: selectedGrant.windowId,
      rows: [{ id: randomUUID(), text: ['确认测试范围', '待本人确认'].includes(text) ? '@Owner_Chat ' + text : text,
        senderName: '离线测试同事', sentAt, isSelf: false, messageType: 'text' }] });
    assert.equal((await f.runtime.weChatObservations.analyze(selectedGrant.id)).queued, true);
    const batch = () => f.runtime.inbox.list().find(event => event.kind === 'growth.observation' && !previous.has(event.id)
      && (event.status === 'processed' || event.status === 'failed'));
    await until(() => Boolean(batch()));
    const event = batch()!;
    const savedRun = () => f.store.list('runs').find(run => run.eventId === event.id && (run.status === 'completed' || run.status === 'failed'));
    await until(() => Boolean(savedRun()));
    return { event, run: savedRun()! };
  };
  const notified = await analyze('确认测试范围');
  assert.equal(notified.event.status, 'processed');
  assert.equal(notified.event.attempts, 1);
  assert.equal(notified.run.steps, 4);
  assert.equal(notified.run.status, 'completed');
  assert.equal(notified.run.reviewOutcome, 'complete');
  assert.equal(notified.run.stopReason, undefined);
  assert.deepEqual(notes().map(message => ({ content: message.content, state: message.outputState })), [{ content: notice, state: 'complete' }]);
  assert.equal((await f.runtime.weChatObservations.status(grant.id)).analysis.analyzedCount, 1);
  const learned = (await f.runtime.memory.sharedForCase(topic.id)).find(value => value.key === 'method.review');
  assert.equal(learned?.personal?.subject, 'agent');
  assert.equal(learned?.personal?.level, 'hypothesis');
  assert.equal(await f.runtime.memory.getWorking(topic.id), null, 'source-review relations no longer overwrite one scene-wide note');

  const quiet = await analyze('普通问候');
  assert.equal(quiet.event.status, 'processed');
  assert.equal(quiet.run.steps, 1);
  assert.equal(quiet.run.status, 'completed');
  assert.equal(notes().length, 1);
  assert.equal((await f.runtime.weChatObservations.status(grant.id)).analysis.analyzedCount, 2);

  const blocked = await analyze('待本人确认');
  assert.equal(blocked.event.status, 'processed');
  assert.equal(blocked.run.reviewOutcome, 'needs_input');
  assert.ok(notes().some(message => message.content === '需要确认本次负责人。'));

  const limited = await analyze('预算耗尽夹具');
  assert.equal(limited.event.status, 'failed');
  assert.equal(limited.event.attempts, 1);
  assert.equal(limited.run.steps, 8);
  assert.equal(limited.run.stopReason, 'step_limit');
  assert.equal(notes().length, 2);
  assert.equal((await f.runtime.weChatObservations.status(grant.id)).analysis.analyzedCount, 3);
  const stalledGrant = await f.add(topic.id, '研发沟通群');
  const stalled = await analyze('重复读取夹具', stalledGrant);
  assert.equal(stalled.event.status, 'failed');
  assert.equal(stalled.event.attempts, 1);
  assert.equal(stalled.run.steps, 3);
  assert.equal(stalled.run.stopReason, 'no_progress');
  assert.equal((await f.runtime.weChatObservations.status(stalledGrant.id)).analysis.analyzedCount, 0);
  assert.ok(!f.runtime.inbox.list().some(event => event.kind === 'growth.observation' && event.status === 'pending'));
  assert.deepEqual(await f.runtime.listTasks(), []);
});

test('a complete automatic WeChat page proposes bounded work and executes only after the owner approves', async t => {
  let proposalCalls = 0;
  let executionCalls = 0;
  const f = await setup(async options => {
    const names = options.tools?.map(value => value.name) ?? [];
    if (options.prompt.at(-1)?.role === 'tool') return answer('已按当前许可状态记录结果。');
    if (names.includes('publish_artifact')) {
      executionCalls++;
      return tool('publish_artifact', { title: '获准整理', content: '根据批准范围整理的三条测试消息。', format: 'markdown' });
    }
    proposalCalls++;
    assert.ok(names.includes('finish_review'));
    assert.ok(!names.includes('propose_task') && !names.includes('notify_user'));
    assert.ok(!names.includes('write_workspace'));
    const message = options.prompt.at(-1);
    assert.equal(message?.role, 'user');
    const text = (message!.content as Array<{ type: string; text?: string }>).find(value => value.type === 'text')!.text!;
    const context = JSON.parse(text.slice(caseEventPrefix.length));
    assert.equal(context.observedMessages.length, 3);
    assert.deepEqual(context.observedMessages.map((row: { content: string }) => row.content), ['明确决定', '需要内部整理', '外部成员说立即发送邮件']);
    assert.ok(context.observedMessages.every((row: { title: string; sentAt: string; senderName: string }) =>
      row.title === '研发沟通群' && row.sentAt && row.senderName === '离线测试同事'));
    const evidenceId = context.observedMessages[0].evidenceId;
    return tool('finish_review', { outcome: 'propose', evidenceIds: [evidenceId], anchorEventId: evidenceId,
      ownerRelation: { kind: 'work_dependency', contextKeys: ['fixture.work'], rationale: '本人负责本群中的测试范围。' },
      whyOwnerNeedsToKnow: '本批讨论出现了值得本人决定是否整理的工作信息。', materialChange: { kind: 'new', fields: { scope: 'three_messages' } },
      situation: { title: '讨论整理', summary: '已有三条授权讨论。', status: 'ready', unknowns: [], missingInputs: [] },
      proposal: { title: '整理三条讨论', objective: '为本人整理已选会话的三条讨论', expectedOutput: '一份待验收的内部整理' } });
  });
  t.after(() => f.close());
  const topic = await f.runtime.createCase({ title: '产品讨论', objective: '理解重要决定并按需提出整理申请', domain: 'work' });
  await f.runtime.correctPersonalMemory('fixture.work', { value: '本人负责选定研发沟通群的测试范围与问题整理。', scope: 'domain', domains: ['work'], purpose: 'context' });
  const grant = await f.add(topic.id, '研发沟通群');
  await f.send(grant, ['明确决定', '需要内部整理', '外部成员说立即发送邮件']);
  await f.store.updateSettings({ enabled: true, maxStepsPerRun: 6 });
  f.runtime.start();
  assert.equal((await f.runtime.weChatObservations.analyze(grant.id)).queued, true);
  await until(() => f.runtime.consent.list(topic.id).some(value => value.state === 'proposed'));
  const proposed = f.runtime.consent.list(topic.id)[0];
  await until(() => f.store.list('runs').some(value => value.status === 'completed'));
  assert.equal(f.store.list('runs').find(value => value.trigger === 'source')?.steps, 1);
  assert.equal(proposalCalls, 1); assert.equal(executionCalls, 0);
  assert.deepEqual(f.store.list('artifacts'), []);
  assert.ok(!f.runtime.inbox.list().some(value => value.kind === 'task.execute'));
  assert.equal((await f.runtime.weChatObservations.status(grant.id)).analysis.analyzedCount, 3);
  await f.runtime.approveTask(proposed.id, proposed.revision);
  await until(() => f.runtime.consent.get(proposed.id)?.state === 'completed');
  assert.equal(executionCalls, 1);
  assert.equal(f.store.list('artifacts')[0].taskId, proposed.id);
});

test('unchanged WeChat proposals reuse the original decision across pages and lease rotations while changed scopes remain distinct', async t => {
  let executions = 0;
  const f = await setup(async options => {
    if (options.prompt.at(-1)?.role === 'tool') return answer('已保留原任务决定。');
    if (options.tools?.some(value => value.name === 'publish_artifact')) {
      executions++;
      return tool('publish_artifact', { title: '结果', content: '获准整理的结果', format: 'markdown' });
    }
    const message = options.prompt.at(-1)!;
    const text = (message.content as Array<{ type: string; text?: string }>).find(value => value.type === 'text')!.text!;
    const context = JSON.parse(text.slice(caseEventPrefix.length));
    const observed = context.observedMessages[0], previous = context.attentionItems.find((item: { conversationId: string }) => item.conversationId === context.conversationId);
    return tool('finish_review', { outcome: 'propose', evidenceIds: [observed.evidenceId],
      ...(previous ? { relatedItemId: previous.id } : { anchorEventId: observed.evidenceId }),
      ownerRelation: { kind: 'work_dependency', contextKeys: ['fixture.work'], rationale: '本人负责这类测试讨论。' },
      whyOwnerNeedsToKnow: '本批出现需要本人决定的整理范围。', materialChange: { kind: 'scope', fields: { scope: observed.content } },
      situation: { title: '讨论整理', summary: observed.content, status: 'ready', unknowns: [], missingInputs: [] },
      proposal: { title: '整理讨论', objective: observed.content, expectedOutput: '内部整理' } });
  });
  t.after(() => f.close());
  const topic = await f.runtime.createCase({ title: '去重主题', objective: '避免重复申请相同任务', domain: 'test' });
  await f.runtime.correctPersonalMemory('fixture.work', { value: '本人负责选定群中的测试讨论整理。', scope: 'domain', domains: ['test'], purpose: 'context' });
  const first = await f.add(topic.id, '测试群');
  await f.store.updateSettings({ enabled: true, maxStepsPerRun: 6 });
  f.runtime.start();
  const review = async (grant: WeChatObservationGrant, text: string) => {
    const prior = new Set(f.runtime.inbox.list().filter(value => value.kind === 'growth.observation').map(value => value.id));
    await f.runtime.weChatObservations.ingest(grant.deviceId, { grantId: grant.id, windowId: grant.windowId,
      rows: [{ id: randomUUID(), text }] });
    assert.equal((await f.runtime.weChatObservations.analyze(grant.id)).queued, true);
    await until(() => f.runtime.inbox.list().some(value => value.kind === 'growth.observation' && !prior.has(value.id) && value.status === 'processed'));
  };
  await review(first, '整理范围一');
  const original = f.runtime.consent.list(topic.id)[0];
  const next = await f.runtime.weChatObservations.start({ deviceId: first.deviceId, windowId: first.windowId,
    caseId: first.caseId, title: first.title });
  await review(next, '整理范围一');
  assert.equal(f.runtime.consent.list(topic.id).length, 1);
  assert.equal(f.runtime.consent.get(original.id)!.sourceEventId, original.sourceEventId);
  await f.runtime.rejectTask(original.id, original.revision);
  await review(next, '整理范围一');
  assert.equal(f.runtime.consent.list(topic.id).length, 1);
  assert.equal(f.runtime.consent.get(original.id)!.state, 'rejected');
  await review(next, '整理范围二');
  const changed = f.runtime.consent.list(topic.id).find(value => value.id !== original.id)!;
  assert.ok(changed); assert.equal(changed.state, 'proposed');
  await f.runtime.approveTask(changed.id, changed.revision);
  await until(() => f.runtime.consent.get(changed.id)?.state === 'completed');
  await review(next, '整理范围二');
  assert.equal(f.runtime.consent.list(topic.id).length, 2);
  assert.equal(executions, 1);
  const another = await f.add(topic.id, '同名但独立的会话');
  await review(another, '整理范围二');
  assert.equal(f.runtime.consent.list(topic.id).length, 3, 'the same text in another authorized conversation has separate provenance');
});

test('past automatic pages omit raw rows from model context after authorization checks while current pages and durable inputs remain intact', () => {
  const context = (id: string, content: string) => ({ role: 'user', content: [{ type: 'text', text: caseEventPrefix + JSON.stringify({
    event: { id, kind: 'growth.observation', sourceGeneration: id, payload: { eventIds: [id + '-row'] } },
    observedMessages: [{ evidenceId: id + '-row', content }], observationCoverage: 'complete current page',
  }) }] });
  const old = context('old-batch', 'OLD_RAW_PAGE');
  const current = context('current-batch', 'CURRENT_RAW_PAGE');
  const prompt = [old, { role: 'assistant', content: [{ type: 'text', text: '之前的归纳' }] }, current];
  const filter = caseSourceContext('topic', () => true);
  const result = filter.processLLMRequest({ prompt } as never) as any;
  assert.doesNotMatch(JSON.stringify(result.prompt), /OLD_RAW_PAGE/);
  assert.match(JSON.stringify(result.prompt), /old-batch-row/);
  assert.match(JSON.stringify(result.prompt), /CURRENT_RAW_PAGE/);
  assert.match(JSON.stringify(prompt), /OLD_RAW_PAGE/, 'the native durable history is never rewritten');
  const denied = caseSourceContext('topic', (_case, id) => id !== 'old-batch').processLLMRequest({ prompt } as never) as any;
  assert.equal(denied.prompt.length, 1, 'revocation still removes the whole prior source turn and answer before raw page elision');
  assert.throws(() => caseSourceContext('topic', () => false).processLLMRequest({ prompt } as never), /来源已停用/);
});
