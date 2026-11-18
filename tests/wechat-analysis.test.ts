import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventInbox } from '../server/v2/events.js';

function receive(inbox: EventInbox, sequence: number, generation = 'group-a') {
  return inbox.ingest({ sourceId: `connector:${generation}`, sourceGeneration: generation, externalId: String(sequence),
    caseId: 'topic', kind: 'connector.change', actor: 'external', operation: 'create', occurredAt: new Date().toISOString(),
    payload: { provider: 'wechat-desktop', content: `message ${sequence}` } }).event;
}
function complete(inbox: EventInbox, id: string) {
  const event = inbox.claim(1, 60000, [id])[0];
  assert.ok(event);
  inbox.ack(event.id, event.leaseToken!);
}

test('WeChat analysis covers every message fairly in durable bounded pages without idle reviews', () => {
  const inbox = new EventInbox(':memory:');
  const at = Date.now();
  try {
    for (let i = 0; i < 45; i++) receive(inbox, i);
    receive(inbox, 1, 'group-b');
    inbox.captureObservations(() => true, at);
    assert.equal(inbox.releaseObservation(() => true, at + 599999), undefined);
    const first = inbox.releaseObservation(() => true, at + 600000)!;
    assert.equal((first.payload.eventIds as string[]).length, 20);
    assert.equal(inbox.observationStats(['group-a']).analyzedCount, 0);
    const second = inbox.releaseObservation(() => true, at + 600000)!;
    assert.equal(second.sourceGeneration, 'group-b');
    assert.equal(inbox.releaseObservation(() => true, at + 1200000), undefined, 'never overlap one source analysis');
    complete(inbox, first.id); complete(inbox, second.id);
    const ids = new Set(first.payload.eventIds as string[]);
    for (let tick = 2; tick <= 3; tick++) {
      const batch = inbox.releaseObservation(() => true, at + tick * 600000)!;
      for (const id of batch.payload.eventIds as string[]) { assert.ok(!ids.has(id)); ids.add(id); }
      complete(inbox, batch.id);
    }
    assert.equal(ids.size, 45);
    const status = inbox.observationStats(['group-a']);
    assert.equal(status.analyzedCount, 45); assert.equal(status.pendingCount, 0);
    assert.ok(status.lastAnalyzedAt);
    assert.equal(inbox.releaseObservation(() => true, at + 86400000), undefined);
    assert.equal(inbox.nextObservationAt(), null);
  } finally { inbox.close(); }
});

test('analysis failures keep coverage incomplete until explicit scoped retry', () => {
  const inbox = new EventInbox(':memory:');
  try {
    receive(inbox, 1); inbox.captureObservations(() => true);
    const scope = { caseId: 'topic', sourceGenerations: ['group-a'] };
    const batch = inbox.releaseObservation(() => true, Date.now(), true, scope)!;
    const leased = inbox.claim(1, 60000, [batch.id])[0];
    inbox.fail(batch.id, 'bounded failure', leased.leaseToken!);
    assert.equal(inbox.observationStats(['group-a']).failedCount, 1);
    assert.equal(inbox.observationStats(['group-a']).analyzedCount, 0);
    assert.equal(inbox.releaseObservation(() => true, Date.now() + 86400000), undefined);
    assert.equal(inbox.releaseObservation(() => true, Date.now(), true, { ...scope, caseId: 'other' }), undefined);
    assert.equal(inbox.releaseObservation(() => false, Date.now(), true, scope), undefined);
    assert.equal(inbox.releaseObservation(() => true, Date.now(), true, scope)?.id, batch.id);
    complete(inbox, batch.id);
    assert.equal(inbox.observationStats(['group-a']).analyzedCount, 1);
  } finally { inbox.close(); }
});

test('restart reconstructs old truncated batches from original records and keeps successful coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-wechat-analysis-'));
  const path = join(directory, 'events.sqlite');
  let inbox = new EventInbox(path);
  try {
    const events = Array.from({ length: 43 }, (_, i) => receive(inbox, i));
    inbox.ingestProcessed({ id: 'old-review', sourceId: 'connector:group-a', sourceGeneration: 'group-a', externalId: 'old-review',
      caseId: 'topic', kind: 'growth.observation', actor: 'system', operation: 'create', occurredAt: new Date().toISOString(),
      payload: { eventIds: events.slice(-20).map(event => event.id), changeCount: 43 } });
    const legacy = new DatabaseSync(path);
    legacy.prepare("DELETE FROM source_checkpoints WHERE source_id='source-review-queue-v1'").run();
    legacy.close();
    inbox.close();
    inbox = new EventInbox(path);
    const stats = inbox.observationStats(['group-a']);
    assert.equal(stats.analyzedCount, 20); assert.equal(stats.pendingCount, 23);
    inbox.captureObservations(() => true);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_analysis BEFORE INSERT ON events WHEN json_extract(NEW.json,'$.kind')='growth.observation' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.throws(() => inbox.releaseObservation(() => true, Date.now()), /fixture failure/);
    assert.equal(inbox.observationStats(['group-a']).pendingCount, 23);
    db.exec('DROP TRIGGER reject_analysis'); db.close();
    const batch = inbox.releaseObservation(() => true, Date.now())!;
    complete(inbox, batch.id);
    inbox.close(); inbox = new EventInbox(path);
    assert.equal(inbox.observationStats(['group-a']).analyzedCount, 40);
    assert.equal(inbox.observationStats(['group-a']).pendingCount, 3);
  } finally { inbox.close(); await rm(directory, { recursive: true, force: true }); }
});

test('revoked queues stop scheduling while original evidence remains stored', () => {
  const inbox = new EventInbox(':memory:');
  try {
    const event = receive(inbox, 1); inbox.captureObservations(() => true);
    assert.ok(inbox.nextObservationAt());
    inbox.retireObservationSources(['group-a']);
    assert.equal(inbox.nextObservationAt(), null);
    assert.equal(inbox.releaseObservation(() => false, Date.now() + 86400000), undefined);
    assert.ok(inbox.get(event.id));
  } finally { inbox.close(); }
});
