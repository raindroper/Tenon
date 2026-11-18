import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import type { RuntimeApi } from '../server/runtime.js';

async function fixture() {
  const prefix = join(tmpdir(), 'rae-settings-concurrency-'); const directory = await mkdtemp(prefix);
  const store = new Store(directory); let starts = 0; let cancellations = 0;
  const runtime = { cancel: async () => { cancellations++; }, stop: async () => {}, start: () => { starts++; },
    status: () => ({ state: 'paused' }), subscribe: () => () => {} } as unknown as RuntimeApi;
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  return { store, get starts() { return starts; }, get cancellations() { return cancellations; },
    post(path: string, input: unknown): Promise<{ status: number; body: any }> {
      const address = app.address(); assert.ok(address && typeof address === 'object');
      return new Promise((done, fail) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
          let text = ''; response.on('data', chunk => { text += chunk; });
          response.on('end', () => done({ status: response.statusCode!, body: JSON.parse(text) }));
        }); req.once('error', fail); req.end(JSON.stringify(input));
      });
    },
    async close() {
      app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); store.close();
      assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true });
    },
  };
}

test('a legacy full settings snapshot cannot resume inference after another window pauses', async () => {
  const f = await fixture();
  try {
    await f.store.updateSettings({ enabled: true });
    const { apiKeyConfigured: _secret, ...oldSettings } = f.store.getSettings();
    // Older clients did not have the read-only control revision field.
    delete (oldSettings as Record<string, unknown>).enabledRevision;
    assert.equal((await f.post('/api/control', { action: 'pause' })).status, 200);
    const saved = await f.post('/api/settings', { ...oldSettings, ownerName: 'only renamed' });
    assert.equal(saved.status, 409); assert.equal(f.store.getSettings().enabled, false);
    assert.equal(f.starts, 0); assert.equal(f.cancellations, 0, 'reject a stale change before interrupting current work');
  } finally { await f.close(); }
});

test('explicit inference changes use a durable revision and reject ABA and concurrent stale updates', async () => {
  const f = await fixture();
  try {
    const initial = (f.store.getSettings() as { enabledRevision?: number }).enabledRevision;
    assert.equal(typeof initial, 'number');
    const enabled = await f.post('/api/settings', { enabled: true, expectedEnabledRevision: initial });
    assert.equal(enabled.status, 200); assert.equal(enabled.body.enabled, true);
    assert.equal((await f.post('/api/control', { action: 'pause' })).status, 200);
    assert.equal(f.store.getSettings().enabled, false);
    const before = f.cancellations;
    assert.equal((await f.post('/api/settings', { enabled: true, expectedEnabledRevision: initial })).status, 409);
    assert.equal(f.cancellations, before); assert.equal(f.store.getSettings().enabled, false);
    const revision = (f.store.getSettings() as { enabledRevision?: number }).enabledRevision;
    const responses = await Promise.all([f.post('/api/settings', { enabled: true, expectedEnabledRevision: revision }),
      f.post('/api/settings', { enabled: true, expectedEnabledRevision: revision })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal(f.starts, 2);
    const nickname = await f.post('/api/settings', { ownerName: 'only changed field' });
    assert.equal(nickname.status, 200);
    assert.equal(nickname.body.enabledRevision, responses.find(response => response.status === 200)!.body.enabledRevision);
    assert.equal(Object.hasOwn(f.store.getMeta('settings', {}), 'expectedEnabledRevision'), false);
  } finally { await f.close(); }
});

test('inference state and its revision commit or roll back together and survive reopening', async context => {
  const prefix = join(tmpdir(), 'rae-settings-revision-'); const directory = await mkdtemp(prefix);
  let store = new Store(directory);
  try {
    await store.updateSettings({ enabled: true, ownerName: 'retained owner' });
    const before = store.getSettings(); let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications++; });
    const original = store.setMeta.bind(store);
    const fault = context.mock.method(store, 'setMeta', (key: string, value: unknown) => {
      if (key === 'settings') throw new Error('injected state write failure after revision update');
      original(key, value);
    });
    await assert.rejects(store.updateSettings({ enabled: false }), /state write failure/);
    assert.deepEqual(store.getSettings(), before); assert.equal(notifications, 0);
    fault.mock.restore(); unsubscribe();
    await store.updateSettings({ enabled: false }); const paused = store.getSettings();
    assert.equal(paused.enabledRevision, before.enabledRevision! + 1);
    store.close(); store = new Store(directory);
    assert.deepEqual(store.getSettings(), paused);
    assert.equal(Object.hasOwn(store.getMeta('settings', {}), 'enabledRevision'), false, 'read-only fields must not invalidate the saved settings schema');
  } finally {
    store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true });
  }
});
