import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type ClientRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

const closeServer = (app: Server) => new Promise<void>(done => { app.closeAllConnections(); app.close(() => done()); });
async function fixture() {
  const prefix = join(tmpdir(), 'rae-message-submission-'); const directory = await mkdtemp(prefix);
  const dataDir = join(directory, 'store'); const nativeDir = join(directory, 'native');
  let store = new Store(dataDir); store.getApiKey = () => undefined;
  let engine = await V2Coordinator.create(store, { dataDir: nativeDir });
  let dropNext = false; let droppedRequest: ClientRequest | undefined;
  const makeApp = () => createApp({ store, runtime: new Proxy(engine, {
    get(target, key, receiver) {
      if (key === 'ingestOwnerMessage') return async (...args: Parameters<V2Coordinator['ingestOwnerMessage']>) => {
        const result = await target.ingestOwnerMessage(...args);
        if (dropNext) { dropNext = false; droppedRequest?.destroy(new Error('injected response loss after durable acceptance')); }
        return result;
      };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) });
  let app = makeApp();
  const listen = () => new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  await listen();
  return {
    get store() { return store; }, get engine() { return engine; },
    post(body: unknown, loseResponse = false): Promise<{ status: number; body: any }> {
      const address = app.address(); assert.ok(address && typeof address === 'object');
      return new Promise((done, fail) => {
        const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/messages', method: 'POST',
          headers: { 'content-type': 'application/json' } }, response => {
          let text = ''; response.on('data', chunk => { text += chunk; });
          response.on('end', () => done({ status: response.statusCode!, body: JSON.parse(text) }));
        });
        if (loseResponse) { dropNext = true; droppedRequest = req; }
        req.once('error', fail); req.end(JSON.stringify(body));
      });
    },
    imageCount() {
      const db = new DatabaseSync(join(dataDir, 'rae.sqlite'), { readOnly: true });
      try { return Number(db.prepare('SELECT count(*) AS count FROM message_images').get()!.count); }
      finally { db.close(); }
    },
    async restart() {
      await closeServer(app); await engine.close(); store.close();
      store = new Store(dataDir); store.getApiKey = () => undefined;
      engine = await V2Coordinator.create(store, { dataDir: nativeDir }); app = makeApp(); await listen();
    },
    async close() {
      await closeServer(app); await engine.close(); store.close();
      assert.ok(resolve(directory).startsWith(resolve(prefix)));
      try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // The offline parent removes this isolated directory after native handles exit.
      }
    },
  };
}
const png = async (color: string) => ({ name: 'fixture.png', data: (await sharp({ create: {
  width: 12, height: 10, channels: 3, background: color,
} }).png().toBuffer()).toString('base64') });

test('a lost acceptance response reuses its message, images and event before and after restart', async () => {
  const f = await fixture();
  try {
    const body = { requestId: randomUUID(), content: 'one owner submission', attachments: [await png('#123456')], reasoningEffort: 'high' };
    await assert.rejects(f.post(body, true), /response loss/);
    const [original] = f.store.list('messages'); assert.ok(original);
    const [originalEvent] = f.engine.inbox.list().filter(event => event.kind === 'owner.message');
    const retried = await f.post(body); assert.equal(retried.status, 202); assert.equal(retried.body.id, original.id);
    await f.restart();
    const resumed = await f.post(body); assert.equal(resumed.status, 202); assert.equal(resumed.body.id, original.id);
    assert.deepEqual(resumed.body.attachments, original.attachments);
    const projected = await f.engine.snapshot({ caseId: original.caseId });
    assert.equal(projected.messages.find(message => message.id === original.id)?.requestId, body.requestId);
    assert.equal(f.store.get('messages', original.id)?.id, original.id);
    assert.equal(f.imageCount(), 1); assert.equal(f.store.list('messages').length, 1);
    assert.deepEqual(f.engine.inbox.list().filter(event => event.kind === 'owner.message').map(event => event.id), [originalEvent.id]);
    assert.equal(f.store.getSettings().enabled, false); assert.equal(f.store.list('runs').length, 0);
  } finally { await f.close(); }
});

test('concurrent identical submissions perform one image ingestion and accept one owner event', async () => {
  const f = await fixture();
  try {
    const body = { requestId: randomUUID(), content: '', attachments: [await png('#cc8844')] };
    const results = await Promise.all(Array.from({ length: 8 }, () => f.post(body)));
    assert.deepEqual(results.map(result => result.status), Array(8).fill(202));
    assert.equal(new Set(results.map(result => result.body.id)).size, 1);
    assert.equal(f.imageCount(), 1); assert.equal(f.store.list('messages').length, 1);
    assert.equal(f.engine.inbox.list().filter(event => event.kind === 'owner.message').length, 1);
  } finally { await f.close(); }
});

test('the same request ID cannot change content, topic, reply, image bytes/name, reasoning or device', async () => {
  const f = await fixture();
  try {
    const topic = await f.engine.createCase({ title: 'Other', objective: 'Isolated', domain: 'fixture' });
    const reference = await f.post({ content: 'reply anchor' }); assert.equal(reference.status, 202);
    const body = { requestId: randomUUID(), content: 'original', attachments: [await png('#123456')], reasoningEffort: 'high' };
    assert.equal((await f.post(body)).status, 202);
    for (const change of [
      { content: 'changed' }, { caseId: topic.id }, { replyTo: reference.body.id },
      { attachments: [await png('#654321')] }, { attachments: [{ ...body.attachments[0], name: 'renamed.png' }] },
      { reasoningEffort: 'max' }, { deviceId: 'different-device' },
    ]) assert.equal((await f.post({ ...body, ...change })).status, 409, JSON.stringify(change));
    assert.equal(f.store.list('messages').length, 2); assert.equal(f.imageCount(), 1);
    assert.equal(f.engine.inbox.list().filter(event => event.kind === 'owner.message').length, 2);
  } finally { await f.close(); }
});

test('same ID racing across topics accepts only one scope and rejects the conflicting scope', async () => {
  const f = await fixture();
  try {
    const topic = await f.engine.createCase({ title: 'Other', objective: 'Isolated', domain: 'fixture' });
    const body = { requestId: randomUUID(), content: 'one scope', attachments: [await png('#442288')] };
    const results = await Promise.all([f.post(body), f.post({ ...body, caseId: topic.id })]);
    assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);
    assert.equal(f.store.list('messages').length, 1); assert.equal(f.imageCount(), 1);
    assert.equal(f.engine.inbox.list().filter(event => event.kind === 'owner.message').length, 1);
  } finally { await f.close(); }
});

test('a message committed before event journaling fails is recovered without accepting a second submission', async context => {
  const f = await fixture();
  try {
    const original = f.engine.inbox.ingest.bind(f.engine.inbox); let failOnce = true;
    context.mock.method(f.engine.inbox, 'ingest', (input: Parameters<typeof original>[0]) => {
      if (input.kind === 'owner.message' && failOnce) { failOnce = false; throw new Error('injected event commit failure'); }
      return original(input);
    });
    const body = { requestId: randomUUID(), content: 'durable submission before crash' };
    assert.equal((await f.post(body)).status, 500); const [message] = f.store.list('messages'); assert.ok(message);
    await f.restart();
    const retried = await f.post(body); assert.equal(retried.status, 202); assert.equal(retried.body.id, message.id);
    assert.equal(f.store.list('messages').length, 1);
    assert.equal(f.engine.inbox.list().filter(event => event.kind === 'owner.message').length, 1);
  } finally { await f.close(); }
});

test('reconciling a previously accepted request after its topic stops cannot revive the topic or retry work', async () => {
  const f = await fixture();
  try {
    const body = { requestId: randomUUID(), content: 'accepted before stop' };
    const accepted = await f.post(body); assert.equal(accepted.status, 202);
    await f.engine.cancelCase(accepted.body.caseId);
    const before = f.engine.inbox.list().filter(event => event.kind === 'owner.message');
    const retried = await f.post(body); assert.equal(retried.status, 202); assert.equal(retried.body.id, accepted.body.id);
    assert.equal((await f.engine.getCase(accepted.body.caseId))?.status, 'cancelled');
    assert.deepEqual(f.engine.inbox.list().filter(event => event.kind === 'owner.message'), before);
  } finally { await f.close(); }
});

test('invalid image uploads do not reserve a request ID or leave a partial acceptance', async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    assert.equal((await f.post({ requestId, content: 'repair invalid image', attachments: [{ name: 'bad.png', data: 'AAAA' }] })).status, 400);
    assert.equal(f.store.ownerMessageRequest(requestId), undefined);
    assert.equal(f.store.list('messages').length, 0); assert.equal(f.imageCount(), 0);
    const corrected = await f.post({ requestId, content: 'repair invalid image', attachments: [await png('#998877')] });
    assert.equal(corrected.status, 202); assert.equal(f.store.list('messages').length, 1); assert.equal(f.imageCount(), 1);
  } finally { await f.close(); }
});

test('a failed message transaction rolls back its request binding as well as image bytes', async context => {
  const f = await fixture();
  try {
    const original = f.store.insert.bind(f.store); let failOnce = true;
    context.mock.method(f.store, 'insert', (...args: Parameters<typeof original>) => {
      const saved = original(...args);
      if (args[0] === 'messages' && failOnce) { failOnce = false; throw new Error('injected message transaction failure'); }
      return saved;
    });
    const requestId = randomUUID(); const input = { requestId, content: 'atomic retry', attachments: [await png('#998877')] };
    assert.equal((await f.post(input)).status, 500);
    assert.equal(f.store.ownerMessageRequest(requestId), undefined);
    assert.equal(f.store.list('messages').length, 0); assert.equal(f.imageCount(), 0);
    assert.equal((await f.post(input)).status, 202); assert.equal(f.store.list('messages').length, 1); assert.equal(f.imageCount(), 1);
  } finally { await f.close(); }
});
