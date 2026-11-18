import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { WeChatDatabaseError, type WeChatChat, type WeChatDatabaseReader } from '../desktop/wechat-database.js';
import type { WeChatProgress, WeChatProgressStorage } from '../desktop/wechat-progress.js';

const timerKey = 'another-rae.tests.wechat-observer.delay';
const timerSymbol = Symbol.for(timerKey);
type Delay = (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
const fixtureGlobals = globalThis as typeof globalThis & Record<symbol, Delay | undefined>;
// The Node timer mock does not replace the observer's ESM timers/promises binding.
// Substitute only that import, leaving all of the observer and transport code intact.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:timers/promises' && context.parentURL?.endsWith('/desktop/wechat-observer.ts')) {
    return { url: `data:text/javascript,export const setTimeout=(...args)=>globalThis[Symbol.for(${JSON.stringify(timerKey)})](...args)`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { WeChatObserver } = await import('../desktop/wechat-observer.js').finally(() => hook.deregister());

class Clock {
  now = 0;
  private pending = new Set<{ at: number; fire(): void }>();

  delay: Delay = (ms, value, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const task = { at: this.now + ms, fire: () => {
      this.pending.delete(task);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    } };
    const abort = () => { this.pending.delete(task); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    this.pending.add(task);
  });

  async advanceTo(at: number): Promise<void> {
    assert.ok(at >= this.now);
    for (;;) {
      const next = [...this.pending].filter(task => task.at <= at).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      next.fire();
      await flush();
    }
    this.now = at;
    await flush();
  }
}

type Row = { id: string; text: string };
type ReadResult = { cursor: string; rows: Row[] };
type Binding = { deviceId: string; windowId: string; caseId: string };
type Lease = Binding & { id: string; createdAt: number; expiresAt: number; revoked?: boolean; stopped?: boolean };
type Reading = (chat: WeChatChat, cursor: string, signal: AbortSignal) => ReadResult | Promise<ReadResult>;
type Receipt = { leaseId: string; rows: Row[]; at: number; status: number; duplicates?: number };

const origin = 'https://rae.fixture.invalid';
const leaseMs = 90_000;
const baseline = 'fixture-baseline';
const nextCursor = 'fixture-next';
const selectedRow = { id: 'fixture-row-id', text: 'synthetic selected message' };
const topic = { id: 'fixture-case', title: 'Fixture' };

function fixture(t: TestContext, read: Reading, storage?: WeChatProgressStorage) {
  const clock = new Clock();
  fixtureGlobals[timerSymbol] = clock.delay;
  t.mock.method(Date, 'now', () => clock.now);
  const leases = new Map<string, Lease>();
  const registrations: Binding[] = [];
  const renewals: Array<{ leaseId: string; status: number; binding: Binding }> = [];
  const receipts: Receipt[] = [];
  const baselineCalls: string[] = [];
  const readCalls: Array<{ chatId: string; cursor: string }> = [];
  const observers: Array<InstanceType<typeof WeChatObserver>> = [];
  const failed = { when: (_rows: Row[]) => false, commitFirstFailedBatch: false };
  const owner = { signedIn: true };
  const committed = new Map<string, Set<string>>();
  let queue: Promise<unknown> = Promise.resolve();

  const reader = {
    async verify(chat: WeChatChat) { return { chatTitle: chat.title }; },
    async baseline(chat: WeChatChat) { baselineCalls.push(chat.chatId); return baseline; },
    read(chat: WeChatChat, cursor: string, signal: AbortSignal) {
      const operation = queue.then(() => {
        signal.throwIfAborted();
        readCalls.push({ chatId: chat.chatId, cursor });
        return read(chat, cursor, signal);
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
  } as unknown as WeChatDatabaseReader;

  const grantResponse = (lease: Lease, status: number) => Response.json({
    id: lease.id, deviceId: lease.deviceId, windowId: lease.windowId, caseId: lease.caseId,
    createdAt: new Date(lease.createdAt).toISOString(), expiresAt: new Date(lease.expiresAt).toISOString(),
  }, { status });
  const ownerFetch = async (url: string, init: RequestInit) => {
    const binding = JSON.parse(String(init.body)) as Binding;
    if (init.method === 'POST') {
      assert.equal(url, `${origin}/api/wechat-observations`);
      registrations.push(binding);
      if (!owner.signedIn) return Response.json({ error: 'Fixture owner signed out' }, { status: 401 });
      const id = `00000000-0000-4000-8000-${String(registrations.length).padStart(12, '0')}`;
      const lease = { ...binding, id, createdAt: clock.now, expiresAt: clock.now + leaseMs };
      leases.set(id, lease);
      return grantResponse(lease, 201);
    }
    assert.equal(init.method, 'PATCH');
    const match = new URL(url).pathname.match(/^\/api\/wechat-observations\/([^/]+)$/);
    assert.ok(match);
    const lease = leases.get(match[1]);
    assert.ok(lease);
    assert.deepEqual(binding, { deviceId: lease.deviceId, windowId: lease.windowId, caseId: lease.caseId });
    const status = !owner.signedIn ? 401 : lease.revoked || lease.stopped ? 409 : 200;
    renewals.push({ leaseId: lease.id, status, binding });
    if (status !== 200) return Response.json({ error: 'Fixture lease unavailable' }, { status });
    if (clock.now >= lease.expiresAt) lease.expiresAt = clock.now + leaseMs;
    return grantResponse(lease, 200);
  };

  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(url, `${origin}/api/device/wechatobservations`);
    const { grantId, windowId, rows } = JSON.parse(String(init?.body)) as { grantId: string; windowId: string; rows: Row[] };
    const lease = leases.get(grantId);
    assert.ok(lease);
    assert.equal(lease.windowId, windowId);
    if (init?.method === 'DELETE') {
      lease.stopped = true;
      return Response.json({ id: grantId, stopped: true });
    }
    assert.equal(init?.method, 'POST');
    const unavailable = failed.when(rows);
    const authorized = !lease.revoked && !lease.stopped && clock.now < lease.expiresAt;
    const status = unavailable ? 502 : authorized ? 200 : 409;
    const lostReceipt = unavailable && authorized && rows.length > 0 && failed.commitFirstFailedBatch;
    if (lostReceipt) failed.commitFirstFailedBatch = false;
    if (status !== 200 && !lostReceipt) {
      receipts.push({ leaseId: grantId, rows, at: clock.now, status });
      return Response.json({ error: 'Fixture request failed' }, { status });
    }
    lease.expiresAt = clock.now + leaseMs;
    const scope = `${lease.deviceId}:${lease.windowId}:${lease.caseId}`;
    const rowIds = committed.get(scope) ?? new Set<string>();
    const duplicates = rows.filter(row => rowIds.has(row.id)).length;
    for (const row of rows) rowIds.add(row.id);
    committed.set(scope, rowIds);
    receipts.push({ leaseId: grantId, rows, at: clock.now, status, duplicates });
    return lostReceipt ? Response.json({ error: 'Fixture receipt lost after commit' }, { status })
      : Response.json({ accepted: rows.length - duplicates, duplicates });
  });

  async function start(chatId: string) {
    const observer = new WeChatObserver(reader, () => {}, storage);
    observers.push(observer);
    await observer.start({ chat: { accountId: 'fixture-account', chatId, title: chatId },
      windowId: `window-${chatId}`, topic, deviceId: 'fixture-device', baseUrl: origin, token: 'fixture-bearer',
      ownerFetch, signal: new AbortController().signal });
    return observer;
  }
  t.after(async () => {
    try { await Promise.all(observers.map(observer => observer.stop())); }
    finally { delete fixtureGlobals[timerSymbol]; }
  });
  return { clock, leases, registrations, renewals, receipts, baselineCalls, readCalls, failed, owner, reader, start };
}

function initialRead(_chat: WeChatChat, cursor: string): ReadResult {
  return cursor === baseline ? { cursor: nextCursor, rows: [selectedRow] } : { cursor, rows: [] };
}

test('WeChat restores an authorized chat outside the chooser without replacing its cursor or pending batch', async t => {
  let progress: WeChatProgress = { cursor: baseline, coverageStartAt: '2026-11-01T00:00:00.000Z', receivedRows: 3, recent: [],
    pending: { cursor: nextCursor, rows: [selectedRow] } };
  const storage: WeChatProgressStorage = { load: async () => structuredClone(progress),
    save: async (_id, _binding, value) => { progress = structuredClone(value); }, remove: async () => {} };
  const f = fixture(t, (_chat, cursor) => ({ cursor, rows: [] }), storage);
  f.reader.list = async () => Array.from({ length: 500 }, (_, index) => ({ accountId: 'fixture-account', chatId: `other-${index}`, title: 'Other' }));
  const observer = await f.start('saved-chat');
  assert.equal(observer.state().phase, 'watching');
  assert.equal(observer.state().pendingRows, 1);
  assert.equal(progress.cursor, baseline);
  assert.deepEqual(progress.pending?.rows, [selectedRow]);
  assert.deepEqual(f.baselineCalls, []);
  await f.clock.advanceTo(12_000);
  assert.deepEqual(f.receipts.find(receipt => receipt.rows.length)?.rows, [selectedRow]);
  assert.equal(progress.cursor, nextCursor);
  assert.equal(progress.receivedRows, 4);
  assert.equal(progress.pending, undefined);
  assert.deepEqual(f.readCalls, [{ chatId: 'saved-chat', cursor: nextCursor }]);
});

test('WeChat refuses a changed account before uploading a saved batch and preserves the checkpoint', async t => {
  const progress: WeChatProgress = { cursor: baseline, coverageStartAt: '2026-11-01T00:00:00.000Z', receivedRows: 0, recent: [],
    pending: { cursor: nextCursor, rows: [selectedRow] } };
  let saved = 0;
  const f = fixture(t, initialRead, { load: async () => structuredClone(progress), save: async () => { saved++; }, remove: async () => {} });
  // An account check must run even when a candidate list is unavailable.
  Object.assign(f.reader, { verify: async () => { throw new WeChatDatabaseError('account-changed'); } });
  await assert.rejects(f.start('saved-chat'), /微信账号已变化/);
  assert.equal(saved, 0);
  assert.deepEqual(f.registrations, []);
  assert.deepEqual(f.receipts, []);
  assert.deepEqual(f.baselineCalls, []);
  assert.deepEqual(f.readCalls, []);
  assert.equal(progress.pending?.cursor, nextCursor);
});

test('WeChat restores the persisted batch after receipt commit persistence fails without resetting the baseline', async t => {
  const saved = new Map<string, { binding: string; progress: WeChatProgress }>();
  let failCommit = true;
  const storage: WeChatProgressStorage = {
    async load(id, binding) {
      const entry = saved.get(id);
      assert.ok(!entry || entry.binding === binding);
      return entry ? structuredClone(entry.progress) : undefined;
    },
    async save(id, binding, progress) {
      if (progress.receivedRows && failCommit) { failCommit = false; throw new Error('fixture disk failure after server receipt'); }
      saved.set(id, { binding, progress: structuredClone(progress) });
    },
    async remove(id) { saved.delete(id); },
  };
  const f = fixture(t, initialRead, storage);
  const first = await f.start('durable-chat');
  await f.clock.advanceTo(24_000);
  assert.equal(first.state().phase, 'paused');
  assert.equal(saved.get('window-durable-chat')?.progress.pending?.rows[0].id, selectedRow.id);
  assert.equal(saved.get('window-durable-chat')?.progress.cursor, baseline);
  await first.stop();
  const restored = await f.start('durable-chat');
  await f.clock.advanceTo(48_000);
  assert.equal(f.baselineCalls.length, 1);
  assert.equal(f.registrations.length, 2);
  assert.ok(f.receipts.some(receipt => receipt.duplicates === 1));
  const progress = saved.get('window-durable-chat')?.progress;
  assert.equal(progress?.cursor, nextCursor);
  assert.equal(progress?.receivedRows, 1);
  assert.equal(progress?.pending, undefined);
  assert.equal(restored.state().phase, 'watching');
});

test('WeChat leases keep renewing while multiple chats wait on the shared database reader', async t => {
  const f: ReturnType<typeof fixture> = fixture(t, (_chat, cursor, signal) => f.clock.delay(110_000, { cursor, rows: [] }, { signal }) as Promise<ReadResult>);
  const observers = await Promise.all([f.start('first'), f.start('second')]);
  await f.clock.advanceTo(108_000);
  assert.deepEqual(f.readCalls, [{ chatId: 'first', cursor: baseline }]);
  assert.deepEqual(f.baselineCalls, ['first', 'second']);
  for (const lease of f.leases.values()) {
    const successful = f.receipts.filter(receipt => receipt.leaseId === lease.id && receipt.status === 200);
    assert.ok(successful.length >= 5, 'heartbeat must not wait on a read or its place in the queue');
    assert.ok(lease.expiresAt > f.clock.now);
  }
  assert.deepEqual(observers.map(observer => observer.state().phase), ['watching', 'watching']);
  assert.deepEqual(f.renewals, []);
});

test('WeChat retries a failed batch on the live grant and advances only after its receipt', async t => {
  const f = fixture(t, initialRead);
  const observer = await f.start('fixture-chat');
  f.failed.when = rows => rows.length > 0;
  f.failed.commitFirstFailedBatch = true;
  await f.clock.advanceTo(65_000);
  const failed = f.receipts.filter(receipt => receipt.status === 502);
  assert.ok(failed.length > 3, 'a short server outage should outlast the old retry limit');
  assert.ok(failed.every(receipt => receipt.rows[0]?.id === selectedRow.id));
  assert.deepEqual(f.readCalls, [{ chatId: 'fixture-chat', cursor: baseline }]);

  f.failed.when = () => false;
  await f.clock.advanceTo(110_000);
  const accepted = f.receipts.find(receipt => receipt.status === 200 && receipt.rows.length);
  assert.deepEqual(accepted?.rows, [selectedRow]);
  assert.equal(accepted?.leaseId, failed[0].leaseId);
  assert.equal(accepted?.duplicates, 1);
  assert.ok(f.readCalls.some(read => read.cursor === nextCursor));
  assert.equal(f.registrations.length, 1);
  assert.deepEqual(f.renewals, []);
  assert.equal(observer.state().phase, 'watching');
});

test('WeChat renews a server-confirmed expired lease in place without losing pending rows or cursor', async t => {
  const f = fixture(t, initialRead);
  const observer = await f.start('fixture-chat');
  f.failed.when = rows => rows.length > 0 || f.receipts.length > 0;
  await f.clock.advanceTo(12_000);
  const lease = [...f.leases.values()][0];
  await f.clock.advanceTo(165_000);
  assert.ok(lease.expiresAt < f.clock.now);
  assert.deepEqual(f.renewals, []);

  f.failed.when = () => false;
  await f.clock.advanceTo(235_000);
  assert.ok(f.receipts.some(receipt => receipt.leaseId === lease.id && receipt.status === 409));
  assert.deepEqual(f.renewals.map(({ leaseId, status }) => ({ leaseId, status })), [{ leaseId: lease.id, status: 200 }]);
  assert.equal(f.registrations.length, 1);
  assert.deepEqual(f.baselineCalls, ['fixture-chat']);
  assert.ok(f.receipts.some(receipt => receipt.leaseId === lease.id && receipt.status === 200 && receipt.rows[0]?.id === selectedRow.id));
  assert.ok(f.readCalls.some(read => read.cursor === nextCursor));
  assert.equal(observer.state().phase, 'watching');
});

test('WeChat stops retrying when the owner route rejects renewal of a revoked grant', async t => {
  const f = fixture(t, (_chat, cursor) => ({ cursor, rows: [] }));
  const observer = await f.start('fixture-chat');
  await f.clock.advanceTo(12_000);
  const lease = [...f.leases.values()][0];
  lease.revoked = true;
  await f.clock.advanceTo(150_000);
  assert.deepEqual(f.renewals.map(({ leaseId, status }) => ({ leaseId, status })), [{ leaseId: lease.id, status: 409 }]);
  assert.equal(f.registrations.length, 1);
  assert.equal(observer.state().phase, 'paused');
  const requestCount = f.receipts.length;
  await f.clock.advanceTo(240_000);
  assert.equal(f.receipts.length, requestCount);
});

test('WeChat waits for the owner session without reading ahead after a renewal 401', async t => {
  const f = fixture(t, initialRead);
  const observer = await f.start('fixture-chat');
  f.failed.when = rows => rows.length > 0 || f.receipts.length > 0;
  await f.clock.advanceTo(160_000);
  const lease = [...f.leases.values()][0];
  f.owner.signedIn = false;
  f.failed.when = () => false;
  await f.clock.advanceTo(225_000);
  assert.ok(f.renewals.length > 0 && f.renewals.every(renewal => renewal.status === 401));
  assert.deepEqual(f.readCalls, [{ chatId: 'fixture-chat', cursor: baseline }]);
  assert.equal(observer.state().phase, 'reconnecting');
  assert.match(observer.state().message, /请登录榫/);

  f.owner.signedIn = true;
  await f.clock.advanceTo(280_000);
  assert.ok(f.renewals.some(renewal => renewal.leaseId === lease.id && renewal.status === 200));
  assert.ok(f.receipts.some(receipt => receipt.leaseId === lease.id && receipt.status === 200 && receipt.rows[0]?.id === selectedRow.id));
  assert.ok(f.readCalls.some(read => read.cursor === nextCursor));
  assert.equal(f.registrations.length, 1);
  assert.equal(observer.state().phase, 'watching');
});

test('stopping WeChat drains its cancelled read before closing the lease', async t => {
  let readSignal: AbortSignal | undefined;
  let finishRead!: (result: ReadResult) => void;
  const pendingRead = new Promise<ReadResult>(resolve => { finishRead = resolve; });
  const f = fixture(t, (_chat, _cursor, signal) => { readSignal = signal; return pendingRead; });
  const observer = await f.start('fixture-chat');
  await f.clock.advanceTo(12_000);
  const lease = [...f.leases.values()][0];
  let stopped = false;
  const stopping = observer.stop().then(() => { stopped = true; });
  try {
    await flush();
    assert.equal(readSignal?.aborted, true);
    assert.equal(stopped, false);
    assert.equal(lease.stopped, undefined);
  } finally {
    finishRead({ cursor: nextCursor, rows: [selectedRow] });
    await stopping;
  }
  assert.equal(observer.state().phase, 'idle');
  assert.equal(lease.stopped, true);
  const requestCount = f.receipts.length;
  await f.clock.advanceTo(150_000);
  assert.equal(f.receipts.length, requestCount);
  assert.ok(f.receipts.every(receipt => receipt.rows.length === 0));
});
