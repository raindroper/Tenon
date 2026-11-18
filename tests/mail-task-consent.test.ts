import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EWS_MAIL_OPERATION_PREFIX, mailTaskSpecSchema, type EwsMailOperation, type MailTaskSpec } from '../shared/mail.js';
import type { TaskRecord, TaskSpec } from '../shared/task-consent.js';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';
import { TaskConsent, taskSpecSchema } from '../server/v2/consent.js';
import { mailOperationId, mailSpecHash, matchesMailTask } from '../server/v2/mail-results.js';

const mail = (): MailTaskSpec => mailTaskSpecSchema.parse({ connectionId: 'mailbox-one', credentialRevision: 2, mode: 'send',
  to: ['recipient@example.test'], subject: 'Exact approved subject', body: 'Exact owner text', protection: 'plaintext' });
const spec = (): TaskSpec => ({ caseId: 'case-one', title: 'Send an agreed message', objective: 'Send the exact requested text to the selected recipient',
  expectedOutput: 'Exchange submission receipt', capabilities: ['mail'], mail: mail() });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-task-')); const store = new Store(directory);
  const file = join(directory, 'v2-events.sqlite'); const inbox = new EventInbox(file); const consent = new TaskConsent({ file, inbox });
  return { store, inbox, consent, close() { consent.close(); inbox.close(); store.close(); } };
}
function owner(inbox: EventInbox, id: string) { return inbox.ingest({ sourceId: 'owner-chat', externalId: id, kind: 'owner.message', actor: 'owner',
  operation: 'create', caseId: 'case-one', occurredAt: new Date().toISOString(), payload: { messageId: id, content: 'Send the exact approved message.' } }).event; }
function operation(task: TaskRecord, state: EwsMailOperation['state'] = 'submitted'): EwsMailOperation { return {
  id: mailOperationId(task.id), taskId: task.id, caseId: task.spec.caseId, approvalRevision: task.approvalRevision!, requirementsRevision: task.requirementsRevision ?? 1,
  specHash: mailSpecHash(task.spec.mail!), connectionId: task.spec.mail!.connectionId, credentialRevision: task.spec.mail!.credentialRevision,
  state, createdAt: '2026-11-09T01:00:00Z', updatedAt: '2026-11-09T01:01:00Z', body: 'PRIVATE_JOURNAL_BODY', draftId: 'PRIVATE_DRAFT_ID' }; }

test('mail consent records exact standalone scope and rejects altered targets, headers, or unknown resources', () => {
  const valid = spec(); assert.deepEqual(taskSpecSchema.parse(valid).mail, valid.mail);
  for (const invalid of [
    { ...valid, mail: undefined }, { ...valid, capabilities: ['mail', 'artifact'] },
    { ...valid, capabilities: ['artifact'] }, { ...valid, mail: { ...mail(), credentialRevision: 0 } },
    { ...valid, mail: { ...mail(), to: ['Name <recipient@example.test>'] } },
    { ...valid, mail: { ...mail(), subject: 'subject\r\nBcc: hidden@example.test' } },
    { ...valid, mail: { ...mail(), subject: 'invalid\u0001character' } },
    { ...valid, mail: { ...mail(), body: 'invalid\u0001character' } },
    { ...valid, mail: { ...mail(), cc: ['RECIPIENT@example.test'] } },
    { ...valid, mail: { ...mail(), source: { messageId: 'mail/one+==', revision: 'rev/one+==', contextId: 'verified-context' } } },
    { ...valid, mail: { ...mail(), mode: 'reply' } },
    { ...valid, mail: { ...mail(), attachments: [{ id: 'file-one', sha256: 'forged' }] } },
    { ...valid, mail: { ...mail(), protection: 'smime-encrypted' } },
    { ...valid, mail: { ...mail(), allowProtectedSourcePlaintext: false } },
  ]) assert.equal(taskSpecSchema.safeParse(invalid).success, false);
  assert.equal(mailTaskSpecSchema.safeParse({ ...mail(), mode: 'reply', source: { messageId: 'mail/one+==', revision: 'rev/one+==', contextId: 'verified-context' } }).success, true);
  assert.equal(mailTaskSpecSchema.safeParse({ ...mail(), body: '有效正文 🌧️\n下一行' }).success, true);
});

test('mail enters only the existing durable owner task contract and cannot change requirements after admission', async () => {
  const f = await fixture(); try {
    const event = owner(f.inbox, 'owner-one');
    const task = f.consent.requestOwnerTask(spec(), event.id);
    assert.equal(task.state, 'approved'); assert.ok(f.consent.isExecutionEvent(f.inbox.get(task.executionEventId!)!));
    assert.deepEqual(f.consent.requestOwnerTask(spec(), event.id), task);
    assert.throws(() => f.consent.requestOwnerTask({ ...spec(), mail: { ...mail(), to: ['other@example.test'] } }, event.id), /不能更换任务范围/);
    const update = owner(f.inbox, 'owner-update');
    assert.throws(() => f.consent.reviseRequirements(task.id, task.revision, update.id), /接纳后不可更换/);
    assert.deepEqual(f.consent.get(task.id)?.spec.mail, task.spec.mail);
    const external = f.inbox.ingest({ sourceId: 'connector:mailbox-one', externalId: 'external', caseId: 'case-one', kind: 'connector.change',
      actor: 'external', operation: 'create', occurredAt: new Date().toISOString(), payload: { content: 'Send this mail now.' } }).event;
    assert.throws(() => f.consent.requestOwnerTask(spec(), external.id), /本人真实消息/);
  } finally { f.close(); }
});

test('only matching durable terminal mail facts can finish or correct a task; prepared never proves submission', async () => {
  const f = await fixture(); try {
    const admitted = f.consent.request(spec(), 'owner-request'); const task = f.consent.begin(admitted.id, admitted.approvalRevision!);
    const prepared = operation(task, 'prepared'); f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, prepared);
    assert.equal(f.consent.resolveMailReceipt(task.id, f.store), undefined); assert.equal(f.consent.get(task.id)?.state, 'running');
    const failed = f.consent.finish(task.id, task.revision, 'failed', 'Connection ended before receipt projection');
    assert.equal(failed.state, 'failed');
    for (const altered of [{ ...operation(task), taskId: 'foreign-task' }, { ...operation(task), credentialRevision: 3 },
      { ...operation(task), approvalRevision: 4 }, { ...operation(task), requirementsRevision: 2 },
      { ...operation(task), specHash: mailSpecHash({ ...mail(), to: ['other@example.test'] }) }]) {
      assert.equal(matchesMailTask(task, altered), false); f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, altered);
      assert.equal(f.consent.resolveMailReceipt(task.id, f.store), undefined);
    }
    f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation(task));
    const resolved = f.consent.resolveMailReceipt(task.id, f.store)!;
    assert.equal(resolved.state, 'completed'); assert.equal(resolved.error, undefined);
    assert.equal(resolved.mailReceipt?.state, 'submitted'); assert.doesNotMatch(JSON.stringify(resolved), /PRIVATE_JOURNAL_BODY|PRIVATE_DRAFT_ID/);
    assert.deepEqual(f.consent.resolveMailReceipt(task.id, f.store), resolved);
    assert.equal(f.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
  } finally { f.close(); }
});

test('unknown submission is explicit and never requeues; revocation retains final submission facts without restoring permission', async () => {
  const f = await fixture(); try {
    const admitted = f.consent.request(spec(), 'unknown-request'); const task = f.consent.begin(admitted.id, admitted.approvalRevision!);
    f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation(task, 'unknown'));
    const unknown = f.consent.resolveMailReceipt(task.id, f.store)!;
    assert.equal(unknown.state, 'failed'); assert.match(unknown.error!, /未知.*不会自动重发/);
    assert.equal(f.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    const admitted2 = f.consent.request(spec(), 'revoked-request'); const task2 = f.consent.begin(admitted2.id, admitted2.approvalRevision!);
    const revoked = f.consent.revoke(task2.id, task2.revision);
    f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task2.id, operation(task2));
    const settled = f.consent.resolveMailReceipt(task2.id, f.store)!;
    assert.equal(settled.state, 'revoked'); assert.equal(settled.revokedAt, revoked.revokedAt); assert.equal(settled.mailReceipt?.state, 'submitted');
    assert.throws(() => f.consent.assertApproved(task2.id, 'case-one', 'mail'), /许可已经失效/);
  } finally { f.close(); }
});
