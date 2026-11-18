import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MailTaskResult } from '../client/components/MailTaskResult.js';
import { downloadMailAttachment, mailAddresses, mailSubject, quotedMail, sourceIsProtected, uniqueMailAddresses, uploadMailAttachment } from '../client/lib/ews-mail.js';
import { apiResponse, ApiError, markSessionBoundary, onSessionExpired } from '../client/api.js';
import type { TaskRecord } from '../shared/task-consent.js';
import type { EwsAttachmentSummary, EwsMessageContext } from '../shared/ews.js';

const attachment: EwsAttachmentSummary = { id: 'attachment', name: 'fixture.txt', contentType: 'text/plain', size: 7,
  isInline: false, sourceProtected: false, supported: true };

test('mail attachment requests expire the current session through the same boundary as JSON requests', async t => {
  let expired = 0;
  const unsubscribe = onSessionExpired(() => { expired++; });
  t.after(unsubscribe);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":"Session expired"}', { status: 401 }));
  const signal = new AbortController().signal;
  await assert.rejects(uploadMailAttachment('mailbox', new File(['fixture'], attachment.name), signal),
    (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === 'Session expired');
  assert.equal(expired, 1);
  await assert.rejects(downloadMailAttachment('mailbox', { queryId: 'query', messageId: 'message' }, attachment, signal), ApiError);
  assert.equal(expired, 2);
});

test('a late attachment rejection cannot expire a replacement login', async t => {
  let rejectUpload!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { rejectUpload = resolve; });
  let expired = 0;
  const unsubscribe = onSessionExpired(() => { expired++; });
  t.after(unsubscribe);
  t.mock.method(globalThis, 'fetch', () => response);
  const pending = uploadMailAttachment('mailbox', new File(['fixture'], attachment.name), new AbortController().signal);
  markSessionBoundary();
  rejectUpload(new Response('{"error":"Old session"}', { status: 401 }));
  await assert.rejects(pending, ApiError);
  assert.equal(expired, 0);
});

test('the shared transport preserves multipart requests and leaves successful binary bodies unread', async t => {
  const upload = { id: 'upload', name: attachment.name, contentType: 'text/plain', size: 7, sha256: 'fixture-digest' };
  const file = new File(['fixture'], attachment.name, { type: 'text/plain' });
  const signal = new AbortController().signal;
  const binary = new Uint8Array([0, 255, 128, 1]);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (path: unknown, init?: RequestInit) => {
    requests++;
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.signal, signal);
    if (requests === 1) {
      assert.equal(path, '/api/connectors/ews/mail%2Fbox/mail-uploads');
      assert.equal(init?.method, 'POST'); assert.equal(init?.headers, undefined);
      assert.ok(init?.body instanceof FormData);
      const sent = init.body.get('file'); assert.ok(sent instanceof File);
      assert.equal(sent.name, file.name); assert.equal(await sent.text(), 'fixture');
      return Response.json(upload);
    }
    return new Response(binary, { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  assert.deepEqual(await uploadMailAttachment('mail/box', file, signal), upload);
  const downloaded = await apiResponse('/api/connectors/ews/mailbox/attachment', { signal });
  assert.equal(downloaded.bodyUsed, false);
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), binary);
});

test('address entry preserves exact addresses and reply-all excludes self and duplicate recipients', () => {
  assert.deepEqual(mailAddresses(' primary@example.test; cc@example.test,\nthird@example.test '),
    ['primary@example.test', 'cc@example.test', 'third@example.test']);
  assert.deepEqual(uniqueMailAddresses(['owner@example.test', 'Sender@example.test', 'sender@example.test', ' another@example.test '], ['OWNER@example.test']),
    ['Sender@example.test', 'another@example.test']);
  assert.deepEqual(uniqueMailAddresses(['self@example.test']), ['self@example.test']);
  assert.equal(mailSubject('replyAll', 'Re: Original'), 'Re: Original');
  assert.equal(mailSubject('forward', '原主题'), '转发: 原主题');
});

const timestamp = '2026-11-09T01:00:00.000Z';
function task(state: NonNullable<TaskRecord['mailReceipt']>['state']): TaskRecord {
  return { id: 'fixture-task', revision: 2, state: 'completed', approvalRevision: 1, requirementsRevision: 1,
    spec: { caseId: 'fixture-scene', title: '发送合成邮件', objective: 'Send one exact fixture mail', expectedOutput: 'Submission receipt', capabilities: ['mail'],
      mail: { connectionId: 'fixture-mailbox', credentialRevision: 1, mode: 'send', to: ['to@example.test'], cc: ['cc@example.test'], bcc: ['bcc@example.test'],
        subject: 'Fixture subject', body: '<script>plaintext-only</script>', protection: 'plaintext', attachments: [] } },
    createdAt: timestamp, updatedAt: timestamp, mailReceipt: { operationId: 'fixture-operation', state, updatedAt: timestamp } };
}

test('a prepared or unknown result cannot render as accepted delivery; exact body is escaped', () => {
  const render = (state: NonNullable<TaskRecord['mailReceipt']>['state']) => renderToStaticMarkup(createElement(MailTaskResult, { task: task(state), timezone: 'Asia/Shanghai' }));
  const prepared = render('prepared'); const unknown = render('unknown'); const submitted = render('submitted');
  assert.match(prepared, /草稿已准备，尚未提交发送/); assert.doesNotMatch(prepared, /Exchange 已接受发送/);
  assert.match(unknown, /发送结果待核对/); assert.match(unknown, /不会自动重发/); assert.doesNotMatch(unknown, /Exchange 已接受发送/);
  assert.match(submitted, /Exchange 已接受发送/); assert.match(submitted, /不代表所有收件人已实际送达或阅读/);
  for (const html of [prepared, unknown, submitted]) {
    assert.match(html, /to@example.test/); assert.match(html, /cc@example.test/); assert.match(html, /bcc@example.test/);
    assert.match(html, /&lt;script&gt;plaintext-only&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  }
});

test('protected-source classification remains conservative and quoting uses only verified returned body', () => {
  assert.equal(sourceIsProtected('none'), false); assert.equal(sourceIsProtected('smime-signed-unverified'), false);
  assert.equal(sourceIsProtected('smime'), true); assert.equal(sourceIsProtected('smime-decrypted'), true);
  assert.equal(sourceIsProtected('future-protected-format'), true);
  const context: EwsMessageContext = { source: { messageId: 'fixture-source', revision: 'fixture-version', contextId: 'fixture-context' },
    credentialRevision: 1, subject: '原信', from: 'sender@example.test', to: ['owner@example.test'], cc: [], encryption: 'smime-decrypted',
    bodyStatus: 'read', body: 'VERIFIED_BODY', totalCharacters: 13, truncated: false };
  const quote = quotedMail(context); assert.match(quote, /VERIFIED_BODY/); assert.match(quote, /sender@example.test/);
  assert.doesNotMatch(quote, /fixture-context|fixture-version/);
});
