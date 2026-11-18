import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createGmailProvider } from '../server/connectors/gmail.js';
import { createOutlookProvider } from '../server/connectors/outlook.js';
import { ConnectorProviderError } from '../server/connectors/types.js';

const gmail = createGmailProvider({ RAE_GMAIL_CLIENT_ID: 'gmail-client', RAE_GMAIL_CLIENT_SECRET: 'gmail-secret' })!;
const outlook = createOutlookProvider({ RAE_OUTLOOK_CLIENT_ID: 'outlook-client', RAE_OUTLOOK_CLIENT_SECRET: 'outlook-secret' })!;
const signal = new AbortController().signal;
const token = { accessToken: 'access', refreshToken: 'refresh' };
const oauth = { state: 'one-use-state', challenge: createHash('sha256').update('verifier').digest('base64url'), redirectUri: 'https://example.test/connector-callback' };
const tenant = '22222222-2222-2222-2222-222222222222';
const owner = '11111111-1111-1111-1111-111111111111';
function microsoftMetadata(url: URL): Response | undefined {
  if (url.pathname.endsWith('/discovery/instance')) return Response.json({
    tenant_discovery_endpoint: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.windows.net', aliases: ['login.microsoftonline.com', 'login.windows.net', 'sts.windows.net'] }],
  });
  if (url.pathname.endsWith('/v2.0/.well-known/openid-configuration')) {
    const selected = url.pathname.split('/')[1]; const root = `https://login.microsoftonline.com/${selected}`;
    return Response.json({ authorization_endpoint: `${root}/oauth2/v2.0/authorize`, token_endpoint: `${root}/oauth2/v2.0/token`,
      issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0', end_session_endpoint: `${root}/oauth2/v2.0/logout`,
      jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' });
  }
}
function microsoftToken(access: string, refresh: string, nonce?: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { aud: 'outlook-client', iss: `https://login.microsoftonline.com/${tenant}/v2.0`, sub: owner, oid: owner, tid: tenant,
    preferred_username: 'owner@example.test', iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) };
  return { access_token: access, refresh_token: refresh, expires_in: 3600, ext_expires_in: 3600, token_type: 'Bearer',
    scope: 'https://graph.microsoft.com/Mail.Read openid profile offline_access',
    client_info: encode({ uid: owner, utid: tenant }), id_token: `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.fixture` };
}

test('mail providers use offline PKCE OAuth and preserve or rotate refresh credentials', async t => {
  t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === 'login.microsoftonline.com') { const metadata = microsoftMetadata(url); if (metadata) return metadata; }
    const body = new URLSearchParams(init?.body as string);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    if (body.get('grant_type') === 'authorization_code') {
      assert.equal(body.get('code_verifier'), 'verifier');
      assert.equal(body.get('code'), 'code');
      assert.equal(body.get('redirect_uri'), oauth.redirectUri);
      return Response.json(url.hostname === 'oauth2.googleapis.com'
        ? { access_token: 'first-access', refresh_token: 'first-refresh', expires_in: 3600 }
        : microsoftToken('first-access', 'first-refresh', oauth.challenge));
    }
    assert.equal(body.get('refresh_token'), token.refreshToken);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'second-access', expires_in: 3600 });
    assert.equal(url.hostname, 'login.microsoftonline.com');
    return Response.json(microsoftToken('second-access', 'rotated'));
  });
  const googleUrl = await gmail.authorize({ ...oauth, scope: 'INBOX' });
  assert.equal(googleUrl.origin, 'https://accounts.google.com');
  assert.equal(googleUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(googleUrl.searchParams.get('access_type'), 'offline');
  const outlookUrl = await outlook.authorize({ ...oauth, scope: 'Inbox' });
  assert.equal(outlookUrl.origin, 'https://login.microsoftonline.com');
  assert.ok(outlookUrl.searchParams.get('scope')?.split(' ').includes('https://graph.microsoft.com/Mail.Read'));
  assert.ok(outlookUrl.searchParams.get('scope')?.split(' ').includes('offline_access'));
  for (const url of [googleUrl, outlookUrl]) {
    assert.equal(url.searchParams.get('state'), oauth.state);
    assert.equal(url.searchParams.get('code_challenge'), oauth.challenge);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.has('client_secret'), false);
  }
  for (const provider of [gmail, outlook]) {
    const exchanged = await provider.exchange({ code: 'code', redirectUri: oauth.redirectUri, verifier: 'verifier' }, signal);
    if (provider === gmail) assert.equal(exchanged.refreshToken, 'first-refresh');
    else { assert.ok(exchanged.msalAccountId); assert.match(exchanged.msalCache!, /first-refresh/); }
    assert.ok(exchanged.expiresAt! > Date.now());
  }
  assert.equal((await gmail.refresh(token, oauth.redirectUri, signal)).refreshToken, 'refresh');
  const migrated = await outlook.refresh(token, oauth.redirectUri, signal);
  assert.equal(migrated.refreshToken, undefined);
  assert.match(migrated.msalCache!, /rotated/);
  assert.equal(migrated.msalAccountId, `${owner}.${tenant}`);
});

test('Gmail starts at current history, resumes a bounded batch, and verifies label before preview', async t => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  let expired = false;
  const previews: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    if (url.pathname.endsWith('/labels/Label_42')) return Response.json({ id: 'Label_42' });
    if (url.pathname.endsWith('/profile')) return Response.json({ historyId: expired ? '999' : '123', emailAddress: 'owner@example.test' });
    if (url.pathname.endsWith('/history')) {
      assert.equal(url.searchParams.get('startHistoryId'), '123');
      assert.equal(url.searchParams.get('labelId'), 'Label_42');
      assert.equal(url.searchParams.get('historyTypes'), 'messageAdded');
      if (expired) return Response.json({}, { status: 404 });
      return Response.json({ historyId: '130', history: [{ messagesAdded: ids.map(id => ({ message: { id } })) }] });
    }
    const id = url.pathname.split('/').at(-1)!;
    if (url.searchParams.get('format') === 'metadata') {
      assert.equal(url.searchParams.get('metadataHeaders'), 'Subject');
      return Response.json({ id, labelIds: id === 'b' ? ['INBOX'] : ['Label_42'], payload: { headers: [{ name: 'Subject', value: `Mail ${id}` }] } });
    }
    assert.equal(url.searchParams.get('fields'), 'id,labelIds,snippet');
    previews.push(id);
    return Response.json({ id, labelIds: id === 'd' ? ['INBOX'] : ['Label_42'], snippet: 'a'.repeat(1000), payload: { body: 'unexpected full body' } });
  });
  const input = { token, scope: 'Label_42', signal };
  const initial = await gmail.scan(input);
  assert.deepEqual(initial.changes, []);
  const first = await gmail.scan({ ...input, cursor: initial.cursor });
  assert.deepEqual(first.changes.map(change => change.id), ['a', 'c', 'e', 'f']);
  assert.equal(previews.includes('b'), false);
  assert.equal(first.changes[0].content.includes('unexpected full body'), false);
  assert.ok(first.changes[0].content.length < 700);
  assert.equal(first.more, true);
  const second = await gmail.scan({ ...input, cursor: first.cursor });
  assert.deepEqual(second.changes.map(change => change.id), ['g', 'h']);
  assert.equal(JSON.parse(second.cursor).historyId, '130');
  expired = true;
  const reset = await gmail.scan({ ...input, cursor: initial.cursor });
  assert.deepEqual(reset.changes, []);
  assert.match(reset.notice!, /可能遗漏/);
  assert.equal(JSON.parse(reset.cursor).historyId, '999');
});

test('Outlook consumes only selected folder delta and rejects forged continuation URLs', async t => {
  const root = 'https://graph.microsoft.com/v1.0/me/mailFolders/Folder%2Fid%3D/messages/delta';
  const next = `${root}?$skiptoken=next`;
  const delta = "https://graph.microsoft.com/v1.0/me/mailfolders('Folder%2Fid%3D')/messages/delta?$deltatoken=delta";
  const input = { token, scope: 'Inbox', signal };
  let since = '';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (request: URL, init?: RequestInit) => {
    const url = new URL(request);
    calls++;
    assert.equal(url.origin, 'https://graph.microsoft.com');
    assert.match((init?.headers as Record<string, string>).Prefer, /ImmutableId/);
    if (url.pathname.endsWith('/inbox')) {
      assert.equal(url.searchParams.get('$select'), 'id');
      return Response.json({ id: 'Folder/id=' });
    }
    if (url.href === next) return Response.json({ value: [], '@odata.deltaLink': delta });
    if (url.href === delta) return Response.json({}, { status: 410 });
    assert.equal(url.searchParams.get('changeType'), 'created');
    assert.equal(url.searchParams.get('$filter'), `receivedDateTime ge ${since}`);
    assert.equal(url.searchParams.get('$select'), 'id,parentFolderId,subject,receivedDateTime,bodyPreview,webLink');
    const email = { id: 'new', parentFolderId: 'Folder/id=', subject: 'New email', receivedDateTime: since, bodyPreview: 'preview' };
    return Response.json({ value: [email, { ...email, id: 'old', receivedDateTime: '2000-01-01T00:00:00Z' },
      { ...email, id: 'outside', parentFolderId: 'other' }, { id: 'deleted', '@removed': { reason: 'deleted' } }], '@odata.nextLink': next });
  });
  const baseline = await outlook.scan(input);
  assert.equal(calls, 1);
  assert.deepEqual(baseline.changes, []);
  const checkpoint = JSON.parse(baseline.cursor);
  since = checkpoint.since;
  const page = await outlook.scan({ ...input, cursor: baseline.cursor });
  assert.deepEqual(page.changes.map(change => change.id), ['new']);
  assert.equal(page.more, true);
  const last = await outlook.scan({ ...input, cursor: page.cursor });
  assert.equal(last.more, false);
  const expired = await outlook.scan({ ...input, cursor: last.cursor });
  assert.match(expired.notice!, /可能遗漏/);
  const callsBeforeForgeries = calls;
  for (const link of [next.replace('graph.microsoft.com', 'example.test'), next.replace('Folder%2Fid%3D', 'Outside'), `${next}&$select=body`]) {
    await assert.rejects(outlook.scan({ ...input, cursor: JSON.stringify({ ...checkpoint, link }) }), /超出已授权文件夹/);
  }
  assert.equal(calls, callsBeforeForgeries);
});

test('Gmail binds legacy and new cursors to the original account before handling history expiry', async t => {
  let account = 'owner@example.test';
  let histories = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    const url = new URL(input);
    const authorization = new Headers(init?.headers).get('Authorization');
    if (url.pathname.endsWith('/profile')) return Response.json({ historyId: '100', emailAddress: authorization === 'Bearer previous' ? 'owner@example.test' : account });
    if (url.pathname.endsWith('/history')) { histories++; return Response.json({ historyId: '100' }); }
    throw new Error('Unexpected request');
  });
  const input = { token, scope: 'INBOX', signal, cursor: JSON.stringify({ labelId: 'INBOX', historyId: '50' }) };
  const upgraded = await gmail.scan(input);
  assert.equal(JSON.parse(upgraded.cursor).account, 'owner@example.test');
  account = 'other@example.test';
  await assert.rejects(gmail.scan({ ...input, cursor: upgraded.cursor }), error => error instanceof ConnectorProviderError && error.needsAttention && error.status === 409);
  assert.equal(histories, 1);
  await assert.rejects(gmail.validateReauthorization!({ previousToken: { accessToken: 'previous' }, nextToken: token,
    scope: 'INBOX', cursor: input.cursor }, signal), /邮箱身份已变化/);
  await assert.rejects(gmail.validateReauthorization!({ previousToken: { accessToken: 'expired' }, nextToken: token,
    scope: 'INBOX', cursor: upgraded.cursor }, signal), /邮箱身份已变化/);
});

test('Outlook refuses a changed inbox before delta expiry can reset the observation baseline', async t => {
  let folder = 'original';
  let deltaCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/inbox')) return Response.json({ id: folder });
    deltaCalls++; return Response.json({}, { status: 410 });
  });
  const initial = await outlook.scan({ token, scope: 'inbox', signal });
  folder = 'different';
  const cursor = JSON.stringify({ ...JSON.parse(initial.cursor), link: 'https://graph.microsoft.com/v1.0/me/mailfolders/original/messages/delta?$deltatoken=expired' });
  await assert.rejects(outlook.scan({ token, scope: 'inbox', signal, cursor }), error => error instanceof ConnectorProviderError && error.needsAttention && error.status === 409);
  await assert.rejects(outlook.validateReauthorization!({ previousToken: token, nextToken: token, scope: 'inbox', cursor }, signal), /邮箱身份已变化/);
  assert.equal(deltaCalls, 0);
});

test('official Google auth does not retry revoked grants or retain SDK errors containing secrets', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: URL, init?: RequestInit) => {
    calls++; assert.equal(init?.redirect, 'error');
    return Response.json({ error: 'invalid_grant', error_description: 'PRIVATE_TOKEN_AND_ACCOUNT' }, { status: 400 });
  });
  await assert.rejects(gmail.refresh(token, oauth.redirectUri, signal), error => {
    assert.ok(error instanceof ConnectorProviderError);
    assert.equal(error.status, 401); assert.equal(error.needsAttention, true);
    assert.doesNotMatch(error.message, /PRIVATE_TOKEN_AND_ACCOUNT/); return true;
  });
  assert.equal(calls, 1);
});

test('SDK data requests never silently refresh, expose retry-after, and keep response size bounded', async t => {
  let status = 401;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    const url = new URL(input); calls.push(url.hostname);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access');
    return status === 200 ? Response.json({ padding: 'x'.repeat(2 * 1024 * 1024) })
      : Response.json({ error: { code: status } }, { status, headers: { 'Retry-After': '120' } });
  });
  await assert.rejects(gmail.scan({ token, scope: 'INBOX', signal }), { status: 401 });
  await assert.rejects(outlook.scan({ token, scope: 'inbox', signal }), { status: 401 });
  assert.deepEqual(calls, ['gmail.googleapis.com', 'graph.microsoft.com']);
  status = 429;
  const earliest = Date.now() + 119_000;
  for (const provider of [gmail, outlook]) await assert.rejects(provider.scan({ token, scope: 'inbox', signal }), error =>
    error instanceof ConnectorProviderError && error.status === 429 && !error.needsAttention && error.retryAt! >= earliest);
  status = 200;
  for (const provider of [gmail, outlook]) await assert.rejects(provider.scan({ token, scope: 'inbox', signal }), /超出读取上限/);
  assert.equal(calls.length, 6);
});

test('Google refresh-token rotation is returned to the durable credential owner', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ access_token: 'access-next', refresh_token: 'refresh-next', expires_in: 120 }));
  const refreshed = await gmail.refresh(token, oauth.redirectUri, signal);
  assert.equal(refreshed.refreshToken, 'refresh-next');
  assert.equal(refreshed.accessToken, 'access-next');
  assert.equal(token.refreshToken, 'refresh');
});

test('MSAL refresh cache is returned, reloadable, account-bound and contains rotated refresh credentials', async t => {
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    const url = new URL(input); const metadata = microsoftMetadata(url); if (metadata) return metadata;
    assert.equal(init?.redirect, 'error');
    const body = new URLSearchParams(init?.body as string);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), refreshes === 0 ? 'refresh' : 'rotated-1');
    refreshes++;
    return Response.json(microsoftToken(`access-${refreshes}`, `rotated-${refreshes}`));
  });
  const first = await outlook.refresh(token, oauth.redirectUri, signal);
  assert.ok(outlook.canRefresh!(first));
  const second = await outlook.refresh(first, oauth.redirectUri, signal);
  assert.equal(second.accessToken, 'access-2'); assert.match(second.msalCache!, /rotated-2/);
  assert.doesNotMatch(second.msalCache!, /rotated-1/);
  assert.equal(first.msalAccountId, second.msalAccountId);
  await assert.rejects(outlook.refresh({ ...second, msalAccountId: 'other-account' }, oauth.redirectUri, signal), { status: 401, needsAttention: true });
  assert.equal(refreshes, 2);
});

test('mail SDK authorization and token requests settle cancellation before returning', async t => {
  for (const operation of ['gmail-token', 'outlook-token'] as const) {
    const controller = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    let settled = false;
    const mock = t.mock.method(globalThis, 'fetch', async (_input: URL, init?: RequestInit) => {
      assert.ok(init?.signal); reached();
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => { settled = true; reject(init.signal!.reason); }, { once: true });
      });
    });
    const work = operation === 'gmail-token'
      ? gmail.exchange({ code: 'code', redirectUri: oauth.redirectUri, verifier: 'verifier' }, controller.signal)
      : outlook.refresh(token, oauth.redirectUri, controller.signal);
    await started;
    const stop = new Error('owner stopped authorization');
    controller.abort(stop);
    await assert.rejects(Promise.resolve(work), error => error === stop);
    assert.equal(settled, true);
    mock.mock.restore();
  }
});

test('MSAL authentication errors and throttling are typed without retries or raw OAuth details', async t => {
  let status = 400;
  let tokenRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    const url = new URL(input); const metadata = microsoftMetadata(url); if (metadata) return metadata;
    tokenRequests++;
    return Response.json({ error: 'interaction_required', error_description: 'PRIVATE_TOKEN_AND_ACCOUNT' }, { status, headers: { 'Retry-After': '90' } });
  });
  await assert.rejects(outlook.refresh(token, oauth.redirectUri, signal), error => {
    assert.ok(error instanceof ConnectorProviderError);
    assert.equal(error.status, 401); assert.equal(error.needsAttention, true);
    assert.doesNotMatch(error.message, /PRIVATE_TOKEN_AND_ACCOUNT/); return true;
  });
  assert.equal(tokenRequests, 1);
  status = 429;
  // A rate-limit status takes precedence over any unrelated body string.
  await assert.rejects(outlook.refresh(token, oauth.redirectUri, signal), error => error instanceof ConnectorProviderError &&
    error.status === 429 && error.retryAt! >= Date.now() + 89_000);
  assert.equal(tokenRequests, 2);
});
