import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventInbox, EventRetryError, type EventInput } from '../server/v2/events.js';

const ownerMessage = (overrides: Partial<EventInput> = {}): EventInput => ({
  sourceId: 'owner-chat', externalId: 'owner-message', kind: 'owner.message', operation: 'create',
  actor: 'owner', caseId: 'personal-growth', occurredAt: '2026-11-04T05:52:39.450Z',
  payload: { messageId: 'owner-message', content: '按已提供的时间表提醒我。' }, ...overrides,
});
function fail(inbox: EventInbox, input: EventInput) {
  const event = inbox.ingest(input).event;
  const claim = inbox.claim(1, 60_000, [event.id])[0];
  inbox.fail(event.id, 'provider output reached limit', claim.leaseToken!);
  return inbox.get(event.id)!;
}

test('explicit failed-owner recovery keeps identity, history and existing reminders across restart', () => {
  const prefix = join(tmpdir(), 'rae-event-retry-'); const directory = mkdtempSync(prefix);
  const file = join(directory, 'events.sqlite'); let inbox = new EventInbox(file);
  try {
    const failed = fail(inbox, ownerMessage());
    const reminder = inbox.scheduleWake({ caseId: failed.caseId!, at: '2026-11-05T09:00:00+08:00',
      originEventId: failed.id, reason: '已保存的提醒', message: '计划节点今天到期。' });
    const before = inbox.scheduledWakes(failed.caseId!);
    const pending = inbox.retryFailedOwnerMessage(failed.id);
    assert.deepEqual(pending, { ...failed, status: 'pending', leaseUntil: null, leaseToken: null, lastError: null });
    assert.deepEqual(inbox.scheduledWakes(failed.caseId!), before);
    assert.equal(inbox.list().length, 1, 'recovery reuses the original event instead of injecting another owner instruction');
    assert.throws(() => inbox.retryFailedOwnerMessage(failed.id), error => error instanceof EventRetryError && error.code === 'conflict');
    inbox.close(); inbox = new EventInbox(file);
    assert.deepEqual(inbox.get(failed.id), pending);
    const reclaimed = inbox.claim(1, 60_000, [failed.id])[0];
    assert.equal(reclaimed.attempts, failed.attempts + 1, 'delivery attempt history is never reset by owner recovery');
    assert.deepEqual(reclaimed.payload, failed.payload); assert.equal(reclaimed.receivedAt, failed.receivedAt);
    inbox.ack(failed.id, reclaimed.leaseToken!);
    assert.equal(inbox.releaseDueWakes(Date.parse('2026-11-05T01:00:00.000Z')), 1);
    assert.equal(inbox.list().filter(event => event.kind === 'growth.reminder').length, 1);
    assert.equal(inbox.list().find(event => event.kind === 'growth.reminder')?.id, reminder.id);
    assert.equal(inbox.releaseDueWakes(Date.parse('2026-11-05T01:00:00.000Z')), 0, 'recovery must not duplicate existing reminder delivery');
  } finally {
    inbox.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true });
  }
});

test('recovery rejects live, completed, missing and non-owner-message events without mutations', () => {
  const inbox = new EventInbox(':memory:');
  try {
    const pending = inbox.ingest(ownerMessage({ externalId: 'pending' })).event;
    const leased = inbox.ingest(ownerMessage({ externalId: 'leased' })).event;
    inbox.claim(1, 60_000, [leased.id]);
    const complete = inbox.ingest(ownerMessage({ externalId: 'complete' })).event;
    const completeClaim = inbox.claim(1, 60_000, [complete.id])[0]; inbox.ack(complete.id, completeClaim.leaseToken!);
    const external = fail(inbox, ownerMessage({ externalId: 'external', actor: 'external' }));
    const feedback = fail(inbox, ownerMessage({ externalId: 'feedback', kind: 'owner.feedback' }));
    const execution = fail(inbox, ownerMessage({ externalId: 'execution', kind: 'task.execute', actor: 'system' }));
    const before = inbox.list();
    for (const event of [pending, leased, complete, external, feedback, execution]) {
      assert.throws(() => inbox.retryFailedOwnerMessage(event.id), error => error instanceof EventRetryError && error.code === 'conflict');
    }
    assert.throws(() => inbox.retryFailedOwnerMessage('missing'), error => error instanceof EventRetryError && error.code === 'not_found');
    assert.deepEqual(inbox.list(), before);
  } finally { inbox.close(); }
});

test('wake receipts are scoped to case and original event, bounded, and exclude cancelled or fired reminders', () => {
  const inbox = new EventInbox(':memory:');
  try {
    const at = (minute: number) => new Date(Date.parse('2027-01-01T09:00:00.000Z') + minute * 60_000).toISOString();
    const ids: string[] = [];
    for (let minute = 0; minute < 26; minute++) ids.push(inbox.scheduleWake({ caseId: 'case-a', originEventId: 'event-a', at: at(minute),
      reason: 'r'.repeat(600), message: 'm'.repeat(1000) }).id);
    inbox.scheduleWake({ caseId: 'case-b', originEventId: 'event-a', at: at(0), reason: 'other case' });
    inbox.scheduleWake({ caseId: 'case-a', originEventId: 'event-b', at: at(0), reason: 'other event' });
    const before = inbox.wakeReceipts('case-a', 'event-a');
    assert.equal(before.scheduledCount, 26); assert.equal(before.scheduled.length, 20);
    assert.ok(before.scheduled.every(wake => wake.reason.length <= 300 && wake.message!.length <= 300));
    assert.ok(before.scheduled.every((wake, index) => wake.id === ids[index]));
    inbox.cancelWake('case-a', ids[0]); inbox.releaseDueWakes(Date.parse(at(1)));
    const after = inbox.wakeReceipts('case-a', 'event-a');
    assert.equal(after.scheduledCount, 24); assert.equal(after.scheduled.length, 20); assert.equal(after.scheduled[0].id, ids[2]);
    assert.deepEqual(inbox.wakeReceipts('case-a', 'missing'), { scheduledCount: 0, scheduled: [] });
  } finally { inbox.close(); }
});
