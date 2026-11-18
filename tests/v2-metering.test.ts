import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { meterModel, type MeteredUsage } from '../server/v2/metering.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { Store } from '../server/store.js';

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } };
const params = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'fixture' }] }], maxOutputTokens: 100 };
test('provider-reported token usage is recorded before returning the response', async () => {
  const events: string[] = []; let pendingId = '';
  const model = meterModel(new MockLanguageModelV4({ doGenerate: async () => { events.push('provider'); return { content: [{ type: 'text', text: 'ok' }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } }; } }),
    { begin: id => { pendingId = id; events.push('begin'); }, record: (value, id) => { assert.equal(id, pendingId); assert.deepEqual(value, { inputTokens: 100, outputTokens: 20, usageStatus: 'reported' }); events.push('record'); } });
  await model.doGenerate(params);
  assert.deepEqual(events, ['begin', 'provider', 'record']);
});
test('a rejected pre-dispatch guard prevents the provider call', async () => {
  let calls = 0;
  const model = meterModel(new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('should not execute'); } }),
    { begin: () => { throw new Error('guard rejected'); }, record: () => assert.fail('nothing to record') });
  await assert.rejects(Promise.resolve(model.doGenerate(params)), /guard rejected/);
  assert.equal(calls, 0);
});
test('an already aborted signal neither persists a call nor dispatches it', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const model = meterModel(new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('should not execute'); } }),
    { begin: () => assert.fail('already cancelled'), record: () => assert.fail('nothing to record') });
  await assert.rejects(Promise.resolve(model.doGenerate({ ...params, abortSignal: controller.signal })), /abort/i);
  assert.equal(calls, 0);
});
test('duplicate stream finish events cannot double-count usage', async () => {
  const records: MeteredUsage[] = [];
  const provider = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } });
    controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } }); controller.close();
  } }) }) });
  const output = await meterModel(provider, { begin: () => {}, record: value => records.push(value) }).doStream(params);
  for await (const _part of output.stream) { /* consume provider stream */ }
  assert.deepEqual(records, [{ inputTokens: 100, outputTokens: 20, usageStatus: 'reported' }]);
});
test('stream cancellation without usage records unknown counts without estimating tokens', async () => {
  const records: MeteredUsage[] = [];
  const provider = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'text-start', id: 't' }); } }) }) });
  const output = await meterModel(provider, { begin: () => {}, record: value => records.push(value) }).doStream(params);
  await output.stream.cancel('test cancellation');
  assert.deepEqual(records, [{ inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' }]);
});
test('transport and HTTP failures without reported usage remain unknown', async () => {
  const records: MeteredUsage[] = [];
  for (const error of [Object.assign(new Error('unauthorized fixture'), { statusCode: 401 }), new Error('transport lost')]) {
    const model = meterModel(new MockLanguageModelV4({ doGenerate: async () => { throw error; } }), { begin: () => {}, record: value => records.push(value) });
    await assert.rejects(Promise.resolve(model.doGenerate(params)));
  }
  assert.deepEqual(records, Array.from({ length: 2 }, () => ({ inputTokens: 0, outputTokens: 0, usageStatus: 'unknown' })));
});

test('ungranted workspace tools remain absent from growth model calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rae-v2-capabilities-')); const store = new Store(join(dir, 'data'));
  await store.updateSettings({ enabled: true }); let names: string[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => { names = options.tools?.map(tool => tool.name) ?? [];
    return { content: [{ type: 'text', text: 'fixture' }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } }; } });
  const engine = await V2Coordinator.create(store, { dataDir: join(dir, 'runtime'), model, maxEvents: 1 });
  try {
    const item = await engine.memory.createCase({ title: '只读观察', objective: '只读资料', domain: 'test' });
    await engine.ingestOwnerMessage('fixture', item.id); engine.start();
    const end = Date.now() + 5000;
    while (!store.list('runs').some(run => run.status === 'completed') && Date.now() < end) await delay(10);
    assert.ok(store.list('runs').some(run => run.status === 'completed'));
    assert.ok(names.includes('read_event'));
    for (const forbidden of ['read_workspace', 'write_workspace', 'verify_workspace', 'handoff_workspace']) assert.ok(!names.includes(forbidden), forbidden);
  } finally { await engine.close(); store.close(); }
});
