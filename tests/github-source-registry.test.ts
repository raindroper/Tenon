import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Store } from '../server/store.js';
import { ConnectorService } from '../server/connectors/service.js';
import type { ConnectorProvider } from '../server/connectors/types.js';
import { EventInbox, type InboxEvent } from '../server/v2/events.js';
import { SourceRegistry } from '../server/v2/sources.js';
import { CaseMemory } from '../server/v2/memory.js';
import { MockLanguageModelV4 } from './support/model.js';

const PAT = 'github_pat_offline_source_registry_fixture_1234567';
const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const call = (tool: 'get_me' | 'search_repositories') => ({ content: [{ type: 'tool-call' as const, toolCallId: `github-${tool}`, toolName: 'read_github_repository', input: JSON.stringify({ tool }) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [] });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-github-registry-'));
  const store = new Store(directory); const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const activeCases = new Set(['personal-growth']);
  const provider: ConnectorProvider = { tokenGrantUrl: 'https://github.com/settings/tokens', validateScope: value => value,
    authorize() { throw new Error('No fixture OAuth'); }, async exchange() { throw new Error('No fixture OAuth'); }, async refresh() { throw new Error('No fixture OAuth'); },
    async scan(input) { return { cursor: input.cursor ?? JSON.stringify({ version: 3, accountId: 42, login: 'fixture-owner', at: Date.now() }), changes: [] }; } };
  const connectors = new ConnectorService(store, inbox, join(directory, 'credentials'), { github: provider }, id => activeCases.has(id), () => {}, () => {},
    () => false, undefined, async () => { throw new Error('No repository enumeration'); }, async () => ({ id: 42, login: 'fixture-owner' }));
  const connection = await connectors.connectGitHub({ token: PAT, accessAllRepositories: true, persistCredentials: true });
  const registry = new SourceRegistry(inbox, { resolveConnectorCase: event => connectors.isEventAllowed(event) ? event.caseId : undefined });
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'github-registry-owner');
  // Match the production coordinator, including the registry's real kind routing.
  memory.setSourceEvidenceFilter((caseId, eventId) => {
    const event = inbox.get(eventId); return Boolean(event && registry.resolveEventCase(event) === caseId && registry.isEventAllowed(event));
  });
  memory.setConnectorEvidenceFilter((caseId, id, source) => connectors.canReadGitHubConnection(caseId, id, source));
  const scene = await memory.createCase({ title: 'GitHub source registry', objective: '', domain: 'fixture' }); activeCases.add(scene.id);
  const receipts: InboxEvent[] = [];
  const read = (tool: string) => {
    const result = tool === 'get_me' ? { id: 42, login: 'fixture-owner' } : { total_count: 2, items: [
      { full_name: 'fixture/private-one', description: 'PRIVATE_REGISTRY_SOURCE' }, { full_name: 'org/private-two', description: 'Another authorized private repository' },
    ] };
    const event = inbox.ingestProcessed({ sourceId: 'connector:' + connection.id, sourceGeneration: connection.id, externalId: randomUUID(),
      kind: 'connector.github_read', actor: 'external', operation: 'create', caseId: scene.id, occurredAt: new Date().toISOString(),
      payload: { provider: 'github', connectionId: connection.id, accountId: 42, credentialRevision: 1, tool, result } });
    receipts.push(event);
    return { githubSource: { version: 2, caseId: scene.id, connectionId: connection.id, accountId: 42, credentialRevision: 1 }, evidenceId: event.id, result };
  };
  const invalidate = async (kind: 'disconnect' | 'revision') => {
    if (kind === 'disconnect') await connectors.disconnect(connection.id, async () => {});
    else await connectors.updateGitHub(connection.id, { expectedRevision: 1, token: PAT + '_rotated', accessAllRepositories: true, persistCredentials: true });
  };
  return { store, inbox, connectors, registry, memory, scene, connection, receipts, read, invalidate,
    async close() { await memory.close(); await registry.close(); await connectors.close(); inbox.close(); store.close(); } };
}

test('GitHub read receipts route through the real connector policy, while unrelated generations stay denied', async () => {
  const f = await fixture();
  try {
    f.read('get_me'); const event = f.receipts[0];
    assert.equal(f.connectors.isEventAllowed(event), true);
    assert.equal(f.registry.resolveEventCase(event), f.scene.id); assert.equal(f.registry.isEventAllowed(event), true);
    assert.equal(f.registry.resolveEventCase({ ...event, kind: 'connector.unrecognized' }), undefined);
    assert.equal(f.registry.isEventAllowed({ ...event, kind: 'connector.unrecognized' }), false);
    const changed = { ...event, payload: { ...event.payload, credentialRevision: 99 } };
    assert.equal(f.registry.resolveEventCase(changed), undefined); assert.equal(f.registry.isEventAllowed(changed), false);
    await f.invalidate('disconnect');
    assert.equal(f.registry.resolveEventCase(event), undefined); assert.equal(f.registry.isEventAllowed(event), false);
    assert.ok(f.inbox.get(event.id), 'source revocation preserves its original stored receipt');
  } finally { await f.close(); }
});

test('real Registry to CaseMemory GitHub get_me and repository search reach the next model step and revoke cleanly', async t => {
  for (const change of ['disconnect', 'revision'] as const) await t.test(change, async () => {
    const f = await fixture(); let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async input => {
      calls++; const prompt = JSON.stringify(input.prompt);
      if (calls === 1) return call('get_me');
      if (calls === 2) {
        assert.equal(f.registry.isEventAllowed(f.receipts[0]), true);
        assert.match(prompt, /fixture-owner/); return call('search_repositories');
      }
      if (calls === 3) {
        assert.equal(f.registry.isEventAllowed(f.receipts[1]), true);
        assert.match(prompt, /PRIVATE_REGISTRY_SOURCE/); return answer('PRIVATE_DERIVED_REGISTRY_REPLY');
      }
      assert.doesNotMatch(prompt, /PRIVATE_REGISTRY_SOURCE|PRIVATE_DERIVED_REGISTRY_REPLY|TRY_THE_CONNECTED_GITHUB/);
      return answer('Current owner context only.');
    } });
    try {
      const read = createTool({ id: 'read_github_repository', description: 'Trusted GitHub app adapter fixture',
        inputSchema: z.object({ tool: z.enum(['get_me', 'search_repositories']) }), execute: async ({ tool }) => f.read(tool) });
      await f.memory.runCase({ caseId: f.scene.id, message: 'TRY_THE_CONNECTED_GITHUB', model, instructions: 'Offline fixture.',
        tools: { read_github_repository: read }, maxSteps: 3, observeOwnerConversation: false });
      assert.equal(calls, 3); assert.equal(f.receipts.length, 2);
      await f.invalidate(change);
      for (const event of f.receipts) assert.equal(f.registry.isEventAllowed(event), false);
      await f.memory.runCase({ caseId: f.scene.id, message: 'New owner question', model, instructions: 'Offline fixture.', maxSteps: 1, observeOwnerConversation: false });
      assert.equal(calls, 4);
      assert.match(JSON.stringify(await f.memory.historyForObservation(f.scene.id)), /PRIVATE_REGISTRY_SOURCE|PRIVATE_DERIVED_REGISTRY_REPLY/);
      assert.equal(f.inbox.get(f.receipts[1].id)?.status, 'processed');
    } finally { await f.close(); }
  });
});

test('real Registry blocks a GitHub result revoked between its receipt and the next model request', async t => {
  for (const change of ['disconnect', 'revision'] as const) await t.test(change, async () => {
    const f = await fixture(); let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => { calls++; return call('get_me'); } });
    try {
      const read = createTool({ id: 'read_github_repository', description: 'Mid-call revocation fixture', inputSchema: z.object({ tool: z.string() }),
        execute: async ({ tool }) => { const result = f.read(tool); await f.invalidate(change); return result; } });
      await assert.rejects(f.memory.runCase({ caseId: f.scene.id, message: 'Test the connected GitHub', model, instructions: 'Offline fixture.',
        tools: { read_github_repository: read }, maxSteps: 2, observeOwnerConversation: false }), /来源已停用/);
      assert.equal(calls, 1); assert.equal(f.registry.isEventAllowed(f.receipts[0]), false);
      assert.ok(f.inbox.get(f.receipts[0].id));
    } finally { await f.close(); }
  });
});
