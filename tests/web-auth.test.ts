import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashWebPassword, loadWebAuthConfig, WebAuth, WebAuthError, type WebAuthConfig, type WebAuthRequest } from '../server/web-auth.js';

const password = 'isolated-test-password';
const passwordHash = await hashWebPassword(password);
const publicRequest: WebAuthRequest = { headers: { host: 'rae.example.com', origin: 'https://rae.example.com' } };
const config: WebAuthConfig = { username: 'rae', password: passwordHash, publicOrigin: 'https://rae.example.com' };
const cookieHeader = (cookie: string): string => cookie.split(';')[0];
const withCookie = (cookie: string): WebAuthRequest => ({ headers: { ...publicRequest.headers, cookie: cookieHeader(cookie) } });
const errorStatus = (expected: number) => (error: unknown) => error instanceof WebAuthError && error.status === expected;

async function removeFixture(directory: string): Promise<void> {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.match(basename(target), /^rae-(?:web-auth|auth-config)-/);
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
}

async function fixture(input: WebAuthConfig = config) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-web-auth-'));
  const dbPath = join(directory, 'sessions.sqlite');
  let instant = 1_000_000;
  const auth = new WebAuth(input, dbPath, { now: () => instant });
  return { directory, dbPath, auth, now: () => instant, advance: (milliseconds: number) => { instant += milliseconds; },
    async close() { await auth.close(); await removeFixture(directory); } };
}

test('public authentication fails closed before session/runtime storage is created; local auth is optional', async () => {
  assert.equal(loadWebAuthConfig({}), undefined);
  assert.equal(loadWebAuthConfig({ publicOrigin: '' }), undefined);
  assert.throws(() => loadWebAuthConfig({ publicOrigin: 'https://rae.example.com' }), /RAE_AUTH_FILE/);
  const directory = await mkdtemp(join(tmpdir(), 'rae-auth-config-'));
  const file = join(directory, 'credentials.json');
  try {
    assert.throws(() => loadWebAuthConfig({ credentialsFile: file, publicOrigin: 'https://rae.example.com' }), /RAE_AUTH_FILE/);
    assert.equal(existsSync(join(directory, 'sessions.sqlite')), false);
    await writeFile(file, JSON.stringify({ version: 1, username: 'rae', password: passwordHash }), { mode: 0o600 });
    assert.deepEqual(loadWebAuthConfig({ credentialsFile: file, publicOrigin: config.publicOrigin }), config);
    assert.equal(loadWebAuthConfig({ credentialsFile: file })?.publicOrigin, undefined);
    assert.throws(() => loadWebAuthConfig({ credentialsFile: file, publicOrigin: 'http://rae.example.com' }), /HTTPS/);
    for (const invalid of [{ version: 1, username: 'rae', password },
      { version: 1, username: 'rae', password: { ...passwordHash, salt: 'not-a-real-salt' } },
      { version: 1, username: 'rae', password: { ...passwordHash, hash: passwordHash.hash + '=' } },
      { version: 1, username: 'rae', password: passwordHash, plaintext: password },
      { version: 1, username: 'invalid:name', password: passwordHash }]) {
      await writeFile(file, JSON.stringify(invalid));
      assert.throws(() => loadWebAuthConfig({ credentialsFile: file }), /RAE_AUTH_FILE/);
    }
    if (process.platform !== 'win32') {
      await writeFile(file, JSON.stringify({ version: 1, username: 'rae', password: passwordHash }));
      for (const mode of [0o644, 0o660, 0o650]) {
        await chmod(file, mode);
        assert.throws(() => loadWebAuthConfig({ credentialsFile: file }), /RAE_AUTH_FILE/);
      }
      await chmod(file, 0o640);
      assert.ok(loadWebAuthConfig({ credentialsFile: file }));
    }
  } finally { await removeFixture(directory); }
});

test('credentials use salted scrypt and login issues a host-only secure cookie without exposing tokens in session views', async () => {
  const f = await fixture();
  try {
    const another = await hashWebPassword(password);
    assert.notEqual(another.salt, passwordHash.salt); assert.notEqual(another.hash, passwordHash.hash);
    assert.deepEqual(f.auth.session(publicRequest), { required: true, authenticated: false });
    const login = await f.auth.login({ username: 'rae', password }, publicRequest);
    assert.deepEqual(login.session, { required: true, authenticated: true, username: 'rae' });
    assert.match(login.cookie, /^__Host-rae_session=[A-Za-z0-9_-]{43};/);
    for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=604800', 'Secure']) assert.ok(login.cookie.includes(flag));
    assert.ok(!login.cookie.includes('Domain=') && !login.cookie.includes(password));
    assert.equal(f.auth.isAuthenticated(withCookie(login.cookie)), true);
    const token = cookieHeader(login.cookie).split('=')[1];
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT * FROM auth_sessions').get()!;
      assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
      assert.ok(!JSON.stringify(row).includes(token));
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('wrong username and wrong password return the same generic failure; malformed inputs never become sessions', async () => {
  const f = await fixture();
  try {
    const failures: string[] = [];
    for (const input of [{ username: 'not-rae', password }, { username: 'rae', password: 'incorrect' }]) {
      await assert.rejects(f.auth.login(input, publicRequest), error => {
        assert.ok(error instanceof WebAuthError); assert.equal(error.status, 401); failures.push(error.message); return true;
      });
    }
    assert.equal(failures[0], failures[1]);
    for (const input of [null, {}, { username: 'rae', password, admin: true }, { username: 'rae', password: 'x'.repeat(1025) }]) {
      await assert.rejects(f.auth.login(input, publicRequest), errorStatus(400));
    }
    assert.equal(f.auth.isAuthenticated(publicRequest), false);
  } finally { await f.close(); }
});

test('origin checks reject missing, cross-origin and forwarded-origin mutations without allowing localhost to bypass login', async () => {
  const f = await fixture();
  try {
    const rejected: WebAuthRequest[] = [
      { headers: { host: 'rae.example.com' } },
      { headers: { host: 'rae.example.com', origin: 'https://untrusted.example' } },
      { headers: { host: 'rae.example.com', origin: 'http://rae.example.com' } },
      { headers: { host: 'evil.example', origin: 'https://rae.example.com', 'x-forwarded-host': 'rae.example.com' } },
      { headers: { host: 'rae.example.com', origin: 'http://127.0.0.1:4317', 'x-forwarded-proto': 'https' } },
    ];
    for (const request of rejected) {
      assert.throws(() => f.auth.assertMutationOrigin(request), errorStatus(403));
      await assert.rejects(f.auth.login({ username: 'rae', password }, request), errorStatus(403));
      assert.throws(() => f.auth.logout(request), errorStatus(403));
    }
    const local = { headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } };
    f.auth.assertMutationOrigin(local);
    assert.deepEqual(f.auth.session(local), { required: true, authenticated: false });
    assert.equal(f.auth.isAuthenticated(local), false);
    assert.throws(() => f.auth.assertMutationOrigin({ headers: { ...local.headers, origin: 'http://127.0.0.1:5173' } }), errorStatus(403));
  } finally { await f.close(); }
});

test('sessions survive restart, expire after an absolute seven days and are invalid after credential rotation', async () => {
  const f = await fixture();
  try {
    const login = await f.auth.login({ username: 'rae', password }, publicRequest);
    await f.auth.close();
    const reopened = new WebAuth(config, f.dbPath, { now: f.now });
    try {
      assert.equal(reopened.isAuthenticated(withCookie(login.cookie)), true);
      f.advance(7 * 24 * 60 * 60 * 1000 - 1);
      assert.equal(reopened.isAuthenticated(withCookie(login.cookie)), true);
      f.advance(1);
      assert.equal(reopened.isAuthenticated(withCookie(login.cookie)), false);
    } finally { await reopened.close(); }
    const original = new WebAuth(config, f.dbPath, { now: f.now });
    const live = await original.login({ username: 'rae', password }, publicRequest); await original.close();
    const rotated = new WebAuth({ ...config, password: await hashWebPassword('rotated-test-password') }, f.dbPath, { now: f.now });
    try { assert.equal(rotated.isAuthenticated(withCookie(live.cookie)), false); } finally { await rotated.close(); }
  } finally { await f.close(); }
});

test('login rotates the presented session and logout revokes server-side access, including copied cookies', async () => {
  const f = await fixture();
  try {
    const first = await f.auth.login({ username: 'rae', password }, publicRequest);
    const second = await f.auth.login({ username: 'rae', password }, withCookie(first.cookie));
    assert.notEqual(first.cookie, second.cookie);
    assert.equal(f.auth.isAuthenticated(withCookie(first.cookie)), false);
    assert.equal(f.auth.isAuthenticated(withCookie(second.cookie)), true);
    const clear = f.auth.logout(withCookie(second.cookie));
    assert.match(clear, /Max-Age=0/); assert.match(clear, /HttpOnly/); assert.match(clear, /Secure/);
    assert.equal(f.auth.isAuthenticated(withCookie(second.cookie)), false);
    assert.equal(f.auth.logout(publicRequest), clear, 'Logout is idempotent for an absent session');
  } finally { await f.close(); }
});

test('cookie parsing refuses ambiguity, tampering and excessive header data', async () => {
  const f = await fixture();
  try {
    const login = await f.auth.login({ username: 'rae', password }, publicRequest);
    const cookie = cookieHeader(login.cookie);
    for (const value of [cookie + '; ' + cookie, cookie + 'x', cookie.replace('=', '="') + '"', cookie + '; x=' + 'x'.repeat(8192), cookie.replace('=', '=%')]) {
      assert.equal(f.auth.isAuthenticated({ headers: { cookie: value } }), false);
    }
    assert.equal(f.auth.isAuthenticated({ headers: { cookie: 'unrelated=value; ' + cookie } }), true);
  } finally { await f.close(); }
});

test('malformed and proxied login attempts cannot lock out the owner; password work stays bounded', async () => {
  const f = await fixture();
  try {
    const proxied = { ...publicRequest, socket: { remoteAddress: '127.0.0.1' } };
    for (let index = 0; index < 12; index++) await assert.rejects(f.auth.login({}, proxied), errorStatus(400));
    const one = f.auth.login({ username: 'rae', password }, publicRequest);
    const two = f.auth.login({ username: 'rae', password }, publicRequest);
    await assert.rejects(f.auth.login({ username: 'rae', password }, { headers: { ...publicRequest.headers, 'x-forwarded-for': '192.0.2.1' } }), errorStatus(429));
    await Promise.all([one, two]);
    for (let index = 0; index < 11; index++) await assert.rejects(f.auth.login({ username: 'rae', password: 'wrong' }, proxied), errorStatus(401));
    assert.equal((await f.auth.login({ username: 'rae', password }, proxied)).session.authenticated, true);
  } finally { await f.close(); }
});

test('direct peer quota uses the transport address rather than spoofable forwarded headers', async () => {
  const f = await fixture();
  const direct = { ...publicRequest, socket: { remoteAddress: '192.0.2.1' } };
  try {
    for (let index = 0; index < 10; index++) await assert.rejects(f.auth.login({ username: 'rae', password: 'wrong' }, direct), errorStatus(401));
    await assert.rejects(f.auth.login({ username: 'rae', password }, { ...direct, headers: { ...direct.headers, 'x-forwarded-for': '192.0.2.2' } }), error => {
      assert.ok(error instanceof WebAuthError); assert.equal(error.status, 429); assert.equal(error.retryAfter, 60); return true;
    });
    assert.equal((await f.auth.login({ username: 'rae', password }, { ...direct, socket: { remoteAddress: '192.0.2.2' } })).session.authenticated, true);
    f.advance(60_000);
    assert.equal((await f.auth.login({ username: 'rae', password }, direct)).session.authenticated, true);
  } finally { await f.close(); }
});

test('session storage stays bounded and local-only authentication does not mark plain HTTP cookies Secure', async () => {
  const f = await fixture({ username: config.username, password: config.password });
  const local: WebAuthRequest = { headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' } };
  try {
    const sessions: string[] = [];
    for (let index = 0; index < 34; index++) {
      f.advance(60_000);
      sessions.push((await f.auth.login({ username: 'rae', password }, local)).cookie);
    }
    assert.ok(sessions.every(cookie => cookie.startsWith('rae_session=') && !cookie.includes('Secure')));
    assert.equal(f.auth.isAuthenticated({ headers: { cookie: cookieHeader(sessions[0]) } }), false);
    assert.equal(f.auth.isAuthenticated({ headers: { cookie: cookieHeader(sessions.at(-1)!) } }), true);
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM auth_sessions').get()!.count, 32); } finally { db.close(); }
  } finally { await f.close(); }
});

test('shutdown drains in-flight password verification and never writes a session after closing', async () => {
  const f = await fixture();
  try {
    const pending = f.auth.login({ username: 'rae', password }, publicRequest);
    const rejected = assert.rejects(pending, errorStatus(503));
    const closing = f.auth.close();
    await Promise.all([rejected, closing]);
    assert.equal(f.auth.isAuthenticated(publicRequest), false);
    await assert.rejects(f.auth.login({ username: 'rae', password }, publicRequest), errorStatus(503));
    const reopened = new WebAuth(config, f.dbPath, { now: f.now });
    try {
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      try { assert.equal(db.prepare('SELECT count(*) AS count FROM auth_sessions').get()!.count, 0); } finally { db.close(); }
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});
