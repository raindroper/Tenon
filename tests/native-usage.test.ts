import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../shared/types.js';
import { deviceDirectoryLookupCapability } from '../shared/local-device.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { UsageTracker } from '../server/v2/usage.js';
import { tokenUsageText } from '../client/lib/format.js';
import { MockLanguageModelV4 } from './support/model.js';

function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
const params = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'offline usage fixture' }] }] };
const reported = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const answer = { content: [{ type: 'text' as const, text: 'offline fixture' }], usage: reported, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } };
const initialRun = (id: string): Run => ({ id, trigger: 'manual', mode: 'execution', status: 'running', startedAt: new Date().toISOString(),
  steps: 0, inputTokens: 0, outputTokens: 0, usageStatus: 'not_used' });

test('native directory execution and restart preserve complete daily usage without a model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-native-usage-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('Native task must not infer'); } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  let detach: (() => void) | undefined;
  try {
    store.insert('runs', { ...initialRun('previous-reported'), status: 'completed', usageStatus: 'reported', inputTokens: 10, outputTokens: 2 });
    const topic = await runtime.createCase({ title: 'Native usage', objective: 'A scoped native directory query', domain: 'fixture' });
    const { device } = runtime.devices.enroll({ name: 'Offline fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token });
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    detach = runtime.devices.attach(device.id, request => {
      if (request.kind !== 'execute') return;
      runtime.devices.admit(device.id, { operationId: request.operationId, specHash: request.specHash });
      runtime.devices.recordResult(device.id, { operationId: request.operationId, state: 'completed', exitCode: 0,
        stdout: JSON.stringify({ directory: 'D:\\fixture', files: [], scanned: 0, truncated: false }) });
    });
    const task = await runtime.requestTask({ requestId: 'native-usage', spec: { caseId: topic.id, title: 'Inspect fixture',
      objective: 'Return directory entries', expectedOutput: 'Native directory receipt', capabilities: ['local-command'],
      command: { kind: 'list_directory', deviceId: device.id, root: 'D:\\fixture', limit: 10, timeoutMs: 1000 } } });
    await store.updateSettings({ enabled: true });
    const terminal = new Promise<void>((done, fail) => {
      const timeout = setTimeout(() => { unsubscribe(); fail(new Error('Native query did not settle')); }, 5000);
      const unsubscribe = runtime.subscribe(() => {
        if (runtime.inbox.get(task.executionEventId!)?.status !== 'processed') return;
        unsubscribe(); clearTimeout(timeout); done();
      });
    });
    runtime.start(); await terminal;
    const run = store.list('runs').find(value => value.taskId === task.id)!;
    assert.equal(calls, 0); assert.equal(run.status, 'completed'); assert.equal(run.usageStatus, 'not_used');
    assert.equal(tokenUsageText(run), '未调用模型');
    assert.deepEqual(store.todayUsage(), { inputTokens: 10, outputTokens: 2, usageStatus: 'reported' });
    detach(); detach = undefined; await runtime.close();
    runtime = await V2Coordinator.create(store, { dataDir: directory, model });
    assert.equal(store.get('runs', run.id)?.usageStatus, 'not_used');
    assert.deepEqual(store.todayUsage(), { inputTokens: 10, outputTokens: 2, usageStatus: 'reported' });
    assert.equal(calls, 0);
    store.insert('runs', { ...initialRun('legacy-unknown'), usageStatus: undefined, status: 'completed' });
    assert.equal(store.todayUsage().usageStatus, 'unknown', 'old missing usage must not be invented as no model use');
  } finally { detach?.(); await runtime.close(); store.close(); }
});

test('first provider dispatch durably clears not-used before response and preserves incomplete concurrent calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-native-meter-')); const store = new Store(directory);
  const run = initialRun('concurrent'); store.insert('runs', run);
  const tracker = new UsageTracker(store); const first = gate(); const second = gate(); const entered = gate(); let calls = 0;
  const model = tracker.meter(run, new MockLanguageModelV4({ doGenerate: async () => {
    const index = calls++;
    if (calls === 2) entered.release();
    assert.notEqual(store.get('runs', run.id)?.usageStatus, 'not_used');
    await (index === 0 ? first : second).promise;
    if (index === 1) throw new Error('Provider response lost');
    return answer;
  } }), new AbortController().signal);
  const operations = [Promise.resolve(model.doGenerate(params)), Promise.resolve(model.doGenerate(params))];
  // Attach rejection handlers before deliberately releasing a failed provider call.
  const completed = Promise.allSettled(operations);
  try {
    await entered.promise;
    assert.equal(store.get('runs', run.id)?.pendingModelCalls, 2);
    assert.equal(store.todayUsage().usageStatus, 'unknown');
    first.release(); await operations[0];
    assert.deepEqual(store.todayUsage(), { inputTokens: 10, outputTokens: 2, usageStatus: 'unknown' });
    second.release(); const results = await completed;
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    const settled = store.get('runs', run.id)!;
    assert.equal(settled.pendingModelCalls, 0); assert.equal(settled.usageStatus, 'unknown');
    assert.equal(settled.inputTokens, 10); assert.equal(settled.outputTokens, 2);
    tracker.recover(); assert.deepEqual(store.get('runs', run.id), settled);
  } finally { first.release(); second.release(); await completed; store.close(); }
});

test('a rejected pre-dispatch guard retains known no-model status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-native-guard-')); const store = new Store(directory);
  const run = initialRun('guarded'); store.insert('runs', run); let calls = 0;
  try {
    const model = new UsageTracker(store).meter(run, new MockLanguageModelV4({ doGenerate: async () => { calls++; return answer; } }),
      new AbortController().signal, () => { throw new Error('Task revoked'); });
    await assert.rejects(Promise.resolve(model.doGenerate(params)), /Task revoked/);
    assert.equal(calls, 0); assert.equal(store.get('runs', run.id)?.usageStatus, 'not_used');
    assert.deepEqual(store.todayUsage(), { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' });
  } finally { store.close(); }
});
