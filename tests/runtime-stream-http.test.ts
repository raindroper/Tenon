import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockLanguageModelV4 } from 'ai/test';
import type { RuntimeView, RuntimeViewDelta } from '../shared/runtime-view.js';
import type { ImageAttachment } from '../shared/chat-images.js';
import { KERNEL_SCHEMA_VERSION, Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { WebAuth } from '../server/web-auth.js';
import { createRuntimeController } from '../client/state/useRuntime.js';

interface Frame { event: string; data: unknown; id?: string }
async function removeFixture(directory: string) {
  // The test runner removes its isolated temp root after Windows libSQL handles exit.
  if (process.platform !== 'win32') await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
async function openStream(app: Server, path = '/api/state/stream') {
  const port = (app.address() as { port: number }).port;
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; next(predicate: (frame: Frame) => boolean): Promise<Frame>; close(): void }>((accept, fail) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path }, response => {
      const frames: Frame[] = [];
      const waiters = new Set<{ predicate: (frame: Frame) => boolean; done(frame: Frame): void; fail(error: Error): void }>();
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const index = buffer.indexOf('\n\n'); const source = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const event = source.match(/^event: (.+)$/m)?.[1]; const data = source.match(/^data: (.+)$/m)?.[1];
          if (!event || !data) continue;
          const frame = { event, data: JSON.parse(data) as unknown, id: source.match(/^id: (.+)$/m)?.[1] }; frames.push(frame);
          for (const waiter of waiters) if (waiter.predicate(frame)) { waiters.delete(waiter); waiter.done(frame); }
        }
      });
      response.on('close', () => { for (const waiter of waiters) waiter.fail(new Error('stream closed before expected frame')); waiters.clear(); });
      accept({ status: response.statusCode!, headers: response.headers,
        next(predicate) {
          const existing = frames.find(predicate); if (existing) return Promise.resolve(existing);
          return new Promise<Frame>((done, reject) => {
            const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('expected live frame was not delivered')); }, 10000);
            const waiter = { predicate, done(frame: Frame) { clearTimeout(timer); done(frame); }, fail(error: Error) { clearTimeout(timer); reject(error); } };
            waiters.add(waiter);
          });
        }, close() { response.destroy(); outgoing.destroy(); },
      });
    }); outgoing.on('error', fail); outgoing.end();
  });
}

async function getJson<T>(app: Server, path: string, input?: object) {
  const port = (app.address() as { port: number }).port;
  return new Promise<{ status: number; body: T; headers: import('node:http').IncomingHttpHeaders }>((accept, fail) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' } } : {}) }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('error', fail);
      response.on('end', () => {
        try { accept({ status: response.statusCode!, body: JSON.parse(body) as T, headers: response.headers }); }
        catch (error) { fail(error); }
      });
    });
    outgoing.on('error', fail); outgoing.end(input ? JSON.stringify(input) : undefined);
  });
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const publicState = (frame: Frame) => frame.event === 'state' ? frame.data as RuntimeView : undefined;

test('the real HTTP and SSE kernel snapshots reach the client controller with a visible conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-client-kernel-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory });
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  let receive!: (snapshot: RuntimeView) => void;
  const controller = createRuntimeController(async () => {
    const response = await getJson<RuntimeView>(app, '/api/state?caseId=personal-growth');
    assert.equal(response.status, 200); return response.body;
  }, callback => { receive = callback; return () => {}; });
  controller.setScope({ caseId: 'personal-growth' });
  const stop = controller.start();
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    assert.equal(await controller.refresh(), true);
    assert.equal(controller.getSnapshot().runtime?.schemaVersion, KERNEL_SCHEMA_VERSION);
    assert.equal(controller.getSnapshot().connectionError, '');
    stream = await openStream(app, '/api/state/stream?caseId=personal-growth');
    receive((await stream.next(frame => frame.event === 'state')).data as RuntimeView);
    const owner = await runtime.ingestOwnerMessage('界面与当前后端的数据版本一致。');
    const update = await stream.next(frame => Boolean(publicState(frame)?.messages.some(message => message.id === owner.externalId)));
    receive(update.data as RuntimeView);
    assert.equal(controller.getSnapshot().connectionError, '');
    assert.equal(controller.getSnapshot().runtime?.messages.at(-1)?.content, '界面与当前后端的数据版本一致。');
    assert.equal(controller.getSnapshot().runtime?.schemaVersion, KERNEL_SCHEMA_VERSION);
    assert.equal(store.list('runs').length, 0);
  } finally {
    stop(); stream?.close(); await new Promise<void>(done => app.close(() => done()));
    await runtime.close(); store.close(); await removeFixture(directory);
  }
});

test('scoped chat pages stay bounded and stable across same-time writes while full export preserves old messages and images', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-chat-window-http-'));
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: join(directory, 'native') });
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  try {
    const first = await runtime.createCase({ title: '长对话', objective: '测试历史分页', domain: 'test' });
    const second = await runtime.createCase({ title: '独立对话', objective: '测试主题隔离', domain: 'test' });
    const createdAt = '2024-05-01T08:00:00.000Z';
    const firstId = (position: number) => `long-${92 - position}`;
    const firstMessages = Array.from({ length: 92 }, (_, index) => firstId(index));
    const attachments: ImageAttachment[] = [];
    const imageBytes = Buffer.from('private fixture image bytes');
    for (const [index, id] of firstMessages.entries()) {
      const message = { id, role: 'user' as const, content: index === 0 ? '早期引用原文。' : `长对话消息 ${index}`, createdAt, caseId: first.id };
      if (index < 13) {
        const attachment: ImageAttachment = { id: randomUUID(), name: `图-${index}.png`, mediaType: 'image/png', size: imageBytes.length, width: 1, height: 1 };
        attachments.push(attachment); store.insertOwnerMessage({ ...message, attachments: [attachment] }, [{ attachment, data: imageBytes }]);
      } else store.insert('messages', { ...message, ...(index === 91 ? { replyTo: firstId(0) } : {}) });
      if (index === 45) store.insert('messages', { id: 'quiet', role: 'user', content: '独立主题预览。', createdAt, caseId: second.id });
    }
    store.insert('messages', { id: 'legacy-unscoped', role: 'user', content: '旧版未归类历史。', createdAt });

    const path = `/api/state?caseId=${first.id}`;
    const ids = (view: RuntimeView) => view.messages.map(message => message.id);
    const latest = await getJson<RuntimeView>(app, path);
    assert.equal(latest.status, 200);
    assert.deepEqual(ids(latest.body), firstMessages.slice(-40));
    assert.equal(latest.body.conversation?.caseId, first.id);
    assert.equal(latest.body.conversation?.before, null);
    assert.equal(latest.body.conversation?.nextBefore, firstId(52));
    assert.equal(latest.body.messages.at(-1)?.replyPreview, '早期引用原文。');
    assert.equal(latest.body.casePreviews?.[second.id], '独立主题预览。');

    store.insert('messages', { id: 'new-live', role: 'user', content: '同一时间写入的后续消息。', createdAt, caseId: first.id });
    const older = await getJson<RuntimeView>(app, `${path}&before=${latest.body.conversation!.nextBefore}`);
    assert.equal(older.status, 200);
    assert.equal(older.body.conversation?.beforeCreatedAt, createdAt);
    assert.deepEqual(ids(older.body), firstMessages.slice(12, 52));
    const olderStream = await openStream(app, `/api/state/stream?caseId=${first.id}&before=${latest.body.conversation!.nextBefore}`);
    try {
      assert.equal(olderStream.status, 200);
      const liveOlder = publicState(await olderStream.next(frame => Boolean(publicState(frame))))!;
      assert.equal(liveOlder.conversation?.before, firstId(52));
      assert.deepEqual(ids(liveOlder), ids(older.body));
    } finally { olderStream.close(); }
    const oldest = await getJson<RuntimeView>(app, `${path}&before=${older.body.conversation!.nextBefore}`);
    assert.equal(oldest.status, 200);
    assert.equal(oldest.body.conversation?.nextBefore, null);
    assert.deepEqual([...ids(oldest.body), ...ids(older.body), ...ids(latest.body)], firstMessages);
    assert.deepEqual(ids((await getJson<RuntimeView>(app, path)).body), [...firstMessages.slice(-39), 'new-live']);
    assert.deepEqual(ids((await getJson<RuntimeView>(app, `/api/state?caseId=${second.id}`)).body), ['quiet']);
    const invalidCursor = await getJson<RuntimeView>(app, `${path}&before=quiet`);
    assert.ok(invalidCursor.status >= 400 && invalidCursor.status < 500, 'a cursor from another case must fail');

    const references = await getJson<ImageAttachment[]>(app, `/api/cases/${first.id}/images`);
    assert.equal(references.status, 200);
    assert.deepEqual(references.body.map(image => image.id).sort(), attachments.slice(1).map(image => image.id).sort());
    assert.equal(JSON.stringify(references.body).includes(imageBytes.toString('base64')), false);
    assert.deepEqual((await getJson<ImageAttachment[]>(app, `/api/cases/${second.id}/images`)).body, []);

    const exported = await getJson<RuntimeView & { imageFiles: { id: string; data: string }[] }>(app, '/api/export');
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-disposition'] ?? '', /^attachment;/);
    assert.deepEqual(new Set(ids(exported.body)), new Set([...firstMessages, 'quiet', 'legacy-unscoped', 'new-live']));
    assert.equal(exported.body.imageFiles.length, attachments.length);
    assert.equal(exported.body.imageFiles.find(image => image.id === attachments[0].id)?.data, imageBytes.toString('base64'));
  } finally {
    await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close();
    await removeFixture(directory);
  }
});

test('negotiated updates omit large unchanged documents and feedback binds the displayed version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-delta-feedback-http-'));
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: join(directory, 'native') });
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    const item = await runtime.createCase({ title: 'Fixture', objective: 'Review scope', domain: 'test' });
    const privateDocument = 'a'.repeat(200 * 1024);
    await runtime.addSource({ title: 'Source fixture', caseId: item.id, content: privateDocument });
    const path = `/api/state/stream?delta=1&caseId=${item.id}`;
    stream = await openStream(app, path);
    const first = await stream.next(frame => frame.event === 'state');
    assert.equal((first.data as RuntimeView).sources[0].content, privateDocument);
    const reply = { id: 'reply', caseId: item.id, role: 'assistant' as const, content: 'Visible part', createdAt: new Date().toISOString() };
    store.put('messages', { ...reply, outputState: 'streaming' });
    const partial = await stream.next(frame => frame.event === 'state-delta');
    const patch = partial.data as RuntimeViewDelta;
    assert.equal(patch.base, first.id);
    assert.equal(patch.replace.sources, undefined); assert.equal(patch.replace.events, undefined);
    assert.equal(patch.replace.messages?.[0].feedbackVersion, undefined);
    assert.ok(JSON.stringify(patch).length < 2000);

    const feedback = { targetType: 'message', targetId: reply.id, verdict: 'useful' };
    assert.equal((await getJson(app, '/api/feedback', feedback)).status, 409);
    store.put('messages', { ...reply, outputState: 'complete' });
    const shown = await stream.next(frame => frame.event === 'state-delta' &&
      (frame.data as RuntimeViewDelta).replace.messages?.[0].outputState === 'complete');
    const version = (shown.data as RuntimeViewDelta).replace.messages?.[0].feedbackVersion;
    assert.match(version ?? '', /^[a-f0-9]{64}$/);
    store.put('messages', { ...reply, content: `${reply.content}. Later text.`, outputState: 'complete' });
    assert.equal((await getJson(app, '/api/feedback', { ...feedback, targetVersion: version })).status, 409);
    assert.deepEqual(store.list('feedback'), []);
    const current = await getJson<RuntimeView>(app, `/api/state?caseId=${item.id}`);
    const accepted = await getJson<{ targetContent: string; targetVersion: string }>(app, '/api/feedback',
      { ...feedback, targetVersion: current.body.messages[0].feedbackVersion });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.targetContent, 'Visible part. Later text.');
    assert.equal(accepted.body.targetVersion, current.body.messages[0].feedbackVersion);

    stream.close(); stream = await openStream(app, path);
    const resync = await stream.next(frame => frame.event === 'state');
    assert.equal((resync.data as RuntimeView).messages[0].content, accepted.body.targetContent);
  } finally {
    stream?.close(); await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close();
    await removeFixture(directory);
  }
});

test('HTTP delivers durable public deltas before model completion, resyncs after reconnect, and drains on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-live-state-http-')); const gate = deferred();
  const store = new Store(join(directory, 'store')); const secret = 'fixture-secret-never-returned'; store.getApiKey = () => secret;
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async options => { calls++; return { stream: new ReadableStream({ start(controller) {
    controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'reasoning-start', id: 'private' });
    controller.enqueue({ type: 'reasoning-delta', id: 'private', delta: 'PRIVATE_REASONING_ONLY' }); controller.enqueue({ type: 'reasoning-end', id: 'private' });
    controller.enqueue({ type: 'text-start', id: 'answer' }); controller.enqueue({ type: 'text-delta', id: 'answer', delta: `第一段。${secret}` });
    options.abortSignal?.addEventListener('abort', () => { try { controller.error(new Error('fixture aborted')); } catch {} }, { once: true });
    void gate.promise.then(() => { try {
      controller.enqueue({ type: 'text-delta', id: 'answer', delta: '第二段。' }); controller.enqueue({ type: 'text-end', id: 'answer' });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } } }); controller.close();
    } catch {} });
  } }) }; } });
  const runtime = await V2Coordinator.create(store, { dataDir: join(directory, 'native'), model });
  const app = createApp({ store, runtime }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  let quietStream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    const active = await runtime.createCase({ title: '流式对话', objective: '测试分页窗口内的回复', domain: 'test' });
    const quiet = await runtime.createCase({ title: '另一个对话', objective: '测试并发订阅隔离', domain: 'test' });
    const createdAt = '2024-05-01T08:00:00.000Z';
    for (let index = 0; index < 45; index++) {
      store.insert('messages', { id: `past-${index}`, role: 'user', content: `旧消息 ${index}`, createdAt, caseId: active.id });
    }
    store.insert('messages', { id: 'quiet-only', role: 'user', content: '独立主题的历史。', createdAt, caseId: quiet.id });
    const streamPath = `/api/state/stream?caseId=${active.id}`;
    [stream, quietStream] = await Promise.all([openStream(app, streamPath), openStream(app, `/api/state/stream?caseId=${quiet.id}`)]);
    assert.equal(stream.status, 200); assert.match(String(stream.headers['content-type']), /text\/event-stream/); assert.equal(stream.headers['x-accel-buffering'], 'no');
    const initial = publicState(await stream.next(frame => Boolean(publicState(frame))))!;
    const quietInitial = publicState(await quietStream.next(frame => Boolean(publicState(frame))))!;
    assert.equal(initial.conversation?.caseId, active.id);
    assert.equal(initial.messages.length, 40); assert.equal(initial.messages[0].id, 'past-5');
    assert.equal(quietInitial.conversation?.caseId, quiet.id);
    assert.deepEqual(quietInitial.messages.map(message => message.id), ['quiet-only']);
    assert.equal(calls, 0, 'view subscriptions cannot start inference');
    await runtime.ingestOwnerMessage('请回答。', active.id); await store.updateSettings({ enabled: true, maxOutputContinuations: 0 }); runtime.start();
    const partial = publicState(await stream.next(frame => Boolean(publicState(frame)?.messages.some(message => message.outputState === 'streaming'))))!;
    const answer = partial.messages.find(message => message.role === 'assistant')!;
    assert.match(answer.content, /第一段。\[REDACTED\]/); assert.doesNotMatch(JSON.stringify(partial), /PRIVATE_REASONING_ONLY|fixture-secret-never-returned/);
    assert.equal(partial.messages.length, 40); assert.equal(partial.messages[0].id, 'past-7');
    assert.doesNotMatch(JSON.stringify(partial), /旧消息 0|"past-0"/);
    assert.equal(partial.runs[0].status, 'running'); assert.equal(calls, 1);
    stream.close(); stream = await openStream(app, streamPath);
    const recovered = publicState(await stream.next(frame => Boolean(publicState(frame)?.messages.some(message => message.id === answer.id))))!;
    assert.equal(recovered.messages.length, 40);
    assert.equal(recovered.messages.find(message => message.id === answer.id)?.outputState, 'streaming'); assert.equal(calls, 1);
    gate.resolve();
    const complete = publicState(await stream.next(frame => Boolean(publicState(frame)?.messages.some(message => message.id === answer.id && message.outputState === 'complete') && publicState(frame)?.status.state !== 'working')))!;
    assert.match(complete.messages.find(message => message.id === answer.id)!.content, /第一段。.*第二段。/s);
    assert.equal(complete.runs[0].status, 'completed'); assert.equal(calls, 1);
    const globalNotice = publicState(await quietStream.next(frame => Boolean(publicState(frame)?.notificationMessages?.some(message => message.id === answer.id && message.outputState === 'complete'))))!;
    assert.equal(globalNotice.notificationMessages?.find(message => message.id === answer.id)?.caseId, active.id);
    assert.deepEqual(globalNotice.messages.map(message => message.id), ['quiet-only'], 'global notices do not replace the scoped conversation');
    assert.doesNotMatch(JSON.stringify(globalNotice.notificationMessages), /PRIVATE_REASONING_ONLY|fixture-secret-never-returned/);
    assert.equal(calls, 1, 'notifications add no model calls');
    // Closing an HTTP server with a live EventSource must not wait forever for that connection.
    await new Promise<void>((done, fail) => app.close(error => error ? fail(error) : done()));
  } finally {
    gate.resolve(); stream?.close(); quietStream?.close(); if (app.listening) await new Promise<void>(done => app.close(() => done()));
    await runtime.close(); store.close(); await removeFixture(directory);
  }
});

test('a revoked login stops an existing stream before it receives another private snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-live-session-http-')); const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: join(directory, 'native') }); let allowed = false;
  const auth = { isAuthenticated: () => allowed } as unknown as WebAuth;
  const app = createApp({ store, runtime, auth }); await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    stream = await openStream(app); assert.equal(stream.status, 401); stream.close();
    allowed = true; stream = await openStream(app); await stream.next(frame => Boolean(publicState(frame)));
    allowed = false; store.insert('messages', { id: 'after-logout', role: 'user', content: 'PRIVATE_AFTER_LOGOUT', createdAt: new Date().toISOString() });
    assert.equal((await stream.next(frame => frame.event === 'session-expired')).event, 'session-expired');
  } finally {
    stream?.close(); await new Promise<void>(done => app.close(() => done())); await runtime.close(); store.close();
    await removeFixture(directory);
  }
});
