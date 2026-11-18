import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonalMemoryEntry, PersonalMemoryPage, PersonalMemorySubject } from '../shared/personal-memory.js';
import { createMemoryPager } from '../client/lib/memory-pages.js';

function entry(key: string, subject: PersonalMemorySubject = 'owner', revision = 1): PersonalMemoryEntry {
  return { key, subject, revision, value: `合成记录 ${key} v${revision}`, kind: 'fact', level: 'explicit', scope: 'global', domains: ['*'], caseIds: [],
    evidenceIds: [], evidence: [], status: 'active', origin: 'owner', effectiveStatus: 'active', supersedes: null, history: [],
    createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', validFrom: '2026-11-10T00:00:00Z', expiresAt: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function fixture(initial: PersonalMemoryEntry[] = []) {
  const requests: Array<{ subject: PersonalMemorySubject; offset: number; limit: number; signal: AbortSignal;
    response: ReturnType<typeof deferred<PersonalMemoryPage | PersonalMemoryEntry[]>> }> = [];
  const pager = createMemoryPager(initial, (subject, offset, limit, signal) => {
    const response = deferred<PersonalMemoryPage | PersonalMemoryEntry[]>(); requests.push({ subject, offset, limit, signal, response }); return response.promise;
  });
  return { pager, requests };
}

test('subject paging starts at its own zero offset and fences a late previous-subject response', async () => {
  const f = fixture([entry('live.owner'), entry('live.agent', 'agent')]);
  const stop = f.pager.start();
  try {
    assert.equal(f.requests[0].subject, 'owner'); assert.equal(f.requests[0].offset, 0); assert.equal(f.requests[0].limit, 50);
    f.pager.setSubject('agent');
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.requests[1].subject, 'agent'); assert.equal(f.requests[1].offset, 0);
    f.requests[1].response.resolve({ entries: [entry('method', 'agent')], total: 1, offset: 0, nextOffset: null });
    await flush();
    f.requests[0].response.resolve({ entries: [entry('PRIVATE_LATE_OWNER')], total: 1, offset: 0, nextOffset: null });
    await flush();
    assert.deepEqual(f.pager.getSnapshot().entries.map(value => value.key), ['method']);
    assert.equal(f.pager.getSnapshot().subject, 'agent'); assert.equal(f.pager.getSnapshot().loading, false);
  } finally { stop(); }
});

test('older fetched pages stay panel-local across live updates and stale page rows cannot overwrite newer visible revisions', async () => {
  const live = [entry('key-0')], f = fixture(live), before = JSON.stringify(live);
  const stop = f.pager.start();
  try {
    f.requests[0].response.resolve({ entries: Array.from({ length: 50 }, (_, index) => entry(`key-${index}`)), total: 100, offset: 0, nextOffset: 50 });
    await flush();
    const loading = f.pager.loadMore();
    assert.equal(f.requests[1].offset, 50); assert.equal(f.requests[1].limit, 50);
    assert.equal(await f.pager.loadMore(), false, 'repeated clicks do not issue the same page twice');
    f.pager.reconcile([entry('key-0', 'owner', 2), entry('UNRELATED_LIVE_ENTRY')]);
    f.requests[1].response.resolve({ entries: Array.from({ length: 50 }, (_, index) => entry(`key-${index + 50}`)), total: 100, offset: 50, nextOffset: null });
    await loading;
    assert.equal(f.pager.getSnapshot().entries.length, 100);
    assert.equal(f.pager.getSnapshot().entries[0].revision, 2);
    assert.equal(f.pager.getSnapshot().entries.at(-1)?.key, 'key-99');
    f.pager.reconcile([entry('key-0', 'owner', 3)]);
    assert.equal(f.pager.getSnapshot().entries.length, 100, 'a bounded SSE window does not reset older pages');
    assert.equal(f.pager.getSnapshot().entries[0].revision, 3);
    assert.equal(f.requests.length, 2, 'live progress does not poll or refetch memory pages');
    assert.equal(JSON.stringify(live), before, 'page loading never mutates or inflates the RuntimeView source');
    const refresh = f.pager.refresh();
    f.requests[2].response.resolve({ entries: [entry('key-0', 'owner', 1)], total: 1, offset: 0, nextOffset: null });
    await refresh;
    assert.equal(f.pager.getSnapshot().entries[0].revision, 3, 'even an older HTTP refresh cannot replace a known newer revision');
  } finally { stop(); }
});

test('closing aborts the outstanding page and ignored transports cannot update the closed panel', async () => {
  const f = fixture(), stop = f.pager.start();
  stop();
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].response.resolve({ entries: [entry('LATE_CLOSED_PANEL')], total: 1, offset: 0, nextOffset: null });
  await flush();
  assert.deepEqual(f.pager.getSnapshot().entries, []); assert.equal(f.pager.getSnapshot().loading, false);
  assert.equal(await f.pager.loadMore(), false);
});

test('refresh reads same-revision status changes while a newer live status still fences an in-flight old page', async () => {
  const original = entry('status'), f = fixture([original]), stop = f.pager.start();
  try {
    f.requests[0].response.resolve({ entries: [{ ...original, effectiveStatus: 'expired' }], total: 1, offset: 0, nextOffset: null });
    await flush();
    assert.equal(f.pager.getSnapshot().entries[0].effectiveStatus, 'expired');
    const refresh = f.pager.refresh();
    f.pager.reconcile([{ ...original, effectiveStatus: 'evidence_unavailable' }]);
    f.requests[1].response.resolve({ entries: [original], total: 1, offset: 0, nextOffset: null });
    await refresh;
    assert.equal(f.pager.getSnapshot().entries[0].effectiveStatus, 'evidence_unavailable');
  } finally { stop(); }
});

test('legacy finite full-list responses adapt once and malformed new pages keep the last useful entries', async () => {
  const f = fixture(), stop = f.pager.start();
  try {
    f.requests[0].response.resolve([entry('legacy.owner'), entry('legacy.method', 'agent')]);
    await flush();
    assert.deepEqual(f.pager.getSnapshot().entries.map(value => value.key), ['legacy.owner']);
    assert.equal(f.pager.getSnapshot().total, 1); assert.equal(f.pager.getSnapshot().nextOffset, null);
    const refreshed = f.pager.refresh();
    f.requests[1].response.resolve({ entries: [entry('wrong-subject', 'agent')], total: 1, offset: 0, nextOffset: null });
    await refreshed;
    assert.deepEqual(f.pager.getSnapshot().entries.map(value => value.key), ['legacy.owner']);
    assert.match(f.pager.getSnapshot().error, /分页数据不匹配/);
    const retry = f.pager.retry();
    f.requests[2].response.resolve({ entries: [entry('recovered')], total: 1, offset: 0, nextOffset: null });
    await retry; assert.equal(f.pager.getSnapshot().error, '');
    assert.deepEqual(f.pager.getSnapshot().entries.map(value => value.key), ['recovered']);
  } finally { stop(); }
});
