import test from 'node:test';
import assert from 'node:assert/strict';
import { caseEventPrefix, caseSourceContext } from '../server/v2/source-context.js';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const context = (field: string, value: unknown) => user(caseEventPrefix + JSON.stringify({
  event: { id: 'owner-event', kind: 'owner.message', actor: 'owner', sourceId: 'owner-chat', payload: { content: 'KEEP_OWNER_ORIGINAL' } }, [field]: value,
}));
const fields: Array<[string, unknown]> = [
  ['conversationNeighborhoods', [{ messages: [{ evidenceId: 'withdrawn', content: 'STALE_NEIGHBORHOOD' }] }]],
  ['evidencePreviews', [{ evidenceId: 'withdrawn', content: 'STALE_PREVIEW' }]],
  ['attentionItems', [{ fields: { answer: 'STALE_ATTENTION' }, evidence: [{ eventId: 'withdrawn' }] }]],
  ['recentOwnerMessages', { messages: [{ eventId: 'withdrawn', content: 'STALE_RECENT_OWNER' }] }],
];

test('every structured review background is omitted from older prompts while original owner payload remains durable', () => {
  for (const [field, value] of fields) {
    const previous = context(field, value);
    const prompt = [previous, user('CURRENT_OWNER_MESSAGE')];
    const filtered = caseSourceContext('case', () => true).processLLMRequest({ prompt } as never) as { prompt: unknown[] };
    assert.doesNotMatch(JSON.stringify(filtered.prompt), /STALE_/);
    assert.match(JSON.stringify(filtered.prompt), /KEEP_OWNER_ORIGINAL|CURRENT_OWNER_MESSAGE/);
    assert.match(JSON.stringify(prompt), /STALE_/, 'stored history and supplied owner text are never rewritten');
  }
});

test('revoked neighborhood and attention evidence fences the current review and its derived prior response', () => {
  for (const [field, value] of fields) {
    const previous = context(field, value);
    const guard = caseSourceContext('case', (_case, id) => id !== 'withdrawn');
    assert.throws(() => guard.processLLMRequest({ prompt: [previous] } as never), /来源已停用/);
    const filtered = guard.processLLMRequest({ prompt: [previous,
      { role: 'assistant', content: [{ type: 'text', text: 'DERIVED_OLD_RESPONSE' }] }, user('CURRENT_OWNER_MESSAGE')] } as never) as { prompt: unknown[] };
    assert.doesNotMatch(JSON.stringify(filtered.prompt), /STALE_|DERIVED_OLD_RESPONSE/);
    assert.match(JSON.stringify(filtered.prompt), /CURRENT_OWNER_MESSAGE/);
  }
});

test('similar strings inside the original owner body are not interpreted as adapter provenance', () => {
  const original = caseEventPrefix + JSON.stringify({ event: { kind: 'owner.message', actor: 'owner', payload: {
    content: JSON.stringify({ attentionItems: [{ evidence: [{ eventId: 'withdrawn' }] }] }),
  } } });
  const result = caseSourceContext('case', () => false).processLLMRequest({ prompt: [user(original)] } as never);
  assert.equal(result, undefined);
});
