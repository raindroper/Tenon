import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import sharp from 'sharp';
import { RuntimeLifecycle } from '../server/v2/lifecycle.js';

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Cancellation barrier fixture did not settle'); await delay(10); }
}

test('pause waits for an accepted image message to reach durable storage before acknowledging', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rae-image-drain-'));
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('Paused fixture cannot infer'); } });
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'runtime'), model });
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const activate = engine.cases.activate.bind(engine.cases);
  let entered = false;
  engine.cases.activate = async (...args) => { entered = true; await gate; return activate(...args); };
  let accepted: ReturnType<typeof engine.ingestOwnerMessage> | undefined; let paused: Promise<void> | undefined;
  try {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    accepted = engine.ingestOwnerMessage('', undefined, undefined, [{ name: 'fixture.png', data: bytes.toString('base64') }]);
    await until(() => entered);
    let acknowledged = false; paused = engine.stop().then(() => { acknowledged = true; });
    await delay(30); assert.equal(acknowledged, false);
    release(); const event = await accepted; await paused;
    const message = store.get('messages', String(event.payload.messageId));
    assert.equal(message?.attachments?.length, 1); assert.ok(store.readImage(message!.attachments![0].id));
    assert.equal(engine.inbox.get(event.id)?.status, 'pending'); assert.equal(calls, 0);
  } finally { release(); await accepted; await paused; await engine.close(); store.close(); }
});

test('accepted owner edit sharing the run drain does not deadlock cancellation', async () => {
  const lifecycle = new RuntimeLifecycle(); lifecycle.start();
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let wrote = false;
  const edit = lifecycle.mutate(() => gate, async () => { wrote = true; return 'saved'; });
  const cancellation = lifecycle.interrupt(() => gate);
  assert.equal(lifecycle.canDispatch, false);
  release(); await cancellation;
  assert.equal(await edit, 'saved'); assert.equal(wrote, true); assert.equal(lifecycle.canDispatch, false);
});

test('request and start cannot reopen dispatch during cancellation; an explicit request resumes after drain', async context => {
  const prefix = join(tmpdir(), 'rae-cancellation-barrier-'); const directory = mkdtempSync(prefix);
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
  let modelCalls = 0; let foodCalls = 0; let firstUiCall = true;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const names = options.tools?.map(tool => tool.name) ?? [];
    assert.ok(names.includes('save_working_state'), 'Growth may save its internal working context');
    assert.ok(!names.includes('write_workspace') && !names.includes('publish_artifact'), 'Ordinary conversation never receives task execution capabilities');
    modelCalls++; const prompt = JSON.stringify(options.prompt); const food = prompt.includes('FOOD_DURING_INTERRUPT');
    if (food) foodCalls++;
    if (!food && firstUiCall) {
      firstUiCall = false;
      return { content: [{ type: 'tool-call', toolCallId: 'blocked-ui-state', toolName: 'save_working_state', input: JSON.stringify({ content: 'UI_NATIVE_TOOL_BLOCKED' }) }], finishReason: { unified: 'tool-calls', raw: 'fixture' }, usage, warnings: [] };
    }
    return { content: [{ type: 'text', text: 'Local fixture finished.' }], finishReason: { unified: 'stop', raw: 'fixture' }, usage, warnings: [] };
  } });
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'runtime'), model });
  let release!: () => void; const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  let toolEntered = false; let toolFinished = false;
  const setWorking = engine.cases.setWorking.bind(engine.cases);
  engine.cases.setWorking = async (...args) => { toolEntered = true; await gate; await setWorking(...args); toolFinished = true; };
  let cancellation: Promise<void> | undefined;
  try {
    const ui = await engine.createCase({ title: 'UI fixture', objective: 'Hold one native tool', domain: 'design' });
    const food = await engine.createCase({ title: 'Food fixture', objective: 'Resume after interruption', domain: 'food' });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 3 });
    const first = await engine.ingestOwnerMessage('UI_BEFORE_INTERRUPT', ui.id); engine.start();
    await until(() => toolEntered);
    let acknowledged = false; cancellation = engine.cancel().then(() => { acknowledged = true; });
    const later = await engine.ingestOwnerMessage('FOOD_DURING_INTERRUPT', food.id);
    engine.request('feedback'); engine.start();
    await delay(250);
    assert.equal(acknowledged, false, 'Cancel waits for the already-started native tool');
    assert.equal(modelCalls, 1, 'Neither request nor start may reopen inference during the drain');
    assert.equal(foodCalls, 0); assert.equal(engine.inbox.get(later.id)?.status, 'pending');
    release(); await cancellation;
    assert.equal(toolFinished, true);
    await delay(100);
    assert.equal(modelCalls, 1, 'Calls received during drain do not implicitly resume after drain');
    engine.request('recovery');
    await until(() => engine.inbox.get(later.id)?.status === 'processed');
    assert.equal(engine.inbox.get(first.id)?.status, 'failed', 'The interrupted tool must not be replayed by a generic resume');
    assert.equal(foodCalls, 1); assert.equal(modelCalls, 2);
    assert.equal((await engine.listTasks()).length, 0);
    assert.equal(store.list('runs').every(run => run.mode === 'growth'), true);
  } finally {
    release(); await cancellation; await engine.close(); store.close();
    const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; context.diagnostic(`cleanupDeferred=${target}`); }
  }
});
