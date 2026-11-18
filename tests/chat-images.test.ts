import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createApp } from '../server/index.js';
import { prepareImages } from '../server/v2/images.js';
import { MAX_IMAGE_BYTES } from '../shared/chat-images.js';

process.env.DEEPSEEK_API_KEY = '';
interface HttpResult { status: number; bytes: Buffer; json: any; headers: Record<string, string | string[] | undefined> }
type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
async function png(width = 32, height = 24) {
  return sharp({ create: { width, height, channels: 3, background: '#39584a' } }).png().toBuffer();
}
const upload = (bytes: Buffer, name = 'image.png') => ({ name, data: bytes.toString('base64') });
const fileUpload = (name: string, mediaType: string, bytes: Buffer) => ({ name, mediaType, data: bytes.toString('base64') });
const closeServer = (server: Server) => new Promise<void>(done => {
  if (!server.listening) return done();
  server.closeAllConnections(); server.close(() => done());
});
async function fixture() {
  const prefix = join(tmpdir(), 'rae-chat-images-'); const directory = await mkdtemp(prefix);
  const dataDir = join(directory, 'data'); const runtimeDir = join(directory, 'native');
  const prompts: ModelOptions[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    prompts.push(options);
    return { content: [{ type: 'text', text: '已收到图片。' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  let store = new Store(dataDir); store.getApiKey = () => undefined;
  let engine = await V2Coordinator.create(store, { dataDir: runtimeDir, model });
  let app = createApp({ store, runtime: engine });
  const listen = () => new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  await listen();
  const f = {
    get store() { return store; }, get engine() { return engine; }, prompts,
    blobCount(table: 'message_images' | 'message_files' = 'message_images') {
      const db = new DatabaseSync(join(dataDir, 'rae.sqlite'), { readOnly: true });
      try { return Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count); }
      finally { db.close(); }
    },
    call(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
      const address = app.address(); assert.ok(address && typeof address === 'object');
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((done, fail) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method,
          headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...extraHeaders } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => { const bytes = Buffer.concat(chunks); let json: unknown; try { json = JSON.parse(bytes.toString('utf8')); } catch {}
            done({ status: response.statusCode ?? 0, bytes, json, headers: response.headers }); });
        }); request.on('error', fail); request.end(payload);
      });
    },
    async restart() {
      await closeServer(app); await engine.close(); store.close();
      store = new Store(dataDir); store.getApiKey = () => undefined;
      engine = await V2Coordinator.create(store, { dataDir: runtimeDir, model });
      app = createApp({ store, runtime: engine }); await listen();
    },
    async close() {
      await closeServer(app); await engine.close(); store.close();
      assert.ok(resolve(directory).startsWith(resolve(prefix)));
      try { await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // The parent offline runner cleans the isolated temp root after native clients exit.
      }
    },
  };
  return f;
}
async function waitForProcessed(f: Awaited<ReturnType<typeof fixture>>, messageId: string) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const event = f.engine.inbox.list().find(item => item.payload.messageId === messageId);
    if (event?.status === 'failed') assert.fail(event.lastError ?? 'image message failed');
    if (event?.status === 'processed') return;
    assert.ok(Date.now() < deadline, 'image message did not finish'); await delay(20);
  }
}
function imageParts(options: ModelOptions) {
  return options.prompt.flatMap(message => message.role === 'user' ? message.content.filter(part => part.type === 'file') : []);
}

test('image-only chat persists private binary attachments and exports them across a full restart without inference', async () => {
  const f = await fixture();
  try {
    const source = await png();
    const sent = await f.call('/api/messages', 'POST', { content: '', attachments: [upload(source)] });
    assert.equal(sent.status, 202); assert.equal(sent.json.content, '');
    assert.equal(sent.json.attachments.length, 1); assert.equal(sent.json.caseId, 'personal-growth');
    const attachment = sent.json.attachments[0]; assert.equal(attachment.mediaType, 'image/png');
    assert.equal(attachment.width, 32); assert.equal(attachment.height, 24); assert.equal(attachment.data, undefined);
    const image = f.store.readImage(attachment.id); assert.ok(image); assert.equal(image.caseId, sent.json.caseId); assert.equal(image.messageId, sent.json.id);
    assert.equal(f.blobCount(), 1); assert.equal(f.prompts.length, 0);
    const imageUrl = '/api/images/' + attachment.id;
    const displayed = await f.call(imageUrl); assert.equal(displayed.status, 200); assert.deepEqual(displayed.bytes, image.data);
    assert.equal(displayed.headers['content-type'], 'image/png'); assert.equal(displayed.headers['cache-control'], 'private, no-store');
    assert.equal(displayed.headers['x-content-type-options'], 'nosniff'); assert.equal(displayed.headers['cross-origin-resource-policy'], 'same-origin');
    const head = await f.call(imageUrl, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers['content-length']), image.data.length);
    assert.equal((await f.call(imageUrl, 'GET', undefined, { origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await f.call('/api/images/' + randomUUID())).status, 404);
    const snapshot = await f.call('/api/state'); assert.equal(snapshot.status, 200); assert.equal(snapshot.json.messages[0].attachments[0].id, attachment.id);
    assert.equal(JSON.stringify(snapshot.json).includes(source.toString('base64')), false, 'polling state must contain references only');
    const exported = await f.call('/api/export'); assert.equal(exported.status, 200); assert.equal(exported.json.imageFiles.length, 1);
    assert.equal(exported.json.imageFiles[0].messageId, sent.json.id); assert.equal(exported.json.imageFiles[0].data, image.data.toString('base64'));
    await f.restart();
    assert.deepEqual((await f.call(imageUrl)).bytes, image.data); assert.equal(f.blobCount(), 1);
    const reopened = await f.call('/api/state'); assert.equal(reopened.json.messages[0].attachments[0].id, attachment.id);
    const events = f.engine.inbox.list().filter(event => event.kind === 'owner.message');
    assert.equal(events.length, 1, 'recovery must reuse the existing owner event');
    assert.equal(f.prompts.length, 0); assert.equal(f.engine.status().state, 'paused');
  } finally { await f.close(); }
});

test('invalid image batches leave no messages or image blobs, including mixed valid/invalid uploads', async () => {
  const f = await fixture();
  try {
    const valid = upload(await png());
    const oversized = upload(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'large.png');
    const hugeDimensions = upload(await png(3000, 3000), 'huge.png');
    for (const attachments of [
      [{ name: 'invalid.png', data: 'not base64!' }],
      [{ name: 'spoof.png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') }],
      [{ name: 'broken.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0]).toString('base64') }],
      [oversized], [hugeDimensions], Array.from({ length: 5 }, () => valid),
      [valid, { name: 'broken.png', data: 'AAAA' }],
      [{ ...valid, name: '../escaped.png' }],
    ]) {
      const response = await f.call('/api/messages', 'POST', { content: '不能保存半条消息', attachments });
      assert.equal(response.status, 400, JSON.stringify(response.json));
      assert.equal(f.store.list('messages').length, 0); assert.equal(f.blobCount(), 0);
      assert.equal(f.engine.inbox.list().filter(event => event.kind === 'owner.message').length, 0);
    }
    assert.equal((await f.call('/api/messages', 'POST', { content: '', attachments: [] })).status, 400);
    assert.equal((await f.call('/api/messages', 'POST', { content: 'x'.repeat(2 * 1024 * 1024) })).status, 400);
    assert.equal(f.store.list('messages').length, 0); assert.equal(f.blobCount(), 0);
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

test('message and image inserts roll back together when a blob insertion fails', async () => {
  const f = await fixture();
  try {
    const prepared = await prepareImages([upload(await png())]);
    const first = { id: randomUUID(), role: 'user' as const, content: '', createdAt: new Date().toISOString(), caseId: 'personal-growth', attachments: prepared.map(image => image.attachment) };
    f.store.insertOwnerMessage(first, prepared);
    const other = await prepareImages([upload(await png(20, 20))]);
    const second = { ...first, id: randomUUID(), attachments: [...other, ...prepared].map(image => image.attachment) };
    assert.throws(() => f.store.insertOwnerMessage(second, [...other, ...prepared]));
    assert.equal(f.store.get('messages', second.id), undefined); assert.equal(f.store.readImage(other[0].attachment.id), undefined);
    assert.equal(f.blobCount(), 1); assert.ok(f.store.readImage(prepared[0].attachment.id));
  } finally { await f.close(); }
});

test('chat files are idempotent, download as original bytes and survive restart and export', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const workbook = fileUpload("项目'预算（秋季）.xlsx", 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);
    const generic = fileUpload('附件.bin', 'application/octet-stream', Buffer.alloc(2 * 1024 * 1024, 0xa5));
    const submission = { content: '', requestId: randomUUID(), files: [workbook, generic] };
    const [sent, replay] = await Promise.all([f.call('/api/messages', 'POST', submission), f.call('/api/messages', 'POST', submission)]);
    assert.equal(sent.status, 202); assert.equal(replay.status, 202); assert.deepEqual(replay.json, sent.json);
    const [attachment, genericAttachment] = sent.json.files;
    assert.deepEqual(attachment, { id: attachment.id, name: workbook.name, mediaType: workbook.mediaType, size: bytes.length });
    assert.equal(genericAttachment.size, 2 * 1024 * 1024);
    const changed = { ...submission, files: [{ ...workbook, data: 'YXNk' }, generic] };
    assert.equal((await f.call('/api/messages', 'POST', changed)).status, 409);
    assert.equal(f.store.list('messages').length, 1);
    assert.equal(f.blobCount('message_files'), 2);
    assert.equal(f.store.readChatFile(attachment.id, 'other-message'), undefined);
    assert.equal(f.store.messagePreviews([sent.json.caseId])[sent.json.caseId], workbook.name);
    const fileUrl = '/api/chat/files/' + attachment.id;
    const downloaded = await f.call(fileUrl);
    assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.bytes, bytes);
    assert.equal(downloaded.headers['content-type'], workbook.mediaType);
    assert.equal(downloaded.headers['cache-control'], 'private, no-store');
    assert.match(String(downloaded.headers['content-disposition']), /^attachment;.*filename\*=UTF-8''.*%27.*\.xlsx$/);
    assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
    const head = await f.call(fileUrl, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers['content-length']), bytes.length);
    assert.equal((await f.call(fileUrl, 'GET', undefined, { origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await f.call('/api/chat/files/' + randomUUID())).status, 404);
    const reply = await f.call('/api/messages', 'POST', { content: '引用附件', replyTo: sent.json.id });
    assert.equal(reply.status, 202);
    const snapshot = await f.call('/api/state');
    assert.deepEqual(snapshot.json.messages[0].files, sent.json.files);
    assert.equal(snapshot.json.messages[1].replyPreview, workbook.name);
    assert.equal(JSON.stringify(snapshot.json).includes(workbook.data), false);
    const exported = await f.call('/api/export');
    assert.equal(exported.status, 200); assert.equal(exported.json.chatFiles.length, 2);
    assert.deepEqual(exported.json.chatFiles[0], { ...attachment, messageId: sent.json.id, caseId: sent.json.caseId, data: workbook.data });
    assert.equal(exported.json.chatFiles[1].data, generic.data);
    await f.restart();
    assert.deepEqual((await f.call(fileUrl)).bytes, bytes);
    const events = f.engine.inbox.list().filter(event => event.payload.messageId === sent.json.id);
    assert.equal(events.length, 1); assert.deepEqual(events[0].payload.files, sent.json.files);
    assert.equal(f.prompts.length, 0);
  } finally { await f.close(); }
});

test('invalid file metadata and mixed image-file uploads leave no partial records', async () => {
  const f = await fixture();
  try {
    const image = upload(await png());
    const file = fileUpload('valid.bin', 'application/octet-stream', Buffer.from('arbitrary binary'));
    for (const invalid of [{ ...file, name: '../outside.bin' }, { ...file, name: 'line\nbreak.bin' },
      { ...file, mediaType: 'text/plain\r\nX-Injection: value' }, { ...file, data: 'AA=A' }]) {
      const response = await f.call('/api/messages', 'POST', { content: '', attachments: [image], files: [file, invalid] });
      assert.equal(response.status, 400);
    }
    assert.equal((await f.call('/api/messages', 'POST', { content: '', attachments: [image], files: Array(5).fill(file) })).status, 400);
    assert.equal(f.store.list('messages').length, 0);
    assert.equal(f.blobCount(), 0); assert.equal(f.blobCount('message_files'), 0);
    const [preparedImage] = await prepareImages([image]);
    const preparedFile = { attachment: { id: randomUUID(), name: file.name, mediaType: file.mediaType, size: 3 }, data: Buffer.from('one') };
    const message = { id: randomUUID(), role: 'user' as const, content: '', createdAt: new Date().toISOString(), caseId: 'personal-growth',
      attachments: [preparedImage.attachment], files: [preparedFile.attachment] };
    const requestId = randomUUID();
    assert.throws(() => f.store.insertOwnerMessage(message, [preparedImage], { id: requestId, fingerprint: 'same request' }, [preparedFile, preparedFile]));
    assert.equal(f.store.get('messages', message.id), undefined);
    assert.equal(f.store.readChatFile(preparedFile.attachment.id), undefined);
    assert.equal(f.store.ownerMessageRequest(requestId), undefined);
    assert.equal(f.blobCount(), 0); assert.equal(f.blobCount('message_files'), 0);
  } finally { await f.close(); }
});

test('case-scoped image followups survive restart; quoted images return without leaking into another case', async () => {
  const f = await fixture();
  try {
    const project = await f.engine.createCase({ title: '图片事项', objective: '只在本事项解释截图', domain: 'work' });
    const other = await f.engine.createCase({ title: '其他事项', objective: '独立上下文', domain: 'personal' });
    const sent = await f.call('/api/messages', 'POST', { content: '解释这张图', caseId: project.id, attachments: [upload(await png())] });
    assert.equal(sent.status, 202);
    const before = f.store.list('messages').length;
    assert.equal((await f.call('/api/messages', 'POST', { content: '不能跨事项引用', caseId: other.id, replyTo: sent.json.id, attachments: [upload(await png())] })).status, 409);
    assert.equal(f.store.list('messages').length, before); assert.equal(f.blobCount(), 1);
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await waitForProcessed(f, sent.json.id);
    assert.ok(imageParts(f.prompts.at(-1)!).length, 'native provider prompt must carry the real image');
    assert.equal(JSON.stringify(f.prompts.at(-1)).includes('rae-image:'), false, 'opaque local references never reach provider');
    await f.engine.stop(); await f.restart(); f.engine.start();
    const followup = await f.call('/api/messages', 'POST', { content: '继续解释图片中的细节', replyTo: sent.json.id });
    assert.equal(followup.status, 202); assert.equal(followup.json.caseId, project.id); await waitForProcessed(f, followup.json.id);
    assert.ok(imageParts(f.prompts.at(-1)!).length, 'quoted original image must be available after reopening');
    const unrelated = await f.call('/api/messages', 'POST', { content: '这个事项不应收到图片', caseId: other.id });
    assert.equal(unrelated.status, 202); await waitForProcessed(f, unrelated.json.id);
    assert.equal(imageParts(f.prompts.at(-1)!).length, 0, 'another case must not receive private pictures');
    assert.equal(JSON.stringify(f.prompts.at(-1)).includes('解释这张图'), false);
    const native = await f.engine.getCaseDetails(project.id);
    assert.equal(JSON.stringify(native.history).includes(f.store.readImage(sent.json.attachments[0].id)!.data.toString('base64')), false, 'native history also stores only local references');
  } finally { await f.close(); }
});
