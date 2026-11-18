import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { APICallError } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { imageRequestError } from '../server/v2/image-errors.js';

const providerError = (statusCode: number, message = 'This model does not support image input') => new APICallError({
  message, url: 'http://127.0.0.1:1/v1/chat/completions', requestBodyValues: {}, statusCode,
  responseBody: JSON.stringify({ error: { message } }),
});

test('vision errors classify only deterministic image rejection, including wrapped native errors', () => {
  for (const code of [400, 415, 422]) assert.match(imageRequestError(new Error('native wrapper', { cause: providerError(code) })) ?? '', /切换支持看图的模型/);
  for (const code of [401, 403, 429, 500, 503]) assert.equal(imageRequestError(providerError(code)), undefined,
    `HTTP ${code} must retain credential/rate-limit/outage handling even when its text mentions images`);
  assert.equal(imageRequestError(providerError(400, 'invalid tools schema')), undefined);
  assert.equal(imageRequestError(new Error('An untyped image error')), undefined);
  const circular: { cause?: unknown } = {}; circular.cause = circular;
  assert.equal(imageRequestError(circular), undefined);
});

test('coordinator marks rejected vision terminal after one real SDK call and retains owner image across reopening', async context => {
  const prefix = join(tmpdir(), 'rae-terminal-vision-'); const directory = await mkdtemp(prefix);
  const dataDir = join(directory, 'data'); const nativeDir = join(directory, 'native');
  const requests: Record<string, unknown>[] = [];
  const model = createDeepSeek({ apiKey: 'offline-vision-fixture', baseURL: 'http://127.0.0.1:1/v1', fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push(request);
    assert.match(JSON.stringify(request.messages), /image_url/);
    return new Response(JSON.stringify({ error: { message: 'This model does not support image input', type: 'invalid_request_error' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  } })('offline-text-only-model');
  const store = new Store(dataDir); store.getApiKey = () => undefined;
  let engine = await V2Coordinator.create(store, { dataDir: nativeDir, model });
  try {
    const image = await sharp({ create: { width: 12, height: 9, channels: 3, background: '#39584a' } }).png().toBuffer();
    const event = await engine.ingestOwnerMessage('请解释这张图片。', undefined, undefined, [{ name: 'example.png', data: image.toString('base64') }]);
    const messageId = String(event.payload.messageId);
    const original = store.get('messages', messageId); assert.ok(original?.caseId); assert.equal(original.attachments?.length, 1);
    const attachment = original.attachments[0];
    await store.updateSettings({ enabled: true }); engine.start();
    const deadline = Date.now() + 10000;
    while (!store.list('runs').some(run => run.eventId === event.id && run.status === 'failed')) {
      assert.ok(Date.now() < deadline, 'the image rejection must settle as a failed run'); await delay(10);
    }
    assert.equal(requests.length, 1, 'the framework must never retry without the picture');
    const failed = engine.inbox.get(event.id); assert.equal(failed?.status, 'failed'); assert.equal(failed?.attempts, 1);
    assert.match(failed?.lastError ?? '', /模型或网关拒绝了图片请求/);
    const run = store.list('runs').find(item => item.eventId === event.id)!;
    assert.match(run.error ?? '', /切换支持看图的模型后重发/);
    assert.match(engine.status().lastError ?? '', /没有丢弃图片改用纯文字/);
    assert.equal(store.list('messages').filter(item => item.role === 'assistant').length, 0, 'a failed vision request must not pretend it answered');
    assert.ok(store.readImage(attachment.id)); assert.equal((await engine.snapshot()).messages.find(item => item.id === messageId)?.attachments?.[0].id, attachment.id);
    assert.equal(engine.inbox.ready(100).some(item => item.id === event.id), false);

    await engine.close();
    engine = await V2Coordinator.create(store, { dataDir: nativeDir, model }); engine.start();
    // An explicit event-loop pass verifies recovery cannot
    // re-enqueue the failed owner event; no manual reflection event is created.
    await delay(100);
    assert.equal(requests.length, 1); assert.equal(engine.inbox.get(event.id)?.status, 'failed');
    const reopened = (await engine.snapshot()).messages.find(item => item.id === messageId);
    assert.deepEqual(reopened?.attachments, original.attachments); assert.equal(reopened?.content, original.content);
    assert.ok(store.readImage(attachment.id));
  } finally {
    await engine.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix)));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      context.diagnostic('cleanup deferred until native clients exit');
    }
  }
});
