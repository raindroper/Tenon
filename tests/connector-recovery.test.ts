import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';
import { SecretStore } from '../server/secrets.js';
import { ConnectorService, type ConnectorProviders } from '../server/connectors/service.js';
import { ConnectorProviderError, type ConnectorProvider, type ConnectorToken } from '../server/connectors/types.js';

function provider(overrides: Partial<ConnectorProvider> = {}): ConnectorProvider {
  return { validateScope: value => value, authorize: () => new URL('https://example.invalid/authorize'),
    exchange: async () => ({ accessToken: 'first-fixture-token' }), refresh: async () => { throw new Error('Unexpected refresh'); },
    scan: async input => ({ cursor: input.cursor ?? 'original-cursor', changes: [] }), ...overrides };
}
async function harness(providers: ConnectorProviders = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-connector-recovery-'));
  const store = new Store(directory); const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const credentials = join(directory, 'connector-credentials');
  const service = new ConnectorService(store, inbox, credentials, providers, () => true, () => {}, () => {});
  const connect = async (kind: 'gmail' | 'outlook') => {
    const started = await service.start(kind, { caseId: 'topic', scope: 'INBOX' }, 'https://rae.example.invalid');
    return service.complete(kind, started.state, 'fixture-code', 'https://rae.example.invalid');
  };
  return { directory, store, inbox, credentials, service, connect,
    close: async () => { await service.close(); inbox.close(); store.close(); } };
}

test('revoked OAuth authorization stops automatic retries while retaining its source, cursor and history', async t => {
  const start = Date.parse('2026-11-09T12:00:00Z'); t.mock.timers.enable({ apis: ['Date'], now: start });
  let scans = 0;
  const h = await harness({ gmail: provider({ scan: async input => {
    scans++; if (input.cursor) throw new ConnectorProviderError('请重新授权。', 401);
    return { cursor: 'original-cursor', changes: [] };
  } }) });
  try {
    const connection = await h.connect('gmail'); const sourceId = 'connector:' + connection.id;
    await h.service.sync(connection.id);
    const saved = h.inbox.getCheckpoint<{ cursor: string; needsAttention: boolean }>(sourceId, null, connection.id)!;
    assert.equal(saved.cursor, 'original-cursor'); assert.equal(saved.needsAttention, true);
    for (const minutes of [5, 10, 60]) { t.mock.timers.setTime(start + minutes * 60_000); h.service.tick(); await flush(); }
    assert.equal(scans, 2, 'baseline plus one rejected scan; passive ticks must not repeat invalid credentials');
    assert.equal(h.service.list().connections[0]!.id, connection.id);
    assert.equal(h.service.list().connections[0]!.needsAttention, true);
    assert.equal(h.service.list().connections[0]!.nextSyncAt, undefined);
  } finally { await h.close(); }
});

test('provider Retry-After gates manual and automatic requests without advancing the cursor', async t => {
  const start = Date.parse('2026-11-09T12:00:00Z'); t.mock.timers.enable({ apis: ['Date'], now: start });
  let scans = 0;
  const retryAt = start + 45 * 60_000;
  const h = await harness({ gmail: provider({ scan: async input => {
    scans++; if (input.cursor && scans === 2) throw new ConnectorProviderError('请求频率受限。', 429, { retryAt });
    return { cursor: input.cursor ? 'next-cursor' : 'original-cursor', changes: [] };
  } }) });
  try {
    const connection = await h.connect('gmail'); await h.service.sync(connection.id);
    t.mock.timers.setTime(start + 20 * 60_000); h.service.tick(); await flush(); await h.service.sync(connection.id);
    assert.equal(scans, 2); assert.equal(h.service.list().connections[0]!.nextSyncAt, new Date(retryAt).toISOString());
    const saved = h.inbox.getCheckpoint<{ cursor: string }>('connector:' + connection.id, null, connection.id)!;
    assert.equal(saved.cursor, 'original-cursor');
    t.mock.timers.setTime(retryAt); await h.service.sync(connection.id);
    assert.equal(scans, 3); assert.equal(h.service.list().connections[0]!.status, 'watching');
  } finally { await h.close(); }
});

test('reauthorization repairs credentials in place without replaying history or changing source identity', async () => {
  let exchange = 0; let validated = 0;
  const h = await harness({ gmail: provider({ exchange: async () => ({ accessToken: `fixture-${++exchange}` }),
    validateReauthorization: async input => {
      assert.equal(input.previousToken.accessToken, 'fixture-1'); assert.equal(input.nextToken.accessToken, 'fixture-2');
      assert.equal(input.cursor, 'original-cursor'); validated++;
    } }) });
  try {
    const connection = await h.connect('gmail');
    await assert.rejects(h.service.start('gmail', { caseId: 'different-topic', scope: 'INBOX', connectionId: connection.id }, 'https://rae.example.invalid'), /原连接/);
    const started = await h.service.start('gmail', { caseId: connection.caseId, scope: connection.scope, connectionId: connection.id }, 'https://rae.example.invalid');
    const repaired = await h.service.complete('gmail', started.state, 'replacement-code', 'https://rae.example.invalid');
    assert.equal(repaired.id, connection.id); assert.equal(validated, 1);
    assert.equal(h.service.list().connections.length, 1);
    assert.equal(h.inbox.getCheckpoint<{ cursor: string }>('connector:' + connection.id, null, connection.id)!.cursor, 'original-cursor');
    assert.equal(JSON.parse(new SecretStore(h.credentials, connection.id + '.json').get()!).accessToken, 'fixture-2');
  } finally { await h.close(); }
});

test('disconnect drains an accepted reauthorization and rejects late credential resurrection', async () => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const began = new Promise<void>(resolve => { entered = resolve; });
  const h = await harness({ gmail: provider({ validateReauthorization: async () => { entered(); await gate; } }) });
  try {
    const connection = await h.connect('gmail');
    const started = await h.service.start('gmail', { caseId: connection.caseId, scope: connection.scope, connectionId: connection.id }, 'https://rae.example.invalid');
    const replacing = h.service.complete('gmail', started.state, 'replacement-code', 'https://rae.example.invalid');
    const rejected = assert.rejects(replacing);
    await began; let disconnected = false;
    const disconnect = h.service.disconnect(connection.id, async () => {}).then(() => { disconnected = true; });
    await flush(); assert.equal(disconnected, false);
    release(); await Promise.all([disconnect, rejected]);
    assert.equal(h.service.list().connections.length, 0);
    assert.equal(new SecretStore(h.credentials, connection.id + '.json').get(), undefined);
  } finally { release?.(); await h.close(); }
});

test('MSAL cache refresh is persisted even when there is no legacy refreshToken field', async t => {
  const start = Date.parse('2026-11-09T12:00:00Z'); t.mock.timers.enable({ apis: ['Date'], now: start });
  const seen: string[] = [];
  const h = await harness({ outlook: provider({ exchange: async () => ({ accessToken: 'first-fixture-token', msalCache: 'first-cache', expiresAt: start + 1000 }),
    canRefresh: token => Boolean(token.msalCache), refresh: async token => {
      assert.equal(token.msalCache, 'first-cache');
      return { accessToken: 'renewed-fixture-token', msalCache: 'rotated-cache', expiresAt: start + 3_600_000 };
    }, scan: async input => { seen.push(input.token.accessToken); return { cursor: input.cursor ?? 'original-cursor', changes: [] }; } }) });
  try {
    const connection = await h.connect('outlook'); await h.service.sync(connection.id);
    assert.deepEqual(seen, ['first-fixture-token', 'renewed-fixture-token']);
    const saved = JSON.parse(new SecretStore(h.credentials, connection.id + '.json').get()!) as ConnectorToken;
    assert.equal(saved.msalCache, 'rotated-cache'); assert.equal(saved.accessToken, 'renewed-fixture-token');
  } finally { await h.close(); }
});

test('OAuth app setup is owner encrypted, revision guarded, reloadable and never returned with its secret', async () => {
  const h = await harness();
  try {
    const directory = await h.service.saveOAuthApp('gmail', { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'private-app-secret', expectedRevision: 0 });
    const option = directory.providers.find(value => value.kind === 'gmail')!;
    assert.equal(option.configured, true); assert.equal(option.setup!.revision, 1); assert.equal(option.setup!.source, 'saved');
    assert.doesNotMatch(JSON.stringify(directory), /private-app-secret/);
    await assert.rejects(h.service.saveOAuthApp('gmail', { clientId: 'changed-client', clientSecret: 'replacement-secret', expectedRevision: 0 }), /配置已变化/);
    const reopened = new ConnectorService(h.store, h.inbox, h.credentials, {}, () => true, () => {}, () => {});
    try { reopened.recover(); assert.deepEqual(reopened.list().providers.find(value => value.kind === 'gmail')!.setup, option.setup); }
    finally { await reopened.close(); }
  } finally { await h.close(); }
});
