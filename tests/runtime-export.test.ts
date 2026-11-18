import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { RuntimeMessage } from '../shared/runtime-view.js';
import { Store } from '../server/store.js';
import { writeRuntimeExport } from '../server/runtime-export.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** A deterministic full buffer: only the test's drain releases the next attachment. */
class ControlledResponse extends EventEmitter {
  destroyed = false;
  ended = false;
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  readonly blocked = deferred();
  private held = false;
  constructor(private readonly holdFirstImage = false) { super(); }
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; return this; }
  write(chunk: string) {
    this.chunks.push(chunk);
    if (this.holdFirstImage && !this.held && chunk.includes('"id":"image-1"')) {
      this.held = true; this.blocked.resolve(); return false;
    }
    return true;
  }
  end(chunk: string) { this.chunks.push(chunk); this.ended = true; return this; }
  disconnect() { this.destroyed = true; this.emit('close'); }
  response() { return this as unknown as ServerResponse; }
}

async function fixture(context: TestContext, secret?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'rae-runtime-export-'));
  const store = new Store(directory);
  context.after(() => {
    store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /rae-runtime-export-/);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  });
  if (secret) await store.updateSettings({ apiKey: secret });
  const reads: string[] = [];
  const bytes = new Map([
    ['image-1', Buffer.alloc(512 * 1024, 0x61)],
    ['image-2', Buffer.alloc(512 * 1024, 0x62)],
  ]);
  const messages: RuntimeMessage[] = [...bytes].map(([id, data], index) => ({
    id: 'message-' + (index + 1), role: 'user', content: '', caseId: 'private-case', createdAt: new Date(0).toISOString(),
    attachments: [{ id, name: 'picture-' + index + '.png', mediaType: 'image/png', width: 2048, height: 2048, size: data.length }],
  }));
  for (const message of messages) store.insertOwnerMessage(message, message.attachments!.map(attachment => ({ attachment, data: bytes.get(attachment.id)! })));
  const readImage = store.readImage.bind(store);
  context.mock.method(store, 'readImage', (id: string) => {
    reads.push(id); return bytes.has(id) ? readImage(id) : undefined;
  });
  return { reads, bytes, messages, store };
}

test('large image export waits for drain before reading the next binary and remains valid JSON', async context => {
  const f = await fixture(context); const response = new ControlledResponse(true);
  let completed = false;
  const operation = writeRuntimeExport(response.response(), { version: 3, settings: { model: 'fixture' } }, f.messages, f.store).then(() => { completed = true; });
  await response.blocked.promise;
  assert.deepEqual(f.reads, ['image-1']); assert.equal(completed, false); assert.equal(response.ended, false);
  assert.equal(response.listenerCount('drain'), 1); assert.equal(response.listenerCount('close'), 1);
  response.emit('drain'); await operation;
  assert.deepEqual(f.reads, ['image-1', 'image-2']); assert.equal(response.ended, true);
  const exported = JSON.parse(response.chunks.join(''));
  assert.equal(exported.version, 3); assert.equal(exported.imageFiles.length, 2);
  for (const [index, id] of ['image-1', 'image-2'].entries()) {
    assert.equal(exported.imageFiles[index].caseId, 'private-case');
    assert.equal(exported.imageFiles[index].messageId, 'message-' + (index + 1));
    assert.deepEqual(Buffer.from(exported.imageFiles[index].data, 'base64'), f.bytes.get(id));
  }
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  for (const event of ['drain', 'close', 'error']) assert.equal(response.listenerCount(event), 0, 'backpressure listeners must be released');
});

test('disconnect while an image is buffered rejects export and does not read later images', async context => {
  const f = await fixture(context); const response = new ControlledResponse(true);
  const operation = writeRuntimeExport(response.response(), { version: 3 }, f.messages, f.store);
  await response.blocked.promise;
  const rejected = assert.rejects(operation, /连接已关闭/); response.disconnect(); await rejected;
  assert.deepEqual(f.reads, ['image-1']); assert.equal(response.ended, false);
  for (const event of ['drain', 'close', 'error']) assert.equal(response.listenerCount(event), 0);
});

test('disconnect immediately after drain prevents the next SQLite image read', async context => {
  const f = await fixture(context); const response = new ControlledResponse(true);
  const operation = writeRuntimeExport(response.response(), { version: 3 }, f.messages, f.store);
  await response.blocked.promise;
  const rejected = assert.rejects(operation, /连接已关闭/);
  response.emit('drain'); response.disconnect(); await rejected;
  assert.deepEqual(f.reads, ['image-1'], 'a completed drain must not authorize reading after disconnect');
  assert.equal(response.ended, false);
});

test('streamed export redacts JSON-escaped secrets from metadata and attachment metadata', async context => {
  const secret = 'sk-fixture-"\\\nsecret'; const f = await fixture(context, secret); const response = new ControlledResponse();
  f.messages[0].attachments![0].name = secret + '.png';
  await writeRuntimeExport(response.response(), { [secret]: 'redacted key', note: `before ${secret} after`, nested: { values: [secret, 'safe'] } }, f.messages, f.store);
  const text = response.chunks.join(''); const exported = JSON.parse(text);
  assert.equal(exported.note, 'before [REDACTED] after');
  assert.equal(exported['[REDACTED]'], 'redacted key');
  assert.deepEqual(exported.nested.values, ['[REDACTED]', 'safe']);
  assert.equal(exported.imageFiles[0].name, '[REDACTED].png');
  assert.equal(text.includes(JSON.stringify(secret).slice(1, -1)), false);
  assert.deepEqual(Buffer.from(exported.imageFiles[0].data, 'base64'), f.bytes.get('image-1'), 'redaction must preserve ordinary image data');
});

test('missing attachment bytes export an explicit null instead of inventing or dropping a file', async context => {
  const f = await fixture(context); f.bytes.delete('image-2'); const response = new ControlledResponse();
  await writeRuntimeExport(response.response(), {}, f.messages, f.store);
  const exported = JSON.parse(response.chunks.join(''));
  assert.equal(exported.imageFiles.length, 2); assert.equal(exported.imageFiles[1].id, 'image-2'); assert.equal(exported.imageFiles[1].data, null);
});
