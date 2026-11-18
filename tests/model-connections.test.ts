import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { LEGACY_MODEL_CONNECTION_ID, type OAuthCredentials } from '../server/models/connections.js';
import { modelBindingSchema, type ModelConnection, type ModelSelection } from '../shared/model-connections.js';

function fixture() {
  const prefix = join(tmpdir(), 'rae-model-connections-'); const directory = mkdtempSync(prefix);
  let store = new Store(directory);
  return { get store() { return store; }, reopen() { store.close(); store = new Store(directory); },
    close() { store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); } };
}
function selection(connection: ModelConnection, modelId = 'fixture-model'): ModelSelection {
  return { connectionId: connection.id, modelId, reasoning: 'default', maxOutputTokens: null };
}
function oauth(connection: ModelConnection, overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return { kind: 'siwc', issuer: 'https://issuer.invalid', subject: 'owner-one', clientId: connection.oauthRegistration?.clientId ?? 'client-one',
    accessToken: 'private-access-one', refreshToken: 'private-refresh-one', expiresAt: Date.now() + 3600_000, scope: 'openid chatgpt.tokens.use.direct', ...overrides };
}
function expectation(connection: ModelConnection) {
  return { expectedCredentialVersion: connection.credentialVersion, expectedIdentityRevision: connection.identityRevision };
}

test('legacy connection migration preserves saved settings, inference intent, and an independent Hub credential', async () => {
  const f = fixture();
  try {
    await f.store.updateSettings({ model: 'saved-model', apiBaseUrl: 'https://saved.invalid/v1', apiKey: 'private-old-key', enabled: false,
      reasoningEffort: 'high', maxOutputTokens: 1234, ownerName: 'Kept owner' });
    const migrated = f.store.models.directory();
    assert.equal(migrated.connections.length, 1);
    assert.deepEqual(migrated.defaults.global, { connectionId: LEGACY_MODEL_CONNECTION_ID, modelId: 'saved-model', reasoning: 'high', maxOutputTokens: 1234 });
    assert.deepEqual(migrated.defaults.background, { mode: 'inherit-global' });
    assert.equal(f.store.getSettings().enabled, false);
    const legacy = migrated.connections[0];
    f.store.models.upsert({ id: legacy.id, expectedRevision: legacy.editRevision, name: 'Renamed', kind: 'api-key', protocol: 'deepseek',
      endpoint: legacy.endpoint, apiKey: 'private-new-key' });
    assert.equal(f.store.models.hubSettings().apiKey, 'private-old-key');
    assert.deepEqual(f.store.models.getCredential(legacy.id), { kind: 'api-key', apiKey: 'private-new-key' });
    f.reopen();
    assert.equal(f.store.models.directory().connections.length, 1);
    assert.equal(f.store.models.hubSettings().apiKey, 'private-old-key');
    assert.equal(f.store.getSettings().ownerName, 'Kept owner');
    const saved = f.store.models.get(legacy.id)!;
    f.store.models.setCatalog(saved.id, [{ id: 'saved-model', name: 'Old provider model', source: 'provider', contextWindow: 128_000 }]);
    f.store.models.upsert({ id: saved.id, expectedRevision: saved.editRevision, name: saved.name, kind: saved.kind, protocol: saved.protocol,
      endpoint: saved.endpoint, contextWindows: [{ modelId: 'saved-model', contextWindow: 96_000 }] });
    await f.store.updateSettings({ apiBaseUrl: 'https://other-provider.invalid/v1' });
    const rebound = f.store.models.resolve({ purpose: 'task' });
    assert.equal(rebound?.endpoint, 'https://other-provider.invalid/v1');
    assert.equal(rebound?.contextWindow, undefined);
  } finally { f.close(); }
});

test('scene inheritance, explicit equal values and the independent background default resolve without inference', () => {
  const f = fixture();
  try {
    const first = f.store.models.upsert({ name: 'First', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://first.invalid/v1' });
    const second = f.store.models.upsert({ name: 'Second', kind: 'api-key', protocol: 'openai-responses', endpoint: 'https://second.invalid/v1' });
    f.store.models.setDefaults({ global: selection(first), background: { mode: 'explicit', selection: selection(second, 'background-model') }, expectedRevision: 1 });
    f.store.models.setScene('scene-one', { preference: { mode: 'explicit', selection: selection(first) }, expectedRevision: 0 });
    const accepted = f.store.models.resolve({ caseId: 'scene-one', purpose: 'conversation' })!;
    assert.equal(accepted.source, 'scene');
    assert.throws(() => f.store.models.assertBinding(accepted), /不可用/);
    f.store.models.setDefaults({ global: selection(second), expectedRevision: 2 });
    assert.equal(f.store.models.resolve({ caseId: 'scene-one', purpose: 'conversation' })?.selection.connectionId, first.id);
    assert.equal(f.store.models.resolve({ caseId: 'scene-two', purpose: 'conversation' })?.selection.connectionId, second.id);
    assert.equal(f.store.models.resolve({ caseId: 'scene-one', purpose: 'background' })?.selection.modelId, 'background-model');
    assert.equal(accepted.selection.connectionId, first.id);
    f.store.models.setScene('scene-one', { preference: { mode: 'inherit-global' }, expectedRevision: 1 });
    assert.equal(f.store.models.resolve({ caseId: 'scene-one', purpose: 'conversation' })?.selection.connectionId, second.id);
    f.reopen();
    assert.equal(f.store.models.getScene('scene-one').preference.mode, 'inherit-global');
    f.store.models.setDefaults({ global: null, expectedRevision: 3 });
    assert.equal(f.store.models.resolve({ caseId: 'scene-one', purpose: 'conversation' }), undefined);
    assert.equal(f.store.models.resolve({ purpose: 'background' })?.selection.connectionId, second.id);
  } finally { f.close(); }
});

test('rename and token-independent changes preserve binding while key replacement and endpoint changes cannot drift', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'Saved', kind: 'api-key', protocol: 'openai-chat', endpoint: 'https://one.invalid/v1', apiKey: 'private-first' });
    const binding = f.store.models.resolve({ purpose: 'conversation', selection: selection(connection) })!;
    f.store.models.assertBinding(binding);
    connection = f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: 'Name only', kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint });
    assert.equal(connection.bindingRevision, binding.bindingRevision);
    f.store.models.assertBinding(binding);
    assert.throws(() => f.store.models.upsert({ id: connection.id, expectedRevision: 1, name: 'Stale', kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint }), /已被修改/);
    connection = f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: connection.name, kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint, apiKey: 'private-replacement' });
    assert.throws(() => f.store.models.assertBinding(binding), /身份或地址已改变/);
    connection = f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: connection.name, kind: connection.kind,
      protocol: connection.protocol, endpoint: 'https://new-target.invalid/v1' });
    assert.equal(connection.credentialConfigured, false);
    assert.equal(f.store.models.getCredential(connection.id), undefined, 'an old key must not travel to a new endpoint');
  } finally { f.close(); }
});

test('project window configuration is model specific, persists, and does not retarget accepted bindings', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'Project API', kind: 'api-key', protocol: 'openai-responses',
      endpoint: 'https://one.invalid/v1', apiKey: 'fixture-key' });
    const change = { id: connection.id, name: connection.name, kind: connection.kind, protocol: connection.protocol, endpoint: connection.endpoint };
    f.store.models.setCatalog(connection.id, [{ id: 'fixture-model', name: 'Fixture', source: 'provider', contextWindow: 150_000 }]);
    const resolve = (modelId?: string) => f.store.models.resolve({ purpose: 'task', selection: selection(connection, modelId) })!;
    const accepted = resolve();
    assert.equal(accepted.contextWindow, 150_000);
    const oldBinding = resolve('unknown-model');
    assert.equal(Object.hasOwn(oldBinding, 'contextWindow'), false);
    assert.equal(modelBindingSchema.safeParse(oldBinding).success, true);
    connection = f.store.models.upsert({ ...change, expectedRevision: connection.editRevision,
      contextWindows: [{ modelId: 'fixture-model', contextWindow: 120_000 }, { modelId: 'owner-model', contextWindow: 90_000 }] });
    f.reopen();
    connection = f.store.models.upsert({ ...change, name: 'Renamed with old form', expectedRevision: connection.editRevision });
    assert.equal(resolve().contextWindow, 120_000); assert.equal(resolve('owner-model').contextWindow, 90_000);
    assert.equal(resolve('fixture-model-extra').contextWindow, undefined);
    assert.equal(accepted.contextWindow, 150_000); f.store.models.assertBinding(accepted);
    connection = f.store.models.upsert({ ...change, expectedRevision: connection.editRevision, contextWindows: [] });
    assert.equal(resolve().contextWindow, 150_000); assert.equal(resolve('owner-model').contextWindow, undefined);
    connection = f.store.models.upsert({ ...change, expectedRevision: connection.editRevision,
      contextWindows: [{ modelId: 'fixture-model', contextWindow: 100_000 }] });
    connection = f.store.models.upsert({ ...change, expectedRevision: connection.editRevision, endpoint: 'https://two.invalid/v1' });
    assert.equal(resolve().contextWindow, undefined);
  } finally { f.close(); }
});

test('OAuth refresh rotates credentials without changing binding and cannot overwrite another identity or logout', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'ChatGPT', kind: 'siwc', protocol: 'siwc-responses' });
    connection = f.store.models.setOAuthRegistration(connection.id, { issuer: 'https://issuer.invalid', clientId: 'registered-client' }, expectation(connection));
    connection = f.store.models.setOAuthCredentials(connection.id, oauth(connection), expectation(connection));
    const binding = f.store.models.resolve({ purpose: 'conversation', selection: selection(connection) })!;
    const initial = connection;
    connection = f.store.models.setOAuthCredentials(connection.id, oauth(connection, { accessToken: 'private-access-two', refreshToken: 'private-refresh-two' }), expectation(connection));
    assert.equal(connection.bindingRevision, initial.bindingRevision);
    assert.equal(connection.identityRevision, initial.identityRevision);
    assert.equal(connection.editRevision, initial.editRevision);
    assert.equal(connection.credentialVersion, initial.credentialVersion + 1);
    f.store.models.assertBinding(binding);
    assert.throws(() => f.store.models.setOAuthCredentials(connection.id, oauth(connection, { subject: 'someone-else' }), expectation(connection)), /账号与原连接不符/);
    assert.throws(() => f.store.models.setOAuthCredentials(connection.id, oauth(connection), expectation(initial)), /已经改变/);
    const beforeLogout = connection;
    connection = f.store.models.clearCredential(connection.id, expectation(connection));
    assert.equal(connection.oauthRegistration?.clientId, 'registered-client');
    assert.equal(connection.identity?.subject, 'owner-one');
    assert.equal(connection.credentialConfigured, false);
    assert.throws(() => f.store.models.setOAuthCredentials(connection.id, oauth(connection), expectation(beforeLogout)), /已经改变/);
    const serialized = JSON.stringify(f.store.models.directory()) + JSON.stringify(f.store.getMeta('models.connections.v1', null));
    assert.ok(!serialized.includes('private-access') && !serialized.includes('private-refresh'));
    f.reopen(); assert.equal(f.store.models.getCredential(connection.id), undefined);
  } finally { f.close(); }
});

test('failed credential-reference commit preserves the original key and metadata across reopening', () => {
  const f = fixture();
  try {
    const connection = f.store.models.upsert({ name: 'Durable', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://durable.invalid/v1', apiKey: 'private-original' });
    const original = f.store.setMeta.bind(f.store);
    f.store.setMeta = (key, value) => { if (key === 'models.connections.v1') throw new Error('injected metadata failure'); original(key, value); };
    assert.throws(() => f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: 'Must not commit', kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint, apiKey: 'private-rejected' }), /injected metadata failure/);
    f.store.setMeta = original;
    assert.deepEqual(f.store.models.get(connection.id), connection);
    assert.deepEqual(f.store.models.getCredential(connection.id), { kind: 'api-key', apiKey: 'private-original' });
    f.reopen();
    assert.deepEqual(f.store.models.getCredential(connection.id), { kind: 'api-key', apiKey: 'private-original' });
  } finally { f.close(); }
});

test('connection removal requires resolved references; disabling one account does not block another', () => {
  const f = fixture();
  try {
    const one = f.store.models.upsert({ name: 'One', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://one.invalid/v1', apiKey: 'private-one' });
    const two = f.store.models.upsert({ name: 'Two', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://two.invalid/v1', apiKey: 'private-two' });
    const firstBinding = f.store.models.resolve({ purpose: 'task', selection: selection(one) })!;
    const secondBinding = f.store.models.resolve({ purpose: 'task', selection: selection(two) })!;
    f.store.models.setScene('case', { preference: { mode: 'explicit', selection: selection(one) }, expectedRevision: 0 });
    assert.throws(() => f.store.models.remove(one.id, one.editRevision), /仍被/);
    f.store.models.archive(one.id, one.editRevision);
    assert.throws(() => f.store.models.assertBinding(firstBinding), /不可用/);
    f.store.models.assertBinding(secondBinding);
    assert.equal(f.store.models.getCredential(one.id)?.kind, 'api-key', 'revocation service can still retrieve a disabled credential');
    f.store.models.setActiveTaskBindingReader(() => [{ id: 'task-two', modelBinding: secondBinding }]);
    assert.throws(() => f.store.models.remove(two.id, two.editRevision), /仍被/);
    f.store.models.setActiveTaskBindingReader(() => []);
    f.store.models.remove(two.id, two.editRevision);
    assert.equal(f.store.models.get(two.id)?.archived, true);
    assert.equal(f.store.models.getCredential(two.id), undefined);
  } finally { f.close(); }
});

test('OAuth scope and reauthentication errors survive rename and disable/re-enable without restoring request access', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'ChatGPT', kind: 'siwc', protocol: 'siwc-responses' });
    connection = f.store.models.setOAuthCredentials(connection.id, oauth(connection), expectation(connection));
    const binding = f.store.models.resolve({ purpose: 'conversation', selection: selection(connection) })!;
    connection = f.store.models.setAuthState(connection.id, 'scope-required', expectation(connection));
    for (const enabled of [false, true]) connection = f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision,
      name: 'Renamed', kind: 'siwc', protocol: 'siwc-responses', enabled });
    assert.equal(connection.status, 'scope-required');
    assert.throws(() => f.store.models.assertBinding(binding), /不可用/);
    assert.throws(() => f.store.models.setDefaults({ global: { ...selection(connection), maxOutputTokens: 100 }, expectedRevision: 1 }), /不支持/);
    assert.throws(() => f.store.models.upsert({ name: 'Wrong endpoint', kind: 'siwc', protocol: 'siwc-responses', endpoint: 'https://attacker.invalid/v1' }));
    assert.match(f.store.models.getOrCreateHostId(), /^urn:uuid:/);
    const host = f.store.models.getOrCreateHostId(); f.reopen(); assert.equal(f.store.models.getOrCreateHostId(), host);
  } finally { f.close(); }
});

test('verified identity without model scopes persists without inventing access tokens', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'Identity only', kind: 'siwc', protocol: 'siwc-responses' });
    connection = f.store.models.setOAuthIdentity(connection.id, { issuer: 'https://issuer.invalid', clientId: 'identity-client', subject: 'owner-one' }, expectation(connection));
    assert.equal(connection.status, 'scope-required'); assert.equal(connection.credentialConfigured, false);
    assert.equal(f.store.models.getCredential(connection.id), undefined);
    assert.equal(connection.identity?.subject, 'owner-one');
    f.reopen(); assert.equal(f.store.models.get(connection.id)?.status, 'scope-required');
    const binding = f.store.models.resolve({ purpose: 'conversation', selection: selection(connection) })!;
    assert.throws(() => f.store.models.assertBinding(binding), /不可用/);
    assert.throws(() => f.store.models.setOAuthIdentity(connection.id, { issuer: 'https://issuer.invalid', clientId: 'identity-client', subject: 'owner-two' }, expectation(connection)), /账号与原连接不符/);
  } finally { f.close(); }
});

test('public redaction covers all accounts, pending refresh tokens and the independent Hub key', async () => {
  const f = fixture();
  try {
    await f.store.updateSettings({ apiKey: 'private-legacy-hub-key' });
    const api = f.store.models.upsert({ name: 'API', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://fixture.invalid/v1', apiKey: 'private-other-api-key' });
    let siwc = f.store.models.upsert({ name: 'ChatGPT', kind: 'siwc', protocol: 'siwc-responses' });
    siwc = f.store.models.setOAuthCredentials(siwc.id, oauth(siwc, { idToken: 'private-id-token', pendingRefresh: {
      accessToken: 'private-pending-access', refreshToken: 'private-pending-refresh', idToken: 'private-pending-id',
      scope: 'chatgpt.tokens.use.direct', expiresAt: Date.now() + 100_000, receivedAt: Date.now(),
    } }), expectation(siwc));
    f.store.models.archive(api.id, api.editRevision);
    const secrets = ['private-legacy-hub-key', 'private-other-api-key', 'private-access-one', 'private-refresh-one', 'private-id-token',
      'private-pending-access', 'private-pending-refresh', 'private-pending-id'];
    assert.equal(f.store.models.redact(secrets.join(' | ')), secrets.map(() => '[REDACTED]').join(' | '));
    assert.equal(f.store.models.redact('ordinary visible text'), 'ordinary visible text');
    assert.equal(siwc.identity?.subject, 'owner-one');
  } finally { f.close(); }
});

test('environment credentials remain bound to the migrated endpoint and rejected removal is mutation-free', () => {
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'fixture-environment-key';
  const f = fixture();
  try {
    const legacy = f.store.models.directory().connections[0];
    assert.equal(legacy.credentialSource, 'environment');
    f.store.models.setDefaults({ global: null, expectedRevision: 1 });
    assert.throws(() => f.store.models.remove(legacy.id, legacy.editRevision), /只能停用/);
    assert.deepEqual(f.store.models.get(legacy.id), legacy);
    assert.throws(() => f.store.models.upsert({ id: legacy.id, expectedRevision: legacy.editRevision, name: legacy.name, kind: 'api-key',
      protocol: legacy.protocol, endpoint: 'https://different.invalid/v1' }), /环境凭据绑定原地址/);
    assert.equal(f.store.models.get(legacy.id)?.endpoint, legacy.endpoint);
  } finally { f.close(); if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});

test('recent diagnostics remain scoped, redacted and durable without changing authentication or selection', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'Quota account', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://quota.invalid/v1', apiKey: 'private-diagnostic-key' });
    const other = f.store.models.upsert({ name: 'Other account', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://other.invalid/v1' });
    const expected = { expectedIdentityRevision: connection.identityRevision, expectedBindingRevision: connection.bindingRevision };
    assert.equal(f.store.models.recordDiagnostic(connection.id, { category: 'quota', message: 'Quota detail private-diagnostic-key', code: 'usage_limit',
      status: 429, at: '2026-11-14T00:00:00.000Z', modelId: 'fixture' }, expected), true);
    const recorded = f.store.models.get(connection.id)?.recentDiagnostic;
    assert.equal(recorded?.message, 'Quota detail [REDACTED]');
    assert.equal(f.store.models.get(connection.id)?.status, 'ready', 'quota does not revoke authentication');
    assert.equal(f.store.models.get(other.id)?.recentDiagnostic, undefined);
    connection = f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: 'New label', kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint });
    f.store.models.setCatalog(connection.id, [{ id: 'fixture', name: 'Fixture', source: 'provider' }]);
    assert.deepEqual(f.store.models.get(connection.id)?.recentDiagnostic, recorded, 'renaming and fetching model listings do not count as successful inference');
    f.reopen(); assert.deepEqual(f.store.models.get(connection.id)?.recentDiagnostic, recorded);
    assert.equal(f.store.models.clearDiagnostic(connection.id, expected), true);
    assert.equal(f.store.models.get(connection.id)?.recentDiagnostic, undefined);
    assert.equal(f.store.models.clearDiagnostic(other.id, { expectedIdentityRevision: other.identityRevision }), true);
  } finally { f.close(); }
});

test('late diagnostics and successful responses cannot overwrite a repaired connection identity', () => {
  const f = fixture();
  try {
    let connection = f.store.models.upsert({ name: 'Repair', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://repair.invalid/v1', apiKey: 'private-before' });
    const old = { expectedIdentityRevision: connection.identityRevision, expectedBindingRevision: connection.bindingRevision };
    connection = f.store.models.upsert({ id: connection.id, expectedRevision: connection.editRevision, name: connection.name, kind: connection.kind,
      protocol: connection.protocol, endpoint: connection.endpoint, apiKey: 'private-after' });
    const current = { expectedIdentityRevision: connection.identityRevision, expectedBindingRevision: connection.bindingRevision };
    const latest = { category: 'transport' as const, message: 'New identity network unavailable', status: 503, at: '2026-11-14T00:01:00.000Z' };
    assert.equal(f.store.models.recordDiagnostic(connection.id, latest, current), true);
    assert.equal(f.store.models.recordDiagnostic(connection.id, { ...latest, message: 'Stale error' }, old), false);
    assert.equal(f.store.models.clearDiagnostic(connection.id, old), false);
    assert.deepEqual(f.store.models.get(connection.id)?.recentDiagnostic, latest);
    assert.equal(f.store.models.recordDiagnostic('missing-connection', latest, current), false);
    assert.equal(f.store.models.clearDiagnostic(connection.id, current), true);
  } finally { f.close(); }
});
