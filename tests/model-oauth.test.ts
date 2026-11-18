import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Store } from '../server/store.js';
import { SiwcAuthService, SIWC_ISSUER, SIWC_RESOURCE, validateSiwcRedirect } from '../server/models/siwc.js';
import type { OAuthCredentials } from '../server/models/connections.js';
import type { SiwcLoginStart } from '../shared/model-connections.js';
import { modelReasoningOptions } from '../shared/model-connections.js';

const keys = generateKeyPair('RS256');
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; };
async function fixture(catalog: unknown = { models: [{ slug: 'available-model', display_name: 'Available model', visibility: 'list' },
  { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' }] }) {
  const prefix = join(tmpdir(), 'rae-model-oauth-'); const directory = mkdtempSync(prefix); const store = new Store(directory);
  const key = await keys; const jwk = { ...await exportJWK(key.publicKey), kid: 'fixture' };
  const seen: Array<{ url: string; body: URLSearchParams }> = [];
  let nonce = ''; let subject = 'fixture-owner'; let clientId = 'fixture_client'; let plan = true;
  let tokenHook: ((body: URLSearchParams) => Promise<Response | undefined>) | undefined;
  let jwksUnavailable = false;
  const signed = () => new SignJWT({ nonce, email: 'same@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setIssuer(SIWC_ISSUER).setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime('1h').sign(key.privateKey);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body : undefined);
    seen.push({ url, body });
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: SIWC_ISSUER, authorization_endpoint: SIWC_ISSUER + '/api/accounts/authorize',
      token_endpoint: SIWC_ISSUER + '/api/accounts/oauth/token', jwks_uri: SIWC_ISSUER + '/jwks', revocation_endpoint: SIWC_ISSUER + '/revoke' });
    if (url.endsWith('/jwks')) return jwksUnavailable ? new Response('', { status: 503 }) : Response.json({ keys: [jwk] });
    if (url.endsWith('/revoke')) return new Response('', { status: 200 });
    if (url.endsWith('/models')) return Response.json(catalog);
    if (url.endsWith('/oauth/token')) {
      const replacement = await tokenHook?.(body); if (replacement) return replacement;
      if (body.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
      return Response.json({ id_token: await signed(), scope: plan ? scopes : 'openid profile email', access_token: 'login-access', token_type: 'Bearer', expires_in: 3600,
        ...(plan ? { refresh_token: 'login-refresh' } : {}) });
    }
    assert.fail('unexpected synthetic URL ' + url);
  };
  const auth = new SiwcAuthService(store.models, { fetch: fetcher });
  return { store, auth, fetcher, seen, directory, signed,
    set nonce(value: string) { nonce = value; }, set subject(value: string) { subject = value; }, set clientId(value: string) { clientId = value; },
    set plan(value: boolean) { plan = value; }, set tokenHook(value: typeof tokenHook) { tokenHook = value; }, set jwksUnavailable(value: boolean) { jwksUnavailable = value; },
    async start(connectionId?: string) { const result = await auth.start({ connectionId, redirectUri: 'http://127.0.0.1:14555/auth/callback' }); nonce = new URL(result.authUrl).searchParams.get('nonce')!; return result; },
    async close() { await auth.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); } };
}
function callback(start: SiwcLoginStart, clientId = 'fixture_client'): string {
  const url = new URL(start.redirectUri); url.search = new URLSearchParams({ state: new URL(start.authUrl).searchParams.get('state')!, code: 'one-time-code', client_id: clientId }).toString(); return url.href;
}
function seed(store: Store, overrides: Partial<OAuthCredentials> = {}) {
  const item = store.models.upsert({ name: 'Fixture account', kind: 'siwc', protocol: 'siwc-responses' });
  store.models.setOAuthCredentials(item.id, { kind: 'siwc', issuer: SIWC_ISSUER, clientId: 'fixture_client', subject: 'fixture-owner',
    accessToken: 'old-access', refreshToken: 'old-refresh', scope: scopes, expiresAt: Date.now() - 1000, ...overrides },
    { expectedCredentialVersion: item.credentialVersion, expectedIdentityRevision: item.identityRevision });
  return item.id;
}

test('SIWC validates loopback target, state, PKCE, nonce and signed identity; callback replay never exchanges twice', async () => {
  for (const bad of ['http://localhost:14555/auth/callback', 'https://127.0.0.1:14555/auth/callback', 'http://127.0.0.1:14555/other', 'http://127.0.0.1:14555/auth/callback?x=1', 'http://user@127.0.0.1:14555/auth/callback']) assert.throws(() => validateSiwcRedirect(bad));
  const f = await fixture();
  try {
    const start = await f.start(); const authorize = new URL(start.authUrl);
    assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.match(authorize.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/); assert.equal(authorize.searchParams.has('id_token_hint'), false);
    const wrong = new URL(callback(start)); wrong.searchParams.set('state', 'unrelated');
    await assert.rejects(f.auth.complete(start.loginId, wrong.href), /不匹配/); assert.equal(f.auth.status(start.loginId).status, 'pending');
    const [result, replay] = await Promise.all([f.auth.complete(start.loginId, callback(start)), f.auth.complete(start.loginId, callback(start))]);
    assert.equal(result.status, 'completed'); assert.equal(replay.status, 'completed');
    const exchange = f.seen.find(item => item.body.get('grant_type') === 'authorization_code')!.body;
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), authorize.searchParams.get('code_challenge'));
    assert.equal(exchange.get('client_id'), 'fixture_client'); assert.equal(exchange.get('redirect_uri'), start.redirectUri); assert.equal(exchange.get('resource'), SIWC_RESOURCE);
    assert.equal(f.store.models.get(start.connectionId)?.status, 'ready'); assert.equal(await f.auth.accessToken(start.connectionId), 'login-access');
    await f.auth.complete(start.loginId, callback(start)); assert.equal(f.seen.filter(item => item.body.get('grant_type') === 'authorization_code').length, 1);
    const models = await f.auth.listModels(start.connectionId); assert.deepEqual(models.map(item => item.id), ['available-model']);
    assert.equal(JSON.stringify(f.store.models.directory()).includes('login-access'), false);
  } finally { await f.close(); }
});

test('SIWC catalog preserves advertised reasoning levels and context windows without inferring missing limits', async () => {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const f = await fixture({ models: [
    { slug: 'reasoning-model', display_name: 'Reasoning model', visibility: 'list', context_window: 272_000, max_context_window: 1_050_000,
      supported_reasoning_levels: [...efforts.map(effort => ({ effort, description: 'Provider description' })), { effort: 'high' },
        { effort: '' }, { effort: 123 }, null, { description: 'Not an effort' }], input_modalities: ['text', 'image', 'text', null, 3] },
    { slug: 'unknown-capabilities', display_name: 'Unknown capabilities', visibility: 'list', context_window: '128000', max_context_window: 128_000 },
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'ultra' }] },
  ] });
  try {
    const start = await f.start(); await f.auth.complete(start.loginId, callback(start));
    // Replace the old name-only cache written by 0.1.25, without changing the account or defaults.
    f.store.models.setCatalog(start.connectionId, [{ id: 'reasoning-model', name: 'Reasoning model', source: 'provider' }]);
    const before = f.store.models.get(start.connectionId)!;
    const defaults = f.store.models.getDefaults();
    const models = await f.auth.listModels(start.connectionId);
    assert.deepEqual(models.map(model => model.id), ['reasoning-model', 'unknown-capabilities']);
    assert.deepEqual(models[0].reasoning, efforts); assert.deepEqual(models[0].inputModalities, ['text', 'image']);
    assert.equal(models[0].contextWindow, 272_000);
    assert.equal(models[1].reasoning, undefined); assert.equal(models[1].contextWindow, undefined);
    const connection = f.store.models.get(start.connectionId)!;
    assert.deepEqual(connection.models, models);
    assert.deepEqual(modelReasoningOptions(connection, 'reasoning-model'), ['default', ...efforts]);
    assert.deepEqual(modelReasoningOptions(connection, 'unknown-capabilities'), ['default']);
    for (const field of ['identityRevision', 'bindingRevision', 'credentialVersion', 'editRevision'] as const) assert.equal(connection[field], before[field]);
    assert.deepEqual(f.store.models.getDefaults(), defaults);
    const selection = { connectionId: connection.id, modelId: 'reasoning-model', reasoning: 'ultra', maxOutputTokens: null };
    f.store.models.setScene('catalog-scene', { preference: { mode: 'explicit', selection }, expectedRevision: 0 });
    const binding = f.store.models.resolve({ purpose: 'task', caseId: 'catalog-scene' });
    assert.equal(binding?.selection.reasoning, 'ultra'); assert.equal(binding?.contextWindow, 272_000);
    f.store.models.upsert({ id: connection.id, name: connection.name, kind: 'siwc', protocol: 'siwc-responses', endpoint: connection.endpoint,
      expectedRevision: connection.editRevision, contextWindows: [{ modelId: 'unknown-capabilities', contextWindow: 92_000 }] });
    const manuallyConfigured = f.store.models.resolve({ purpose: 'task', selection: { ...selection, modelId: 'unknown-capabilities' } });
    assert.equal(manuallyConfigured?.contextWindow, 92_000);
    assert.equal(f.store.models.get(connection.id)?.identityRevision, before.identityRevision);
    assert.equal(f.seen.some(request => request.url.endsWith('/responses')), false);
  } finally { await f.close(); }
});

test('declined plan permission retains verified identity without manufacturing credentials', async () => {
  const f = await fixture();
  try { f.plan = false; const start = await f.start(); assert.equal((await f.auth.complete(start.loginId, callback(start))).status, 'completed');
    const connection = f.store.models.get(start.connectionId)!; assert.equal(connection.status, 'scope-required'); assert.equal(connection.identity?.subject, 'fixture-owner');
    assert.equal(f.store.models.getCredential(start.connectionId), undefined); await assert.rejects(f.auth.accessToken(start.connectionId));
    const retry = await f.start(start.connectionId); assert.equal(new URL(retry.authUrl).searchParams.get('client_id'), 'fixture_client');
  } finally { await f.close(); }
});

test('signed ID token with a different nonce cannot authorize the pending registration', async () => {
  const f = await fixture();
  try { const start = await f.start(); f.nonce = 'wrong-nonce';
    assert.equal((await f.auth.complete(start.loginId, callback(start))).status, 'failed');
    assert.equal(f.store.models.getCredential(start.connectionId), undefined); assert.equal(f.store.models.get(start.connectionId)?.identity, undefined);
  } finally { await f.close(); }
});

test('ID-token signature failure cannot publish credentials even when all visible identity claims match', async () => {
  const f = await fixture();
  try {
    const start = await f.start();
    f.tokenHook = async () => {
      const jwt = (await f.signed()).split('.'); jwt[2] = (jwt[2][0] === 'A' ? 'B' : 'A') + jwt[2].slice(1);
      return Response.json({ access_token: 'untrusted-access', refresh_token: 'untrusted-refresh', id_token: jwt.join('.'), scope: scopes, token_type: 'Bearer', expires_in: 3600 });
    };
    assert.equal((await f.auth.complete(start.loginId, callback(start))).status, 'failed');
    assert.equal(f.store.models.getCredential(start.connectionId), undefined);
    assert.equal(f.seen.find(item => item.url.endsWith('/revoke'))?.body.get('token'), 'untrusted-refresh');
  } finally { await f.close(); }
});

test('same email stays in separate registrations and reconnect rejects a different signed subject', async () => {
  const f = await fixture();
  try {
    const first = await f.start(); await f.auth.complete(first.loginId, callback(first));
    f.clientId = 'second_client'; f.subject = 'second-owner'; const second = await f.start();
    assert.equal((await f.auth.complete(second.loginId, callback(second, 'second_client'))).status, 'completed');
    assert.notEqual(first.connectionId, second.connectionId); assert.equal(f.store.models.get(first.connectionId)?.identity?.subject, 'fixture-owner');
    f.clientId = 'fixture_client'; const reconnect = await f.start(first.connectionId);
    assert.equal((await f.auth.complete(reconnect.loginId, callback(reconnect))).status, 'failed');
    assert.equal(f.store.models.get(first.connectionId)?.identity?.subject, 'fixture-owner');
  } finally { await f.close(); }
});

test('cancellation drains an accepted token exchange and prevents a late credential commit', async () => {
  const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
  try {
    f.tokenHook = async () => { entered.resolve(); await release.promise; return undefined; };
    const start = await f.start(); const finishing = f.auth.complete(start.loginId, callback(start)); await entered.promise;
    let drained = false; const cancelling = f.auth.cancel(start.loginId).then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
    release.resolve(); await cancelling; assert.equal((await finishing).status, 'cancelled'); assert.equal(f.store.models.getCredential(start.connectionId), undefined);
    assert.equal(f.store.models.getOAuthRegistration(start.connectionId)?.clientId, 'fixture_client');
    assert.equal(f.seen.find(item => item.url.endsWith('/revoke'))?.body.get('token'), 'login-refresh');
  } finally { release.resolve(); await f.close(); }
});

test('refresh is single-flight; logout drains rotation and revokes its latest refresh token', async () => {
  const f = await fixture(); const entered = deferred<void>(); const release = deferred<void>();
  try {
    const id = seed(f.store); f.tokenHook = async body => { if (body.get('grant_type') === 'refresh_token') { entered.resolve(); await release.promise; } return undefined; };
    const first = f.auth.accessToken(id); const second = f.auth.accessToken(id); const settled = Promise.allSettled([first, second]); await entered.promise;
    const logout = f.auth.logout(id); await assert.rejects(f.auth.accessToken(id), /退出/); release.resolve(); await settled;
    assert.equal((await logout).remoteRevoked, true); assert.equal(f.store.models.getCredential(id), undefined);
    assert.equal(f.seen.filter(item => item.body.get('grant_type') === 'refresh_token').length, 1);
    assert.equal(f.seen.find(item => item.url.endsWith('/revoke'))?.body.get('token'), 'rotated-refresh');
  } finally { release.resolve(); await f.close(); }
});

test('refresh checkpoint retains a rotated session across identity-key outage and never repeats the consumed grant', async () => {
  const f = await fixture();
  try {
    const id = seed(f.store); f.nonce = 'not-needed-for-refresh'; f.jwksUnavailable = true;
    f.tokenHook = async () => Response.json({ access_token: 'checkpoint-access', refresh_token: 'checkpoint-refresh', token_type: 'Bearer', expires_in: 3600, scope: scopes, id_token: await f.signed() });
    await assert.rejects(f.auth.accessToken(id));
    const persisted = f.store.models.getCredential(id); assert.equal(persisted?.kind === 'siwc' && persisted.pendingRefresh?.refreshToken, 'checkpoint-refresh');
    f.jwksUnavailable = false;
    const resumed = new SiwcAuthService(f.store.models, { fetch: f.fetcher });
    try { assert.equal(await resumed.accessToken(id), 'checkpoint-access'); }
    finally { await resumed.close(); }
    assert.equal(f.seen.filter(item => item.body.get('grant_type') === 'refresh_token').length, 1);
  } finally { await f.close(); }
});

test('temporary refresh failure preserves credentials, terminal refresh failure clears them without switching accounts', async () => {
  const f = await fixture();
  try {
    const id = seed(f.store);
    f.tokenHook = async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    await assert.rejects(f.auth.accessToken(id)); assert.equal(f.store.models.getCredential(id)?.kind, 'siwc');
    f.tokenHook = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    await assert.rejects(f.auth.accessToken(id)); assert.equal(f.store.models.getCredential(id), undefined);
    assert.equal(f.store.models.getOAuthRegistration(id)?.clientId, 'fixture_client');
  } finally { await f.close(); }
});
