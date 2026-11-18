import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EventInbox, SOURCE_REVIEW_INTERVAL_MS } from '../server/v2/events.js';

const fileEvent = (externalId: string, generation = 'active') => ({ sourceId: 'fixture-docs', sourceGeneration: generation, externalId,
  caseId: generation === 'active' ? 'context-b' : 'context-a', kind: 'workspace.file', actor: 'external' as const,
  operation: 'create' as const, occurredAt: new Date().toISOString(), payload: { content: '可学习的背景资料，不是执行任务许可。' } });
test('passive changes retain every event and release bounded pages within the source window', () => {
  const inbox = new EventInbox(':memory:'); const at = Date.now();
  try {
    for (let i = 0; i < 40; i++) inbox.ingest(fileEvent(`file-${i}.md`));
    assert.equal(inbox.captureObservations(() => true, at), 40); assert.equal(inbox.list('processed').length, 40);
    assert.equal(inbox.releaseObservation(() => true, at + 1000), undefined);
    const batch = inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS)!;
    assert.equal(batch.kind, 'growth.observation'); assert.equal(batch.payload.changeCount, 20); assert.equal((batch.payload.eventIds as string[]).length, 20);
    assert.equal(batch.payload.content, undefined); assert.equal(batch.caseId, 'context-b'); assert.equal(batch.sourceGeneration, 'active');
    assert.equal(inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS + 1), undefined, 'one source cannot overlap its current review');
    const claimed = inbox.claim(1, 60000, [batch.id])[0]; inbox.ack(batch.id, claimed.leaseToken!);
    const remaining = inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS + 2)!;
    assert.equal(remaining.payload.changeCount, 20);
    assert.equal(new Set([...(batch.payload.eventIds as string[]), ...(remaining.payload.eventIds as string[])]).size, 40);
    const nextClaim = inbox.claim(1, 60000, [remaining.id])[0]; inbox.ack(remaining.id, nextClaim.leaseToken!);
    inbox.ingest(fileEvent('next.md')); inbox.captureObservations(() => true, at + SOURCE_REVIEW_INTERVAL_MS + 3);
    assert.equal(inbox.releaseObservation(() => true, at + SOURCE_REVIEW_INTERVAL_MS + 4), undefined);
    assert.ok(inbox.releaseObservation(() => true, at + 2 * SOURCE_REVIEW_INTERVAL_MS + 3));
    assert.equal(inbox.nextObservationAt(), null, 'no pending data means no idle model review');
  } finally { inbox.close(); }
});
test('a retired-source backlog cannot hide later active observations or move its data to the new case', () => {
  const inbox = new EventInbox(':memory:'); const at = Date.now();
  try {
    for (let i = 0; i < 1000; i++) inbox.ingest(fileEvent(`old-${i}.md`, 'retired'));
    const fresh = inbox.ingest(fileEvent('new.md')).event;
    assert.equal(inbox.captureObservations(event => event.sourceGeneration === 'active', at), 1);
    assert.equal(inbox.get(fresh.id)?.status, 'processed'); assert.equal(inbox.list('pending').length, 1000);
    const batch = inbox.releaseObservation(event => event.sourceGeneration === 'active', at, true)!;
    assert.deepEqual(batch.payload.eventIds, [fresh.id]); assert.equal(batch.caseId, 'context-b');
  } finally { inbox.close(); }
});
test('capture failures roll back both the source acknowledgment and the pending learning batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-growth-observation-')); const file = join(directory, 'events.sqlite');
  const inbox = new EventInbox(file); const other = new DatabaseSync(file);
  try {
    const event = inbox.ingest(fileEvent('README.md')).event;
    other.exec("CREATE TRIGGER fixture_block_capture BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'capture failure'); END;");
    assert.throws(() => inbox.captureObservations(() => true), /capture failure/);
    assert.equal(inbox.get(event.id)?.status, 'pending'); assert.equal(inbox.nextObservationAt(), null);
    assert.equal(inbox.releaseObservation(() => true, Date.now(), true), undefined);
    other.exec('DROP TRIGGER fixture_block_capture'); assert.equal(inbox.captureObservations(() => true), 1);
    assert.ok(inbox.releaseObservation(() => true, Date.now(), true));
  } finally { other.close(); inbox.close(); }
});
test('release failures retain the batch; removed generations are discarded without a learning run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-growth-release-')); const file = join(directory, 'events.sqlite');
  const inbox = new EventInbox(file); const other = new DatabaseSync(file);
  try {
    inbox.ingest(fileEvent('README.md')); inbox.captureObservations(() => true);
    other.exec("CREATE TRIGGER fixture_block_release BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'release failure'); END;");
    assert.throws(() => inbox.releaseObservation(() => true, Date.now(), true), /release failure/); assert.ok(inbox.nextObservationAt());
    other.exec('DROP TRIGGER fixture_block_release');
    assert.equal(inbox.releaseObservation(() => false, Date.now(), true), undefined); assert.equal(inbox.nextObservationAt(), null);
    assert.equal(inbox.list().some(event => event.kind === 'growth.observation'), false);
  } finally { other.close(); inbox.close(); }
});

test('reminders are independent, idempotent, case-scoped and cancellable before release', () => {
  const inbox = new EventInbox(':memory:'); const at = Date.now();
  try {
    const first = { caseId: 'context-a', at: new Date(at + 1000).toISOString(), reason: '第一个提醒', message: '提醒正文一', originEventId: 'owner-message' };
    const a = inbox.scheduleWake(first); assert.deepEqual(inbox.scheduleWake(first), a);
    const b = inbox.scheduleWake({ ...first, reason: '第二个提醒', message: '提醒正文二' });
    assert.equal(inbox.scheduledWakes('context-a').length, 2); assert.deepEqual(inbox.scheduledWakes('context-b'), []);
    assert.equal(inbox.cancelWake('context-b', a.id), false); assert.equal(inbox.cancelWake('context-a', a.id), true);
    assert.equal(inbox.releaseDueWakes(at + 1001), 1); assert.equal(inbox.releaseDueWakes(at + 2000), 0);
    assert.equal(inbox.list()[0].id, b.id); assert.equal(inbox.list()[0].kind, 'growth.reminder'); assert.equal(inbox.nextWakeAt(), null);
  } finally { inbox.close(); }
});
