import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequestAccess, publicOrigin } from '../server/http-access.js';
import { createApp } from '../server/index.js';
import type { RuntimeApi } from '../server/runtime.js';
import { Store } from '../server/store.js';
import { hashWebPassword, WebAuth } from '../server/web-auth.js';

test('public access requires one canonical origin and rejects broad or decorated URLs', () => {
  assert.equal(publicOrigin(undefined), undefined); assert.equal(publicOrigin(''), undefined);
  assert.equal(publicOrigin('https://rae.example.com')?.origin, 'https://rae.example.com');
  assert.equal(publicOrigin('http://rae.example.com:8080')?.host, 'rae.example.com:8080');
  for (const value of ['*', 'null', 'https://*.example.com', 'ftp://rae.example.com', 'https://user:password@rae.example.com',
    'https://rae.example.com/', 'https://rae.example.com/app', 'https://rae.example.com?x=1', 'https://rae.example.com#x',
    'https://rae.example.com,https://other.example.com', ' https://rae.example.com', 'https://rae.example.com:443']) {
    assert.throws(() => publicOrigin(value), /RAE_PUBLIC_ORIGIN/);
  }
});

test('default policy preserves local ports and never trusts a public or forwarded origin', () => {
  const allowed = createRequestAccess();
  for (const host of ['127.0.0.1:4317', 'localhost:4317', '127.0.0.1:5173', 'localhost:5173', 'localhost:32123']) {
    assert.equal(allowed({ host }, 32123), true);
  }
  assert.equal(allowed({ host: '127.0.0.1:32123', origin: 'http://127.0.0.1:5173' }, 32123), true);
  for (const headers of [{}, { host: 'rae.example.com' }, { host: 'localhost:9999' },
    { host: '127.0.0.1:4317', origin: 'https://evil.example' }, { host: 'localhost:4317', origin: 'null' }]) {
    assert.equal(allowed(headers, 32123), false);
  }
});

async function fixture(origin?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-http-origin-')); const dist = join(directory, 'dist');
  await mkdir(dist); await writeFile(join(dist, 'index.html'), '<!doctype html><title>Origin fixture</title>');
  const store = new Store(directory);
  const previous = process.env.RAE_PUBLIC_ORIGIN;
  const auth = origin ? new WebAuth({ username: 'fixture', password: await hashWebPassword('offline-test-password'), publicOrigin: origin }, join(directory, 'auth.sqlite')) : undefined;
  let app: Server;
  try {
    if (origin === undefined) delete process.env.RAE_PUBLIC_ORIGIN; else process.env.RAE_PUBLIC_ORIGIN = origin;
    app = createApp({ store, runtime: {} as RuntimeApi, distDir: dist, auth });
  } finally { if (previous === undefined) delete process.env.RAE_PUBLIC_ORIGIN; else process.env.RAE_PUBLIC_ORIGIN = previous; }
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const port = (app.address() as { port: number }).port;
  return {
    call(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
      return new Promise((done, fail) => {
        const outgoing = request({ hostname: '127.0.0.1', port, path, headers }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => done({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
        }); outgoing.on('error', fail); outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Origin fixture did not receive an HTTP response.'))); outgoing.end();
      });
    },
    async close() {
      await new Promise<void>((done, fail) => app.close(error => error ? fail(error) : done())); await auth?.close(); store.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /rae-http-origin-/);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('HTTP rejects public requests by default even with spoofed forwarded headers', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/api/health')).status, 200);
    assert.equal((await f.call('/api/health', { host: 'rae.example.com', 'x-forwarded-host': 'localhost:4317', 'x-forwarded-proto': 'http' })).status, 403);
    assert.equal((await f.call('/api/health', { origin: 'https://evil.example', 'x-forwarded-origin': 'http://localhost:4317' })).status, 403);
  } finally { await f.close(); }
});

test('HTTP pins its configured public host and origin at startup for API and static assets', async () => {
  const f = await fixture('https://rae.example.com');
  try {
    assert.equal((await f.call('/api/health', { host: 'rae.example.com', origin: 'https://rae.example.com' })).status, 200);
    const page = await f.call('/', { host: 'rae.example.com' });
    assert.equal(page.status, 200); assert.match(page.body, /Origin fixture/);
    const rejected: Record<string, string>[] = [
      { host: 'rae.example.com', origin: 'https://evil.example' },
      { host: 'rae.example.com', origin: 'http://rae.example.com' },
      { host: 'rae.example.com', origin: 'https://rae.example.com.evil' },
      { host: 'rae.example.com:8443', origin: 'https://rae.example.com' },
      { host: 'evil.example', origin: 'https://rae.example.com', 'x-forwarded-host': 'rae.example.com' },
    ];
    for (const headers of rejected) assert.equal((await f.call('/api/health', headers)).status, 403);
    assert.equal((await f.call('/api/health')).status, 200, 'Public configuration must preserve local health probes');
  } finally { await f.close(); }
});

test('an invalid public-origin environment fails clearly before creating runtime data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-invalid-origin-')); const data = join(directory, 'must-not-exist');
  try {
    const result = spawnSync(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: '', RAE_PUBLIC_ORIGIN: 'https://rae.example.com/path', RAE_DATA_DIR: data },
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /RAE_PUBLIC_ORIGIN/); assert.equal(existsSync(data), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
