import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import type { Run } from '../shared/types.js';
import { meterModel, type MeteredUsage } from '../server/v2/metering.js';
import { UsageTracker } from '../server/v2/usage.js';
import { Store } from '../server/store.js';

const prompt = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'offline fixture' }] }], maxOutputTokens: 100 };
const noUsage: LanguageModelV4Usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const fullUsage: LanguageModelV4Usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const complete = (usage = fullUsage) => ({ content: [{ type: 'text' as const, text: 'ok' }], usage, finishReason: { unified: 'stop' as const, raw: 'stop' }, warnings: [] });
function run(id: string): Run { return { id, trigger: 'chat', status: 'running', startedAt: new Date().toISOString(), steps: 0, inputTokens: 0, outputTokens: 0 }; }
async function fixture(name: string) { return new Store(await mkdtemp(join(tmpdir(), `rae-usage-${name}-`))); }

test('missing provider usage stays unknown without counting prompt characters as tokens', async () => {
  let recorded: MeteredUsage | undefined;
  const model = meterModel(new MockLanguageModelV4({ doGenerate: async () => complete(noUsage) }), { begin: () => {}, record: value => { recorded = value; } });
  await model.doGenerate({ ...prompt, prompt: [{ role: 'user', content: [{ type: 'text', text: '并非token'.repeat(10000) }] }] });
  assert.deepEqual(recorded, { inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' });
});
test('complete token components and partial provider reports retain only reported counts', async () => {
  const records: MeteredUsage[] = [];
  for (const usage of [
    { inputTokens: { total: undefined, noCache: 10, cacheRead: 20, cacheWrite: 0 }, outputTokens: { total: undefined, text: 3, reasoning: 2 } },
    { ...noUsage, outputTokens: { total: 0, text: undefined, reasoning: undefined } },
    { ...noUsage, inputTokens: { total: undefined, noCache: undefined, cacheRead: 20, cacheWrite: undefined } },
  ]) await meterModel(new MockLanguageModelV4({ doGenerate: async () => complete(usage) }), { begin: () => {}, record: value => records.push(value) }).doGenerate(prompt);
  assert.deepEqual(records, [
    { inputTokens: 30, outputTokens: 5, usageStatus: 'reported' },
    { inputTokens: 0, outputTokens: 0, usageStatus: 'partial' },
    { inputTokens: 20, outputTokens: 0, usageStatus: 'partial' },
  ]);
});
test('invalid provider counts cannot create negative, fractional or non-finite totals', async () => {
  const records: MeteredUsage[] = [];
  const usage = { inputTokens: { total: -2, noCache: NaN, cacheRead: Infinity, cacheWrite: -1 }, outputTokens: { total: 0.5, text: undefined, reasoning: undefined } };
  await meterModel(new MockLanguageModelV4({ doGenerate: async () => complete(usage) }), { begin: () => {}, record: value => records.push(value) }).doGenerate(prompt);
  assert.deepEqual(records, [{ inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' }]);
});
test('an aborted non-cooperative provider settles unknown once and cannot count late usage', async () => {
  let resolve!: (value: ReturnType<typeof complete>) => void;
  const gate = new Promise<ReturnType<typeof complete>>(done => { resolve = done; });
  const records: MeteredUsage[] = []; const controller = new AbortController();
  const model = meterModel(new MockLanguageModelV4({ doGenerate: () => gate }), { begin: () => {}, record: value => records.push(value) });
  const call = model.doGenerate({ ...prompt, abortSignal: controller.signal }); controller.abort();
  assert.deepEqual(records, [{ inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' }]);
  resolve(complete()); await call;
  assert.equal(records.length, 1);
});
test('unfinished pending calls recover as unknown once without manufacturing tokens', async () => {
  const store = await fixture('recovery');
  try {
    store.insert('runs', { ...run('unfinished'), inputTokens: 10, outputTokens: 2, pendingModelCalls: 2 });
    const tracker = new UsageTracker(store); tracker.recover(); tracker.recover();
    const recovered = store.get('runs', 'unfinished')!;
    assert.equal(recovered.pendingModelCalls, 0); assert.equal(recovered.usageStatus, 'unknown');
    assert.equal(recovered.inputTokens, 10); assert.equal(recovered.outputTokens, 2);
  } finally { store.close(); }
});
test('the owning runtime signal cancels metering even if a caller omits its own signal', async () => {
  const store = await fixture('runtime-abort');
  try {
    const current = run('runtime-abort'); store.insert('runs', current); const controller = new AbortController();
    let resolve!: (value: ReturnType<typeof complete>) => void;
    const gate = new Promise<ReturnType<typeof complete>>(done => { resolve = done; });
    const provider = new MockLanguageModelV4({ doGenerate: params => { assert.ok(params.abortSignal); return gate; } });
    const call = new UsageTracker(store).meter(current, provider, controller.signal).doGenerate(prompt);
    assert.equal(current.pendingModelCalls, 1); controller.abort();
    assert.equal(current.pendingModelCalls, 0); assert.equal(current.usageStatus, 'unknown');
    resolve(complete()); await call;
    assert.equal(current.inputTokens, 0); assert.equal(current.outputTokens, 0);
  } finally { store.close(); }
});
test('settlement persistence errors on abort stay recoverable and surface on the owning call', async () => {
  const store = await fixture('abort-persist');
  try {
    const current = run('abort-persist'); store.insert('runs', current); const controller = new AbortController();
    let resolve!: (value: ReturnType<typeof complete>) => void;
    const gate = new Promise<ReturnType<typeof complete>>(done => { resolve = done; });
    const provider = new MockLanguageModelV4({ doGenerate: () => gate });
    const put = store.put.bind(store);
    store.put = (kind, value) => { if (kind === 'runs' && (value as Run).pendingModelCalls === 0) throw new Error('abort persistence failure'); return put(kind, value); };
    const call = new UsageTracker(store).meter(current, provider, controller.signal).doGenerate(prompt);
    assert.doesNotThrow(() => controller.abort());
    resolve(complete()); await assert.rejects(Promise.resolve(call), /abort persistence failure/);
    assert.equal(current.pendingModelCalls, 1); assert.equal(current.inputTokens, 0);
    store.put = put; new UsageTracker(store).recover();
    assert.equal(store.get('runs', current.id)?.usageStatus, 'unknown');
    assert.equal(store.get('runs', current.id)?.pendingModelCalls, 0);
  } finally { store.close(); }
});
test('legacy outstanding fee reservations recover without converting them to tokens or charging again', async () => {
  const store = await fixture('legacy');
  try {
    const legacy = { ...run('legacy'), costCny: 0.01, reservedCostCny: 0.03 }; store.insert('runs', legacy);
    const tracker = new UsageTracker(store); tracker.recover(); tracker.recover();
    const recovered = store.get('runs', 'legacy')! as Run & { costCny: number; reservedCostCny: number };
    assert.equal(recovered.usageStatus, 'unknown'); assert.equal(recovered.pendingModelCalls, 0);
    assert.equal(recovered.inputTokens, 0); assert.equal(recovered.outputTokens, 0);
    assert.equal(recovered.costCny, 0.01); assert.equal(recovered.reservedCostCny, 0);
  } finally { store.close(); }
});
test('lease loss or task revocation prevents pending writes and provider dispatch', async () => {
  const store = await fixture('guards');
  try {
    for (const guard of ['lease', 'task']) {
      const current = run(guard); store.insert('runs', current); let calls = 0;
      const fail = () => { throw new Error(`${guard} revoked`); };
      const tracker = new UsageTracker(store, guard === 'lease' ? { assertActive: fail } : {});
      const provider = new MockLanguageModelV4({ doGenerate: async () => { calls++; return complete(); } });
      await assert.rejects(Promise.resolve(tracker.meter(current, provider, new AbortController().signal, guard === 'task' ? fail : undefined).doGenerate(prompt)), /revoked/);
      assert.equal(calls, 0); assert.equal(store.get('runs', current.id)?.pendingModelCalls, undefined);
    }
  } finally { store.close(); }
});
test('failed pending-call persistence cannot dispatch or leave an in-memory pending marker', async () => {
  const store = await fixture('begin-persist');
  try {
    const current = run('failed-begin'); store.insert('runs', current); let calls = 0;
    const put = store.put.bind(store);
    store.put = (kind, value) => { if (kind === 'runs' && (value as Run).pendingModelCalls) throw new Error('fixture persistence failure'); return put(kind, value); };
    const provider = new MockLanguageModelV4({ doGenerate: async () => { calls++; return complete(); } });
    await assert.rejects(Promise.resolve(new UsageTracker(store).meter(current, provider, new AbortController().signal).doGenerate(prompt)), /persistence failure/);
    assert.equal(calls, 0); assert.equal(current.pendingModelCalls, undefined);
    assert.equal(store.get('runs', current.id)?.pendingModelCalls, undefined);
  } finally { store.close(); }
});
test('failed settlement persistence leaves a recoverable pending marker without counting twice', async () => {
  const store = await fixture('settle-persist');
  try {
    const current = run('failed-settle'); store.insert('runs', current); let writes = 0;
    const put = store.put.bind(store);
    store.put = (kind, value) => { if (kind === 'runs' && ++writes === 2) throw new Error('fixture settlement failure'); return put(kind, value); };
    const provider = new MockLanguageModelV4({ doGenerate: async () => complete() });
    await assert.rejects(Promise.resolve(new UsageTracker(store).meter(current, provider, new AbortController().signal).doGenerate(prompt)), /settlement failure/);
    const pending = store.get('runs', current.id)!;
    assert.equal(pending.pendingModelCalls, 1); assert.equal(pending.inputTokens, 0); assert.equal(current.inputTokens, 0);
    store.put = put; const tracker = new UsageTracker(store); tracker.recover(); tracker.recover();
    const recovered = store.get('runs', current.id)!;
    assert.equal(recovered.pendingModelCalls, 0); assert.equal(recovered.inputTokens, 0); assert.equal(recovered.usageStatus, 'unknown');
  } finally { store.close(); }
});
test('concurrent calls settle their reported counts once and preserve an unknown sibling call', async () => {
  const store = await fixture('concurrent');
  try {
    const current = run('concurrent'); store.insert('runs', current); const tracker = new UsageTracker(store);
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const good = new MockLanguageModelV4({ doGenerate: async () => { await gate; return complete(); } });
    const failed = new MockLanguageModelV4({ doGenerate: async () => { await gate; throw new Error('fixture lost response'); } });
    const signal = new AbortController().signal;
    const a = tracker.meter(current, good, signal).doGenerate(prompt); const b = tracker.meter(current, failed, signal).doGenerate(prompt);
    assert.equal(store.get('runs', current.id)?.pendingModelCalls, 2); release();
    const results = await Promise.allSettled([a, b]); assert.equal(results[1].status, 'rejected');
    const settled = store.get('runs', current.id)!;
    assert.equal(settled.inputTokens, 10); assert.equal(settled.outputTokens, 2); assert.equal(settled.pendingModelCalls, 0); assert.equal(settled.usageStatus, 'unknown');
  } finally { store.close(); }
});
