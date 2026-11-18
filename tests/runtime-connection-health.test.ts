import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type ClientRequest } from 'node:http';
import { connectRuntime, markSessionBoundary, onSessionExpired, type RuntimeConnectionHealth, type RuntimeConnector } from '../client/api.js';
import { createRuntimeController } from '../client/state/useRuntime.js';
import { RuntimeStateStream } from '../server/runtime-stream.js';
import type { RuntimeApi } from '../server/runtime.js';
import type { RuntimeView, RuntimeViewScope } from '../shared/runtime-view.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Expected stream event')), 5000); })]); }
  finally { clearTimeout(timer); }
}

function view(scope: RuntimeViewScope = {}): RuntimeView {
  return { runtime: 'mastra', schemaVersion: 3,
    settings: { agentName: 'Rae', ownerName: '', mission: '', model: 'fixture', apiBaseUrl: 'https://example.invalid/v1', apiKeyConfigured: false,
      enabled: false, reasoningEffort: 'auto', maxOutputTokens: null, maxOutputContinuations: 1, maxStepsPerRun: 3, timezone: 'Asia/Shanghai' },
    status: { state: 'paused', pending: false, nextWakeAt: null, lastRunAt: null, lastError: null,
      todayUsage: { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' } },
    cases: [], messages: [], tasks: [], understanding: [], sources: [], workspaceSources: [], artifacts: [], feedback: [], runs: [], events: [], grants: [],
    history: { runs: { items: [], nextBefore: null }, events: { items: [], nextBefore: null } },
    conversation: { caseId: scope.caseId ?? null, before: scope.before ?? null, beforeCreatedAt: null, nextBefore: null }, casePreviews: {},
    archive: { readOnly: true, counts: { memories: 0, initiatives: 0, activities: 0 } } };
}

function fakeSources(context: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const sources: FakeSource[] = [];
  class FakeSource extends EventTarget {
    readyState = 1; closed = false; onerror?: () => void;
    constructor(readonly url: string) { super(); sources.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    emit(event: string, data: unknown, id = '') { this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data), lastEventId: id })); }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeSource });
  context.after(() => { if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource'); });
  return sources;
}

test('fresh states and heartbeats report liveness without revising snapshots; retired sockets cannot refresh it', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const sources = fakeSources(context); const health: RuntimeConnectionHealth[] = []; const snapshots: RuntimeView[] = [];
  context.mock.method(globalThis, 'fetch', async () => Response.json({ required: true, authenticated: true }));
  const close = connectRuntime(value => snapshots.push(value), () => {}, undefined, value => health.push(value));
  try {
    assert.deepEqual(health, [{ state: 'connecting' }]);
    sources[0].emit('state', view(), '1');
    assert.deepEqual(health.at(-1), { state: 'connected', lastHeartbeatAt: 1000 });
    context.mock.timers.tick(15_000);
    sources[0].emit('heartbeat', { serverTime: '2099-01-01T00:00:00.000Z' }, '1');
    assert.deepEqual(health.at(-1), { state: 'connected', lastHeartbeatAt: 16_000 });
    assert.equal(snapshots.length, 1, 'heartbeat is not a state or execution-progress update');
    sources[0].emit('state-delta', { base: '1', replace: { messages: [] } }, '2');
    assert.equal(snapshots.length, 2, 'heartbeat must preserve the negotiated delta base');
    sources[0].readyState = 2; sources[0].onerror?.(); await flush();
    assert.equal(health.at(-1)?.state, 'reconnecting');
    const before = health.length; sources[0].emit('heartbeat', { serverTime: new Date().toISOString() });
    assert.equal(health.length, before);
    context.mock.timers.tick(2000); assert.equal(sources.length, 2);
    sources[1].emit('state', view(), '1');
    assert.deepEqual(health.at(-1), { state: 'connected', lastHeartbeatAt: 18_000 });
    close(); const closedHealth = health.length;
    sources[1].emit('heartbeat', { serverTime: new Date().toISOString() }); context.mock.timers.tick(120_000);
    assert.equal(health.length, closedHealth); assert.equal(sources.length, 2);
  } finally { close(); }
});

test('a silent live socket reconnects after the heartbeat grace period without polling or issuing owner commands', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const sources = fakeSources(context); const health: RuntimeConnectionHealth[] = []; let failures = 0; let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No HTTP command expected'); });
  const close = connectRuntime(() => {}, () => { failures++; }, undefined, value => health.push(value));
  try {
    sources[0].emit('state', view(), '1');
    context.mock.timers.tick(44_999);
    sources[0].emit('heartbeat', { serverTime: 'not-a-server-time' });
    assert.equal(health.at(-1)?.state, 'connected');
    context.mock.timers.tick(1);
    assert.equal(health.at(-1)?.state, 'reconnecting'); assert.equal(sources[0].closed, true); assert.equal(failures, 1);
    assert.equal(requests, 0);
    context.mock.timers.tick(2000); assert.equal(sources.length, 2);
    sources[1].emit('heartbeat', { serverTime: new Date().toISOString() });
    assert.equal(health.at(-1)?.state, 'connected'); assert.equal(requests, 0);
    markSessionBoundary(); const count = health.length;
    sources[1].emit('heartbeat', { serverTime: new Date().toISOString() }); context.mock.timers.tick(120_000);
    assert.equal(health.length, count); assert.equal(sources.length, 2);
  } finally { close(); }
});

test('native reconnection cannot become healthy from a queued heartbeat until its socket is open again', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const sources = fakeSources(context); const health: RuntimeConnectionHealth[] = [];
  context.mock.method(globalThis, 'fetch', async () => Response.json({ required: true, authenticated: true }));
  const close = connectRuntime(() => {}, () => {}, undefined, value => health.push(value));
  try {
    sources[0].emit('state', view(), '1');
    sources[0].readyState = 0; sources[0].onerror?.(); await flush();
    const count = health.length;
    sources[0].emit('heartbeat', { serverTime: new Date().toISOString() });
    assert.equal(health.length, count); assert.equal(health.at(-1)?.state, 'reconnecting');
    context.mock.timers.tick(60_000); assert.equal(sources.length, 1);
    sources[0].readyState = 1; sources[0].dispatchEvent(new Event('open'));
    sources[0].emit('heartbeat', { serverTime: new Date().toISOString() });
    assert.deepEqual(health.at(-1), { state: 'connected', lastHeartbeatAt: 61_000 });
  } finally { close(); }
});

test('runtime controller resets health by scope and lifecycle while keeping heartbeat updates out of the runtime snapshot', async () => {
  let reads = 0;
  const streams: Array<{ scope?: RuntimeViewScope; closed: boolean; health(value: RuntimeConnectionHealth): void }> = [];
  const connect: RuntimeConnector = (_receive, _fail, scope, onHealth) => {
    const stream = { scope, closed: false, health(value: RuntimeConnectionHealth) { onHealth?.(value); } };
    streams.push(stream); return () => { stream.closed = true; };
  };
  const controller = createRuntimeController(async (_signal, scope) => { reads++; return view(scope); }, connect);
  const stop = controller.start();
  try {
    await flush(); assert.equal(controller.getSnapshot().connection.state, 'connecting', 'HTTP success is not proof of SSE health');
    streams[0].health({ state: 'connected', lastHeartbeatAt: 1000 });
    const runtime = controller.getSnapshot().runtime;
    streams[0].health({ state: 'connected', lastHeartbeatAt: 2000 });
    assert.equal(controller.getSnapshot().runtime, runtime); assert.equal(reads, 1);
    controller.setScope({ caseId: 'another-scene' });
    assert.deepEqual(controller.getSnapshot().connection, { state: 'connecting' }); assert.equal(streams[0].closed, true);
    streams[0].health({ state: 'connected', lastHeartbeatAt: 999_999 });
    assert.deepEqual(controller.getSnapshot().connection, { state: 'connecting' });
    streams[1].health({ state: 'connected', lastHeartbeatAt: 3000 }); await flush();
    assert.equal(controller.getSnapshot().connection.lastHeartbeatAt, 3000); assert.equal(reads, 2);
    stop(); streams[1].health({ state: 'connected', lastHeartbeatAt: 999_999 });
    assert.equal(controller.getSnapshot().runtime, null); assert.deepEqual(controller.getSnapshot().connection, { state: 'connecting' });
    const again = controller.start(); await flush();
    streams[1].health({ state: 'reconnecting', lastHeartbeatAt: 999_999 });
    assert.deepEqual(controller.getSnapshot().connection, { state: 'connecting' }); again();
    assert.equal(streams.every(stream => stream.closed), true);
  } finally { stop(); controller.stop(); }
});

test('a controller stopped synchronously by a connector callback disposes the returned stream immediately', () => {
  let closed = 0; let reads = 0;
  const controller = createRuntimeController(async () => { reads++; return view(); }, (_receive, _fail, _scope, onHealth) => {
    onHealth?.({ state: 'connecting' }); controller.stop(); return () => { closed++; };
  });
  controller.start();
  assert.equal(closed, 1); assert.equal(reads, 0); assert.equal(controller.getSnapshot().runtime, null);
});

test('actual HTTP heartbeat frames reach the client independently of snapshots and session revocation closes the channel', async context => {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let reads = 0; let allowed = true; let changed!: () => void; let currentView = view();
  const runtime = { snapshot: async () => { reads++; return currentView; }, subscribe(listener: () => void) { changed = listener; return () => {}; } } as unknown as RuntimeApi;
  const stream = new RuntimeStateStream(runtime, JSON.stringify);
  const server = createServer((_request, response) => stream.connect(response, () => allowed, {}, true));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  class HttpSource extends EventTarget {
    readyState = 0; closed = false; onerror?: () => void; outgoing: ClientRequest;
    constructor(url: string) {
      super();
      this.outgoing = request(new URL(url, `http://127.0.0.1:${port}`), response => {
        this.readyState = 1; this.dispatchEvent(new Event('open')); let buffer = ''; let lastId = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          while (buffer.includes('\n\n')) {
            const end = buffer.indexOf('\n\n'); const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1]; const data = frame.match(/^data: (.+)$/m)?.[1];
            lastId = frame.match(/^id: (.+)$/m)?.[1] ?? lastId;
            if (event && data) this.dispatchEvent(new MessageEvent(event, { data, lastEventId: lastId }));
          }
        });
      });
      this.outgoing.on('error', () => { if (!this.closed) this.onerror?.(); }); this.outgoing.end();
    }
    close() { this.closed = true; this.readyState = 2; this.outgoing.destroy(); }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: HttpSource });
  const initial = deferred<void>(); const heartbeat = deferred<void>(); const update = deferred<void>(); const expired = deferred<void>();
  const snapshots: RuntimeView[] = []; const health: RuntimeConnectionHealth[] = [];
  const unsubscribe = onSessionExpired(() => expired.resolve());
  const close = connectRuntime(value => { snapshots.push(value); if (snapshots.length === 1) initial.resolve(); else update.resolve(); }, () => {}, undefined,
    value => { health.push(value); if (value.lastHeartbeatAt === 16_000) heartbeat.resolve(); });
  try {
    await within(initial.promise); const initialSnapshot = snapshots[0];
    context.mock.timers.tick(15_000); await within(heartbeat.promise);
    assert.equal(reads, 1); assert.equal(snapshots.length, 1); assert.equal(snapshots[0], initialSnapshot);
    assert.deepEqual(health.at(-1), { state: 'connected', lastHeartbeatAt: 16_000 });
    currentView = { ...currentView, messages: [{ id: 'durable-message', role: 'assistant', content: 'saved', createdAt: '2026-11-10T00:00:00.000Z' }] };
    changed(); await within(update.promise);
    assert.equal(snapshots[1].messages[0].id, 'durable-message', 'heartbeat leaves the state-delta base intact across HTTP');
    assert.equal(reads, 2);
    allowed = false; context.mock.timers.tick(15_000); await within(expired.promise);
    assert.equal(reads, 2, 'session liveness checks cannot trigger runtime reads');
  } finally {
    close(); unsubscribe(); stream.close(); await new Promise<void>(done => server.close(() => done()));
    if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});
