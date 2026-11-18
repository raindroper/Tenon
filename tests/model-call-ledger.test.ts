import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { UsageTracker } from '../server/v2/usage.js';
import type { Run } from '../shared/types.js';
import { MockLanguageModelV4 } from './support/model.js';

const runValue = (): Run => ({ id: 'fixture-run', trigger: 'chat', mode: 'growth', status: 'running', startedAt: new Date().toISOString(), steps: 0,
  inputTokens: 0, outputTokens: 0, usageStatus: 'not_used' });

test('request attribution is durable before dispatch and settles once with the run projection', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'rae-model-call-')));
  try {
    const run = runValue(); run.modelBinding = store.models.resolve({ purpose: 'conversation', caseId: 'fixture' }); store.insert('runs', run);
    const tracker = new UsageTracker(store); let id = '';
    const model = tracker.meter(run, new MockLanguageModelV4({ doGenerate: async () => {
      const pending = store.list('modelCalls'); assert.equal(pending.length, 1); id = pending[0].id;
      assert.equal(pending[0].status, 'pending'); assert.deepEqual(pending[0].binding, run.modelBinding);
      return { content: [{ type: 'text', text: 'fixture' }], warnings: [], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } } };
    } }), new AbortController().signal);
    await model.doGenerate({ prompt: [] });
    assert.equal(store.get('modelCalls', id)?.status, 'settled'); assert.equal(store.get('modelCalls', id)?.inputTokens, 3);
    assert.equal(store.get('runs', run.id)?.inputTokens, 3); assert.equal(store.get('runs', run.id)?.pendingModelCalls, 0);
    assert.throws(() => tracker.external(run, id, new AbortController().signal, () => {}), /已经受理/);
    assert.equal(store.get('runs', run.id)?.inputTokens, 3);
  } finally { store.close(); }
});

test('recovery terminalizes an unreported durable request without inventing tokens or replaying it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-model-call-recover-')); let store = new Store(directory);
  const run = runValue(); store.insert('runs', run);
  new UsageTracker(store).external(run, 'unreported-call', new AbortController().signal, () => {});
  store.close(); store = new Store(directory);
  try {
    const tracker = new UsageTracker(store); tracker.recover(); tracker.recover();
    const call = store.get('modelCalls', 'unreported-call')!;
    assert.equal(call.status, 'settled'); assert.equal(call.usageStatus, 'unknown'); assert.equal(call.inputTokens, 0);
    assert.equal(store.get('runs', run.id)?.pendingModelCalls, 0); assert.equal(store.get('runs', run.id)?.usageStatus, 'unknown');
    assert.equal(store.list('modelCalls').length, 1);
  } finally { store.close(); }
});
