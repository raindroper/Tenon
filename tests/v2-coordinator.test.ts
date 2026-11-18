import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MockLanguageModelV4 } from 'ai/test';
import { Store, KERNEL_SCHEMA_VERSION } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

type Options = Parameters<MockLanguageModelV4['doStream']>[0];
type Part = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } };
const finish = (reason: 'stop' | 'tool-calls' | 'length' = 'stop'): Part => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage });
function answer(value: string, reason: 'stop' | 'length' = 'stop'): Part[] { return [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: value }, { type: 'text-end', id: 'text' }, finish(reason)]; }
function call(name: string, input: unknown): Part[] { return [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: Math.random().toString(36), toolName: name, input: JSON.stringify(input) }, finish('tool-calls')]; }
function fixture(respond?: (options: Options, serialized: string) => Part[] | Promise<Part[]>) {
  const prompts: Options[] = [];
  const produce = async (options: Options) => {
    prompts.push(options); const serialized = JSON.stringify(options.prompt);
    const toolResult = options.prompt.at(-1)?.role === 'tool';
    const parts = respond ? await respond(options, serialized) : toolResult ? answer('已完成这一轮相处与学习。')
      : call('save_working_state', { content: serialized.includes('"domain":"food"') || serialized.includes('饮食安排') ? 'FOOD_WORKING_PRIVATE' : 'UI_WORKING_PRIVATE' });
    return parts;
  };
  const model = new MockLanguageModelV4({ doStream: async options => {
    const parts = await produce(options);
    return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
  }, doGenerate: async options => {
    const parts = await produce(options); const end = parts.find(part => part.type === 'finish');
    return { content: parts.flatMap(part => part.type === 'tool-call' ? [{ type: 'tool-call' as const, toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }] : []),
      ...(!parts.some(part => part.type === 'tool-call') ? { content: [{ type: 'text' as const, text: parts.filter(part => part.type === 'text-delta').map(part => part.type === 'text-delta' ? part.delta : '').join('') }] } : {}),
      finishReason: end?.type === 'finish' ? end.finishReason : { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
  } });
  return { model, prompts };
}
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for durable event result'); await new Promise(done => setTimeout(done, 25)); }
}
async function setup(model: MockLanguageModelV4) {
  const prefix = join(tmpdir(), 'rae-v2-coordinator-'); const directory = mkdtempSync(prefix);
  const store = new Store(directory); store.getApiKey = () => undefined;
  const engine = await V2Coordinator.create(store, { dataDir: directory, model });
  return { directory, store, engine, async close() {
    await engine.close(); store.close(); const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // npm test's parent process removes its isolated temp root after all workers exit.
    }
  } };
}

test('explicit conversation contexts preserve private histories without an extra intake model loop', async () => {
  const mock = fixture(); const f = await setup(mock.model);
  try {
    assert.equal(f.engine.status().state, 'paused'); assert.equal(mock.prompts.length, 0);
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 3 }); f.engine.start();
    const ui = await f.engine.createCase({ title: '页面优化', objective: '保留独立项目上下文', domain: 'design' });
    const food = await f.engine.createCase({ title: '饮食安排', objective: '保留独立生活上下文', domain: 'food' });
    const uiEvent = await f.engine.ingestOwnerMessage('UI_PRIVATE_HISTORY：想改善我的项目排版。', ui.id);
    await waitFor(() => f.engine.inbox.list().find(event => event.id === uiEvent.id)?.status === 'processed');
    const foodEvent = await f.engine.ingestOwnerMessage('FOOD_PRIVATE_HISTORY：考虑明天的午饭。', food.id);
    await waitFor(() => f.engine.inbox.list().find(event => event.id === foodEvent.id)?.status === 'processed');
    assert.notEqual(food.id, ui.id);
    const again = await f.engine.ingestOwnerMessage('继续当前界面事项。', ui.id);
    await waitFor(() => f.engine.inbox.list().find(event => event.id === again.id)?.status === 'processed');
    assert.equal(mock.prompts.length, 6, 'three conversations each need only their own two-step native loop');
    const workerPrompts = mock.prompts;
    const foodPrompts = workerPrompts.filter(options => JSON.stringify(options.prompt).includes('饮食安排'));
    assert.ok(foodPrompts.length > 0); for (const prompt of foodPrompts) assert.doesNotMatch(JSON.stringify(prompt.prompt), /UI_PRIVATE_HISTORY|UI_WORKING_PRIVATE/);
    const uiPrompts = workerPrompts.filter(options => JSON.stringify(options.prompt).includes('页面优化'));
    for (const prompt of uiPrompts) assert.doesNotMatch(JSON.stringify(prompt.prompt), /FOOD_PRIVATE_HISTORY|FOOD_WORKING_PRIVATE/);
    assert.match(JSON.stringify(await f.engine.memory.history(ui.id)), /UI_PRIVATE_HISTORY/);
    assert.doesNotMatch(JSON.stringify(await f.engine.memory.history(ui.id)), /FOOD_PRIVATE_HISTORY/);
    assert.equal(f.store.list('messages').filter(message => message.role === 'assistant').length, 3);
    assert.equal(f.engine.inbox.list().length, 3); f.engine.request('chat'); assert.equal(f.engine.inbox.list().length, 3);
    assert.ok(f.store.todayUsage().inputTokens > 0); assert.equal(f.store.list('runs').reduce((sum, run) => sum + run.inputTokens, 0), mock.prompts.length * 20);
    const state = await f.engine.snapshot(); assert.equal(state.runtime, 'mastra'); assert.equal(state.schemaVersion, KERNEL_SCHEMA_VERSION);
    assert.ok(state.events.every(event => !('leaseToken' in event)));
  } finally { await f.close(); }
});

test('authorized filesystem collection stays alive when inference is stopped and removal revokes pending source events', async () => {
  const mock = fixture(); const f = await setup(mock.model); const watched = join(f.directory, 'watched');
  const { mkdirSync } = await import('node:fs'); mkdirSync(watched); writeFileSync(join(watched, 'note.md'), 'REAL_FILE_FIRST');
  try {
    const item = await f.engine.memory.createCase({ title: '真实目录', objective: '留意明确授权资料', domain: 'work' });
    await f.engine.registerWorkspaceSource({ sourceId: 'authorized-notes', root: watched, caseId: item.id, include: ['**/*.md'] });
    assert.ok(f.engine.inbox.list().some(event => event.sourceId === 'authorized-notes')); assert.equal(mock.prompts.length, 0);
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await waitFor(() => f.engine.inbox.list().filter(event => event.sourceId === 'authorized-notes').every(event => event.status === 'processed'));
    assert.equal(mock.prompts.length, 0, 'passive file collection does not call a model');
    await f.engine.stop(); const calls = mock.prompts.length;
    writeFileSync(join(watched, 'note.md'), 'REAL_FILE_SECOND');
    await waitFor(() => f.engine.inbox.list().some(event => event.sourceId === 'authorized-notes' && event.payload.content === 'REAL_FILE_SECOND'));
    assert.equal(mock.prompts.length, calls);
    await f.engine.removeWorkspaceSource('authorized-notes'); const count = f.engine.inbox.list().length;
    writeFileSync(join(watched, 'note.md'), 'AFTER_REMOVE'); await new Promise(done => setTimeout(done, 400)); assert.equal(f.engine.inbox.list().length, count);
    assert.equal(f.engine.sources.get('authorized-notes')?.status, 'removed');
    const pending = f.engine.inbox.list().filter(event => event.sourceId === 'authorized-notes');
    assert.ok(pending.length > 0);
    f.engine.start(); await new Promise(done => setTimeout(done, 1100));
    assert.equal(mock.prompts.length, calls);
    for (const event of pending) assert.equal(f.engine.inbox.get(event.id)?.attempts, event.attempts);
  } finally { await f.close(); }
});

test('growth notifications send once and background rounds do not receive deliverable tools', async () => {
  let workerCalls = 0;
  const mock = fixture(async options => {
    if (options.prompt.at(-1)?.role === 'tool') return answer('这段final不能重复推送。');
    workerCalls++;
    assert.ok(!options.tools?.some(tool => tool.name === 'publish_artifact'));
    return workerCalls === 1 ? call('notify_user', { content: '值得你知道的实际新消息。' }) : call('save_working_state', { content: '没有新价值就保持安静，不制造产物。' });
  });
  const f = await setup(mock.model);
  try {
    const item = await f.engine.memory.createCase({ title: '独立事项', objective: '真实结果判断', domain: 'research' });
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    const event = await f.engine.ingestOwnerMessage('给我有价值的反馈。', item.id);
    await waitFor(() => f.engine.inbox.list().find(row => row.id === event.id)?.status === 'processed');
    const messages = f.store.list('messages').filter(message => message.role === 'assistant'); assert.equal(messages.length, 1); assert.match(messages[0].content, /实际新消息/);
    const background = f.engine.inbox.ingest({ sourceId: 'explicit-background', externalId: 'one', caseId: item.id, kind: 'case.wake', operation: 'create', actor: 'system', occurredAt: new Date().toISOString(), payload: {} }).event;
    f.engine.request('recovery'); await waitFor(() => f.engine.inbox.list().find(row => row.id === background.id)?.status === 'processed');
    assert.equal(f.store.list('artifacts').length, 0); assert.deepEqual(await f.engine.listTasks(), []); assert.equal((await f.engine.getCase(item.id))?.status, 'active'); assert.equal(f.store.list('messages').filter(message => message.role === 'assistant').length, 1);
  } finally { await f.close(); }
});

test('length-limited owner answer is visible and terminal once; cancelling the case preserves its input', async () => {
  const mock = fixture(() => answer('未完成', 'length')); const f = await setup(mock.model);
  try {
    const item = await f.engine.memory.createCase({ title: '取消测试', objective: '不能误认完成', domain: 'work' });
    await f.store.updateSettings({ enabled: true, maxOutputContinuations: 0 }); f.engine.start();
    const event = await f.engine.ingestOwnerMessage('这条输入不能丢。', item.id);
    await waitFor(() => f.engine.inbox.get(event.id)?.status === 'processed');
    const replies = f.store.list('messages').filter(message => message.role === 'assistant');
    assert.equal(replies.length, 1); assert.equal(replies[0].outputState, 'incomplete'); assert.match(`${replies[0].content}\n${replies[0].outputNote ?? ''}`, /上限/);
    assert.equal(f.store.list('runs').at(-1)?.stopReason, 'output_limit'); assert.equal(f.engine.status().lastError, null);
    await f.engine.cancelCase(item.id); assert.equal((await f.engine.getCase(item.id))?.status, 'cancelled');
    assert.ok(f.store.list('messages').some(message => message.content === '这条输入不能丢。'));
    await f.engine.cancel(); const calls = mock.prompts.length; await new Promise(done => setTimeout(done, 1100)); assert.equal(mock.prompts.length, calls);
  } finally { await f.close(); }
});
