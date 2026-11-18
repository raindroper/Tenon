import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { V2Coordinator, type CoordinatorOptions } from '../server/v2/coordinator.js';
import { HubMediaClient } from '../server/media/hub-media.js';
import { createApp } from '../server/index.js';
import { hashWebPassword, WebAuth } from '../server/web-auth.js';
import { prepareImages } from '../server/v2/images.js';
import { mediaContentPath, type MediaJob, type MediaSpec } from '../shared/media.js';
import type { TaskSpec } from '../shared/task-consent.js';

const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#315143' } }).png().toBuffer();
// An ISO BMFF fixture header is enough to exercise bounded binary delivery.
const mp4 = Buffer.from('000000186674797069736F6D0000020069736F6D69736F32', 'hex');
const origin = 'https://rae.example.com';
type ModelOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type ModelResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const modelUsage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const modelTool = (toolName: string, input: unknown): ModelResult => ({ content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage: modelUsage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });
const modelAnswer = (text: string): ModelResult => ({ content: [{ type: 'text', text }], usage: modelUsage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const imageSpec = (prompt = 'Generate the approved fixture image.'): MediaSpec => ({ kind: 'image', model: 'fixture-image', prompt });
const videoSpec = (): MediaSpec => ({ kind: 'video', model: 'fixture-video', prompt: 'Generate the approved fixture video.', seconds: 4 });
function specification(caseId: string, media: MediaSpec): TaskSpec {
  return { caseId, title: 'Approved fixture media', objective: media.prompt, expectedOutput: 'One media file for owner review', capabilities: ['media'], media };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const end = performance.now() + timeout;
  while (!await check()) { assert.ok(performance.now() < end, 'media fixture did not settle'); await delay(20); }
}
const closeServer = (server: Server) => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));

async function fixture(options: { authenticate?: boolean; uncertainImage?: boolean; gateVideoPoll?: boolean;
  uncertainVideo?: boolean; gateVideoCancel?: boolean; waitingCancellation?: boolean; terminalVideoFailure?: boolean;
  videoAudioMode?: 'switchable' | 'always-on'; videoContent?: 'wrong-mime' | 'wrong-magic' | 'oversized' | 'network-once';
  respond?: (request: ModelOptions, index: number) => ModelResult | Promise<ModelResult> } = {}) {
  const prefix = join(tmpdir(), 'rae-media-flow-'); const directory = await mkdtemp(prefix);
  const dataDir = join(directory, 'data'); const runtimeDir = join(directory, 'native');
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let videoComplete = false; let modelCalls = 0; let videoSubmissions = 0; let videoDownloads = 0;
  let releaseVideoPoll!: () => void; let markVideoPollEntered!: () => void;
  const videoPollGate = new Promise<void>(done => { releaseVideoPoll = done; });
  const videoPollEntered = new Promise<void>(done => { markVideoPollEntered = done; });
  let releaseVideoCancel!: () => void; let markVideoCancelEntered!: () => void;
  const videoCancelGate = new Promise<void>(done => { releaseVideoCancel = done; });
  const videoCancelEntered = new Promise<void>(done => { markVideoCancelEntered = done; });
  const provider = new HubMediaClient({ baseUrl: 'http://127.0.0.1:1/v1', connection: () => ({ apiBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-media-key' }),
    fetch: async (address, request) => {
      const path = new URL(String(address)).pathname; const method = request?.method ?? 'GET';
      const body = typeof request?.body === 'string' ? JSON.parse(request.body) : undefined;
      calls.push({ path, method, ...(body ? { body } : {}) });
      if (path === '/v1/media/models') return json({ enabled: true, models: [
        { id: 'fixture-image', name: 'Fixture image model', tags: ['text-to-image', 'image-to-image'] },
        { id: 'fixture-video', name: 'Fixture video model', tags: ['text-to-video', 'image-to-video'], videoGeneration: {
          minSeconds: 1, maxSeconds: 8, defaultSeconds: 4, ...(options.videoAudioMode ? { audioMode: options.videoAudioMode, defaultEnableAudio: true } : {}) } },
      ] });
      if (path === '/v1/images/generations' || path === '/v1/images/edits') {
        if (options.uncertainImage) throw new TypeError('fixture lost connection after accepting generation');
        return json({ model: 'fixture-image', data: [{ b64_json: png.toString('base64') }] });
      }
      if (path === '/v1/videos' && method === 'POST') {
        videoSubmissions++;
        if (options.uncertainVideo && videoSubmissions === 1) throw new TypeError('fixture lost response after accepting video');
        return json({ id: 'fixture-upstream-video' + (videoSubmissions === 1 ? '' : `-${videoSubmissions}`), status: 'queued', model: 'fixture-video', seconds: 4 }, 202);
      }
      const videoPath = path.match(/^\/v1\/videos\/(fixture-upstream-video(?:-\d+)?)(?:\/(content|cancel))?$/);
      if (videoPath && !videoPath[2] && method === 'GET') {
        if (options.gateVideoPoll) { markVideoPollEntered(); await videoPollGate; }
        if (options.terminalVideoFailure && videoPath[1] === 'fixture-upstream-video') {
          return json({ id: videoPath[1], status: 'failed', error: { code: 'upstream_error', message: 'fixture terminal worker failure with no output' } });
        }
        return json({ id: videoPath[1], status: videoComplete ? 'completed' : 'queued', model: 'fixture-video', seconds: 4 });
      }
      if (videoPath?.[2] === 'cancel' && method === 'POST') {
        if (options.gateVideoCancel) { markVideoCancelEntered(); await videoCancelGate; }
        return json({ id: videoPath[1], status: 'failed', error: { code: 'cancelled',
          message: options.waitingCancellation ? 'cancelled while queued (未提交到上游，未扣费)' : 'fixture local queue cancelled' } });
      }
      if (videoPath?.[2] === 'content') {
        videoDownloads++;
        if (options.videoContent === 'network-once' && videoDownloads === 1) throw new TypeError('fixture transient download connection failure');
        if (options.videoContent === 'wrong-mime') return new Response('<html>not a video</html>', { headers: { 'content-type': 'text/html' } });
        if (options.videoContent === 'wrong-magic') return new Response('not-an-mp4-fixture-body', { headers: { 'content-type': 'video/mp4' } });
        if (options.videoContent === 'oversized') return new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(101 * 1024 * 1024) } });
        return new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
      }
      throw new Error(`Unexpected fixture media route ${method} ${path}`);
    } });
  const model = new MockLanguageModelV4({ doGenerate: async request => {
    modelCalls++; if (options.respond) return options.respond(request, modelCalls);
    throw new Error('Exact approved media must not invoke a language model');
  } });
  let store = new Store(dataDir); store.getApiKey = () => undefined;
  const coordinatorOptions = { dataDir: runtimeDir, model, mediaClient: provider } as CoordinatorOptions;
  let engine = await V2Coordinator.create(store, coordinatorOptions);
  let auth: WebAuth | undefined;
  if (options.authenticate) auth = new WebAuth({ username: 'rae', password: await hashWebPassword('offline-media-password'), publicOrigin: origin }, join(directory, 'auth.sqlite'));
  const open = async () => {
    const previous = process.env.RAE_PUBLIC_ORIGIN;
    if (auth) process.env.RAE_PUBLIC_ORIGIN = origin; else delete process.env.RAE_PUBLIC_ORIGIN;
    let app: Server;
    try { app = createApp({ store, runtime: engine, ...(auth ? { auth } : {}) }); }
    finally { if (previous === undefined) delete process.env.RAE_PUBLIC_ORIGIN; else process.env.RAE_PUBLIC_ORIGIN = previous; }
    await new Promise<void>(done => app.listen(0, '127.0.0.1', done)); return app;
  };
  let app = await open();
  const f = {
    calls, get store() { return store; }, get engine() { return engine; }, modelCalls: () => modelCalls,
    imagePosts: () => calls.filter(call => call.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(call.path)),
    videoPosts: () => calls.filter(call => call.method === 'POST' && call.path === '/v1/videos'),
    completeVideo() { videoComplete = true; },
    videoPollEntered, releaseVideoPoll, videoCancelEntered, releaseVideoCancel,
    leaveSubmissionUnacknowledged(eventId: string) {
      const db = new DatabaseSync(join(runtimeDir, 'v2-events.sqlite'));
      try { db.prepare("UPDATE events SET status='leased',lease_until=?,lease_token=? WHERE id=?").run(Date.now() + 60_000, randomUUID(), eventId); }
      finally { db.close(); }
    },
    async job(taskId: string): Promise<MediaJob | undefined> { return (await engine.snapshot()).mediaJobs?.find(job => job.taskId === taskId); },
    call(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
      const address = app.address(); assert.ok(address && typeof address === 'object');
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise<{ status: number; body: Buffer; json: any; headers: Record<string, string | string[] | undefined> }>((done, fail) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: address.port, method, path,
          headers: { host: auth ? 'rae.example.com' : `127.0.0.1:${address.port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...extra } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => { const body = Buffer.concat(chunks); let parsed; try { parsed = JSON.parse(body.toString('utf8')); } catch {}
            done({ status: response.statusCode!, body, json: parsed, headers: response.headers }); });
        }); request.once('error', fail); request.end(payload);
      });
    },
    async restart() {
      await closeServer(app); await engine.close(); store.close();
      store = new Store(dataDir); store.getApiKey = () => undefined;
      engine = await V2Coordinator.create(store, coordinatorOptions); app = await open();
    },
    async close() {
      releaseVideoPoll(); releaseVideoCancel();
      await closeServer(app); await engine.close(); store.close(); await auth?.close();
      assert.ok(resolve(directory).startsWith(resolve(prefix)));
      try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    },
  };
  return f;
}

test('media proposal makes no paid request before approval; approved image is delivered privately without a language-model turn', async () => {
  const f = await fixture({ authenticate: true });
  try {
    const item = await f.engine.createCase({ title: 'Image fixture', objective: 'Create only the reviewed image', domain: 'media' });
    const owner = f.engine.inbox.ingestProcessed({ sourceId: 'owner-chat', externalId: randomUUID(), caseId: item.id, kind: 'owner.message', actor: 'owner', operation: 'create',
      occurredAt: new Date().toISOString(), payload: { content: 'Please generate one fixture image after I approve the scope.' } });
    const proposed = f.engine.consent.propose(specification(item.id, imageSpec()), owner.id);
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await delay(80);
    assert.equal(f.imagePosts().length, 0); assert.equal(f.modelCalls(), 0);
    const approved = await f.engine.approveTask(proposed.id, proposed.revision);
    await until(async () => (await f.job(approved.id))?.state === 'completed');
    const job = (await f.job(approved.id))!;
    assert.equal(f.imagePosts().length, 1); assert.equal(f.modelCalls(), 0); assert.equal(job.files.length, 1);
    assert.doesNotMatch(JSON.stringify(await f.engine.snapshot()), /b64_json|fixture-media-key|iVBORw0KGgo/, 'snapshots contain file metadata, never generated binary data or provider keys');
    assert.equal(f.engine.consent.get(approved.id)?.state, 'completed');
    assert.deepEqual(f.imagePosts()[0].body, { model: 'fixture-image', prompt: imageSpec().prompt, n: 1, response_format: 'url' });
    const path = mediaContentPath(job.id);
    assert.equal((await f.call(path)).status, 401);
    const login = await f.call('/api/auth/login', 'POST', { username: 'rae', password: 'offline-media-password' }, { origin });
    assert.equal(login.status, 200); const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0];
    const delivered = await f.call(path, 'GET', undefined, { cookie });
    assert.equal(delivered.status, 200); assert.equal(delivered.headers['content-type'], 'image/png'); assert.deepEqual(delivered.body, png);
    assert.equal(delivered.headers['x-content-type-options'], 'nosniff'); assert.match(String(delivered.headers['cache-control']), /private|no-store/);
    const partial = await f.call(path, 'GET', undefined, { cookie, range: 'bytes=0-15' });
    assert.equal(partial.status, 206); assert.equal(partial.headers['content-range'], `bytes 0-15/${png.length}`); assert.deepEqual(partial.body, png.subarray(0, 16));
  } finally { await f.close(); }
});

test('explicit media request is idempotent and its approved prompt cannot be replaced through the same request id', async () => {
  const f = await fixture();
  try {
    const item = await f.engine.createCase({ title: 'Exact media scope', objective: 'Preserve owner scope', domain: 'media' });
    const request = { requestId: 'exact-media-owner-request', spec: specification(item.id, imageSpec()) };
    const task = await f.engine.requestTask(request); const duplicate = await f.engine.requestTask(request);
    assert.equal(duplicate.id, task.id); assert.equal(f.imagePosts().length, 0);
    await assert.rejects(f.engine.requestTask({ ...request, spec: specification(item.id, imageSpec('A different unapproved image')) }));
    assert.equal(f.engine.consent.get(task.id)?.spec.media?.prompt, imageSpec().prompt);
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(async () => (await f.job(task.id))?.state === 'completed');
    assert.equal(f.imagePosts().length, 1); assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});

test('lost image submission becomes unknown and is never automatically submitted again across restart', async () => {
  const f = await fixture({ uncertainImage: true });
  try {
    const item = await f.engine.createCase({ title: 'Uncertain image', objective: 'Do not pay twice', domain: 'media' });
    const task = await f.engine.requestTask({ requestId: 'uncertain-image', spec: specification(item.id, imageSpec()) });
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(async () => (await f.job(task.id))?.state === 'unknown');
    assert.equal(f.imagePosts().length, 1); await f.restart(); f.engine.start(); await delay(100);
    assert.equal((await f.job(task.id))?.state, 'unknown'); assert.equal(f.imagePosts().length, 1); assert.equal(f.modelCalls(), 0);
    assert.equal(f.engine.consent.get(task.id)?.state, 'failed');
  } finally { await f.close(); }
});

test('video resumes polling the persisted Hub task id after restart and delivers its original file without resubmission', async () => {
  const f = await fixture(); const originalNow = Date.now; let shift = 0;
  try {
    const item = await f.engine.createCase({ title: 'Async video', objective: 'Resume the existing Hub task', domain: 'media' });
    const task = await f.engine.requestTask({ requestId: 'durable-video', spec: specification(item.id, videoSpec()) });
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(async () => Boolean((await f.job(task.id))?.upstreamId));
    const before = (await f.job(task.id))!; assert.equal(before.upstreamId, 'fixture-upstream-video'); assert.equal(f.videoPosts().length, 1);
    assert.equal(f.engine.consent.get(task.id)?.state, 'running');
    // Simulate dying after the durable receipt, immediately before event ack.
    f.leaveSubmissionUnacknowledged(f.engine.consent.get(task.id)!.executionEventId!);
    await f.restart(); f.completeVideo(); Date.now = () => originalNow() + shift; shift = 11_000; f.engine.start();
    await until(async () => (await f.job(task.id))?.state === 'completed');
    const completed = (await f.job(task.id))!;
    assert.equal(completed.id, before.id); assert.equal(completed.upstreamId, before.upstreamId); assert.equal(f.videoPosts().length, 1);
    assert.equal(f.modelCalls(), 0); assert.equal(f.engine.consent.get(task.id)?.state, 'completed');
    assert.equal(f.engine.status().pending, false, 'the recovered submission must not leave an old lease masquerading as pending work');
    const content = await f.call(mediaContentPath(completed.id)); assert.equal(content.status, 200); assert.equal(content.headers['content-type'], 'video/mp4'); assert.deepEqual(content.body, mp4);
  } finally { Date.now = originalNow; await f.close(); }
});

test('reference images from another case are rejected before media submission', async () => {
  const f = await fixture();
  try {
    const current = await f.engine.createCase({ title: 'Current image', objective: 'Keep reference scope', domain: 'media' });
    const other = await f.engine.createCase({ title: 'Private reference', objective: 'Do not cross scopes', domain: 'other' });
    const prepared = await prepareImages([{ name: 'fixture.png', data: png.toString('base64') }]);
    f.store.insertOwnerMessage({ id: randomUUID(), role: 'user', content: '', createdAt: new Date().toISOString(), caseId: other.id, attachments: prepared.map(item => item.attachment) }, prepared);
    await assert.rejects(f.engine.requestTask({ requestId: 'wrong-case-reference', spec: specification(current.id, { ...imageSpec(), referenceImageIds: [prepared[0].attachment.id] }) }));
    await assert.rejects(f.engine.requestTask({ requestId: 'wrong-model-kind', spec: specification(current.id, { ...videoSpec(), model: 'fixture-image' }) }));
    await assert.rejects(f.engine.requestTask({ requestId: 'unknown-media-model', spec: specification(current.id, { ...imageSpec(), model: 'missing-media-model' }) }));
    assert.equal(f.imagePosts().length, 0); assert.equal(f.videoPosts().length, 0); assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});

test('an approved same-case reference uses the image edit endpoint and preserves the selected source bytes', async () => {
  const f = await fixture();
  try {
    const item = await f.engine.createCase({ title: 'Reference edit', objective: 'Edit only the selected owner image', domain: 'media' });
    const prepared = await prepareImages([{ name: 'fixture.png', data: png.toString('base64') }]);
    f.store.insertOwnerMessage({ id: randomUUID(), role: 'user', content: '', createdAt: new Date().toISOString(), caseId: item.id, attachments: prepared.map(image => image.attachment) }, prepared);
    const task = await f.engine.requestTask({ requestId: 'same-case-edit', spec: specification(item.id, { ...imageSpec(), referenceImageIds: [prepared[0].attachment.id] }) });
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(async () => (await f.job(task.id))?.state === 'completed');
    assert.equal(f.imagePosts().length, 1); assert.equal(f.imagePosts()[0].path, '/v1/images/edits');
    assert.deepEqual(f.imagePosts()[0].body?.image, ['data:image/png;base64,' + f.store.readImage(prepared[0].attachment.id)!.data.toString('base64')]);
    assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});

test('an ambiguous cancel drains the poll and blocks later videos until the original is privately saved', async () => {
  const f = await fixture({ gateVideoPoll: true }); const originalNow = Date.now; let cancellation: Promise<MediaJob> | undefined;
  try {
    const item = await f.engine.createCase({ title: 'Cancel video poll', objective: 'Retain the cancellation boundary', domain: 'media' });
    const other = await f.engine.createCase({ title: 'Later video', objective: 'Wait for a safe original outcome', domain: 'media' });
    const task = await f.engine.requestTask({ requestId: 'cancel-video-poll', spec: specification(item.id, videoSpec()) });
    const next = await f.engine.requestTask({ requestId: 'cancel-video-next', spec: specification(other.id, videoSpec()) });
    await f.store.updateSettings({ enabled: true }); f.engine.start(); await until(async () => Boolean((await f.job(task.id))?.upstreamId));
    const job = (await f.job(task.id))!;
    Date.now = () => originalNow() + 11_000;
    await until(() => f.calls.some(call => call.method === 'GET' && call.path === '/v1/videos/fixture-upstream-video'));
    await f.videoPollEntered;
    let acknowledged = false; cancellation = f.engine.cancelMediaJob(job.id).then(result => { acknowledged = true; return result; });
    await delay(30); assert.equal(acknowledged, false, 'Cancellation acknowledges only after the already-started poll settles');
    f.releaseVideoPoll(); await cancellation;
    await delay(60);
    assert.equal((await f.job(task.id))?.state, 'cancelled');
    assert.match((await f.job(task.id))?.error ?? '', /后续视频会等待/);
    assert.equal(await f.job(next.id), undefined); assert.equal(f.videoPosts().length, 1);
    f.completeVideo(); Date.now = () => originalNow() + 80_000;
    await until(() => f.videoPosts().length === 2);
    const saved = (await f.job(task.id))!;
    assert.equal(saved.files.length, 1); assert.equal(saved.state, 'cancelled');
    assert.deepEqual((await f.call(mediaContentPath(saved.id))).body, mp4);
    assert.equal(f.modelCalls(), 0);
  } finally { Date.now = originalNow; f.releaseVideoPoll(); await cancellation?.catch(() => undefined); await f.close(); }
});

test('a lost submission stays blocked after restart without blocking unrelated owner chat', async () => {
  const f = await fixture({ uncertainVideo: true, respond: () => modelAnswer('普通聊天已回复。') });
  try {
    const item = await f.engine.createCase({ title: 'Unknown video', objective: 'Persist the uncertain submission', domain: 'media' });
    const other = await f.engine.createCase({ title: 'Later video', objective: 'Never overwrite an unresolved original', domain: 'media' });
    const first = await f.engine.requestTask({ requestId: 'lost-video', spec: specification(item.id, videoSpec()) });
    const later = await f.engine.requestTask({ requestId: 'lost-video-later', spec: specification(other.id, videoSpec()) });
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(async () => (await f.job(first.id))?.state === 'unknown');
    await f.restart();
    const chat = await f.engine.ingestOwnerMessage('视频未确认时正常聊天。');
    f.engine.start();
    await until(() => f.engine.inbox.get(chat.id)?.status === 'processed');
    assert.match((await f.job(first.id))?.error ?? '', /后续视频会等待/);
    assert.equal(await f.job(later.id), undefined);
    assert.equal(f.videoPosts().length, 1);
  } finally { await f.close(); }
});

test('a late cancel result cannot overwrite a privately saved completed job', async () => {
  const f = await fixture({ gateVideoCancel: true }); const originalNow = Date.now;
  let cancellation: Promise<MediaJob> | undefined;
  try {
    const item = await f.engine.createCase({ title: 'Concurrent cancel', objective: 'Keep the private completion receipt', domain: 'media' });
    const task = await f.engine.requestTask({ requestId: 'cancel-after-download', spec: specification(item.id, videoSpec()) });
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(async () => Boolean((await f.job(task.id))?.upstreamId));
    cancellation = f.engine.cancelMediaJob((await f.job(task.id))!.id);
    await f.videoCancelEntered;
    f.completeVideo(); Date.now = () => originalNow() + 6000;
    await until(async () => (await f.job(task.id))?.state === 'completed');
    f.releaseVideoCancel();
    assert.equal((await cancellation).state, 'completed');
    assert.equal(f.engine.consent.get(task.id)?.state, 'completed');
  } finally { Date.now = originalNow; f.releaseVideoCancel(); await cancellation?.catch(() => undefined); await f.close(); }
});

for (const terminalVideoFailure of [false, true]) test(`a confirmed ${terminalVideoFailure ? 'worker failure with no output' : 'waiting cancellation'} releases the video queue`, async () => {
  const f = await fixture({ terminalVideoFailure, waitingCancellation: !terminalVideoFailure }); const originalNow = Date.now;
  try {
    const item = await f.engine.createCase({ title: 'First video', objective: 'End with an authoritative result', domain: 'media' });
    const other = await f.engine.createCase({ title: 'Later video', objective: 'Allow new submissions once safe', domain: 'media' });
    const first = await f.engine.requestTask({ requestId: 'video-with-no-output', spec: specification(item.id, videoSpec()) });
    await f.engine.requestTask({ requestId: 'video-after-no-output', spec: specification(other.id, videoSpec()) });
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(async () => Boolean((await f.job(first.id))?.upstreamId));
    if (terminalVideoFailure) Date.now = () => originalNow() + 6000;
    else await f.engine.cancelMediaJob((await f.job(first.id))!.id);
    await until(() => f.videoPosts().length === 2);
    assert.equal((await f.job(first.id))?.state, terminalVideoFailure ? 'failed' : 'cancelled');
  } finally { Date.now = originalNow; await f.close(); }
});

test('an explicit owner chat request creates one source-bound media task and generation does not add another language-model turn', async () => {
  const media = imageSpec('做一张清爽的测试海报。');
  const f = await fixture({ respond: (request, index) => {
    assert.ok(request.tools?.some(tool => tool.name === 'request_task'));
    assert.ok(!request.tools?.some(tool => ['generate_image', 'submit_video', 'write_workspace', 'publish_artifact'].includes(tool.name)));
    if (index === 1) return modelTool('list_media_models', {});
    if (index === 2) return modelTool('request_task', { title: '制作测试海报', objective: media.prompt,
      expectedOutput: '一张私有图片', capabilities: ['media'], media });
    assert.fail('A recorded task uses a deterministic acknowledgement, not another model call');
  } });
  try {
    const event = await f.engine.ingestOwnerMessage('帮我做一张清爽的测试海报。');
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(async () => {
      const task = f.engine.consent.list().find(task => task.sourceEventId === event.id);
      return Boolean(task && (await f.job(task.id))?.state === 'completed');
    });
    const tasks = f.engine.consent.list(); assert.equal(tasks.length, 1);
    const task = tasks[0]; assert.equal(task.sourceEventId, event.id); assert.deepEqual(task.spec.media, media);
    assert.equal(task.state, 'completed'); assert.equal(f.imagePosts().length, 1); assert.equal(f.modelCalls(), 2);
    assert.equal(f.engine.inbox.get(event.id)?.status, 'processed');
    assert.equal(f.engine.consent.requestOwnerTask(task.spec, event.id).id, task.id);
    assert.throws(() => f.engine.consent.requestOwnerTask({ ...task.spec, media: { ...media, prompt: 'Different unapproved prompt' } }, event.id));
    await delay(50); assert.equal(f.imagePosts().length, 1); assert.equal(f.engine.consent.list().length, 1);
    const runs = f.store.list('runs');
    assert.equal(runs.length, 2, 'The conversation and the durable native task each have a truthful run record');
    assert.equal(runs.filter(run => run.mode === 'growth').length, 1);
    const execution = runs.filter(run => run.mode === 'execution'); assert.equal(execution.length, 1);
    assert.equal(execution[0].taskId, task.id); assert.equal(execution[0].status, 'completed');
    assert.equal(execution[0].usageStatus, 'not_used'); assert.equal(execution[0].steps, 0);
    assert.equal(execution[0].inputTokens, 0); assert.equal(execution[0].outputTokens, 0);
    assert.equal(f.modelCalls(), 2, 'Native workflow bookkeeping must not add a provider request');
  } finally { await f.close(); }
});

test('documents, reflection and fabricated owner provenance cannot authorize media generation', async () => {
  const f = await fixture();
  try {
    const item = await f.engine.createCase({ title: 'Media provenance', objective: 'Only current real owner commands authorize media', domain: 'media' });
    const spec = specification(item.id, imageSpec());
    for (const provenance of [
      { sourceId: 'owner-chat', kind: 'owner.reflect', actor: 'owner' as const },
      { sourceId: 'owner-chat', kind: 'owner.source', actor: 'owner' as const },
      { sourceId: 'workspace-source', kind: 'owner.message', actor: 'owner' as const },
      { sourceId: 'owner-chat', kind: 'owner.message', actor: 'external' as const },
    ]) {
      const messageId = randomUUID();
      const event = f.engine.inbox.ingestProcessed({ ...provenance, externalId: messageId, caseId: item.id, operation: 'create', occurredAt: new Date().toISOString(),
        payload: { messageId, content: 'Please generate an image.' } });
      assert.throws(() => f.engine.consent.requestOwnerTask(spec, event.id), (error: any) => error.code === 'invalid_scope');
    }
    const fake = f.engine.inbox.ingestProcessed({ sourceId: 'owner-chat', kind: 'owner.message', actor: 'owner', externalId: 'different-from-message-id', caseId: item.id,
      operation: 'create', occurredAt: new Date().toISOString(), payload: { messageId: randomUUID(), content: 'Please generate an image.' } });
    assert.throws(() => f.engine.consent.requestOwnerTask(spec, fake.id), (error: any) => error.code === 'invalid_scope');
    assert.equal(f.engine.consent.list().length, 0); assert.equal(f.imagePosts().length, 0); assert.equal(f.videoPosts().length, 0); assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});

test('explicit video audio settings reach Hub unchanged and unsupported silent video is rejected before submission', async () => {
  for (const audioMode of ['switchable', 'always-on'] as const) {
    const f = await fixture({ videoAudioMode: audioMode });
    try {
      const item = await f.engine.createCase({ title: 'Audio scope', objective: 'Respect the owner silent-video requirement', domain: 'media' });
      const request = { requestId: `silent-${audioMode}`, spec: specification(item.id, { ...videoSpec(), enableAudio: false }) };
      if (audioMode === 'always-on') {
        await assert.rejects(f.engine.requestTask(request), /音频|声音|静音/);
        assert.equal(f.videoPosts().length, 0);
        assert.equal(f.engine.consent.list().length, 0);
      } else {
        const task = await f.engine.requestTask(request);
        await f.store.updateSettings({ enabled: true }); f.engine.start();
        await until(async () => Boolean((await f.job(task.id))?.upstreamId));
        assert.equal(f.videoPosts().length, 1);
        assert.equal(f.videoPosts()[0].body?.enable_audio, false);
        assert.equal(f.engine.consent.get(task.id)?.spec.media?.enableAudio, false);
      }
      assert.equal(f.modelCalls(), 0);
    } finally { await f.close(); }
  }
});

test('permanent artifact size and format failures retain the original task without endless downloads or regeneration', async () => {
  for (const videoContent of ['wrong-mime', 'wrong-magic', 'oversized'] as const) {
    const f = await fixture({ videoContent }); const originalNow = Date.now; let shift = 0;
    const downloads = () => f.calls.filter(call => call.path.endsWith('/content')).length;
    try {
      const item = await f.engine.createCase({ title: 'Invalid artifact', objective: 'Keep paid receipt without repeatedly downloading a rejected artifact', domain: 'media' });
      const task = await f.engine.requestTask({ requestId: `invalid-${videoContent}`, spec: specification(item.id, videoSpec()) });
      f.completeVideo(); await f.store.updateSettings({ enabled: true }); f.engine.start();
      await until(async () => Boolean((await f.job(task.id))?.upstreamId));
      Date.now = () => originalNow() + shift; shift = 6000;
      await until(async () => (await f.job(task.id))?.state === 'failed');
      const failed = (await f.job(task.id))!;
      assert.equal(failed.upstreamId, 'fixture-upstream-video');
      assert.equal(f.engine.consent.get(task.id)?.state, 'failed');
      assert.match(failed.error ?? '', /MP4|格式|上限/);
      assert.equal(downloads(), 1); assert.equal(f.videoPosts().length, 1);
      shift = 24 * 60 * 60 * 1000;
      await f.restart(); f.engine.start(); await delay(1100);
      assert.equal((await f.job(task.id))?.state, 'failed');
      assert.equal(downloads(), 1, 'terminal local validation failures must not resume download polling');
      assert.equal(f.videoPosts().length, 1);
    } finally { Date.now = originalNow; await f.close(); }
  }
});

test('a transient video download failure retries only the existing artifact and can complete', async () => {
  const f = await fixture({ videoContent: 'network-once' }); const originalNow = Date.now; let shift = 0;
  const downloads = () => f.calls.filter(call => call.path.endsWith('/content')).length;
  try {
    const item = await f.engine.createCase({ title: 'Transient artifact', objective: 'Retry transport without new generation', domain: 'media' });
    const task = await f.engine.requestTask({ requestId: 'transient-download', spec: specification(item.id, videoSpec()) });
    f.completeVideo(); await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(async () => Boolean((await f.job(task.id))?.upstreamId));
    Date.now = () => originalNow() + shift; shift = 6000;
    await until(async () => Boolean((await f.job(task.id))?.error));
    assert.notEqual((await f.job(task.id))?.state, 'failed'); assert.equal(downloads(), 1);
    shift += 31000;
    await until(async () => (await f.job(task.id))?.state === 'completed');
    assert.equal(downloads(), 2); assert.equal(f.videoPosts().length, 1);
    const content = await f.call(mediaContentPath((await f.job(task.id))!.id));
    assert.equal(content.status, 200); assert.deepEqual(content.body, mp4);
  } finally { Date.now = originalNow; await f.close(); }
});

test('video submissions wait for local delivery while an unrelated owner conversation remains responsive', async () => {
  const f = await fixture({ gateVideoPoll: true, respond: () => modelAnswer('普通聊天仍能正常回复。') });
  const originalNow = Date.now; let shift = 0;
  try {
    const firstCase = await f.engine.createCase({ title: 'First video', objective: 'Deliver the original file before another submission', domain: 'media' });
    const secondCase = await f.engine.createCase({ title: 'Second video', objective: 'Wait without blocking normal conversation', domain: 'media' });
    const first = await f.engine.requestTask({ requestId: 'serial-video-first', spec: specification(firstCase.id, videoSpec()) });
    const second = await f.engine.requestTask({ requestId: 'serial-video-second', spec: specification(secondCase.id, videoSpec()) });
    const chat = await f.engine.ingestOwnerMessage('生成视频期间能正常聊天吗？');
    await f.store.updateSettings({ enabled: true }); f.engine.start();
    await until(async () => Boolean((await f.job(first.id))?.upstreamId) && f.engine.inbox.get(chat.id)?.status === 'processed');
    assert.equal(f.videoPosts().length, 1); assert.equal(await f.job(second.id), undefined);
    assert.ok(f.store.list('messages').some(message => message.role === 'assistant' && message.content.includes('普通聊天')));
    Date.now = () => originalNow() + shift; shift = 6000;
    await until(() => f.calls.some(call => call.path === '/v1/videos/fixture-upstream-video' && call.method === 'GET'));
    assert.equal(f.videoPosts().length, 1, 'even a polled first video must keep the second submission queued');
    f.completeVideo(); f.releaseVideoPoll();
    await until(() => f.videoPosts().length === 2);
    const delivered = (await f.job(first.id))!;
    assert.equal(delivered.state, 'completed'); assert.equal(delivered.files.length, 1);
    const content = await f.call(mediaContentPath(delivered.id));
    assert.equal(content.status, 200); assert.deepEqual(content.body, mp4);
    assert.equal((await f.job(second.id))?.upstreamId, 'fixture-upstream-video-2');
  } finally { Date.now = originalNow; f.releaseVideoPoll(); await f.close(); }
});
