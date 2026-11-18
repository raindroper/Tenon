import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseSourceContext, toolEvidenceIds } from '../server/v2/source-context.js';
import { EventInbox } from '../server/v2/events.js';
import { SourceRegistry } from '../server/v2/sources.js';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const context = (evidenceId = 'context-receipt') => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'context-call',
  toolName: 'get_mail_message_context', output: { type: 'json', value: { connectionId: 'mailbox-one', evidenceId,
    source: { messageId: 'message-one', revision: 'revision-one', contextId: 'context-one' }, body: 'WITHDRAWN_MAIL_CONTEXT', from: 'sender@example.test' } } }] });
const filter = (allowed: (id: string) => boolean, connected = true) => caseSourceContext('case-one', (_case, id) => allowed(id), () => connected);

test('mail context uses its durable external receipt as evidence and is never replayed as a raw historical tool', () => {
  assert.deepEqual(toolEvidenceIds('get_mail_message_context', { evidenceId: 'context-receipt', body: 'text' }), ['context-receipt']);
  const prompt = [user('Reply to this selected email'), context(), assistant('DERIVED_CONTEXT_SUMMARY'), user('New owner question')];
  const allowed = filter(() => true).processLLMRequest({ prompt } as never) as { prompt: unknown[] };
  assert.doesNotMatch(JSON.stringify(allowed.prompt), /WITHDRAWN_MAIL_CONTEXT/);
  assert.match(JSON.stringify(allowed.prompt), /DERIVED_CONTEXT_SUMMARY/);
  const revoked = filter(id => id !== 'context-receipt').processLLMRequest({ prompt } as never) as { prompt: unknown[] };
  assert.doesNotMatch(JSON.stringify(revoked.prompt), /WITHDRAWN_MAIL_CONTEXT|DERIVED_CONTEXT_SUMMARY|Reply to this/);
  assert.match(JSON.stringify(revoked.prompt), /New owner question/);
  const disconnected = filter(() => true, false).processLLMRequest({ prompt } as never) as { prompt: unknown[] };
  assert.doesNotMatch(JSON.stringify(disconnected.prompt), /WITHDRAWN_MAIL_CONTEXT|DERIVED_CONTEXT_SUMMARY/);
  assert.match(JSON.stringify(prompt), /WITHDRAWN_MAIL_CONTEXT/, 'Durable native history is not rewritten');
});

test('a current mail context with revoked or missing evidence fails before the next model call', () => {
  const prompt = [user('Reply to this selected email'), context()];
  assert.throws(() => filter(() => false).processLLMRequest({ prompt } as never), /来源已停用/);
  const missing = context(); delete (missing.content[0].output.value as Partial<typeof missing.content[0]['output']['value']>).evidenceId;
  assert.throws(() => filter(() => true).processLLMRequest({ prompt: [user('Reply'), missing] } as never), /来源已停用/);
});

test('connector mail-context receipts resolve only through the live original connector identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-context-source-')); const inbox = new EventInbox(join(directory, 'events.sqlite'));
  let connected = true;
  const registry = new SourceRegistry(inbox, { resolveConnectorCase: event => connected && event.sourceId === 'connector:mailbox-one'
    && event.sourceGeneration === 'mailbox-one' && event.caseId === 'case-one' ? 'case-one' : undefined });
  try {
    const event = inbox.ingestProcessed({ sourceId: 'connector:mailbox-one', sourceGeneration: 'mailbox-one', externalId: 'context-one',
      kind: 'connector.mail_context', actor: 'external', caseId: 'case-one', operation: 'create', occurredAt: new Date().toISOString(), payload: { content: 'external context' } });
    assert.equal(registry.resolveEventCase(event), 'case-one'); assert.equal(registry.isEventAllowed(event), true);
    connected = false; assert.equal(registry.resolveEventCase(event), undefined); assert.equal(registry.isEventAllowed(event), false);
    assert.equal(registry.isEventAllowed({ ...event, sourceGeneration: 'different-connection' }), false);
  } finally { await registry.close(); inbox.close(); }
});
