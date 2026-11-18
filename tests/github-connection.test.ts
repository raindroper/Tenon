import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';
import { SecretStore } from '../server/secrets.js';
import { ConnectorService } from '../server/connectors/service.js';
import type { ConnectorProvider } from '../server/connectors/types.js';
import type { inspectGitHubAccount } from '../server/connectors/github-mcp.js';
import type { RuntimeApi } from '../server/runtime.js';
import { routeRuntime } from '../server/v2/http.js';

const PAT = 'github_pat_fixture_token_for_offline_tests_12345';
const provider: ConnectorProvider = {
  tokenGrantUrl: 'https://github.com/settings/tokens', validateScope: value => value.toLowerCase(),
  authorize: () => { throw new Error('No GitHub OAuth'); }, exchange: async () => { throw new Error('No GitHub OAuth'); },
  refresh: async () => { throw new Error('No GitHub OAuth'); },
  scan: async input => ({ cursor: input.cursor ?? JSON.stringify({ version: 3, accountId: 42, login: 'owner', at: Date.now() }), changes: [] }),
};
async function harness(inspect: typeof inspectGitHubAccount = async () => ({ id: 42, login: 'owner' })) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-github-connection-'));
  const credentials = join(directory, 'credentials'); const store = new Store(directory); const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const service = new ConnectorService(store, inbox, credentials, { github: provider }, () => true, () => {}, () => {}, () => false,
    undefined, async () => { throw new Error('Account setup must not inspect one repository'); }, inspect);
  return { directory, credentials, service, inbox, store, close: async () => { await service.close(); inbox.close(); store.close(); } };
}
const selection = { token: PAT, accessAllRepositories: true as const, persistCredentials: true as const };

test('disconnect drains a late GitHub account credential validation and prevents resurrection', async () => {
  let calls = 0; let entered!: () => void; let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(async () => { if (++calls > 1) { entered(); await gate; } return { id: 42, login: 'owner' }; });
  try {
    const connected = await h.service.connectGitHub(selection);
    const updating = h.service.updateGitHub(connected.id, { ...selection, expectedRevision: 1, token: PAT + '_replacement' });
    const rejected = assert.rejects(updating); await enteredPromise;
    let completed = false; const disconnect = h.service.disconnect(connected.id, async () => {}).then(() => { completed = true; });
    await flush(); assert.equal(completed, false); release(); await Promise.all([rejected, disconnect]);
    assert.equal(h.service.list().connections.length, 0); assert.equal(new SecretStore(h.credentials, connected.id + '.json').get(), undefined);
  } finally { release?.(); await h.close(); }
});

test('account create/update/upgrade and OAuth app routes validate commands and discard submitted secrets', async () => {
  const bodies: unknown[] = [];
  const runtime = { connectorSettings: {
    connectGitHub: async (input: unknown) => { bodies.push(input); return { id: 'connection', kind: 'github' }; },
    updateGitHub: async (_id: string, input: unknown) => { bodies.push(input); return { id: 'connection', kind: 'github' }; },
    upgradeGitHub: async (_id: string, input: unknown) => { bodies.push(input); return { id: 'connection', kind: 'github' }; },
    saveOAuthApp: async (_kind: string, input: unknown) => { bodies.push(input); return { providers: [] }; },
  } } as unknown as RuntimeApi;
  const origin = 'https://rae.example.invalid'; const query = new URLSearchParams();
  const create = { ...selection };
  assert.equal((await routeRuntime(runtime, '/api/connectors/github', 'POST', create, query, origin)).status, 201);
  assert.equal(create.token, ''); assert.equal((bodies[0] as { token: string }).token, PAT);
  const update = { ...selection, expectedRevision: 1 };
  assert.equal((await routeRuntime(runtime, '/api/connectors/github/connection/credentials', 'PATCH', update, query, origin)).status, 200);
  assert.equal(update.token, ''); assert.equal((bodies[1] as { token: string }).token, PAT);
  const upgrade = { expectedRevision: 1, accessAllRepositories: true };
  assert.equal((await routeRuntime(runtime, '/api/connectors/github/connection/account', 'POST', upgrade, query, origin)).status, 200);
  assert.deepEqual(bodies[2], upgrade); assert.equal('token' in (bodies[2] as object), false);
  const invalid = { ...selection, accessAllRepositories: false };
  await assert.rejects(routeRuntime(runtime, '/api/connectors/github', 'POST', invalid, query, origin));
  assert.equal(invalid.token, ''); assert.equal(bodies.length, 3);
  const app = { clientId: 'client', clientSecret: 'private-client-secret', expectedRevision: 0 };
  await routeRuntime(runtime, '/api/connectors/gmail/app', 'POST', app, query, origin);
  assert.equal(app.clientSecret, ''); assert.equal((bodies[3] as { clientSecret: string }).clientSecret, 'private-client-secret');
});

test('a private account read cannot be reused through read_event after its credential snapshot changes', async () => {
  const h = await harness();
  try {
    const connection = await h.service.connectGitHub(selection);
    const evidence = h.inbox.ingestProcessed({ sourceId: 'connector:' + connection.id, sourceGeneration: connection.id,
      externalId: 'private-read', kind: 'connector.github_read', actor: 'external', operation: 'create', caseId: connection.caseId,
      occurredAt: new Date().toISOString(), payload: { provider: 'github', connectionId: connection.id,
        accountId: 42, credentialRevision: 1, result: 'PRIVATE_ACCOUNT_CONTENT' } });
    assert.equal(h.service.isEventAllowed(evidence), true);
    assert.equal(h.service.isEventAllowed({ ...evidence, payload: { ...evidence.payload, connectionId: 'another-connection' } }), false);
    assert.equal(h.service.isEventAllowed({ ...evidence, payload: { ...evidence.payload, accountId: 99 } }), false);
    await h.service.updateGitHub(connection.id, { ...selection, expectedRevision: 1, token: PAT + '_rotated' });
    assert.equal(h.service.isEventAllowed(evidence), false);
    assert.equal(h.inbox.get(evidence.id)!.payload.result, 'PRIVATE_ACCOUNT_CONTENT', 'scope changes fence model use without deleting native owner history');
  } finally { await h.close(); }
});
