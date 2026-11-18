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
import { EventInbox } from '../server/v2/events.js';

const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const answer = { content: [{ type: 'text' as const, text: '不应自动重放这轮已经产生进展的事件。' }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < deadline, 'stream recovery boundary did not settle'); await delay(10); }
}
async function temporary() {
  const prefix = join(tmpdir(), 'rae-stream-recovery-'); const directory = await mkdtemp(prefix);
  return { directory, dataDir: join(directory, 'data'), runtimeDir: join(directory, 'native'), async cleanup() {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 30 }); }
    catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } };
}

test('autonomous review retains its five-minute bound without allocating a fresh automatic budget', async () => {
  const f = await temporary(); const store = new Store(f.dataDir); store.getApiKey = () => undefined;
  let entered = false; let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async options => {
    calls++;
    const stream = new ReadableStream({ start(controller) {
      const aborted = () => controller.error(options.abortSignal?.reason ?? new Error('fixture deadline'));
      if (options.abortSignal?.aborted) aborted(); else options.abortSignal?.addEventListener('abort', aborted, { once: true });
      entered = true;
    } });
    return { stream };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: f.runtimeDir, model });
  const originalTimeout = globalThis.setTimeout;
  let fireDeadline: (() => void) | undefined;
  try {
    const scene = await runtime.createCase({ title: 'Autonomous review fixture', objective: 'Bound passive autonomous processing', domain: 'fixture' });
    const event = runtime.inbox.ingest({ sourceId: 'fixture-autonomous', externalId: 'bounded-review', caseId: scene.id,
      kind: 'case.wake', actor: 'system', operation: 'create', occurredAt: new Date().toISOString(), payload: { reason: 'A bounded autonomous review' } }).event;
    await store.updateSettings({ enabled: true });
    // Capture only the runtime's five-minute timer, restoring the global hook
    // immediately. The provider gate makes firing it deterministic and instant.
    globalThis.setTimeout = ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
      if (milliseconds !== 300000) return originalTimeout(callback, milliseconds, ...args);
      globalThis.setTimeout = originalTimeout;
      const timer = originalTimeout(callback, milliseconds, ...args);
      fireDeadline = () => { clearTimeout(timer); callback(...args); };
      return timer;
    }) as typeof globalThis.setTimeout;
    runtime.start(); await until(() => entered);
    assert.ok(fireDeadline, 'the original runtime timer must be captured before provider work'); fireDeadline();
    await until(() => runtime.inbox.get(event.id)?.status === 'failed');
    const run = store.list('runs')[0];
    assert.equal(run.status, 'failed'); assert.equal(run.toolCallsStarted ?? 0, 0); assert.match(run.error ?? '', /时间上限/);
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 0);
    runtime.request('recovery'); runtime.start(); await delay(100);
    assert.equal(calls, 1); assert.equal(store.list('runs').length, 1); assert.equal(runtime.inbox.get(event.id)?.status, 'failed');
    assert.equal(runtime.inbox.hasPending(), false);
  } finally {
    globalThis.setTimeout = originalTimeout; await runtime.close(); store.close(); await f.cleanup();
  }
});

test('a crash after finalizing interrupted Run metadata cannot bypass its already durable event quarantine', async () => {
  const f = await temporary(); let store = new Store(f.dataDir); store.getApiKey = () => undefined;
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; return answer; } });
  let runtime: V2Coordinator | undefined = await V2Coordinator.create(store, { dataDir: f.runtimeDir, model });
  const runId = randomUUID(); const replyId = randomUUID(); let eventId = '';
  try {
    const event = await runtime.ingestOwnerMessage('这一条的部分结果已经付费生成，不能因重启再执行。'); eventId = event.id;
    const claim = runtime.inbox.claim(1, 600000, [event.id])[0]; assert.equal(claim.status, 'leased');
    store.insert('runs', { id: runId, eventId: event.id, caseId: 'personal-growth', trigger: 'chat', mode: 'growth', status: 'running',
      startedAt: new Date().toISOString(), steps: 1, inputTokens: 20, outputTokens: 5, toolCallsStarted: 1 });
    store.insert('messages', { id: replyId, role: 'assistant', caseId: 'personal-growth', runId, replyTo: String(event.payload.messageId),
      content: 'CRASH_SAFE_PUBLIC_BODY', outputState: 'streaming', createdAt: new Date().toISOString() });
    await store.updateSettings({ enabled: true }); await runtime.close(); runtime = undefined;

    const originalPut = store.put.bind(store); let injected = false;
    store.put = ((kind, item) => {
      const saved = originalPut(kind, item);
      if (!injected && kind === 'runs' && item.id === runId && 'status' in item && item.status === 'interrupted') {
        injected = true;
        // Commit this second database's status, then simulate process death.
        // The event must already be quarantined in the other database.
        throw new Error('fixture crash after interrupted Run commit');
      }
      return saved;
    }) as Store['put'];
    await assert.rejects(V2Coordinator.create(store, { dataDir: f.runtimeDir, model }), /fixture crash after interrupted Run commit/);
    assert.equal(injected, true); store.put = originalPut;
    assert.equal(store.get('runs', runId)?.status, 'interrupted');
    const inbox = new EventInbox(join(f.runtimeDir, 'v2-events.sqlite'));
    try { assert.equal(inbox.get(eventId)?.status, 'failed', 'event quarantine must precede the committed interrupted status'); }
    finally { inbox.close(); }
    store.close(); store = new Store(f.dataDir); store.getApiKey = () => undefined;
    runtime = await V2Coordinator.create(store, { dataDir: f.runtimeDir, model }); runtime.start(); await delay(100);
    assert.equal(calls, 0); assert.equal(runtime.inbox.get(eventId)?.status, 'failed'); assert.equal(runtime.inbox.hasPending(), false);
    assert.equal(store.get('messages', replyId)?.content, 'CRASH_SAFE_PUBLIC_BODY');
    assert.equal(store.get('messages', replyId)?.outputState, 'incomplete'); assert.equal(store.list('runs').length, 1);
  } finally { await runtime?.close(); store.close(); await f.cleanup(); }
});

test('pausing after a reminder commits but before another started tool returns never automatically repeats the event', async () => {
  const f = await temporary(); const store = new Store(f.dataDir); store.getApiKey = () => undefined;
  let committed = false; const release = deferred(); const at = new Date(Date.now() + 86400000).toISOString(); let calls = 0; let workingWrites = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    calls++;
    return calls > 1 ? answer : { content: [
      { type: 'tool-call', toolCallId: 'committed-reminder', toolName: 'schedule_wake', input: JSON.stringify({ at, reason: '不应重复的提醒', message: '这条已经保存。' }) },
      { type: 'tool-call', toolCallId: 'held-working-write', toolName: 'save_working_state', input: JSON.stringify({ content: 'COMMITTED_WORKING_STATE' }) },
    ], usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: f.runtimeDir, model });
  const originalWorking = runtime.cases.setWorking.bind(runtime.cases);
  runtime.cases.setWorking = async (...args) => { workingWrites++; await originalWorking(...args); committed = true; await release.promise; };
  let cancellation: Promise<void> | undefined;
  try {
    const event = await runtime.ingestOwnerMessage('保存提醒与背景，并在完成后答复。');
    await store.updateSettings({ enabled: true }); runtime.start(); await until(() => committed);
    await until(() => runtime.inbox.wakeReceipts('personal-growth', event.id).scheduledCount === 1);
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 0);
    let acknowledged = false; cancellation = runtime.cancel().then(() => { acknowledged = true; });
    await delay(30); assert.equal(acknowledged, false, 'cancellation must drain the already-started write');
    release.resolve(); await cancellation;
    assert.equal(runtime.inbox.get(event.id)?.status, 'failed');
    assert.equal(await runtime.cases.getWorking('personal-growth'), 'COMMITTED_WORKING_STATE');
    runtime.request('recovery'); runtime.start(); await delay(100);
    assert.equal(calls, 1); assert.equal(workingWrites, 1); assert.equal(runtime.inbox.wakeReceipts('personal-growth', event.id).scheduledCount, 1);
    assert.equal(runtime.inbox.get(event.id)?.status, 'failed');
  } finally { release.resolve(); await cancellation; await runtime.close(); store.close(); await f.cleanup(); }
});
