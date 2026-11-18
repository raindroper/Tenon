import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { routeRuntime } from '../server/v2/http.js';

type Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const usage = { inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 12, text: 12, reasoning: 0 } };
const answer = (text: string): Result => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });
const clipped = (text = ''): Result => ({ content: text ? [{ type: 'text', text }] : [{ type: 'reasoning', text: 'Unreturned fixture reasoning.' }],
  finishReason: { unified: 'length', raw: 'length' }, usage: { ...usage, outputTokens: { total: 2048, text: text ? 20 : 0, reasoning: text ? 2028 : 2048 } }, warnings: [] });
const tool = (toolName: string, input: unknown): Result => ({ content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] });
async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < end, 'bounded round did not settle'); await delay(10); }
}
async function fixture(respond: (options: Options, call: number) => Result | Promise<Result>) {
  const prefix = join(tmpdir(), 'rae-bounded-run-'); const directory = await mkdtemp(prefix);
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const calls: Options[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => { calls.push(options); return respond(options, calls.length); } });
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'native'), model });
  return { store, engine, calls, async run(content = '请回答本人的问题。', maxStepsPerRun = 4) {
    const event = await engine.ingestOwnerMessage(content);
    await store.updateSettings({ enabled: true, maxStepsPerRun, maxOutputContinuations: 0 }); engine.start();
    await until(() => ['processed', 'failed'].includes(engine.inbox.get(event.id)?.status ?? ''));
    return event;
  }, async close() {
    await engine.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } };
}
const assistants = (store: Store) => store.list('messages').filter(message => message.role === 'assistant');
const displayed = (message: ReturnType<typeof assistants>[number]) => `${message.content}\n${message.outputNote ?? ''}`;

test('a reasoning decision is fixed across tool steps and new runs pick up the next saved policy', async () => {
  const f = await fixture(async (options, call) => {
    assert.deepEqual(options.providerOptions?.deepseek, call <= 2
      ? { thinking: { type: 'enabled' }, reasoningEffort: 'high' }
      : { thinking: { type: 'disabled' } });
    if (call === 1) {
      await f.store.updateSettings({ reasoningEffort: 'none' });
      return tool('notify_user', { content: '已收到，继续核对。' });
    }
    return answer('离线夹具答复。');
  });
  try {
    await f.run('继续核对刚才的问题。');
    assert.equal(f.store.list('runs')[0].reasoning?.effort, 'high'); assert.equal(f.calls.length, 2);
    await f.run('下一条问题。');
    const run = f.store.list('runs')[1]; assert.equal(run.reasoning?.effort, 'none'); assert.equal(run.reasoning?.policy, 'none');
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test('clipped owner reply is retained and marked incomplete once with automatic high reasoning', async () => {
  const f = await fixture(() => clipped('这部分解释已经生成，但还没有说完'));
  try {
    const event = await f.run();
    assert.equal(f.engine.inbox.get(event.id)?.status, 'processed'); assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
    const run = f.store.list('runs')[0]; assert.equal(run.status, 'completed'); assert.equal(run.stopReason, 'output_limit');
    const reply = assistants(f.store); assert.equal(reply.length, 1); assert.equal(reply[0].replyTo, event.payload.messageId);
    assert.equal(reply[0].outputState, 'incomplete'); assert.match(displayed(reply[0]), /上限/); assert.match(reply[0].content, /这部分解释已经生成/);
    assert.equal(f.calls[0].maxOutputTokens, undefined);
    assert.deepEqual(f.calls[0].providerOptions?.deepseek, { thinking: { type: 'enabled' }, reasoningEffort: 'high' });
    assert.equal(run.reasoning?.policy, 'auto'); assert.equal(run.reasoning?.effort, 'high');
    assert.equal(f.engine.status().lastError, null);
    f.engine.request('recovery'); await delay(100);
    assert.equal(f.calls.length, 1); assert.equal(f.store.list('runs').length, 1);
  } finally { await f.close(); }
});

test('reasoning-only output after a successful reminder still returns an honest limit notice and its durable receipt', async () => {
  const at = new Date(Date.now() + 86400000).toISOString();
  const f = await fixture((_options, call) => call === 1 ? tool('schedule_wake', { at, reason: 'fixture-lunch', message: 'fixture-reminder' }) : clipped());
  try {
    const event = await f.run('请安排明天的网页提醒。');
    assert.equal(f.engine.inbox.get(event.id)?.status, 'processed'); assert.equal(f.engine.inbox.get(event.id)?.attempts, 1);
    assert.equal(f.calls.length, 2); assert.equal(f.store.list('runs')[0].stopReason, 'output_limit');
    const receipts = f.engine.inbox.wakeReceipts('personal-growth', event.id); assert.equal(receipts.scheduledCount, 1);
    const content = displayed(assistants(f.store)[0]);
    assert.match(content, /正文|答复/); assert.match(content, /已保存 1 条时间安排/); assert.match(content, /fixture-lunch/);
    assert.doesNotMatch(content, /Unreturned fixture reasoning|手机|系统推送/);
    assert.equal(f.engine.status().state, 'idle');
  } finally { await f.close(); }
});

test('owner rounds can exceed 20 model calls and preserve a committed reminder exactly once', async () => {
  const at = new Date(Date.now() + 86400000).toISOString();
  const f = await fixture((_options, call) => {
    if (call === 1) return tool('schedule_wake', { at, reason: 'owner-plan', message: 'saved-once' });
    if (call <= 21) return tool('find_case_evidence', { query: 'requested evidence ' + call });
    return answer('已保存提醒并完成证据查询。');
  });
  try {
    const event = await f.run('先保存一个提醒。', 1);
    assert.equal(f.engine.inbox.get(event.id)?.status, 'processed'); assert.equal(f.calls.length, 22);
    assert.equal(f.store.list('runs')[0].stopReason, undefined); assert.equal(f.store.list('runs')[0].status, 'completed');
    assert.equal(f.engine.inbox.wakeReceipts('personal-growth', event.id).scheduledCount, 1);
    assert.match(displayed(assistants(f.store)[0]), /已保存提醒并完成证据查询/);
    f.engine.request('recovery'); await delay(100);
    assert.equal(f.calls.length, 22); assert.equal(f.engine.inbox.scheduledWakes('personal-growth').length, 1);
  } finally { await f.close(); }
});

test('notify tool followed by a limit preserves its original message once and shows the limit separately', async () => {
  const notified = 'UNIQUE_ALREADY_DELIVERED_BODY';
  const f = await fixture((_options, call) => call === 1 ? tool('notify_user', { content: notified }) : clipped(notified));
  try {
    const event = await f.run();
    assert.equal(f.engine.inbox.get(event.id)?.status, 'processed'); assert.equal(f.calls.length, 2);
    const replies = assistants(f.store); assert.equal(replies.length, 1);
    assert.equal(replies[0].content.split(notified).length - 1, 1, 'the model continuation must not duplicate an already delivered notification');
    assert.equal(replies[0].outputState, 'incomplete'); assert.match(displayed(replies[0]), /上限/);
    assert.equal(f.store.list('runs')[0].stopReason, 'output_limit');
  } finally { await f.close(); }
});

test('an explicitly approved execution that hits its output limit fails once and never claims a prepared result', async () => {
  const f = await fixture(options => {
    assert.ok(options.tools?.some(tool => tool.name === 'publish_artifact'));
    assert.equal(options.maxOutputTokens, 8192);
    assert.deepEqual(options.providerOptions?.deepseek, { thinking: { type: 'enabled' }, reasoningEffort: 'high' });
    return clipped('任务草稿尚未完成');
  });
  try {
    const item = await f.engine.createCase({ title: '许可任务', objective: '只执行本人批准的文本任务', domain: 'work' });
    await f.store.updateSettings({ maxOutputTokens: 8192, maxOutputContinuations: 0 });
    const task = await f.engine.requestTask({ requestId: 'execution-output-limit', spec: { caseId: item.id, title: '准备文本', objective: '验证有限执行不能假装完成',
      expectedOutput: '经工具保存的文本', capabilities: ['artifact'] } });
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(() => f.engine.consent.get(task.id)?.state === 'failed');
    const saved = f.engine.consent.get(task.id)!; assert.match(saved.error ?? '', /回复长度上限/);
    const run = f.store.list('runs')[0]; assert.equal(run.mode, 'execution'); assert.equal(run.status, 'failed'); assert.equal(run.stopReason, 'output_limit');
    assert.equal(f.engine.inbox.get(run.eventId!)?.status, 'processed'); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.store.list('artifacts'), []);
    const partial = assistants(f.store); assert.equal(partial.length, 1); assert.equal(partial[0].outputState, 'incomplete');
    assert.match(partial[0].content, /任务草稿尚未完成/); assert.match(displayed(partial[0]), /上限/);
    f.engine.request('recovery'); await delay(100); assert.equal(f.calls.length, 1); assert.equal(f.engine.consent.get(task.id)?.state, 'failed');
  } finally { await f.close(); }
});

test('explicit retry of a legacy failed owner event stays paused and resumes the original message with its saved plans', async () => {
  let existingWake = '';
  const f = await fixture(options => {
    const current = options.prompt.flatMap(message => message.role === 'user' ? message.content.filter(part => part.type === 'text').map(part => part.text) : [])
      .find(value => value.startsWith('当前事件'));
    assert.ok(current);
    const context = JSON.parse(current.slice(current.indexOf('\n') + 1));
    assert.equal(context.recovery.savedTimePlans.scheduledCount, 1);
    assert.equal(context.recovery.savedTimePlans.scheduled[0].id, existingWake);
    assert.match(context.recovery.meaning, /不要重新安排已有提醒/);
    return answer('原先的提醒已经保存，我现在补上答复。');
  });
  try {
    const event = await f.engine.ingestOwnerMessage('请安排明天的提醒并答复。');
    existingWake = f.engine.inbox.scheduleWake({ caseId: 'personal-growth', originEventId: event.id, at: new Date(Date.now() + 86400000).toISOString(), reason: 'legacy-saved-plan', message: 'legacy-reminder' }).id;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = f.engine.inbox.claim(1, 60000, [event.id])[0];
      if (attempt < 3) f.engine.inbox.retry(event.id, 'legacy output cap', claimed.leaseToken!);
      else f.engine.inbox.fail(event.id, '本轮尚未形成完整结果，原事件保留。', claimed.leaseToken!);
    }
    f.store.insert('runs', { id: randomUUID(), eventId: event.id, caseId: 'personal-growth', trigger: 'chat', mode: 'growth', status: 'failed',
      startedAt: new Date().toISOString(), steps: 1, inputTokens: 12000, outputTokens: 1200, error: '本轮尚未形成完整结果，原事件保留。' });
    const retried = await routeRuntime(f.engine, `/api/events/${event.id}/retry`, 'POST', {});
    assert.equal(retried.status, 202); assert.deepEqual(retried.body, { id: event.id, status: 'pending' });
    assert.equal(f.engine.inbox.get(event.id)?.attempts, 3); assert.equal(f.store.getSettings().enabled, false);
    f.engine.start(); await delay(50); assert.equal(f.calls.length, 0); assert.equal(f.engine.status().state, 'paused');
    await assert.rejects(routeRuntime(f.engine, `/api/events/${event.id}/retry`, 'POST', {}), (error: any) => error.status === 409);
    assert.equal(f.store.list('messages').length, 1); assert.equal(f.engine.inbox.wakeReceipts('personal-growth', event.id).scheduledCount, 1);
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(() => f.engine.inbox.get(event.id)?.status === 'processed');
    assert.equal(f.calls.length, 1); assert.equal(f.engine.inbox.get(event.id)?.attempts, 4);
    assert.equal(f.engine.inbox.scheduledWakes('personal-growth').length, 1); assert.equal(f.engine.inbox.scheduledWakes('personal-growth')[0].id, existingWake);
    const replies = assistants(f.store); assert.equal(replies.length, 1); assert.equal(replies[0].replyTo, event.payload.messageId);
    assert.match(replies[0].content, /现在补上答复/); assert.equal(f.store.list('runs').length, 2);
    assert.equal(f.store.list('runs')[0].status, 'failed', 'recovery must not rewrite historical failure into success');
    assert.equal(f.store.list('runs')[1].status, 'completed');
  } finally { await f.close(); }
});
