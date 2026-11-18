import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createApp } from '../server/index.js';
import type { EwsNativeRequest, EwsTransport } from '../server/connectors/ews.js';
import type { EwsAttachmentPage, EwsMessageContext, EwsMailUpload } from '../shared/ews.js';
import type { TaskRecord } from '../shared/task-consent.js';
import { EWS_MAIL_OPERATION_PREFIX } from '../shared/mail.js';
import { mailSpecHash, mailOperationId } from '../server/v2/mail-results.js';

test('owner HTTP files use bounded multipart and selected download handles; sending is admitted only as a task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-http-')); const store = new Store(directory); const calls: EwsNativeRequest[] = [];
  const sha = createHash('sha256').update('download fixture').digest('hex');
  const transport: EwsTransport = async request => {
    calls.push(request);
    if (request.operation === 'baseline') return { id: 'inbox-one', displayName: 'Inbox', totalCount: 1, unreadCount: 1 };
    if (request.operation === 'query') return { messages: [{ id: 'message-one', revision: 'revision-one', subject: 'Fixture',
      receivedAt: '2026-11-01T01:00:00Z', sender: 'sender@example.test', encryptionHint: 'none', isRead: false }], totalItems: 1, nextOffset: null };
    if (request.operation === 'message-info') return { messageId: 'message-one', revision: 'revision-one', subject: 'Fixture',
      from: 'sender@example.test', to: ['owner@example.test'], cc: [], bcc: [], replyTo: [], selfAddress: 'owner@example.test', internetMessageId: '<fixture@example.test>',
      encryption: 'none', bodyStatus: 'read', body: 'Fixture original text', totalCharacters: 21, truncated: false };
    if (request.operation === 'list-attachments') return { messageId: 'message-one', revision: 'revision-one', sourceProtected: false,
      attachments: [{ reference: 'native-reference', name: '附件.txt', contentType: 'text/plain', size: 16, isInline: false, kind: 'file', supported: true, sourceProtected: false, unsupportedReason: null },
        { reference: 'attached-item', name: 'attached-message', contentType: 'message/rfc822', size: 100, isInline: false, kind: 'item', supported: false, sourceProtected: false, unsupportedReason: 'item_attachment' }] };
    if (request.operation === 'read-attachment') return { name: '附件.txt', contentType: 'text/plain', size: 16, sha256: sha,
      base64: Buffer.from('download fixture').toString('base64'), isInline: false, sourceProtected: false };
    throw new Error('HTTP owner form must not directly call a mailbox write');
  };
  const runtime = await V2Coordinator.create(store, { dataDir: directory, ewsTransport: transport });
  const server = createApp({ store, runtime }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const connection = await runtime.connectorSettings.connectEws({ caseId: 'personal-growth', scope: 'inbox',
      endpoint: 'https://mail.example.test/EWS/Exchange.asmx', username: 'OFFLINE_USER', password: 'OFFLINE_SECRET', observeNewMailAndAnalyze: true, persistCredentials: true });
    const base = '/api/connectors/ews/' + connection.id;
    const page = await (await post(base + '/messages', { readExistingInbox: true })).json();
    const selected = { readExistingInbox: true, queryId: page.queryId, messageId: 'message-one' };
    assert.equal((await post(base + '/message-context', { ...selected, queryId: 'forged' })).status, 409);
    const contextResponse = await post(base + '/message-context', selected); assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json() as EwsMessageContext; assert.ok(context.source.contextId && context.evidenceId);
    const listed = await (await post(base + '/attachments', selected)).json() as EwsAttachmentPage;
    assert.equal(listed.attachments.length, 2); assert.equal(listed.attachments[1].supported, false);
    assert.equal(JSON.stringify(listed).includes('native-reference'), false);
    const download = await post(base + '/attachment', { ...selected, attachmentId: listed.attachments[0].id });
    assert.equal(download.status, 200); assert.equal(await download.text(), 'download fixture');
    assert.match(download.headers.get('content-disposition')!, /attachment;.*filename\*=UTF-8''/);
    assert.equal((await post(base + '/attachment', { ...selected, attachmentId: listed.attachments[1].id })).status, 409);
    assert.equal((await post(base + '/mail-uploads', { file: 'wrong-protocol' })).status, 415);
    const form = new FormData(); form.append('file', new File(['local file bytes'], '本机附件.txt', { type: 'text/plain' }));
    const uploadResponse = await fetch(origin + base + '/mail-uploads', { method: 'POST', body: form }); assert.equal(uploadResponse.status, 201);
    const upload = await uploadResponse.json() as EwsMailUpload; assert.equal(upload.size, 16); assert.equal('path' in upload, false);
    const copied = await post(base + '/mail-uploads/from-message', { ...selected, attachmentId: listed.attachments[0].id }); assert.equal(copied.status, 201);
    const extra = new FormData(); extra.append('file', new File(['x'], 'x.txt')); extra.append('unexpected', 'field');
    assert.equal((await fetch(origin + base + '/mail-uploads', { method: 'POST', body: extra })).status, 400);
    const request = { requestId: randomUUID(), spec: { caseId: 'personal-growth', title: 'Reply fixture', objective: 'Reply exactly once', expectedOutput: 'Actual receipt', capabilities: ['mail'],
      mail: { connectionId: connection.id, credentialRevision: 1, mode: 'reply', source: context.source, to: ['sender@example.test'], cc: [], bcc: [],
        subject: 'Reply Fixture', body: 'Owner authored reply', attachments: [{ id: upload.id, sha256: upload.sha256 }], protection: 'plaintext' } } };
    const admitted = await post('/api/tasks', request); assert.equal(admitted.status, 201); const task = await admitted.json() as TaskRecord;
    assert.equal((await fetch(origin + base + '/mail-uploads/' + upload.id, { method: 'DELETE' })).status, 409, 'queued consent already retains upload before native dispatch');
    assert.equal((await (await post('/api/tasks', request)).json()).id, task.id);
    const contextKey = 'connectors.ews.mail-context.' + context.source.contextId;
    const retained = store.getMeta<Record<string, unknown>>(contextKey, {});
    store.setMeta(contextKey, { ...retained, createdAt: '2000-01-01T00:00:00Z' });
    assert.equal((await (await post('/api/tasks', request)).json()).id, task.id, 'lost admission response reads the original task even after source-handle expiry');
    assert.deepEqual(await (await fetch(origin + '/api/tasks/' + task.id + '/mail-operation')).json(), { operation: null });
    assert.equal((await post(base + '/send', request.spec.mail)).status, 404);
    assert.ok(!calls.some(call => ['prepare-message', 'attach-file', 'inspect-draft', 'submit-draft'].includes(call.operation)));
    // Trusted synthetic transport truth is projected without body, paths, credentials or draft identifiers.
    store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, { id: mailOperationId(task.id), taskId: task.id, caseId: task.spec.caseId,
      approvalRevision: task.approvalRevision, requirementsRevision: 1, specHash: mailSpecHash(task.spec.mail!), connectionId: connection.id, credentialRevision: 1,
      state: 'unknown', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), body: 'PRIVATE_JOURNAL_BODY', draftId: 'PRIVATE_DRAFT_ID', error: 'Unknown fixture' });
    const receipt = await (await fetch(origin + '/api/tasks/' + task.id + '/mail-operation')).json();
    assert.equal(receipt.operation.state, 'unknown'); assert.equal(JSON.stringify(receipt).includes('PRIVATE_'), false);
    assert.equal(store.getSettings().enabled, false, 'mail setup never enables inference');
  } finally { await new Promise<void>(done => server.close(() => done())); await runtime.close(); store.close(); }
});
