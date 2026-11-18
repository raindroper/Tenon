import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectedMailTools } from '../server/v2/connected-mail.js';

type Access = Parameters<typeof createConnectedMailTools>[0];
type Factory = NonNullable<ReturnType<typeof createConnectedMailTools>>;
type ToolName = keyof Factory['tools'];
type Executable = { inputSchema: { parse(value: unknown): unknown }; execute(input: unknown, context: unknown): Promise<unknown> };
const mailbox = (connectionId: string, endpoint = 'https://mail.example.test/EWS/Exchange.asmx') => ({ connectionId, scope: 'inbox' as const, endpoint, credentialRevision: 1 });
const summary = (id: string) => ({ id, revision: 'revision-1', subject: 'Fixture subject', receivedAt: '2026-11-09T08:00:00Z',
  sender: 'Fixture sender', encryptionHint: 'none' as const, isRead: false });
const body = 'Fixture body for bounded routing. '.repeat(200);
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }

function fixture(initial = [mailbox('mailbox-one')], ids = ['mail/one+==', 'mail/two+==']) {
  let available = initial;
  let queryWait: Promise<void> | undefined; let bodyWait: Promise<void> | undefined;
  const queries: Array<Parameters<Access['queryEwsMessagesForEvent']>> = [];
  const reads: Array<Parameters<Access['readEwsMessageForEvent']>> = [];
  const contexts: unknown[] = [];
  const access: Access = {
    listEwsMailboxes: () => available,
    queryEwsMessagesForEvent: async (...args) => {
      queries.push(args); const index = queries.length;
      if (queryWait) await queryWait;
      const input = args[2];
      return { queryId: 'query-' + index, messages: ids.map(summary), nextOffset: (input.offset ?? 0) + ids.length, totalItems: 100 };
    },
    readEwsMessageForEvent: async (...args) => {
      reads.push(args);
      if (bodyWait) await bodyWait;
      const input = args[2]; const offset = input.offset ?? 0; const limit = input.limit ?? 4000;
      const end = Math.min(offset + limit, body.length);
      return { connectionId: input.connectionId, messageId: input.messageId, subject: 'Fixture subject', receivedAt: '2026-11-09T08:00:00Z',
        sender: 'Fixture sender', encryption: 'none', bodyStatus: 'read', content: body.slice(offset, end), totalCharacters: body.length,
        nextOffset: end < body.length ? end : null, truncated: false };
    },
    getEwsMessageContextForOwner: async (...args) => {
      contexts.push(args); if (bodyWait) await bodyWait;
      return { source: { messageId: args[2].messageId, revision: 'rev/one+==', contextId: 'verified-context-one' },
        credentialRevision: 1, subject: 'Fixture subject', from: 'sender@example.test', to: ['owner@example.test'], cc: [],
        selfAddress: 'owner@example.test', encryption: 'smime-encrypted', bodyStatus: 'decrypted', body,
        totalCharacters: body.length, truncated: false };
    },
  };
  const controller = new AbortController(); let guards = 0;
  const tools = createConnectedMailTools(access, 'case-one', 'owner-event-one', controller.signal, () => { guards++; })!;
  return { access, tools, controller, queries, reads, contexts, guards: () => guards,
    setAvailable: (value: typeof available) => { available = value; },
    waitQuery: (value: Promise<void>) => { queryWait = value; }, waitBody: (value: Promise<void>) => { bodyWait = value; } };
}
async function call<T = Record<string, unknown>>(factory: Factory, name: ToolName, input: unknown): Promise<T> {
  const tool = factory.tools[name] as unknown as Executable;
  return await tool.execute(tool.inputSchema.parse(input), {}) as T;
}

test('mail tools route current-owner list, subject search and body paging through one connected mailbox', async () => {
  const f = fixture();
  const listed = await call<{ queryId: string; connectionId: string; messages: Array<{ id: string }> }>(f.tools, 'list_mailbox_messages', { subject: '  Weekly progress  ', offset: 10 });
  assert.equal(listed.connectionId, 'mailbox-one');
  assert.deepEqual(f.queries[0].slice(0, 3), ['case-one', 'owner-event-one', { connectionId: 'mailbox-one', subject: 'Weekly progress', offset: 10, limit: 10 }]);
  assert.equal(f.queries[0][3], f.controller.signal);
  const first = await call<{ content: string; nextOffset: number }>(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: listed.messages[0].id });
  assert.equal(first.content, body.slice(0, 4000)); assert.equal(first.nextOffset, 4000);
  const second = await call<{ content: string }>(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: listed.messages[0].id, offset: first.nextOffset });
  assert.equal(second.content, body.slice(4000, 8000)); assert.equal(f.reads[0][1], 'owner-event-one');
  assert.ok(f.guards() >= 6);
});

test('reply context is read-only, bounded, source-bound to this turn and invalidated by credential rotation', async () => {
  const f = fixture();
  await assert.rejects(call(f.tools, 'get_mail_message_context', { queryId: 'forged', messageId: 'mail/one+==' }), /本轮返回/);
  const listed = await call<{ queryId: string }>(f.tools, 'list_mailbox_messages', {});
  const args = { queryId: listed.queryId, messageId: 'mail/one+==' };
  const context = await call<{ source: { contextId: string }; body: string; truncated: boolean; credentialRevision: number; untrustedExternalContent: boolean }>(f.tools, 'get_mail_message_context', args);
  assert.equal(context.source.contextId, 'verified-context-one'); assert.equal(context.body.length, 4000);
  assert.equal(context.truncated, true); assert.equal(context.credentialRevision, 1); assert.equal(context.untrustedExternalContent, true);
  assert.deepEqual((f.contexts[0] as unknown[]).slice(0, 3), ['case-one', 'owner-event-one', { connectionId: 'mailbox-one', ...args }]);
  await call(f.tools, 'get_mail_message_context', args); assert.equal(f.contexts.length, 1);
  f.setAvailable([{ ...mailbox('mailbox-one'), credentialRevision: 2 }]);
  await assert.rejects(call(f.tools, 'get_mail_message_context', args), /停用或范围已变化/);
  assert.equal(f.contexts.length, 1);
});

test('multiple mailboxes require a real connection choice and a read is limited to its own exposed query results', async () => {
  const f = fixture([mailbox('first'), mailbox('second', 'https://other.example.test/EWS/Exchange.asmx')]);
  const selection = await call<{ selectionRequired: boolean; mailboxes: unknown[] }>(f.tools, 'list_mailbox_messages', {});
  assert.equal(selection.selectionRequired, true); assert.equal(selection.mailboxes.length, 2); assert.equal(f.queries.length, 0);
  const unknown = await call<{ selectionRequired: boolean }>(f.tools, 'list_mailbox_messages', { connectionId: 'guessed' });
  assert.equal(unknown.selectionRequired, true); assert.equal(f.queries.length, 0);
  const listed = await call<{ queryId: string }>(f.tools, 'list_mailbox_messages', { connectionId: 'second' });
  await assert.rejects(call(f.tools, 'read_mailbox_message', { connectionId: 'first', queryId: listed.queryId, messageId: 'mail/one+==' }), /本轮返回/);
  await assert.rejects(call(f.tools, 'read_mailbox_message', { queryId: 'forged-query', messageId: 'mail/one+==' }), /本轮返回/);
  await assert.rejects(call(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: 'unlisted-mail' }), /本轮返回/);
  assert.equal(f.reads.length, 0);
  const nextTurn = createConnectedMailTools(f.access, 'case-one', 'owner-event-two', f.controller.signal, () => {})!;
  await assert.rejects(call(nextTurn, 'read_mailbox_message', { queryId: listed.queryId, messageId: 'mail/one+==' }), /本轮返回/);
  await call(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: 'mail/one+==' });
  assert.equal(f.reads[0][2].connectionId, 'second');
});

test('identical requests share the same read while tool budgets bound repeated calls', async () => {
  const f = fixture();
  const listed = await call<{ queryId: string }>(f.tools, 'list_mailbox_messages', {});
  assert.deepEqual(await call(f.tools, 'list_mailbox_messages', {}), listed); assert.equal(f.queries.length, 1);
  const args = { queryId: listed.queryId, messageId: 'mail/one+==' };
  await call(f.tools, 'read_mailbox_message', args); await call(f.tools, 'read_mailbox_message', args);
  assert.equal(f.reads.length, 1);
  for (let i = 0; i < 4; i++) await call(f.tools, 'list_mailbox_messages', { offset: i + 1 });
  await assert.rejects(call(f.tools, 'list_mailbox_messages', { offset: 99 }), /列表分页已达上限/);
  for (let i = 2; i < 8; i++) await call(f.tools, 'read_mailbox_message', { ...args, offset: i * 100, limit: 100 });
  await assert.rejects(call(f.tools, 'read_mailbox_message', { ...args, offset: 999 }), /正文分页已达上限/);
});

test('one owner turn can read only three distinct mails and schemas bound list and body output', async () => {
  const f = fixture([mailbox('mailbox-one')], ['one', 'two', 'three', 'four']);
  const listed = await call<{ queryId: string }>(f.tools, 'list_mailbox_messages', {});
  for (const id of ['one', 'two', 'three']) await call(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: id });
  await assert.rejects(call(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: 'four' }), /最多读取三封/);
  assert.equal(f.reads.length, 3);
  await assert.rejects(call(f.tools, 'list_mailbox_messages', { limit: 26 }));
  await assert.rejects(call(f.tools, 'list_mailbox_messages', { offset: 10001 }));
  await assert.rejects(call(f.tools, 'list_mailbox_messages', { subject: 'x'.repeat(241) }));
  await assert.rejects(call(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: 'one', limit: 4001 }));
});

test('disconnect or changed resource scope discards a late query result and prevents exposing IDs', async () => {
  for (const changedScope of [false, true]) {
    const f = fixture(); const pending = gate(); f.waitQuery(pending.promise);
    const work = call(f.tools, 'list_mailbox_messages', {}); const rejected = assert.rejects(work, /已停用或范围已变化/);
    await Promise.resolve();
    f.setAvailable(changedScope ? [mailbox('mailbox-one', 'https://changed.example.test/EWS/Exchange.asmx')] : []);
    pending.release(); await rejected;
    await assert.rejects(call(f.tools, 'read_mailbox_message', { queryId: 'query-1', messageId: 'mail/one+==' }), /本轮返回/);
    assert.equal(f.reads.length, 0);
  }
});

test('aborting or revoking a body read cannot return cached or late plaintext', async () => {
  const f = fixture(); const listed = await call<{ queryId: string }>(f.tools, 'list_mailbox_messages', {});
  const pending = gate(); f.waitBody(pending.promise);
  const work = call(f.tools, 'read_mailbox_message', { queryId: listed.queryId, messageId: 'mail/one+==' });
  const rejected = assert.rejects(work); await Promise.resolve(); f.controller.abort(); pending.release(); await rejected;
  assert.equal(f.reads[0][3], f.controller.signal);
  const revoked = fixture(); const query = await call<{ queryId: string }>(revoked.tools, 'list_mailbox_messages', {});
  await call(revoked.tools, 'read_mailbox_message', { queryId: query.queryId, messageId: 'mail/one+==' });
  revoked.setAvailable([]);
  await assert.rejects(call(revoked.tools, 'read_mailbox_message', { queryId: query.queryId, messageId: 'mail/one+==' }), /已停用或范围已变化/);
  assert.equal(revoked.reads.length, 1);
});

test('mail tools are absent when the current scene has no connected EWS mailbox', () => {
  const f = fixture([]);
  assert.equal(f.tools, undefined);
});
