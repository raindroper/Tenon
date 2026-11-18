import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventInbox, WorkspaceWatcher } from '../server/v2/events.js';
import { SourceRegistry } from '../server/v2/sources.js';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const prefix = join(tmpdir(), 'rae-v2-source-test-'); const directory = mkdtempSync(prefix);
  const root = join(directory, 'authorized'); mkdirSync(root);
  return { directory, root, file: join(directory, 'inbox.sqlite'), cleanup() {
    assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true });
  } };
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

test('concurrent source shutdown callers share the same drain and close storage once', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); const registry = new SourceRegistry(inbox);
  try {
    await registry.init();
    await Promise.all([registry.close(), registry.close()]);
    await registry.close();
    await assert.rejects(registry.register({ sourceId: 'late', root: f.root, caseId: 'case-A' }), /closed/);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});

test('source shutdown fences new work immediately and drains already accepted source changes', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let entered!: () => void; const changing = new Promise<void>(done => { entered = done; });
  const registry = new SourceRegistry(inbox, { mutateCase: async (_caseId, mutation) => {
    entered(); await gate; return mutation();
  } });
  let closing: Promise<void> | undefined;
  try {
    await registry.register({ sourceId: 'original', root: f.root, caseId: 'case-A' });
    const removal = registry.remove('original'); await changing;
    let drained = false; closing = registry.close().then(() => { drained = true; });
    let fenced = false; const rejected = assert.rejects(registry.reconcile(), /closed/).then(() => { fenced = true; });
    await new Promise<void>(done => setImmediate(done)); assert.equal(drained, false); assert.equal(fenced, true);
    release(); await removal; await closing; await rejected;
  } finally { release(); await closing; await registry.close(); inbox.close(); f.cleanup(); }
});

test('removing source A and rebinding its alias to B never migrates old pending data to B', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); let registry = new SourceRegistry(inbox);
  try {
    writeFileSync(join(f.root, 'a.md'), 'case A software fixture'); writeFileSync(join(f.root, 'b.md'), 'case B software fixture');
    await registry.init();
    const first = await registry.register({ sourceId: 'alias', root: f.root, caseId: 'case-A', include: ['a.md'] });
    const old = inbox.ready()[0]; assert.equal(old.caseId, 'case-A'); assert.equal(old.sourceGeneration, first.generation);
    await registry.remove('alias');
    const second = await registry.register({ sourceId: 'alias', root: f.root, caseId: 'case-B', include: ['b.md'] });
    assert.notEqual(first.generation, second.generation); assert.equal(registry.resolveEventCase(old), 'case-A'); assert.equal(registry.isEventAllowed(old), false);
    const eligible = inbox.ready(20, event => registry.isEventAllowed(event));
    assert.deepEqual(eligible.map(item => [item.externalId, item.caseId]), [['b.md', 'case-B']]);
    assert.equal(inbox.get(old.id)?.caseId, 'case-A'); assert.equal(inbox.get(old.id)?.status, 'pending');
    await registry.close(); registry = new SourceRegistry(inbox); await registry.init();
    assert.equal(registry.get('alias')?.generation, second.generation); assert.equal(registry.isEventAllowed(inbox.get(old.id)!), false);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});

test('include replacement stops the old watcher and creates a new immutable generation', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); const registry = new SourceRegistry(inbox);
  try {
    writeFileSync(join(f.root, 'a.md'), 'old include fixture'); writeFileSync(join(f.root, 'b.md'), 'new include fixture'); await registry.init();
    const a = await registry.register({ sourceId: 'include', root: f.root, caseId: 'case-A', include: ['a.md'] });
    const b = await registry.register({ sourceId: 'include', root: f.root, caseId: 'case-A', include: ['b.md'] });
    assert.notEqual(a.generation, b.generation); assert.deepEqual(registry.get('include')?.include, ['b.md']);
    const count = inbox.list().length; writeFileSync(join(f.root, 'a.md'), 'must not be collected by the new generation'); await sleep(350); await registry.reconcile();
    assert.equal(inbox.list().length, count);
    assert.deepEqual(inbox.ready(20, event => registry.isEventAllowed(event)).map(item => item.externalId), ['b.md']);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});

test('legacy mutable routes cannot authorize old unscoped events or reuse old checkpoint identities', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); let registry: SourceRegistry | undefined;
  const legacy = new WorkspaceWatcher(inbox, { sourceId: 'legacy', root: f.root, include: ['a.md'] });
  try {
    writeFileSync(join(f.root, 'a.md'), 'legacy fixture'); await legacy.reconcile(); await legacy.stop(); const original = inbox.list()[0];
    registry = new SourceRegistry(inbox);
    await registry.init({ sources: [{ sourceId: 'legacy', root: f.root, caseId: 'case-B', include: ['a.md'] }], sourceRoutes: { legacy: 'case-B' }, eventCases: {}, disabledSources: [] });
    const old = inbox.get(original.id)!; assert.equal(old.payload.content, 'legacy fixture'); assert.equal(old.caseId, undefined);
    assert.equal(registry.resolveEventCase(old), undefined); assert.equal(registry.isEventAllowed(old), false);
    const fresh = inbox.ready(20, event => registry!.isEventAllowed(event));
    assert.equal(fresh.length, 1); assert.notEqual(fresh[0].id, original.id); assert.equal(fresh[0].caseId, 'case-B'); assert.ok(fresh[0].sourceGeneration);
    const generation = registry.get('legacy')!.generation;
    await registry.close(); registry = new SourceRegistry(inbox);
    await registry.init({ sources: [{ sourceId: 'legacy', root: f.root, caseId: 'case-C', include: ['a.md'] }], sourceRoutes: { legacy: 'case-C' } });
    assert.equal(registry.get('legacy')?.caseId, 'case-B'); assert.equal(registry.get('legacy')?.generation, generation); assert.equal(inbox.list().length, 2);
  } finally { await legacy.stop(); await registry?.close(); inbox.close(); f.cleanup(); }
});

test('legacy per-event case evidence fixes original ownership without granting a replacement case access', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); const registry = new SourceRegistry(inbox);
  try {
    writeFileSync(join(f.root, 'b.md'), 'replacement fixture');
    const old = inbox.ingest({ sourceId: 'legacy', externalId: 'old-a.md', kind: 'workspace.file', operation: 'create', actor: 'external', occurredAt: new Date().toISOString(), payload: { content: 'original A fixture' } }).event;
    await registry.init({ sources: [{ sourceId: 'legacy', root: f.root, caseId: 'case-B', include: ['b.md'] }], sourceRoutes: { legacy: 'case-B' }, eventCases: { [old.id]: 'case-A' } });
    const migrated = inbox.get(old.id)!; assert.equal(migrated.caseId, 'case-A'); assert.equal(registry.resolveEventCase(migrated), 'case-A'); assert.equal(registry.isEventAllowed(migrated), false);
    assert.deepEqual(inbox.ready(20, event => registry.isEventAllowed(event)).map(item => item.caseId), ['case-B']);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});

test('failed replacement keeps the effective failed configuration visible and reconciliation recovers it', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); const registry = new SourceRegistry(inbox);
  try {
    writeFileSync(join(f.root, 'a.md'), 'initial fixture'); await registry.init();
    await registry.register({ sourceId: 'failure', root: f.root, caseId: 'case-A', include: ['a.md'] });
    const missing = join(f.directory, 'not-present-yet');
    await assert.rejects(registry.register({ sourceId: 'failure', root: missing, caseId: 'case-B', include: ['b.md'] }));
    const failed = registry.get('failure')!; assert.equal(failed.status, 'failed'); assert.equal(failed.root, missing); assert.ok(failed.health); assert.equal(failed.watching, false);
    assert.equal(inbox.ready(20, event => registry.isEventAllowed(event)).length, 0);
    mkdirSync(missing); writeFileSync(join(missing, 'b.md'), 'recovered fixture'); await registry.reconcile();
    assert.equal(registry.get('failure')?.status, 'active'); assert.equal(registry.get('failure')?.generation, failed.generation); assert.equal(registry.get('failure')?.health, null);
    assert.deepEqual(inbox.ready(20, event => registry.isEventAllowed(event)).map(item => [item.externalId, item.caseId]), [['b.md', 'case-B']]);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});

test('intake can bind an owner event once, without parsing processed history or rebinding a source event', () => {
  const f = fixture(); const inbox = new EventInbox(f.file);
  try {
    const event = inbox.ingest({ sourceId: 'owner-chat', externalId: 'message-1', kind: 'owner.message', operation: 'create', actor: 'owner', occurredAt: new Date().toISOString(), payload: { content: 'test fixture' } }).event;
    assert.equal(inbox.hasPending(), true); assert.equal(inbox.bindCase(event.id, 'case-A').caseId, 'case-A'); assert.equal(inbox.getCaseId(event.id), 'case-A');
    assert.throws(() => inbox.bindCase(event.id, 'case-B'), /immutable/);
    const claim = inbox.claim()[0]; inbox.ack(claim.id, claim.leaseToken!); assert.equal(inbox.hasPending(), false); assert.deepEqual(inbox.ready(), []);
    const source = inbox.ingest({ sourceId: 'legacy', externalId: 'file.md', kind: 'workspace.file', operation: 'create', actor: 'external', occurredAt: new Date().toISOString(), payload: {} }).event;
    assert.throws(() => inbox.bindCase(source.id, 'case-B'), /registry migration/);
  } finally { inbox.close(); f.cleanup(); }
});

test('the old inbox unique index migrates without losing history or colliding new generations', () => {
  const f = fixture();
  const legacy = new DatabaseSync(f.file);
  legacy.exec(`CREATE TABLE events (id TEXT PRIMARY KEY,source_id TEXT NOT NULL,external_id TEXT NOT NULL,version TEXT NOT NULL,operation TEXT NOT NULL,json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,lease_token TEXT,last_error TEXT,
    UNIQUE(source_id,external_id,version,operation));`);
  const original = { id: 'old-row', sourceId: 'alias', externalId: 'file.md', version: '1', kind: 'workspace.file', operation: 'create' as const, actor: 'external' as const,
    occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), payload: { content: 'legacy raw fixture' } };
  legacy.prepare('INSERT INTO events(id,source_id,external_id,version,operation,json) VALUES(?,?,?,?,?,?)').run(original.id, original.sourceId, original.externalId, original.version, original.operation, JSON.stringify(original)); legacy.close();
  const inbox = new EventInbox(f.file);
  try {
    assert.equal(inbox.get(original.id)?.payload.content, 'legacy raw fixture');
    const { id: _id, ...input } = original;
    assert.equal(inbox.ingest({ ...input, sourceGeneration: 'generation-A', caseId: 'case-A' }).duplicate, false);
    assert.equal(inbox.ingest({ ...input, sourceGeneration: 'generation-B', caseId: 'case-B' }).duplicate, false);
    assert.equal(inbox.ingest({ ...input, sourceGeneration: 'generation-B', caseId: 'case-B' }).duplicate, true); assert.equal(inbox.list().length, 3);
    inbox.ingestBatch([], { sourceId: 'alias', sourceGeneration: 'generation-A', value: { cursor: 'A' } });
    inbox.ingestBatch([], { sourceId: 'alias', sourceGeneration: 'generation-B', value: { cursor: 'B' } });
    assert.deepEqual(inbox.getCheckpoint('alias', null, 'generation-A'), { cursor: 'A' }); assert.deepEqual(inbox.getCheckpoint('alias', null, 'generation-B'), { cursor: 'B' });
  } finally { inbox.close(); f.cleanup(); }
});

test('startup failures are reported and persisted while reconcile can retry the same generation after reopening', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); let registry = new SourceRegistry(inbox);
  const missing = join(f.directory, 'offline-root');
  try {
    await assert.rejects(registry.init({ sources: [{ sourceId: 'offline', root: missing, caseId: 'case-A', include: ['a.md'] }] }), AggregateError);
    const failed = registry.get('offline')!; assert.equal(failed.status, 'failed'); assert.ok(failed.health); assert.equal(registry.list().length, 1);
    await registry.close(); registry = new SourceRegistry(inbox); await assert.rejects(registry.init(), AggregateError);
    assert.equal(registry.get('offline')?.generation, failed.generation);
    mkdirSync(missing); writeFileSync(join(missing, 'a.md'), 'source recovery fixture'); await registry.reconcile();
    assert.equal(registry.get('offline')?.status, 'active'); assert.equal(registry.get('offline')?.generation, failed.generation);
    assert.equal(inbox.ready(10, event => registry.isEventAllowed(event)).length, 1);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});

test('migration schema errors remain fatal rather than becoming a recoverable source AggregateError', async () => {
  const f = fixture(); const inbox = new EventInbox(f.file); const registry = new SourceRegistry(inbox);
  try {
    await assert.rejects(registry.init({ sources: [{ sourceId: 'bad', root: './not-an-absolute-root', caseId: 'case-A' }] }), error => !(error instanceof AggregateError));
    assert.equal(registry.get('bad'), undefined); assert.deepEqual(inbox.list(), []);
  } finally { await registry.close(); inbox.close(); f.cleanup(); }
});
