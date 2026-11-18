import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { Store } from '../server/store.js';
import { acquireRuntimeLease } from '../server/runtime-lease.js';

async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check() && Date.now() < end) await delay(10); assert.ok(check()); }
test('R07 HTTP activation and owner input share one case state authority', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'rae-r07-')); const store = new Store(join(dir, 'data'));
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; return { content: [{ type: 'text', text: 'offline fixture' }], warnings: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } }; } });
  const engine = await V2Coordinator.create(store, { dataDir: join(dir, 'runtime'), model });
  const app = createApp({ store, runtime: engine }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const send = async (path: string, method: string, body?: unknown) => { const response = await fetch(base + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(response.ok, `${path}: ${response.status}`); return response.json(); };
  try {
    const item = await engine.createCase({ title: '事项', objective: '验证状态恢复', domain: 'fixture' }); await store.updateSettings({ enabled: true }); engine.start();
    await send(`/api/v2/cases/${item.id}`, 'PATCH', { status: 'cancelled' }); await send(`/api/v2/cases/${item.id}`, 'PATCH', { status: 'active' });
    await send('/api/messages', 'POST', { content: '继续这个事项', caseId: item.id });
    await until(() => engine.inbox.list().filter(event => event.kind === 'owner.message' && event.status === 'processed').length === 1);
    assert.equal(calls, 1); assert.equal((await engine.getCase(item.id))?.status, 'active');
    await engine.cancelCase(item.id);
    const staleSend = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '继续这个事项', caseId: item.id }) });
    assert.equal(staleSend.status, 409); await staleSend.text();
    assert.equal((await engine.getCase(item.id))?.status, 'cancelled'); assert.equal(calls, 1);
    await send(`/api/v2/cases/${item.id}`, 'PATCH', { status: 'active' });
    await send('/api/messages', 'POST', { content: '本人明确继续', caseId: item.id });
    await until(() => calls === 2); assert.equal((await engine.getCase(item.id))?.status, 'active');

    // R12: retired V1 write routes cannot mutate archives or pause the runtime.
    const id = randomUUID(); const now = new Date().toISOString();
    store.insert('memories', { id, content: 'legacy fixture', kind: 'hypothesis', status: 'proposed', evidence: [], createdAt: now, updatedAt: now });
    assert.equal((await fetch(`${base}/api/memories/${id}`, { method: 'DELETE' })).status, 410);
    const initiativeId = randomUUID(); store.insert('initiatives', { id: initiativeId, title: 'legacy', why: 'fixture', expectedValue: 'fixture', evidence: [], status: 'planned', nextAction: 'fixture', createdAt: now, updatedAt: now });
    assert.equal((await fetch(`${base}/api/initiatives/${initiativeId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'dismissed' }) })).status, 410);
    assert.ok(store.get('memories', id)); assert.equal(store.get('initiatives', initiativeId)?.status, 'planned');
    assert.equal(store.getSettings().enabled, true); assert.notEqual(engine.status().state, 'paused');
    const event = engine.inbox.ingest({ sourceId: 'background', externalId: 'after-legacy-delete', kind: 'case.wake', caseId: item.id, actor: 'system', operation: 'create', occurredAt: now, payload: {} }).event;
    // Let the normal background tick run: no owner request can accidentally clear a hold.
    await until(() => engine.inbox.get(event.id)?.status === 'processed');
  } finally { app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); await engine.close(); store.close(); try { await rm(dir, { recursive: true, force: true }); } catch (error) {
    if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    context.diagnostic('Windows temp cleanup deferred until worker exit');
  } }
});
test('R11 a second coordinator cannot recover or modify a live runtime directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rae-r11-')); const store = new Store(join(dir, 'data')); const runtime = join(dir, 'runtime');
  const engine = await V2Coordinator.create(store, { dataDir: runtime });
  try {
    store.insert('runs', { id: 'still-live', trigger: 'chat', status: 'running', startedAt: new Date().toISOString(), steps: 0, inputTokens: 0, outputTokens: 0 });
    await assert.rejects(V2Coordinator.create(store, { dataDir: runtime }), /held|locked|lock/i);
    assert.equal(store.get('runs', 'still-live')?.status, 'running');
  } finally { await engine.close(); store.close(); }
  const lease = await acquireRuntimeLease(runtime); lease.assertOwned(); await lease.release();
});
