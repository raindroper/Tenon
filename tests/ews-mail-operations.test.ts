import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';
import { EwsMail, type MailConnection } from '../server/connectors/ews-mail.js';
import { EwsNativeOperationError, type EwsDraftSnapshot, type EwsNativeRequest, type EwsTransport } from '../server/connectors/ews.js';
import type { TaskRecord } from '../shared/task-consent.js';
import { EWS_MAIL_OPERATION_PREFIX, type MailTaskSpec } from '../shared/mail.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
function gate() { let open!: () => void; const promise = new Promise<void>(done => { open = done; }); return { promise, open }; }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-operations-'));
  const store = new Store(directory); const inbox = new EventInbox(':memory:'); const controller = new AbortController();
  let authorized = true; let tamper = false; let encrypted = false; let submitting = gate(); let finish = gate(); let hold = false; let failSubmit = false;
  let receiptState: 'found' | 'pending' | 'ambiguous' = 'pending'; let receiptHold = false;
  const receiptEntered = gate(), receiptFinish = gate();
  const requests: EwsNativeRequest[] = []; let draft: EwsDraftSnapshot;
  const connection: MailConnection = { id: 'mail-one', caseId: 'case-one', folderId: 'inbox-one', revision: 2,
    token: { accessToken: '', ews: { endpoint: 'https://mail.example.test/EWS/Exchange.asmx', username: 'OFFLINE_USER', password: 'OFFLINE_PASSWORD', revision: 2 } } };
  const transport: EwsTransport = async (request, signal) => {
    requests.push(request);
    if (request.operation === 'message-info') return { messageId: 'message-one', revision: 'revision-one', subject: 'Original',
      from: 'sender@example.test', to: ['owner@example.test'], cc: [], bcc: [], replyTo: [], selfAddress: 'owner@example.test', internetMessageId: '<fixture@example.test>',
      encryption: encrypted ? 'smime-decrypted' : 'none', bodyStatus: 'read', body: 'Original text', totalCharacters: 13, truncated: false };
    if (request.operation === 'list-attachments') return { messageId: 'message-one', revision: 'revision-one', sourceProtected: encrypted,
      attachments: [{ reference: 'OPAQUE_BOUND_REFERENCE', name: 'original.txt', contentType: 'text/plain', size: 5, isInline: false,
        sourceProtected: encrypted, kind: 'file', supported: true, unsupportedReason: null }] };
    if (request.operation === 'read-attachment') return { name: 'original.txt', contentType: 'text/plain', size: 5, sha256: hash('hello'),
      base64: Buffer.from('hello').toString('base64'), isInline: false, sourceProtected: encrypted };
    if (request.operation === 'prepare-message') {
      assert.equal(store.getMeta<{ phase: string }>(EWS_MAIL_OPERATION_PREFIX + 'task-one', { phase: '' }).phase, 'draft_creating');
      draft = { operationId: request.prepare!.operationId, draftId: 'draft-one', revision: 'draft-revision-one',
        to: request.prepare!.to, cc: request.prepare!.cc, bcc: request.prepare!.bcc, subject: request.prepare!.subject,
        body: request.prepare!.body, attachments: [], snapshotHash: hash('draft-one') };
      return structuredClone(draft);
    }
    if (request.operation === 'attach-file') {
      assert.equal(hash(await readFile(request.attach!.file.path)), request.attach!.file.sha256);
      draft.attachments.push({ id: 'native-file-' + draft.attachments.length, name: request.attach!.file.name,
        contentType: request.attach!.file.contentType, size: request.attach!.file.size, sha256: request.attach!.file.sha256 });
      draft.revision += '-attached'; return structuredClone(draft);
    }
    if (request.operation === 'inspect-draft') return { ...structuredClone(draft), ...(tamper ? { body: 'unapproved hidden quote' } : {}) };
    if (request.operation === 'submit-draft') {
      assert.equal(store.getMeta<{ phase: string }>(EWS_MAIL_OPERATION_PREFIX + 'task-one', { phase: '' }).phase, 'sending');
      submitting.open(); if (hold) await finish.promise;
      if (failSubmit) throw new EwsNativeOperationError('fixture lost receipt', 409, true, true);
      return { state: 'submitted', operationId: request.submit!.operationId, draftId: request.submit!.draftId, revision: request.submit!.revision };
    }
    if (request.operation === 'submission-receipt') {
      receiptEntered.open(); if (receiptHold) await receiptFinish.promise;
      return { state: receiptState, operationId: request.submission!.operationId,
        ...(receiptState === 'found' ? { internetMessageId: '<delayed-sent@example.test>', sentMessageId: 'verified-sent-copy' } : {}) };
    }
    signal.throwIfAborted(); throw new Error('Unexpected fixture request');
  };
  const options = { store, inbox, directory, transport,
    select: (id: string, caseId?: string) => { if (!authorized || id !== connection.id || caseId && caseId !== connection.caseId) throw new Error('scope revoked'); return connection; },
    assertSelection: (id: string, input: { messageId: string; queryId: string }) => { assert.equal(id, connection.id); assert.equal(input.queryId, 'query-one'); assert.equal(input.messageId, 'message-one'); },
    assertOwner: () => undefined, allowedEvidence: () => authorized,
    run: async <T>(_selection: MailConnection, work: (signal: AbortSignal) => Promise<T>) => work(controller.signal), changed: () => undefined, tasks: () => [] };
  const service = new EwsMail(options);
  const mail = (override: Partial<MailTaskSpec> = {}): MailTaskSpec => ({ connectionId: connection.id, credentialRevision: 2, mode: 'send',
    to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Approved subject', body: 'Exact owner text', attachments: [], protection: 'plaintext', ...override });
  const task = (spec = mail()): TaskRecord => ({ id: 'task-one', revision: 2, approvalRevision: 1, requirementsRevision: 1, state: 'running',
    spec: { caseId: 'case-one', title: 'Send one mail', objective: 'Send exact approved text', expectedOutput: 'Exchange receipt', capabilities: ['mail'], mail: spec }, createdAt: now(), updatedAt: now() });
  return { directory, store, inbox, controller, requests, service, mail, task, options,
    guard: () => { if (!authorized) throw new Error('scope revoked'); }, revoke: () => { authorized = false; }, tamper: () => { tamper = true; }, encrypt: () => { encrypted = true; },
    holdSubmit: () => { hold = true; failSubmit = true; return { entered: submitting.promise, release: finish.open }; },
    receipt: (value: typeof receiptState) => { receiptState = value; },
    holdReceipt: () => { receiptHold = true; return { entered: receiptEntered.promise, release: receiptFinish.open }; },
    close: () => { inbox.close(); store.close(); } };
}
const selection = { readExistingInbox: true as const, queryId: 'query-one', messageId: 'message-one' };

test('approved mail freezes payload, checks actual remote content and attachments, and records submission before returning', async () => {
  const f = await fixture();
  try {
    const file = f.service.upload('mail-one', { name: 'report.txt', contentType: 'text/plain', bytes: Buffer.from('attachment fixture') });
    const task = f.task(f.mail({ attachments: [{ id: file.id, sha256: file.sha256 }] }));
    const result = await f.service.execute(task, { signal: f.controller.signal, guard: f.guard });
    assert.equal(result.state, 'submitted'); assert.equal(result.body, 'Exact owner text'); assert.equal(result.attachmentCount, 1);
    assert.deepEqual(f.requests.map(request => request.operation), ['prepare-message', 'attach-file', 'inspect-draft', 'submit-draft']);
    await f.service.execute(task, { signal: f.controller.signal, guard: () => { throw new Error('revoked after factual receipt'); } });
    assert.equal(f.requests.filter(request => request.operation === 'submit-draft').length, 1);
    f.service.removeUpload('mail-one', file.id);
  } finally { f.close(); }
});

test('confirmed mail gains its delayed thread receipt once without changing the send fact or resending across restart', async t => {
  const f = await fixture(); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const task = { ...f.task(), dependencyId: 'waiting-rules' };
    const sent = await f.service.execute(task, { signal: f.controller.signal, guard: f.guard });
    assert.equal(sent.state, 'submitted'); assert.equal(sent.replyTracking, false);
    assert.equal(f.service.needsSubmissionReceipt(task), false);
    clock += 5001; f.receipt('found');
    const restored = new EwsMail(f.options);
    const [first, duplicate] = await Promise.all([1, 2].map(() => restored.reconcileSubmissionReceipt(task, { signal: f.controller.signal, guard: f.guard })));
    assert.equal(first.id, sent.id); assert.equal(first.submittedAt, sent.submittedAt); assert.equal(first.phase, 'submitted');
    assert.equal(first.internetMessageId, '<delayed-sent@example.test>'); assert.equal(first.sentMessageId, 'verified-sent-copy');
    assert.equal(first.replyTracking, true); assert.deepEqual(first, duplicate);
    assert.equal(f.requests.filter(request => request.operation === 'submission-receipt').length, 1);
    assert.equal(f.requests.filter(request => request.operation === 'submit-draft').length, 1);
    assert.equal(new EwsMail(f.options).needsSubmissionReceipt(task), false);
    assert.equal(f.inbox.list().filter(event => event.kind === 'connector.task_access' && event.actor === 'agent').length, 1);
    assert.equal(f.inbox.list().filter(event => event.kind === 'connector.mail_submission_receipt' && event.actor === 'external').length, 1);
  } finally { f.close(); }
});

test('receipt lookup budget and backoff survive restart and never turn an unavailable index into a resend', async t => {
  const f = await fixture(); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const task = { ...f.task(), dependencyId: 'waiting-rules' };
    const sent = await f.service.execute(task, { signal: f.controller.signal, guard: f.guard });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stored = f.service.operationForTask(task.id)!; clock = Date.parse(stored.receiptLookup!.nextAt!) + 1;
      const restored = new EwsMail(f.options);
      assert.equal(restored.needsSubmissionReceipt(task), true);
      const value = await restored.reconcileSubmissionReceipt(task, { signal: f.controller.signal, guard: f.guard });
      assert.equal(value.state, 'submitted'); assert.equal(value.submittedAt, sent.submittedAt);
      assert.equal(value.receiptLookup?.attempts, attempt); assert.equal(value.replyTracking, false);
    }
    clock += 86400_000;
    assert.equal(new EwsMail(f.options).needsSubmissionReceipt(task), false);
    assert.equal(f.service.operationForTask(task.id)?.receiptLookup?.state, 'unavailable');
    assert.equal(f.requests.filter(request => request.operation === 'submission-receipt').length, 3);
    assert.equal(f.requests.filter(request => request.operation === 'submit-draft').length, 1);
  } finally { f.close(); }
});

test('revocation drains an accepted receipt read and cannot downgrade or re-send the original submission', async t => {
  const f = await fixture(); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  try {
    const task = { ...f.task(), dependencyId: 'waiting-rules' };
    await f.service.execute(task, { signal: f.controller.signal, guard: f.guard }); clock += 5001;
    const hold = f.holdReceipt(); f.receipt('found'); let settled = false;
    const read = f.service.reconcileSubmissionReceipt(task, { signal: f.controller.signal, guard: f.guard }).finally(() => { settled = true; });
    await hold.entered; f.revoke(); f.controller.abort(); await Promise.resolve(); assert.equal(settled, false);
    hold.release(); await assert.rejects(read, /scope revoked/);
    const stored = f.service.operationForTask(task.id)!;
    assert.equal(stored.state, 'submitted'); assert.equal(stored.internetMessageId, undefined);
    assert.equal(f.requests.filter(request => request.operation === 'submit-draft').length, 1);
  } finally { f.close(); }
});
test('lost submission drains native work and persists unknown across restart without another send', async () => {
  const f = await fixture();
  try {
    const hold = f.holdSubmit(); let settled = false;
    const operation = f.service.execute(f.task(), { signal: f.controller.signal, guard: f.guard }).finally(() => { settled = true; });
    await hold.entered; f.controller.abort(); f.revoke(); await Promise.resolve();
    assert.equal(settled, false); hold.release(); assert.equal((await operation).state, 'unknown');
    const restored = new EwsMail(f.options);
    assert.equal((await restored.execute(f.task(), { signal: f.controller.signal, guard: f.guard })).state, 'unknown');
    assert.equal(f.requests.filter(request => request.operation === 'submit-draft').length, 1);
  } finally { f.close(); }
});
test('remote draft mismatch blocks submit and retained journal cannot be repurposed with a new recipient', async () => {
  const f = await fixture();
  try {
    f.tamper(); assert.equal((await f.service.execute(f.task(), { signal: f.controller.signal, guard: f.guard })).state, 'failed');
    assert.equal(f.requests.some(request => request.operation === 'submit-draft'), false);
    await assert.rejects(f.service.execute(f.task(f.mail({ to: ['other@example.test'] })), { signal: f.controller.signal, guard: f.guard }), /许可不一致/);
    const stored = f.service.operationForTask('task-one')!;
    f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + 'task-one', { ...stored, id: 'foreign-operation', state: 'prepared', phase: 'prepared' });
    const before = f.requests.length;
    await assert.rejects(new EwsMail(f.options).execute(f.task(), { signal: f.controller.signal, guard: f.guard }), /许可不一致/);
    assert.equal(f.requests.length, before, 'full journal identity is checked before any native mutation');
  } finally { f.close(); }
});
test('protected source and selected inner attachment require explicit plaintext consent and bound message handles', async () => {
  const f = await fixture();
  try {
    f.encrypt(); const [context, page] = await Promise.all([f.service.context('mail-one', selection), f.service.attachments('mail-one', selection)]);
    assert.equal(f.requests.filter(request => request.operation === 'message-info').length, 1, 'parallel compose metadata shares one body fetch/decryption');
    assert.ok(context.evidenceId); assert.equal(f.inbox.get(context.evidenceId!)?.kind, 'connector.mail_context');
    const spec = f.mail({ mode: 'forward', source: context.source });
    assert.throws(() => f.service.prepareScope('case-one', spec), /明文/);
    assert.deepEqual(f.service.prepareScope('case-one', { ...spec, allowProtectedSourcePlaintext: true }).source, context.source);
    assert.equal(page.attachments[0].sourceProtected, true); assert.equal('reference' in page.attachments[0], false);
    await assert.rejects(f.service.uploadFromMessage('mail-one', { ...selection, attachmentId: page.attachments[0].id }), /明文/);
    const uploaded = await f.service.uploadFromMessage('mail-one', { ...selection, attachmentId: page.attachments[0].id, allowProtectedSourcePlaintext: true });
    assert.throws(() => f.service.prepareScope('case-one', f.mail({ attachments: [{ id: uploaded.id, sha256: uploaded.sha256 }] })), /受保护/);
    await assert.rejects(f.service.download('mail-one', { ...selection, messageId: 'another-mail', attachmentId: page.attachments[0].id }));
    f.revoke(); assert.throws(() => f.service.validateTask(f.task({ ...spec, allowProtectedSourcePlaintext: true })));
  } finally { f.close(); }
});
