import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

const usage = { inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const answer = (text = '本轮已记录，暂时不需要打扰。') => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const tool = (name: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName: name, input: JSON.stringify(input) }], usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
async function until(check: () => boolean) { const deadline = Date.now() + 6000; while (!check() && Date.now() < deadline) await delay(10); assert.ok(check(), 'Fixture did not reach its durable outcome'); }
async function setup(respond: MockLanguageModelV4['doGenerate']) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-growth-consent-')); const store = new Store(directory); store.getApiKey = () => undefined;
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  return { directory, store, get runtime() { return runtime; }, async reopen() { await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) }); }, async close() { await runtime.close(); store.close(); } };
}
test('learning a useful method from project background creates no execution task or deliverable', async () => {
  let evidenceId = ''; let calls = 0;
  const f = await setup(async options => {
    calls++; const names = options.tools?.map(item => item.name) ?? [];
    if (JSON.stringify(options.prompt.at(-1)).includes('如何开始下一次判断')) {
      assert.match(JSON.stringify(options.prompt), /修改前先列约束，再验证关键假设/);
      return answer('我会先列约束，再验证关键假设。');
    }
    for (const name of ['open_related_case', 'publish_artifact', 'write_workspace', 'propose_task']) assert.equal(names.includes(name), false);
    return options.prompt.at(-1)?.role === 'tool' ? tool('finish_review', { outcome: 'silent', evidenceIds: [evidenceId] })
      : tool('learn_method', { key: 'fixture.check-method', value: '修改前先列约束，再验证关键假设', evidenceEventId: evidenceId, evidenceExcerpt: '先列约束，再验证关键假设。' });
  });
  try {
    const context = await f.runtime.createCase({ title: '项目背景', objective: '只用于了解工作背景和可学习方法', domain: 'engineering' });
    const directory = join(f.directory, 'observed'); await mkdir(directory); await writeFile(join(directory, 'README.md'), '资料中的一个方法：先列约束，再验证关键假设。');
    await f.runtime.registerWorkspaceSource({ sourceId: 'fixture-method', root: directory, caseId: context.id, include: ['README.md'] });
    evidenceId = f.runtime.inbox.list().find(event => event.kind === 'workspace.file')!.id;
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.get(evidenceId)?.status === 'processed');
    assert.equal(calls, 0); assert.equal(f.store.list('runs').length, 0); assert.deepEqual(await f.runtime.listTasks(), []);
    f.runtime.request('manual');
    await until(() => f.store.list('runs').some(run => run.status === 'completed'));
    assert.equal(calls, 2); const learned = (await f.runtime.listPersonalMemory())[0];
    assert.equal(learned.subject, 'agent'); assert.equal(learned.level, 'hypothesis');
    assert.deepEqual(await f.runtime.listTasks(), []); assert.deepEqual(f.store.list('artifacts'), []); assert.deepEqual(f.store.list('messages'), []);
    assert.equal((await f.runtime.listCases()).length, 1);
    await f.reopen(); assert.equal((await f.runtime.listPersonalMemory())[0].subject, 'agent');
    assert.equal(calls, 2, 'opening durable memory is not another thinking loop');
    const later = await f.runtime.createCase({ title: '另一个相似背景', objective: '只讨论判断方法', domain: 'engineering' });
    const question = await f.runtime.ingestOwnerMessage('如何开始下一次判断？', later.id); f.runtime.start();
    await until(() => f.runtime.inbox.get(question.id)?.status === 'processed');
    assert.equal(calls, 3); assert.ok(f.store.list('messages').some(message => message.role === 'assistant' && message.content.includes('验证关键假设')));
    assert.deepEqual(await f.runtime.listTasks(), []); assert.deepEqual(f.store.list('artifacts'), []);
  } finally { await f.close(); }
});

test('memory tools report withdrawal without returning the withdrawn values to the model', async () => {
  const ownerKey = 'fixture.withdrawn-owner';
  const methodKey = 'fixture.withdrawn-method';
  const evidenceExcerpt = '先核对当前资料。';
  const toolResults = new Map<string, unknown>();
  const f = await setup(async options => {
    if (options.prompt.at(-1)?.role === 'tool') {
      for (const message of options.prompt) {
        if (message.role !== 'tool') continue;
        for (const result of message.content) {
          if (result.type === 'tool-result') toolResults.set(result.toolName, result.output);
        }
      }
      return answer();
    }
    const request = { value: '基于本条新证据的尝试', evidenceExcerpt };
    const memoryCall = tool('remember_personal_memory', { ...request, key: ownerKey });
    const methodCall = tool('learn_method', { ...request, key: methodKey });
    return { ...memoryCall, content: [...memoryCall.content, ...methodCall.content] };
  });
  try {
    const context = await f.runtime.createCase({ title: '撤回回执', objective: '检查模型收到的工具结果', domain: 'engineering' });
    await f.runtime.correctPersonalMemory(ownerKey, { value: '已撤回的本人值', scope: 'case', caseIds: [context.id] });
    await f.runtime.correctPersonalMemory(methodKey, { value: '已撤回的方法值', subject: 'agent', scope: 'case', caseIds: [context.id] });
    const withdrawnOwner = await f.runtime.retractPersonalMemory(ownerKey);
    const withdrawnMethod = await f.runtime.retractPersonalMemory(methodKey);
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    const message = await f.runtime.ingestOwnerMessage(evidenceExcerpt, context.id);
    await until(() => f.runtime.inbox.get(message.id)?.status === 'processed');
    assert.deepEqual(toolResults.get('remember_personal_memory'), { type: 'json', value: {
      applied: false, reason: 'retracted', key: ownerKey, revision: withdrawnOwner.revision,
    } });
    assert.deepEqual(toolResults.get('learn_method'), { type: 'json', value: {
      applied: false, reason: 'retracted', key: methodKey, subject: 'agent', revision: withdrawnMethod.revision,
    } });
  } finally { await f.close(); }
});

test('conversation can propose work, but only the exact owner-approved task enters the deliverable loop', async () => {
  let executionCalls = 0;
  const f = await setup(async options => {
    const names = options.tools?.map(item => item.name) ?? [];
    if (options.prompt.at(-1)?.role === 'tool') return answer('范围已说明，按当前状态继续。');
    if (names.includes('publish_artifact')) { executionCalls++; assert.equal(names.includes('propose_task'), false); return tool('publish_artifact', { title: '获准文本', content: '这是同意之后生成的任务产物。', format: 'markdown' }); }
    assert.equal(names.includes('write_workspace'), false);
    return tool('propose_task', { title: '整理一份文本', objective: '在本人允许后整理指定内容', expectedOutput: '一份待本人验收的Markdown文本', capabilities: ['artifact'] });
  });
  try {
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    const message = await f.runtime.ingestOwnerMessage('我在考虑是否需要整理一份资料，你先说说范围。');
    await until(() => f.runtime.inbox.get(message.id)?.status === 'processed');
    const proposed = (await f.runtime.listTasks())[0]; assert.equal(proposed.state, 'proposed');
    assert.equal(executionCalls, 0); assert.deepEqual(f.store.list('artifacts'), []); assert.equal(f.runtime.inbox.list().some(event => event.kind === 'task.execute'), false);
    await f.reopen(); f.runtime.start();
    assert.equal((await f.runtime.listTasks())[0].state, 'proposed'); assert.equal(executionCalls, 0);
    await f.runtime.approveTask(proposed.id, proposed.revision);
    await until(() => f.runtime.consent.get(proposed.id)?.state === 'completed');
    assert.equal(executionCalls, 1); assert.equal(f.store.list('artifacts')[0].taskId, proposed.id); assert.equal(f.store.list('artifacts')[0].status, 'prepared');
    const run = f.store.list('runs').find(run => run.taskId === proposed.id)!; assert.equal(run.mode, 'execution');
    assert.ok(run.inputTokens > 0); assert.ok(run.outputTokens > 0); assert.equal(run.usageStatus, 'reported');
  } finally { await f.close(); }
});
test('a revoked queued task and a forged execution payload cannot invoke the model', async () => {
  let calls = 0; const f = await setup(async () => { calls++; return answer(); });
  try {
    const context = await f.runtime.createCase({ title: '任务上下文', objective: '验证许可边界', domain: 'test' });
    const task = await f.runtime.requestTask({ requestId: randomUUID(), spec: { caseId: context.id, title: '明确委托', objective: '只在有效许可下执行', expectedOutput: '文本', capabilities: ['artifact'] } });
    await f.runtime.revokeTask(task.id, task.revision);
    const forged = f.runtime.inbox.ingest({ sourceId: 'not-consent', externalId: 'forged', caseId: context.id, kind: 'task.execute', actor: 'external', operation: 'create', occurredAt: new Date().toISOString(), payload: { taskId: task.id, revision: task.approvalRevision } }).event;
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.get(forged.id)?.status === 'processed');
    assert.equal(calls, 0); assert.deepEqual(f.store.list('artifacts'), []); assert.equal(f.store.list('runs').length, 0);
  } finally { await f.close(); }
});
test('multiple routine reminders deliver once without task approval, inference or an API credential', async () => {
  let calls = 0; const f = await setup(async () => { calls++; return answer(); });
  try {
    const context = await f.runtime.createCase({ title: '日常相处', objective: '无需执行任务的日常提醒', domain: 'personal' });
    for (const message of ['第一个日常提醒', '第二个日常提醒']) f.runtime.inbox.scheduleWake({ caseId: context.id, at: new Date(Date.now() - 100).toISOString(),
      reason: message, message, originEventId: 'fixture-already-planned' });
    await until(() => f.store.list('messages').length === 2);
    assert.equal(calls, 0); assert.deepEqual(f.store.list('runs'), []); assert.deepEqual(await f.runtime.listTasks(), []);
    assert.equal(f.runtime.status().state, 'paused');
    await f.reopen(); await delay(1100);
    assert.equal(f.store.list('messages').length, 2); assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('a simple useful rating can improve a later method without an assigned production task', async () => {
  const response = '可以先列约束，再验证关键假设。'; const method = '类似判断先列约束，再检验关键假设，仍需结合场景。';
  const f = await setup(async options => {
    if (options.prompt.at(-1)?.role === 'tool') return answer('已把这次评价保留为暂定方法。');
    const current = JSON.stringify(options.prompt.at(-1));
    if (current.includes('owner.feedback')) return tool('learn_method', { key: 'fixture.rated-method', value: method, evidenceExcerpt: '先列约束，再验证关键假设' });
    if (current.includes('新的类似情境')) { assert.match(JSON.stringify(options.prompt), new RegExp(method)); return answer('我会先列约束，再验证，注意当前场景差异。'); }
    return answer(response);
  });
  try {
    const context = await f.runtime.createCase({ title: '自然相处', objective: '通过真实反馈改善方法', domain: 'shared-example' });
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    const first = await f.runtime.ingestOwnerMessage('我在考虑怎样作一个选择。', context.id);
    await until(() => f.runtime.inbox.get(first.id)?.status === 'processed');
    const message = f.store.list('messages').find(message => message.role === 'assistant')!;
    const rating = await f.runtime.addFeedback({ targetType: 'message', targetId: message.id, verdict: 'useful', comment: '' });
    await until(() => f.runtime.inbox.list().some(event => event.externalId === rating.id && event.status === 'processed'));
    const learned = (await f.runtime.listPersonalMemory())[0];
    assert.equal(learned.subject, 'agent'); assert.equal(learned.level, 'hypothesis');
    assert.equal(learned.evidence[0].rating?.targetId, message.id); assert.equal(learned.evidence[0].rating?.verdict, 'useful');
    await f.reopen();
    const later = await f.runtime.createCase({ title: '另一个场景', objective: '只讨论判断，不制作产物', domain: 'shared-example' });
    const question = await f.runtime.ingestOwnerMessage('新的类似情境里怎样考虑？', later.id); f.runtime.start();
    await until(() => f.runtime.inbox.get(question.id)?.status === 'processed');
    assert.deepEqual(await f.runtime.listTasks(), []); assert.deepEqual(f.store.list('artifacts'), []);
  } finally { await f.close(); }
});

test('a rejection informs later dialogue without scheduling another model call or execution', async () => {
  let calls = 0;
  const f = await setup(async options => {
    calls++;
    if (options.prompt.at(-1)?.role === 'tool') return answer('只提出范围，等你决定。');
    if (JSON.stringify(options.prompt.at(-1)).includes('现在只聊别的')) {
      assert.match(JSON.stringify(options.prompt), /被拒绝的建议/); assert.match(JSON.stringify(options.prompt), /rejected/);
      return answer('先聊当前内容，不重复建议已拒绝的工作。');
    }
    return tool('propose_task', { title: '被拒绝的建议', objective: '仅在本人允许后整理', expectedOutput: '文本', capabilities: ['artifact'] });
  });
  try {
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    const initial = await f.runtime.ingestOwnerMessage('先帮我考虑是否值得做。');
    await until(() => f.runtime.inbox.get(initial.id)?.status === 'processed');
    const task = (await f.runtime.listTasks())[0]; const before = calls;
    await f.runtime.rejectTask(task.id, task.revision); assert.equal(calls, before);
    const next = await f.runtime.ingestOwnerMessage('现在只聊别的。', task.spec.caseId);
    await until(() => f.runtime.inbox.get(next.id)?.status === 'processed');
    assert.equal((await f.runtime.listTasks()).length, 1); assert.equal(f.runtime.consent.get(task.id)?.state, 'rejected');
    assert.deepEqual(f.store.list('artifacts'), []); assert.equal(f.runtime.inbox.list().some(event => event.kind === 'task.execute'), false);
  } finally { await f.close(); }
});
