import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionProbe } from '../client/lib/session-probe.js';
import { connectRuntime, markSessionBoundary, onSessionExpired } from '../client/api.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let count = 0; count < 12; count++) await Promise.resolve(); }

test('repeated stream errors share one session probe and only explicit anonymous sessions expire', async () => {
  const read = deferred<unknown>(); let reads = 0; let expired = 0;
  const probe = createSessionProbe(async () => { reads++; return read.promise; }, () => true, () => { expired++; });
  try {
    probe.check(); probe.check(); probe.check(); assert.equal(reads, 1);
    read.resolve({ required: true, authenticated: false }); await flush(); assert.equal(expired, 1);
  } finally { probe.close(); }
});

test('network failures, unprotected mode, malformed sessions and valid sessions do not sign the owner out', async () => {
  let expired = 0; let reads = 0;
  const values: unknown[] = [new Error('Network down'), { required: false, authenticated: false },
    { required: 'true', authenticated: false }, { required: true, authenticated: 'false' },
    { required: true, authenticated: true }, null];
  const probe = createSessionProbe(async () => {
    const value = values[reads++]; if (value instanceof Error) throw value; return value;
  }, () => true, () => { expired++; });
  try {
    for (const _value of values) { probe.check(); await flush(); }
    assert.equal(reads, values.length); assert.equal(expired, 0);
  } finally { probe.close(); }
});

test('a hung probe times out, releases deduplication and fences its late response from a replacement probe', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const reads: Array<ReturnType<typeof deferred<unknown>> & { signal: AbortSignal }> = [];
  let expired = 0;
  const probe = createSessionProbe(signal => { const read = { ...deferred<unknown>(), signal }; reads.push(read); return read.promise; }, () => true, () => { expired++; });
  try {
    probe.check(); context.mock.timers.tick(4999); assert.equal(reads[0].signal.aborted, false);
    context.mock.timers.tick(1); assert.equal(reads[0].signal.aborted, true);
    probe.check(); assert.equal(reads.length, 2);
    reads[0].resolve({ required: true, authenticated: false }); await flush(); assert.equal(expired, 0);
    probe.check(); assert.equal(reads.length, 2, 'late first completion must not release the second probe');
    reads[1].resolve({ required: true, authenticated: true }); await flush(); assert.equal(expired, 0);
  } finally { probe.close(); }
});

test('closing the stream aborts its probe and ignores a late anonymous response', async () => {
  const read = deferred<unknown>(); let signal!: AbortSignal; let expired = 0;
  const probe = createSessionProbe(abort => { signal = abort; return read.promise; }, () => true, () => { expired++; });
  probe.check(); probe.close(); assert.equal(signal.aborted, true);
  read.resolve({ required: true, authenticated: false }); await flush(); probe.check(); assert.equal(expired, 0);
});

test('a refused EventSource reconnect cannot expire a newer login after its probe returns late', async context => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let source!: FakeEventSource;
  class FakeEventSource extends EventTarget {
    closed = false; onerror?: () => void;
    constructor(_url: string) { super(); source = this; }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  const read = deferred<Response>(); let expired = 0; let reads = 0; let signal: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', async (_path: unknown, options?: RequestInit) => {
    reads++; signal = options?.signal ?? undefined; return read.promise;
  });
  const detach = onSessionExpired(() => { expired++; });
  const close = connectRuntime(() => {}, () => {});
  try {
    source.onerror?.(); source.onerror?.(); assert.equal(reads, 1);
    markSessionBoundary();
    read.resolve(new Response('{"required":true,"authenticated":false}', { status: 200 }));
    await flush(); assert.equal(expired, 0); assert.equal(source.closed, true);
    source.onerror?.(); assert.equal(reads, 1, 'a superseded stream must not launch new checks');
    close(); assert.equal(signal?.aborted, true, 'a new login cancels the superseded session probe');
  } finally {
    close(); detach();
    if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

test('terminal EventSource failures rebuild one stream while native reconnects keep their own connection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const sources: FakeEventSource[] = [];
  class FakeEventSource extends EventTarget {
    readyState = 0; closed = false; onerror?: () => void;
    constructor(_url: string) { super(); sources.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    state(value: unknown) { this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(value) })); }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  context.mock.method(globalThis, 'fetch', async () => new Response('{"required":true,"authenticated":true}'));
  const received: unknown[] = []; const close = connectRuntime(value => received.push(value), () => {});
  try {
    sources[0].readyState = 2; sources[0].onerror?.(); sources[0].onerror?.(); await flush();
    assert.equal(sources[0].closed, true); context.mock.timers.tick(1999); assert.equal(sources.length, 1);
    context.mock.timers.tick(1); assert.equal(sources.length, 2);
    sources[0].state({ obsolete: true }); sources[1].state({ revision: 'recovered' });
    assert.deepEqual(received, [{ revision: 'recovered' }]);
    sources[1].readyState = 0; sources[1].onerror?.(); await flush();
    context.mock.timers.tick(60_000); assert.equal(sources.length, 2, 'CONNECTING stays in the native retry loop');
  } finally {
    close(); if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

test('closing or replacing a login cancels terminal stream retries and rejects late source events', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const sources: FakeEventSource[] = [];
  class FakeEventSource extends EventTarget {
    readyState = 2; closed = false; onerror?: () => void;
    constructor(_url: string) { super(); sources.push(this); }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  context.mock.method(globalThis, 'fetch', async () => new Response('{"required":true,"authenticated":true}'));
  let received = 0;
  try {
    for (const boundary of ['close', 'login']) {
      const close = connectRuntime(() => { received++; }, () => {}); const source = sources.at(-1)!;
      source.onerror?.(); await flush();
      if (boundary === 'close') close(); else markSessionBoundary();
      source.dispatchEvent(new MessageEvent('state', { data: '{"late":true}' })); source.onerror?.();
      context.mock.timers.tick(60_000); await flush(); assert.equal(source.closed, true); close();
    }
    assert.equal(sources.length, 2); assert.equal(received, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});
