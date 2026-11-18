import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventInbox, WorkspaceWatcher, type EventInput } from '../server/v2/events.js';

// These are disposable software fixtures, never user profile data or seeded agent tasks.
function fixture(): { directory: string; root: string; file: string; cleanup(): void } {
  const prefix = join(tmpdir(), 'rae-v2-events-test-'); const directory = mkdtempSync(prefix);
  const root = join(directory, 'authorized'); mkdirSync(root);
  return { directory, root, file: join(directory, 'inbox.sqlite'), cleanup() {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    rmSync(directory, { recursive: true, force: true });
  } };
}
function event(overrides: Partial<EventInput> = {}): EventInput {
  return { sourceId: 'fixture-source', externalId: 'fixture-event', kind: 'test.fixture', operation: 'create',
    occurredAt: new Date().toISOString(), actor: 'system', payload: { purpose: 'automated test fixture' }, version: '1', ...overrides };
}
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
async function until(check: () => boolean, timeout = 6000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected filesystem event was not observed before timeout');
    await sleep(25);
  }
}

test('event identity survives duplicate delivery and database reopening', () => {
  const f = fixture(); let inbox = new EventInbox(f.file);
  try {
    const first = inbox.ingest(event()); assert.equal(first.duplicate, false); assert.equal(first.event.status, 'pending');
    const again = inbox.ingest(event({ payload: { ignored: 'duplicate delivery cannot change original event' } }));
    assert.equal(again.duplicate, true); assert.equal(again.event.id, first.event.id);
    assert.deepEqual(again.event.payload, { purpose: 'automated test fixture' });
    inbox.ingest(event({ operation: 'update', version: '2' }));
    inbox.ingest(event({ operation: 'delete', version: '2' }));
    inbox.close(); inbox = new EventInbox(f.file);
    assert.equal(inbox.list().length, 3); assert.equal(inbox.ingest(event()).duplicate, true);
    assert.throws(() => inbox.ingest(event({ id: first.event.id, externalId: 'different-object' })));
  } finally { inbox.close(); f.cleanup(); }
});

test('eligible claims bypass a disabled source backlog without consuming its events', () => {
  const inbox = new EventInbox(':memory:');
  try {
    const blocked = inbox.ingest(event({ sourceId: 'disabled-source' })).event;
    const active = inbox.ingest(event({ sourceId: 'active-source' })).event;
    const claimed = inbox.claim(1, 60_000, [active.id]);
    assert.equal(claimed[0].id, active.id);
    assert.equal(inbox.list().find(row => row.id === blocked.id)?.status, 'pending');
    inbox.ack(active.id, claimed[0].leaseToken!);
    assert.deepEqual(inbox.claim(1, 60_000, []), []);
  } finally { inbox.close(); }
});

test('event batches and source checkpoints commit or roll back together', () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  try {
    inbox.ingestBatch([], { sourceId: 'fixture-source', value: { cursor: 'before' } });
    assert.throws(() => inbox.ingestBatch([event(), event({ externalId: 'invalid', occurredAt: 'invalid time' })], { sourceId: 'fixture-source', value: { cursor: 'after' } }));
    assert.deepEqual(inbox.list(), []); assert.deepEqual(inbox.getCheckpoint('fixture-source'), { cursor: 'before' });
    const batch = inbox.ingestBatch('fixture-source', [event(), event()], { cursor: 'committed' });
    assert.equal(batch.duplicates, 1); assert.equal(inbox.list().length, 1);
    assert.deepEqual(inbox.getCheckpoint('fixture-source'), { cursor: 'committed' });
    assert.throws(() => inbox.ingestBatch([event({ sourceId: 'another-source' })], { sourceId: 'fixture-source', value: {} }));
    assert.deepEqual(inbox.getCheckpoint('fixture-source'), { cursor: 'committed' });
  } finally { inbox.close(); f.cleanup(); }
});

test('a crashed lease can be reclaimed after restart and stale acknowledgements cannot steal a new lease', async () => {
  const f = fixture(); let inbox = new EventInbox(f.file);
  try {
    inbox.ingest(event()); const first = inbox.claim(1, 40)[0]; assert.equal(first.attempts, 1);
    assert.deepEqual(inbox.claim(), []); inbox.close(); await sleep(70); inbox = new EventInbox(f.file);
    const second = inbox.claim(1, 5000)[0]; assert.equal(second.id, first.id); assert.equal(second.attempts, 2);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.throws(() => inbox.ack(first.id, first.leaseToken!));
    assert.throws(() => inbox.retry(first.id, 'stale worker', first.leaseToken!));
    inbox.ack(second.id, second.leaseToken!); assert.equal(inbox.list('processed').length, 1); assert.deepEqual(inbox.claim(), []);
  } finally { inbox.close(); f.cleanup(); }
});

test('two database clients cannot claim the same live event, and retries preserve failure history', () => {
  const f = fixture(); const first = new EventInbox(f.file); const second = new EventInbox(f.file);
  try {
    first.ingest(event()); const claimed = first.claim()[0]; assert.deepEqual(second.claim(), []);
    first.retry(claimed.id, 'temporary fixture failure', claimed.leaseToken!);
    assert.equal(first.list('pending')[0].lastError, 'temporary fixture failure');
    const next = second.claim()[0]; assert.equal(next.attempts, 2);
    second.fail(next.id, 'terminal fixture failure', next.leaseToken!);
    assert.equal(first.list('failed')[0].lastError, 'terminal fixture failure'); assert.deepEqual(first.claim(), []);
    assert.throws(() => first.claim(0)); assert.throws(() => first.claim(1, -1));
  } finally { first.close(); second.close(); f.cleanup(); }
});

test('chokidar captures real text create/change/delete and same-content recreation remains a new event', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); let wakes = 0;
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'directory-fixture', root: f.root, onEvents: () => { wakes++; } });
  const path = join(f.root, 'fixture.md');
  try {
    await watcher.start(); assert.deepEqual(inbox.list(), []);
    writeFileSync(path, 'automated fixture version one');
    await until(() => inbox.list().length === 1); assert.equal(inbox.list()[0].operation, 'create');
    writeFileSync(path, 'automated fixture version two');
    await until(() => inbox.list().length === 2); assert.equal(inbox.list()[1].operation, 'update');
    assert.equal(inbox.list()[1].payload.content, 'automated fixture version two');
    unlinkSync(path); await until(() => inbox.list().length === 3); assert.equal(inbox.list()[2].operation, 'delete');
    writeFileSync(path, 'automated fixture version one'); await until(() => inbox.list().length === 4);
    assert.equal(inbox.list()[3].operation, 'create'); assert.notEqual(inbox.list()[0].version, inbox.list()[3].version);
    const unchanged = await watcher.reconcile(); assert.deepEqual(unchanged, { created: 0, updated: 0, deleted: 0 }); assert.equal(inbox.list().length, 4);
    assert.ok(wakes >= 4); assert.ok(inbox.list().every(item => item.actor === 'external'));
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('reconciliation backfills actual offline create/change/delete from durable file checkpoints', async () => {
  const f = fixture(); let inbox = new EventInbox(f.file);
  let watcher = new WorkspaceWatcher(inbox, { sourceId: 'offline-fixture', root: f.root });
  try {
    writeFileSync(join(f.root, 'change.txt'), 'fixture before offline'); writeFileSync(join(f.root, 'delete.txt'), 'fixture to remove');
    await watcher.start(); assert.equal(inbox.list().length, 2); await watcher.stop(); inbox.close();
    writeFileSync(join(f.root, 'change.txt'), 'fixture after offline'); unlinkSync(join(f.root, 'delete.txt')); writeFileSync(join(f.root, 'new.txt'), 'fixture created offline');
    inbox = new EventInbox(f.file); watcher = new WorkspaceWatcher(inbox, { sourceId: 'offline-fixture', root: f.root });
    const result = await watcher.reconcile(); assert.deepEqual(result, { created: 1, updated: 1, deleted: 1 });
    const backfill = inbox.list().slice(2); assert.equal(backfill.length, 3);
    assert.ok(backfill.some(item => item.externalId === 'new.txt' && item.operation === 'create'));
    assert.ok(backfill.some(item => item.externalId === 'change.txt' && item.operation === 'update'));
    assert.ok(backfill.some(item => item.externalId === 'delete.txt' && item.operation === 'delete'));
    await watcher.start(); assert.equal(inbox.list().length, 5);
    assert.deepEqual(await watcher.reconcile(), { created: 0, updated: 0, deleted: 0 });
    const checkpoint = inbox.getCheckpoint<{ files: Record<string, unknown> }>('offline-fixture')!;
    assert.equal(JSON.stringify(checkpoint).includes('fixture after offline'), false);
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('watch scope excludes ignored trees, binary data, oversized text, credentials and directory symlinks', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'scope-fixture', root: f.root });
  try {
    writeFileSync(join(f.root, 'allowed.md'), 'automated allowed fixture');
    for (const name of ['.git', 'node_modules', 'data', '.local', 'dist']) { mkdirSync(join(f.root, name)); writeFileSync(join(f.root, name, 'ignored.md'), 'excluded fixture'); }
    writeFileSync(join(f.root, 'large.txt'), 'x'.repeat(200 * 1024 + 1)); writeFileSync(join(f.root, 'binary.txt'), Buffer.from([0xff, 0xfe, 0x00]));
    writeFileSync(join(f.root, '.env'), 'TEST_FIXTURE_NOT_A_REAL_KEY=example');
    const outside = join(f.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'outside.md'), 'must not be observed');
    symlinkSync(outside, join(f.root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await watcher.start(); assert.deepEqual(inbox.list().map(item => item.externalId), ['allowed.md']);
    assert.deepEqual(await watcher.reconcile(), { created: 0, updated: 0, deleted: 0 });
    writeFileSync(join(outside, 'outside.md'), 'changed outside authorization'); await sleep(350);
    assert.equal(inbox.list().length, 1);
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('include patterns use the native glob matcher and one source cannot silently move to another root', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'include-fixture', root: f.root, include: ['**/*.md'] });
  const outside = join(f.directory, 'different-root'); mkdirSync(outside);
  const other = new WorkspaceWatcher(inbox, { sourceId: 'include-fixture', root: outside });
  try {
    writeFileSync(join(f.root, 'included.md'), 'glob fixture'); writeFileSync(join(f.root, 'excluded.txt'), 'glob fixture');
    await watcher.start(); assert.deepEqual(inbox.list().map(item => item.externalId), ['included.md']);
    await assert.rejects(other.start(), /bound to another directory/);
    assert.throws(() => new WorkspaceWatcher(inbox, { sourceId: 'bad', root: './relative' }));
  } finally { await other.stop(); await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('a failing wake callback does not roll back real file events and can be retried by reconciliation', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); let calls = 0;
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'wake-fixture', root: f.root, onEvents: () => { calls++; throw new Error('fixture callback unavailable'); } });
  try {
    writeFileSync(join(f.root, 'fixture.txt'), 'durable even when callback fails');
    await watcher.start(); assert.equal(inbox.list('pending').length, 1); assert.match(watcher.lastError ?? '', /callback failed/);
    const before = calls; await watcher.reconcile(); assert.ok(calls > before); assert.equal(inbox.list().length, 1);
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('include observation roots prune an unrelated tree larger than the scan limit', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'narrow-fixture', root: f.root,
    include: ['README.md', 'package.json', 'docs/**/*.md', 'app/package.json'] });
  try {
    mkdirSync(join(f.root, 'docs')); mkdirSync(join(f.root, 'app', 'spike'), { recursive: true });
    mkdirSync(join(f.root, '.workbuddy')); writeFileSync(join(f.root, '.workbuddy', 'unrelated.md'), 'not selected');
    writeFileSync(join(f.root, 'README.md'), 'selected automated fixture'); writeFileSync(join(f.root, 'package.json'), '{"fixture":true}');
    writeFileSync(join(f.root, 'docs', 'selected.md'), 'selected docs fixture'); writeFileSync(join(f.root, 'app', 'package.json'), '{"fixture":"app"}');
    // The previous root-wide scan visits >20,000 entries and fails on this real tree.
    for (let index = 0; index < 20_010; index++) writeFileSync(join(f.root, 'app', 'spike', `unrelated-${index}.txt`), '');
    await watcher.start();
    assert.deepEqual([...watcher.observationRoots].sort(), [join(f.root, 'README.md'), join(f.root, 'package.json'), join(f.root, 'docs'), join(f.root, 'app', 'package.json')].sort());
    assert.equal(watcher.observationRoots.includes(f.root), false);
    assert.deepEqual(inbox.list().map(item => item.externalId).sort(), ['README.md', 'package.json', 'docs/selected.md', 'app/package.json'].sort());
    writeFileSync(join(f.root, 'app', 'spike', 'unrelated-new.md'), 'still not selected');
    await sleep(350); assert.equal(inbox.list().length, 4);
    writeFileSync(join(f.root, 'docs', 'selected.md'), 'selected docs fixture changed');
    await until(() => inbox.list().length === 5); assert.equal(inbox.list()[4].operation, 'update');
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('include roots monitor later creation of missing literal files and dynamic directories', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'missing-include-fixture', root: f.root,
    include: ['future/nested/file.md', 'later/docs/**/*.md'] });
  try {
    await watcher.start(); assert.deepEqual(inbox.list(), []); assert.equal(watcher.observationRoots.includes(f.root), false);
    mkdirSync(join(f.root, 'future', 'nested'), { recursive: true }); writeFileSync(join(f.root, 'future', 'nested', 'file.md'), 'later literal fixture');
    mkdirSync(join(f.root, 'later', 'docs', 'chapter'), { recursive: true }); writeFileSync(join(f.root, 'later', 'docs', 'chapter', 'new.md'), 'later dynamic fixture');
    await until(() => inbox.list().length === 2);
    assert.deepEqual(inbox.list().map(item => item.externalId).sort(), ['future/nested/file.md', 'later/docs/chapter/new.md']);
    writeFileSync(join(f.root, 'later', 'docs', 'chapter', 'new.md'), 'later dynamic fixture updated'); await until(() => inbox.list().length === 3);
    assert.equal(inbox.list()[2].operation, 'update');
    unlinkSync(join(f.root, 'future', 'nested', 'file.md')); await until(() => inbox.list().length === 4);
    writeFileSync(join(f.root, 'future', 'nested', 'file.md'), 'recreated literal fixture'); await until(() => inbox.list().length === 5);
    assert.equal(inbox.list()[4].operation, 'create');
    assert.deepEqual(await watcher.reconcile(), { created: 0, updated: 0, deleted: 0 });
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('include observation roots deduplicate overlapping task bases and reject expanded path escapes or symlinks', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  mkdirSync(join(f.root, 'docs', 'deep'), { recursive: true }); writeFileSync(join(f.root, 'docs', 'deep', 'one.md'), 'overlap fixture');
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'overlap-fixture', root: f.root,
    include: ['docs/**/*.md', 'docs/deep/**/*.md', 'docs/deep/one.md', '!docs/private/**'] });
  try {
    mkdirSync(join(f.root, 'docs', 'private')); writeFileSync(join(f.root, 'docs', 'private', 'excluded.md'), 'negative glob fixture');
    await watcher.start(); assert.deepEqual([...watcher.observationRoots], [join(f.root, 'docs')]); assert.equal(inbox.list().length, 1);
    for (const pattern of ['../outside/**/*.md', '/absolute/**/*.md', 'C:/outside/**/*.md', 'docs/../**/*.md', '{README.md,../secret.md}']) {
      assert.throws(() => new WorkspaceWatcher(inbox, { sourceId: 'unsafe', root: f.root, include: [pattern] }), /relative/);
    }
    const outside = join(f.directory, 'outside-include'); mkdirSync(outside); writeFileSync(join(outside, 'secret.md'), 'outside fixture');
    symlinkSync(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linked = new WorkspaceWatcher(inbox, { sourceId: 'linked-fixture', root: f.root, include: ['linked/**/*.md'] });
    try { await assert.rejects(linked.start(), /symlinks or junctions/); } finally { await linked.stop(); }
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('an unavailable authorized root preserves the last snapshot and recovers without synthetic deletes', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'unavailable-fixture', root: f.root, include: ['**/*.md'] });
  const parked = join(f.directory, 'temporarily-offline');
  try {
    writeFileSync(join(f.root, 'fixture.md'), 'availability fixture'); await watcher.reconcile();
    const before = inbox.getCheckpoint('unavailable-fixture');
    const { renameSync } = await import('node:fs'); renameSync(f.root, parked);
    await assert.rejects(watcher.reconcile(), /root|directory|available/i);
    assert.ok(watcher.lastError); assert.deepEqual(inbox.getCheckpoint('unavailable-fixture'), before);
    assert.deepEqual(inbox.list().map(item => item.operation), ['create']);
    renameSync(parked, f.root); assert.deepEqual(await watcher.reconcile(), { created: 0, updated: 0, deleted: 0 });
    assert.equal(watcher.lastError, null); assert.equal(inbox.list().length, 1);
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});

test('flat and negative include globs prune unmatched nested trees before the scan limit', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const flat = new WorkspaceWatcher(inbox, { sourceId: 'flat-fixture', root: f.root, include: ['docs/*.md'] });
  const negative = new WorkspaceWatcher(inbox, { sourceId: 'negative-fixture', root: f.root, include: ['docs/**/*.md', '!docs/archive/**'] });
  try {
    mkdirSync(join(f.root, 'docs', 'archive'), { recursive: true }); writeFileSync(join(f.root, 'docs', 'top.md'), 'selected fixture');
    for (let index = 0; index < 20_010; index++) writeFileSync(join(f.root, 'docs', 'archive', `unmatched-${index}.txt`), '');
    await flat.start(); await negative.start();
    assert.deepEqual(inbox.list().map(item => item.externalId), ['docs/top.md', 'docs/top.md']);
    writeFileSync(join(f.root, 'docs', 'archive', 'also-excluded.md'), 'excluded fixture'); await sleep(350);
    assert.equal(flat.lastError, null); assert.equal(negative.lastError, null); assert.equal(inbox.list().length, 2);
    assert.deepEqual(await flat.reconcile(), { created: 0, updated: 0, deleted: 0 });
    assert.deepEqual(await negative.reconcile(), { created: 0, updated: 0, deleted: 0 });
  } finally { await flat.stop(); await negative.stop(); inbox.close(); f.cleanup(); }
});

test('an enumerated file read failure cannot commit a partial snapshot as deletion', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  const watcher = new WorkspaceWatcher(inbox, { sourceId: 'partial-fixture', root: f.root, include: ['*.md'] });
  try {
    writeFileSync(join(f.root, 'fixture.md'), 'stable software fixture'); await watcher.reconcile();
    const before = inbox.getCheckpoint('partial-fixture');
    const injected = watcher as unknown as { readText(path: string): Promise<unknown> };
    const original = injected.readText;
    injected.readText = async () => { throw Object.assign(new Error('Injected file-disappearance race after enumeration'), { code: 'ENOENT' }); };
    try { await assert.rejects(watcher.reconcile(), /incomplete|changed during scan/i); }
    finally { injected.readText = original; }
    assert.deepEqual(inbox.getCheckpoint('partial-fixture'), before); assert.deepEqual(inbox.list().map(item => item.operation), ['create']);
    assert.deepEqual(await watcher.reconcile(), { created: 0, updated: 0, deleted: 0 });
  } finally { await watcher.stop(); inbox.close(); f.cleanup(); }
});
