import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ProjectBridge } from '../desktop/project-bridge.js';
import { DeviceHttpError, deviceFetch, parseOperation } from '../desktop/transport.js';
import { localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { ProjectStreamWriteTimeoutError, writeProjectStreamFrame } from '../shared/project-stream-write.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const input: ProjectExecutionInput = { operationId: 'operation', taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
  spec: localProjectSpecSchema.parse({ deviceId: 'fixture' }), specHash: 'a'.repeat(64), title: 'fixture', objective: 'fixture',
  expectedOutput: 'fixture', ownerRequest: 'fixture', updates: [], model: { model: 'fixture', reasoningEffort: 'high', maxOutputTokens: null },
  stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };

test('a gateway EOF during the read-only guard recovers with the same scope and request deadline', async () => {
  const execute = { kind: 'project-execute', operationId: input.operationId, input };
  assert.deepEqual(parseOperation(JSON.stringify(execute)), execute);
  let calls = 0; const bodies: string[] = []; const signals: AbortSignal[] = []; const waits: number[] = [];
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
    signal: new AbortController().signal, async assertLocal() {}, wait: async ms => { waits.push(ms); },
    request: async (_base, route, _credential, options) => {
      assert.equal(route, '/api/device/projectguard'); calls++; bodies.push(String(options?.body)); signals.push(options!.signal!);
      if (calls <= 2) throw new DeviceHttpError(502);
      return Response.json({ input, sequence: 0 });
    } });
  try {
    assert.equal((await bridge.guard()).input.specHash, input.specHash);
    assert.equal(calls, 3); assert.deepEqual(waits, [200, 600]);
    assert.equal(new Set(bodies).size, 1); assert.equal(new Set(signals).size, 1);
  } finally { await bridge.close(); }
});

test('permission changes stop the guard immediately, and cancellation stops pending backoff', async () => {
  for (const status of [401, 403, 409]) {
    let calls = 0;
    const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
      signal: new AbortController().signal, async assertLocal() {},
      request: async () => { calls++; throw new DeviceHttpError(status, 'Current permission changed'); },
      wait: async () => { throw new Error('Must not retry a permission denial'); } });
    try { await assert.rejects(bridge.guard(), /Current permission changed/); assert.equal(calls, 1); }
    finally { await bridge.close(); }
  }
  const controller = new AbortController(); let calls = 0;
  const cancelled = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
    signal: controller.signal, async assertLocal() {}, request: async () => { calls++; throw new DeviceHttpError(502); },
    wait: async () => { controller.abort(new DOMException('Owner stopped', 'AbortError')); } });
  try { await assert.rejects(cancelled.guard(), /Owner stopped/); assert.equal(calls, 1); }
  finally { await cancelled.close(); }
});

test('uncertain model submissions and source tools are sent once even when the proxy returns 502', async () => {
  const routes: string[] = [];
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
    signal: new AbortController().signal, async assertLocal() {},
    request: async (_base, route) => { routes.push(route); throw new DeviceHttpError(502); } });
  const address = await bridge.start();
  try {
    const response = await fetch(address + '/v1/responses', { method: 'POST', headers: {
      Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ model: 'fixture', input: [] }) });
    assert.equal(response.status, 409); await response.text();
    await assert.rejects(bridge.context({ action: 'call', name: 'web_search', arguments: {} }));
    assert.deepEqual(routes, ['/api/device/projectmodel', '/api/device/projectcontext']);
  } finally { await bridge.close(); }
});

test('desktop and worker project bridges accept a valid HTTP envelope beyond the former 32 MiB cap', async () => {
  const signal = new AbortController().signal;
  const modelRequest = { model: 'fixture', input: [] };
  let calls = 0;
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'paired-device-fixture', input: () => input,
    signal, async assertLocal() {},
    request: async (base, route, credential, options) => {
      calls++;
      assert.equal(base, 'https://fixture.invalid'); assert.equal(route, '/api/device/projectmodel');
      assert.equal(credential, 'paired-device-fixture'); assert.equal(options?.signal?.aborted, signal.aborted);
      const forwarded = JSON.parse(String(options?.body));
      assert.deepEqual(forwarded.request, modelRequest);
      assert.deepEqual(forwarded.authorization, { operationId: input.operationId, specHash: input.specHash, requirementsRevision: input.requirementsRevision });
      assert.equal(typeof forwarded.requestId, 'string');
      return new Response('data: {"type":"response.completed","response":{"id":"fixture"}}\n\n');
    } });
  try {
    const address = await bridge.start();
    const response = await fetch(address + '/v1/responses', { method: 'POST', headers: {
      Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json',
    }, body: JSON.stringify(modelRequest) + ' '.repeat(32 * 1024 * 1024 + 1) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"type":"response.completed"/);
    assert.equal(calls, 1, 'the accepted request reaches only the injected relay once');
  } finally { await bridge.close(); }
});

test('desktop relay turns an unfinished frame and transport error into a complete native failure event', async () => {
  let requests = 0;
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
    signal: new AbortController().signal, async assertLocal() {},
    request: async () => {
      requests++;
      const encoder = new TextEncoder();
      let first = true;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!first) { controller.error(new Error('PRIVATE_TRANSPORT_ERROR')); return; }
        first = false;
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"已收到"}\n\ndata: {"type":'));
      } }));
    } });
  try {
    const address = await bridge.start();
    const response = await fetch(address + '/v1/responses', { method: 'POST', headers: {
      Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ model: 'fixture', input: [] }) });
    assert.equal(response.status, 200);
    const frames = (await response.text()).trim().split('\n\n');
    assert.equal(frames.length, 2);
    assert.match(frames[0], /已收到/);
    assert.match(frames[1], /^event: response.failed\ndata: /);
    const failure = JSON.parse(frames[1].split('\n')[1].slice(6));
    assert.equal(failure.response.error.code, 'transport_interrupted');
    assert.doesNotMatch(frames[1], /PRIVATE_TRANSPORT_ERROR/);
    assert.equal(requests, 1);
  } finally { await bridge.close(); }
});

test('device errors keep controlled application detail and never render proxy HTML or unrelated response fields', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '任务要求已更新，请同步当前要求后继续。', debug: 'PRIVATE_FIELD' }, { status: 409 }));
  await assert.rejects(deviceFetch('https://fixture.invalid', '/api/device/projectguard', 'secret'), error => {
    assert.ok(error instanceof DeviceHttpError); assert.equal(error.status, 409);
    assert.match(error.message, /任务要求已更新/); assert.doesNotMatch(error.message, /PRIVATE_FIELD|secret/); return true;
  });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>PRIVATE_PROXY_BODY</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(deviceFetch('https://fixture.invalid', '/api/device/projectguard', 'secret'), /任务许可核对服务暂未连通（HTTP 502）/);
});

test('model stream backpressure waits for drain, close or cancellation and detaches every listener', async () => {
  for (const finish of ['drain', 'close', 'abort', 'timeout'] as const) {
    const controller = new AbortController();
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writes: 0,
      write() { this.writes++; return false; } });
    let settled = false;
    const keepAlive = setTimeout(() => {}, 1000);
    const pending = writeProjectStreamFrame(response as unknown as ServerResponse, 'data: {}\n\n', controller.signal, 20)
      .finally(() => { settled = true; });
    try {
      await Promise.resolve(); assert.equal(settled, false); assert.equal(response.writes, 1);
      if (finish === 'abort') controller.abort(new DOMException('Owner cancelled', 'AbortError'));
      else if (finish !== 'timeout') {
        if (finish === 'close') response.destroyed = true;
        response.emit(finish);
      }
      if (finish === 'abort') await assert.rejects(pending, /Owner cancelled/);
      else if (finish === 'timeout') await assert.rejects(pending, ProjectStreamWriteTimeoutError);
      else assert.equal(await pending, finish === 'drain');
      assert.equal(response.listenerCount('drain') + response.listenerCount('close') + response.listenerCount('error'), 0);
    } finally { clearTimeout(keepAlive); }
  }
});

test('fencing a bridge aborts its accepted model read and waits for actual reader cancellation', async () => {
  const cancelled = gate();
  const finishCancel = gate();
  let requests = 0;
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
    signal: new AbortController().signal, async assertLocal() {},
    request: async (_base, _route, _credential, init) => {
      requests++; assert.equal(init?.signal?.aborted, false);
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"saved"}\n\n')); },
        async cancel() { cancelled.resolve(); await finishCancel.promise; },
      }));
    } });
  const address = await bridge.start();
  try {
    const response = await fetch(address + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
      body: JSON.stringify({ model: 'fixture', input: [] }) });
    const body = response.text();
    bridge.fence();
    let drained = false;
    const closing = bridge.close().then(() => { drained = true; });
    await cancelled.promise; await Promise.resolve();
    assert.equal(drained, false, 'Cancellation acknowledgment must wait for the accepted reader');
    finishCancel.resolve(); await closing;
    assert.match(await body, /saved/); assert.match(await body, /task_stopped/);
    assert.equal(requests, 1);
  } finally { finishCancel.resolve(); await bridge.close(); }
});

test('a model request and transport progress keep the version captured before its upload completes', async () => {
  let current = input;
  const captured = gate();
  const finishUpload = gate();
  const revisions: number[] = [];
  let forwarded: unknown;
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture',
    input() { captured.resolve(); return current; }, signal: new AbortController().signal, async assertLocal() {},
    async modelTransport(event) { revisions.push(event.requirementsRevision); },
    request: async (_base, _route, _credential, init) => {
      forwarded = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.completed","response":{"id":"fixture"}}\n\n');
    } });
  const address = await bridge.start();
  try {
    const pending = fetch(address + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
      body: new ReadableStream<Uint8Array>({ async start(stream) {
        stream.enqueue(new TextEncoder().encode('{"model":"fixture",'));
        await finishUpload.promise; stream.enqueue(new TextEncoder().encode('"input":[]}')); stream.close();
      } }), duplex: 'half' } as RequestInit);
    await captured.promise;
    current = { ...input, requirementsRevision: 2 };
    finishUpload.resolve();
    const response = await pending; assert.equal(response.status, 200); await response.text();
    assert.equal((forwarded as { authorization: { requirementsRevision: number } }).authorization.requirementsRevision, 1);
    assert.deepEqual(revisions, [1, 1]);
  } finally { finishUpload.resolve(); await bridge.close(); }
});

test('closing one native consumer leaves the other accepted model request responsive', async () => {
  const sources: ReadableStreamDefaultController<Uint8Array>[] = [];
  const stopped = [gate(), gate()];
  const cancelled = [false, false];
  const ids: string[] = [];
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture', input: () => input,
    signal: new AbortController().signal, async assertLocal() {},
    request: async (_base, _route, _credential, init) => {
      const index = ids.length;
      ids.push(JSON.parse(String(init?.body)).requestId);
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { sources[index] = stream; stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"started"}\n\n')); },
        cancel() { cancelled[index] = true; stopped[index].resolve(); },
      }));
    } });
  const address = await bridge.start();
  const firstController = new AbortController();
  try {
    const first = await fetch(address + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
      body: JSON.stringify({ model: 'fixture', input: [] }), signal: firstController.signal });
    const firstBody = first.text(); void firstBody.catch(() => {});
    const second = await fetch(address + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
      body: JSON.stringify({ model: 'fixture', input: [] }) });
    const secondBody = second.text();
    firstController.abort(); await stopped[0].promise;
    await assert.rejects(firstBody);
    assert.equal(cancelled[1], false); assert.equal(new Set(ids).size, 2);
    sources[1].enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"second"}}\n\n'));
    sources[1].close();
    assert.match(await secondBody, /response.completed/);
  } finally { firstController.abort(); await bridge.close(); }
});

test('fencing during a partial model upload closes it before it can dispatch', async () => {
  const captured = gate(), finishUpload = gate();
  let dispatched = false;
  const bridge = new ProjectBridge({ baseUrl: 'https://fixture.invalid', credential: 'fixture',
    input() { captured.resolve(); return input; }, signal: new AbortController().signal, async assertLocal() {},
    request: async () => { dispatched = true; throw new Error('A fenced request must not reach the service'); } });
  const address = await bridge.start();
  const request = fetch(address + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token },
    body: new ReadableStream<Uint8Array>({ async start(stream) {
      stream.enqueue(new TextEncoder().encode('{"model":"fixture",'));
      await finishUpload.promise; stream.close();
    } }), duplex: 'half' } as RequestInit);
  void request.catch(() => {});
  try {
    await captured.promise;
    await bridge.close();
    await assert.rejects(request);
    assert.equal(dispatched, false);
  } finally { finishUpload.resolve(); await bridge.close(); }
});
