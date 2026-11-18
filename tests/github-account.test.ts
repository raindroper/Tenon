import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { ConnectorService } from '../server/connectors/service.js';
import type { ConnectorProvider } from '../server/connectors/types.js';
import { SecretStore } from '../server/secrets.js';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';

const PAT = 'github_pat_offline_account_fixture_1234567890';
const input = { token: PAT, accessAllRepositories: true as const, persistCredentials: true as const };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-github-account-service-')); const credentials = join(directory, 'credentials');
  const store = new Store(directory); const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const validScenes = new Set(['personal-growth', 'first', 'second']); let scans = 0; let inspected = 0; let scanAccountId = 42;
  let wait: Promise<void> | undefined; let entered: (() => void) | undefined;
  const provider: ConnectorProvider = {
    tokenGrantUrl: 'https://github.com/settings/tokens', validateScope: value => value.toLowerCase(),
    authorize() { throw new Error('No GitHub OAuth'); }, async exchange() { throw new Error('No GitHub OAuth'); }, async refresh() { throw new Error('No GitHub OAuth'); },
    async scan(selected) { scans++; return { cursor: selected.cursor ?? JSON.stringify({ version: 3, accountId: scanAccountId, login: 'owner', at: Date.now() }), changes: [] }; },
  };
  const service = new ConnectorService(store, inbox, credentials, { github: provider }, caseId => validScenes.has(caseId), () => {}, () => {}, () => false,
    undefined, async () => { throw new Error('Account setup must not choose a repository'); },
    async token => { inspected++; if (wait) { entered?.(); await wait; } return token.accessToken.endsWith('_other') ? { id: 99, login: 'other' } : { id: 42, login: 'owner' }; });
  return { directory, credentials, store, inbox, service, validScenes, scans: () => scans, inspected: () => inspected,
    setScanAccount(id: number) { scanAccountId = id; }, pause(gate: Promise<void>, onEntered: () => void) { wait = gate; entered = onEntered; },
    async close() { await service.close(); inbox.close(); store.close(); } };
}

test('GitHub connects an immutable account without a repository selector and records explicit account-wide resource consent', async () => {
  const h = await fixture();
  try {
    await assert.rejects(async () => h.service.connectGitHub({ ...input, accessAllRepositories: false } as never));
    await assert.rejects(async () => h.service.connectGitHub({ ...input, scope: 'owner/repo' } as never));
    const connected = await h.service.connectGitHub(input);
    assert.equal(connected.scope, 'account'); const details = connected.github;
    assert.ok(details?.kind === 'account'); assert.equal(details.accountId, 42); assert.equal(details.login, 'owner');
    assert.ok(details.grantEventId); const grant = h.inbox.get(details.grantEventId!);
    assert.equal(grant?.kind, 'owner.github_account_access'); assert.equal(grant?.actor, 'owner');
    assert.equal(grant?.payload.accessAllRepositories, true); assert.equal(grant?.payload.accountId, 42);
    assert.equal(h.scans(), 1); assert.equal(h.inspected(), 1);
    assert.doesNotMatch(JSON.stringify(h.service.list()), new RegExp(PAT));
    assert.ok(new SecretStore(h.credentials, connected.id + '.json').get());
    assert.equal((await h.service.connectGitHub(input)).id, connected.id, 'repeating the same account credential reuses its existing connection');
    assert.equal(h.service.list().connections.length, 1);
  } finally { await h.close(); }
});

test('account resource access works in each active owner scene and is not disabled when its setup scene is stopped', async () => {
  const h = await fixture();
  try {
    const connected = await h.service.connectGitHub({ ...input, caseId: 'first' });
    const snapshot = { accountId: 42, credentialRevision: 1 };
    assert.equal(h.service.canReadGitHubConnection('first', connected.id, snapshot), true);
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, snapshot), true);
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, { ...snapshot, accountId: 99 }), false);
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, { ...snapshot, credentialRevision: 2 }), false);
    h.validScenes.delete('first');
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, snapshot), true);
    assert.equal(h.service.canReadGitHubConnection('stopped-scene', connected.id, snapshot), false);
    const evidence = h.inbox.ingestProcessed({ sourceId: 'connector:' + connected.id, sourceGeneration: connected.id,
      externalId: 'account-search', kind: 'connector.github_read', actor: 'external', operation: 'create', caseId: 'second',
      occurredAt: new Date().toISOString(), payload: { provider: 'github', connectionId: connected.id, ...snapshot, result: 'PRIVATE_ACCOUNT_SEARCH' } });
    assert.equal(h.service.isEventAllowed(evidence), true);
    await h.service.disconnect(connected.id, async () => {});
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, snapshot), false);
    assert.equal(h.service.isEventAllowed(evidence), false);
  } finally { await h.close(); }
});

test('account connections do not enumerate repositories or poll automatically, while explicit sync remains bounded', async () => {
  const h = await fixture();
  try {
    const connected = await h.service.connectGitHub(input);
    const checkpoint = h.inbox.getCheckpoint<Record<string, unknown>>('connector:' + connected.id, null, connected.id)!;
    h.inbox.ingestBatch([], { sourceId: 'connector:' + connected.id, sourceGeneration: connected.id, value: { ...checkpoint, nextAt: 0 } });
    for (let n = 0; n < 3; n++) { h.service.tick(); await flush(); }
    assert.equal(h.scans(), 1, 'automatic ticks do not call even get_me for account connections');
    await h.service.sync(connected.id); assert.equal(h.scans(), 2);
  } finally { await h.close(); }
});

test('upgrading a legacy repository needs explicit consent and preserves its old checkpoint and source history', async () => {
  const h = await fixture();
  try {
    const id = randomUUID(); const legacyCursor = JSON.stringify({ version: 2, repositoryId: 7, at: 1794240000000, numbers: null });
    const legacy = { id, kind: 'github', caseId: 'first', scope: 'owner/repo', redirectUri: '', connectedAt: new Date().toISOString(),
      github: { repositoryId: 7, credentialRevision: 1, access: 'read', defaultBranch: 'main' } };
    h.store.setMeta('connectors.v1', [legacy]);
    new SecretStore(h.credentials, id + '.json').set(JSON.stringify({ accessToken: PAT }));
    h.inbox.ingestBatch([], { sourceId: 'connector:' + id, sourceGeneration: id,
      value: { cursor: legacyCursor, lastSyncedAt: new Date().toISOString(), nextAt: 0 } });
    const historical = h.inbox.ingestProcessed({ sourceId: 'connector:' + id, sourceGeneration: id, externalId: 'old-issue',
      kind: 'connector.change', actor: 'external', operation: 'update', caseId: 'first', occurredAt: new Date().toISOString(), payload: { content: 'PRESERVED_LEGACY_EVIDENCE' } });
    assert.equal(h.service.canReadGitHubConnection('second', id, { accountId: 42, credentialRevision: 1 }), false);
    await assert.rejects(h.service.upgradeGitHub(id, { expectedRevision: 1, accessAllRepositories: false } as never));
    assert.equal(h.service.list().connections[0].scope, 'owner/repo');
    const upgraded = await h.service.upgradeGitHub(id, { expectedRevision: 1, accessAllRepositories: true });
    assert.equal(upgraded.id, id); assert.equal(upgraded.scope, 'account'); assert.ok(upgraded.github?.kind === 'account');
    assert.equal(upgraded.github.credentialRevision, 2); assert.equal(upgraded.github.accountId, 42);
    const grant = h.inbox.get(upgraded.github.grantEventId!);
    assert.equal(grant?.payload.previousScope, 'owner/repo');
    assert.equal((grant?.payload.previousCheckpoint as { cursor: string }).cursor, legacyCursor);
    assert.equal(h.inbox.get(historical.id)?.payload.content, 'PRESERVED_LEGACY_EVIDENCE');
    assert.equal(h.service.canReadGitHubConnection('second', id, { accountId: 42, credentialRevision: 2 }), true);
    assert.equal(h.service.canReadGitHubConnection('second', id, { repositoryId: 7, credentialRevision: 1 }), false);
  } finally { await h.close(); }
});

test('account credential rotation keeps the same user and invalidates old resource snapshots', async () => {
  const h = await fixture();
  try {
    const connected = await h.service.connectGitHub(input);
    await assert.rejects(h.service.updateGitHub(connected.id, { ...input, expectedRevision: 1, token: PAT + '_other' }), /另一个/);
    assert.equal(h.service.list().connections[0].github?.credentialRevision, 1);
    const updated = await h.service.updateGitHub(connected.id, { ...input, expectedRevision: 1, token: PAT + '_replacement' });
    assert.ok(updated.github?.kind === 'account'); assert.equal(updated.github.accountId, 42); assert.equal(updated.github.credentialRevision, 2);
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, { accountId: 42, credentialRevision: 1 }), false);
    assert.equal(h.service.canReadGitHubConnection('second', connected.id, { accountId: 42, credentialRevision: 2 }), true);
  } finally { await h.close(); }
});

test('account setup refuses an immutable-user mismatch between profile validation and the provider baseline', async () => {
  const h = await fixture();
  try {
    h.setScanAccount(99);
    await assert.rejects(h.service.connectGitHub(input), /身份|账号/);
    assert.equal(h.service.list().connections.length, 0);
  } finally { await h.close(); }
});
