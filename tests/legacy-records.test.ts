import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { Store, KERNEL_SCHEMA_VERSION } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { acquireRuntimeLease } from '../server/runtime-lease.js';

test('old memories, initiatives and activity remain exportable read-only archives without becoming live persona state', async context => {
  const prefix = join(tmpdir(), 'rae-readonly-archive-'); const directory = await mkdtemp(prefix);
  const lease = await acquireRuntimeLease(directory); const store = new Store(directory); store.getApiKey = () => undefined;
  const timestamp = new Date().toISOString();
  const memory = store.insert('memories', { id: 'old-memory', content: 'OLD_V1_MEMORY_SENTINEL', kind: 'hypothesis', status: 'proposed', evidence: ['old-source'], createdAt: timestamp, updatedAt: timestamp });
  const initiative = store.insert('initiatives', { id: 'old-initiative', title: 'OLD_V1_AGENDA_SENTINEL', why: 'history', expectedValue: 'history', evidence: [], status: 'planned', nextAction: 'archive only', createdAt: timestamp, updatedAt: timestamp });
  const activity = store.insert('activities', { id: 'old-activity', kind: 'observation', title: 'old record', detail: 'archive only', evidence: [], createdAt: timestamp });
  const original = JSON.stringify({ memory, initiative, activity }); let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('Archive access must never invoke a provider'); } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model, lease });
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const state = await call('/api/state'); assert.equal(state.status, 200); assert.equal(state.data.schemaVersion, KERNEL_SCHEMA_VERSION);
    assert.deepEqual(state.data.understanding, []); assert.equal(state.data.memories, undefined); assert.equal(state.data.initiatives, undefined);
    assert.deepEqual(state.data.archive.counts, { memories: 1, initiatives: 1, activities: 1 });
    for (const [path, method, body] of [
      ['/api/memories/old-memory', 'DELETE', undefined],
      ['/api/memories/old-memory', 'PATCH', { content: 'must not replace history' }],
      ['/api/initiatives/old-initiative', 'PATCH', { status: 'completed' }],
      ['/api/v2/memories/old-memory', 'DELETE', undefined],
    ] as const) assert.equal((await call(path, method, body)).status, 410);
    const exported = await call('/api/export'); assert.equal(exported.status, 200); assert.equal(exported.data.archive.readOnly, true);
    assert.deepEqual(exported.data.archive.records.memories, [memory]); assert.deepEqual(exported.data.archive.records.initiatives, [initiative]); assert.deepEqual(exported.data.archive.records.activities, [activity]);
    assert.equal(JSON.stringify({ memory: store.get('memories', memory.id), initiative: store.get('initiatives', initiative.id), activity: store.get('activities', activity.id) }), original);
    assert.equal(calls, 0); assert.equal(runtime.status().state, 'paused');
  } finally {
    await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close(); await lease.release();
    const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) throw error; context.diagnostic('cleanupDeferred=' + target); }
  }
});
