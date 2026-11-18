import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { publicOrigin } from './http-access.js';

const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const LOGIN_WINDOW = 60_000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_LOGIN_PEERS = 1024;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const usernameSchema = z.string().min(1).max(80).regex(/^[^\s:\x00-\x1f\x7f]+$/);
const hashSchema = z.object({ algorithm: z.literal('scrypt-v1'), salt: z.string(), hash: z.string() }).strict();
const credentialSchema = z.object({ version: z.literal(1), username: usernameSchema, password: hashSchema }).strict();
const loginSchema = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(1024) }).strict();

export interface WebPasswordHash { algorithm: 'scrypt-v1'; salt: string; hash: string }
export interface WebAuthConfig { username: string; password: WebPasswordHash; publicOrigin?: string }
export interface WebAuthRequest { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string } }
export interface WebSession { required: true; authenticated: boolean; username?: string }
export class WebAuthError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); }
}

function canonicalBytes(value: string, length: number): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error('RAE_AUTH_FILE 的密码摘要格式无效。');
  return bytes;
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((done, fail) => scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? fail(error) : done(key)));
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Provisioning helper; callers must keep both the plaintext input and result out of exports/logs. */
export async function hashWebPassword(password: string): Promise<WebPasswordHash> {
  if (typeof password !== 'string' || !password.length || password.length > 1024) throw new Error('登录密码长度无效。');
  const salt = randomBytes(16);
  return { algorithm: 'scrypt-v1', salt: salt.toString('base64url'), hash: (await derive(password, salt)).toString('base64url') };
}

/** Validate before constructing the runtime or its data directory; public deployments fail closed. */
export function loadWebAuthConfig(input: { credentialsFile?: string; publicOrigin?: string }): WebAuthConfig | undefined {
  const origin = publicOrigin(input.publicOrigin);
  if (!input.credentialsFile) {
    if (origin) throw new Error('配置 RAE_PUBLIC_ORIGIN 时必须同时配置内置用户凭据文件 RAE_AUTH_FILE。');
    return undefined;
  }
  if (origin && origin.protocol !== 'https:') throw new Error('内置用户的公网入口 RAE_PUBLIC_ORIGIN 必须使用 HTTPS。');
  let credentials: z.infer<typeof credentialSchema>;
  try {
    const stat = lstatSync(input.credentialsFile);
    if (!stat.isFile() || stat.size > 16 * 1024 || process.platform !== 'win32' && (stat.mode & 0o037) !== 0) throw new Error();
    credentials = credentialSchema.parse(JSON.parse(readFileSync(input.credentialsFile, 'utf8')));
    canonicalBytes(credentials.password.salt, 16); canonicalBytes(credentials.password.hash, 64);
  } catch { throw new Error('RAE_AUTH_FILE 必须是可读取的私有内置用户凭据文件，且包含有效的 scrypt 密码摘要。'); }
  return { username: credentials.username, password: credentials.password, ...(origin ? { publicOrigin: origin.origin } : {}) };
}

/** Authentication persistence is deliberately separate from runtime memories, context and data export. */
export class WebAuth {
  readonly cookieName: string;
  private readonly db: DatabaseSync;
  private readonly username: string;
  private readonly usernameDigest: Buffer;
  private readonly salt: Buffer;
  private readonly passwordHash: Buffer;
  private readonly credentialVersion: string;
  private readonly origin?: URL;
  private readonly now: () => number;
  private readonly secure: boolean;
  private readonly pending = new Set<Promise<{ session: WebSession; cookie: string }>>();
  private readonly loginPeers = new Map<string, { start: number; attempts: number }>();
  private closing = false;
  private closeTask?: Promise<void>;

  constructor(config: WebAuthConfig, sessionDbPath: string, options: { now?: () => number } = {}) {
    this.username = usernameSchema.parse(config.username);
    this.usernameDigest = createHash('sha256').update(this.username).digest();
    if (config.password.algorithm !== 'scrypt-v1') throw new Error('不支持的内置用户密码摘要。');
    this.salt = canonicalBytes(config.password.salt, 16); this.passwordHash = canonicalBytes(config.password.hash, 64);
    this.origin = publicOrigin(config.publicOrigin);
    if (this.origin && this.origin.protocol !== 'https:') throw new Error('内置用户公网入口必须使用 HTTPS。');
    this.secure = this.origin?.protocol === 'https:';
    this.cookieName = this.secure ? '__Host-rae_session' : 'rae_session';
    this.now = options.now ?? Date.now;
    this.credentialVersion = digest(JSON.stringify([this.username, config.password.salt, config.password.hash]));
    mkdirSync(dirname(sessionDbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(sessionDbPath);
    if (process.platform !== 'win32') chmodSync(sessionDbPath, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, credential_version TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);`);
    this.prune();
  }

  private prune(): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR credential_version <> ?').run(this.now(), this.credentialVersion);
  }
  private readToken(request: WebAuthRequest): string | undefined {
    const cookie = request.headers.cookie;
    if (typeof cookie !== 'string' || cookie.length > 8192) return undefined;
    const values: string[] = [];
    for (const part of cookie.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== this.cookieName) continue;
      values.push(part.slice(separator + 1).trim());
    }
    return values.length === 1 && tokenPattern.test(values[0]) ? values[0] : undefined;
  }
  private cookie(value: string, expired = false): string {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : SESSION_LIFETIME / 1000}` +
      (expired ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '') + (this.secure ? '; Secure' : '');
  }

  isAuthenticated(request: WebAuthRequest): boolean {
    if (this.closing) return false;
    const token = this.readToken(request); if (!token) return false;
    const row = this.db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ? AND credential_version = ?').get(digest(token), this.credentialVersion);
    return row !== undefined && typeof row.expires_at === 'number' && row.expires_at > this.now();
  }
  session(request: WebAuthRequest): WebSession {
    return this.isAuthenticated(request) ? { required: true, authenticated: true, username: this.username } : { required: true, authenticated: false };
  }

  /** Require an explicit same-origin browser mutation; forwarded headers never widen this policy. */
  assertMutationOrigin(request: WebAuthRequest): void {
    const { host, origin } = request.headers;
    if (typeof host !== 'string' || typeof origin !== 'string') throw new WebAuthError(403, '请求来源无效，请从登录页面重试。');
    const local = /^(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(host) && Number(host.split(':')[1]) <= 65535;
    const expected = this.origin?.host === host ? this.origin.origin : local ? 'http://' + host : undefined;
    if (!expected || origin !== expected) throw new WebAuthError(403, '请求来源无效，请从登录页面重试。');
  }

  async login(input: unknown, request: WebAuthRequest): Promise<{ session: WebSession; cookie: string }> {
    if (this.closing) throw new WebAuthError(503, '服务正在关闭，请稍后重试。');
    this.assertMutationOrigin(request);
    const result = loginSchema.safeParse(input);
    if (!result.success) throw new WebAuthError(400, '请输入有效的用户名和密码。');
    if (this.pending.size >= 2) throw new WebAuthError(429, '登录尝试过于频繁，请稍后重试。', 1);
    this.limitDirectPeer(request);
    const operation = this.authenticate(result.data, request);
    this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); }
  }

  private limitDirectPeer(request: WebAuthRequest): void {
    const peer = request.socket?.remoteAddress?.replace(/^::ffff:/i, '');
    // A loopback reverse proxy shares one socket address across all owners.
    // Its request headers cannot establish a distinct trusted client identity.
    if (!peer || !isIP(peer) || peer === '::1' || peer.startsWith('127.')) return;
    const instant = this.now();
    const window = this.loginPeers.get(peer);
    if (window && instant >= window.start && instant < window.start + LOGIN_WINDOW) {
      if (window.attempts >= MAX_LOGIN_ATTEMPTS) {
        throw new WebAuthError(429, '登录尝试过于频繁，请稍后重试。', Math.ceil((window.start + LOGIN_WINDOW - instant) / 1000));
      }
      window.attempts++;
      return;
    }
    this.loginPeers.delete(peer);
    const oldest = this.loginPeers.keys().next().value;
    if (oldest !== undefined && this.loginPeers.size >= MAX_LOGIN_PEERS) this.loginPeers.delete(oldest);
    this.loginPeers.set(peer, { start: instant, attempts: 1 });
  }

  private async authenticate(input: { username: string; password: string }, request: WebAuthRequest): Promise<{ session: WebSession; cookie: string }> {
    const actual = await derive(input.password, this.salt);
    const passwordMatches = timingSafeEqual(actual, this.passwordHash);
    const usernameMatches = timingSafeEqual(createHash('sha256').update(input.username).digest(), this.usernameDigest);
    if (!passwordMatches || !usernameMatches) throw new WebAuthError(401, '用户名或密码不正确。');
    if (this.closing) throw new WebAuthError(503, '服务正在关闭，请稍后重试。');
    this.prune();
    const previous = this.readToken(request);
    if (previous) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(digest(previous));
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(MAX_SESSIONS - 1);
    const token = randomBytes(32).toString('base64url'); const instant = this.now();
    this.db.prepare('INSERT INTO auth_sessions(token_hash,credential_version,expires_at,created_at) VALUES (?,?,?,?)').run(digest(token), this.credentialVersion, instant + SESSION_LIFETIME, instant);
    return { session: { required: true, authenticated: true, username: this.username }, cookie: this.cookie(token) };
  }

  logout(request: WebAuthRequest): string {
    if (this.closing) throw new WebAuthError(503, '服务正在关闭，请稍后重试。');
    this.assertMutationOrigin(request);
    const token = this.readToken(request);
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(digest(token));
    return this.cookie('', true);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = Promise.allSettled([...this.pending]).then(() => { this.db.close(); });
    return this.closeTask;
  }
}
