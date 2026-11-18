import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireRuntimeLease, assertRuntimeLease, RUNTIME_LEASE_STALE_MS } from '../server/runtime-lease.js';
const execute = promisify(execFile);
async function fixture() {
  const prefix = join(tmpdir(), 'rae-runtime-lease-'); const directory = await mkdtemp(prefix);
  return { directory, async cleanup() { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); } };
}

test('the canonical data directory is exclusive across processes, release is idempotent, and lookalikes are rejected', async () => {
  const f = await fixture(); const lease = await acquireRuntimeLease(f.directory);
  try {
    assertRuntimeLease(lease, join(f.directory, 'child', '..'));
    await assert.rejects(acquireRuntimeLease(f.directory), /locked|ELOCKED|being held/i);
    const moduleUrl = pathToFileURL(resolve('server/runtime-lease.ts')).href;
    const source = `(async()=>{const{acquireRuntimeLease}=await import(${JSON.stringify(moduleUrl)});try{const l=await acquireRuntimeLease(${JSON.stringify(f.directory)});await l.release();process.exitCode=2}catch(e){console.log(e.code||e.message)}})()`;
    const child = await execute(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '-e', source], { windowsHide: true });
    assert.match(child.stdout, /ELOCKED/);
    assert.throws(() => assertRuntimeLease({ ...lease, assertOwned() {} }, f.directory), /genuine/);
    const other = await fixture(); try { assert.throws(() => assertRuntimeLease(lease, other.directory), /another data directory/); lease.assertOwned(); } finally { await other.cleanup(); }
    assert.throws(() => lease.assertOwned(join(f.directory, 'does-not-exist')), /invalid data directory/); lease.assertOwned();
    await lease.release(); await lease.release(); assert.equal(lease.released, true); assert.throws(() => lease.assertOwned(), /no longer owned/);
    const successor = await acquireRuntimeLease(f.directory); await successor.release();
  } finally { await lease.release().catch(() => undefined); await f.cleanup(); }
});

test('a stale predecessor process exit cannot delete a newer process owner lock', async () => {
  const f = await fixture(); const moduleUrl = pathToFileURL(resolve('server/runtime-lease.ts')).href;
  const source = `(async()=>{const{acquireRuntimeLease}=await import(${JSON.stringify(moduleUrl)});await acquireRuntimeLease(${JSON.stringify(f.directory)});console.log('OWNED');process.stdin.once('data',()=>process.exit(0))})()`;
  const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '-e', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let successor: Awaited<ReturnType<typeof acquireRuntimeLease>> | undefined;
  try {
    await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error('predecessor did not acquire fixture lock')), 10000);
      child.once('error', fail); child.stdout.on('data', chunk => { if (String(chunk).includes('OWNED')) { clearTimeout(timer); done(); } }); });
    const lock = resolve(f.directory, '.another-rae-runtime.lock'); assert.ok(lock.startsWith(resolve(f.directory))); await rm(lock, { recursive: true });
    successor = await acquireRuntimeLease(f.directory);
    const exited = new Promise<void>((done, fail) => { child.once('exit', code => code === 0 ? done() : fail(new Error(`predecessor exit ${code}`))); });
    child.stdin.write('exit'); await exited; successor.assertOwned();
  } finally { child.kill(); await successor?.release(); await f.cleanup(); }
});

test('fresh orphan locks are refused, genuinely stale lock directories can be reclaimed', async () => {
  const f = await fixture(); const lock = join(f.directory, '.another-rae-runtime.lock'); await mkdir(lock);
  try {
    await assert.rejects(acquireRuntimeLease(f.directory), /locked|ELOCKED|being held/i);
    const stale = new Date(Date.now() - RUNTIME_LEASE_STALE_MS - 10000); await utimes(lock, stale, stale);
    await writeFile(join(f.directory, '.another-rae-runtime.owner.json'), JSON.stringify({ id: 'expired-fixture', dataDir: f.directory }));
    const recovered = await acquireRuntimeLease(f.directory); recovered.assertOwned(); await recovered.release();
  } finally { await f.cleanup(); }
});

test('lost ownership fails closed and an old release does not remove a replacement owner', async () => {
  const f = await fixture(); let notifications = 0; const first = await acquireRuntimeLease(f.directory, { onLost: () => notifications++ });
  let second: Awaited<ReturnType<typeof acquireRuntimeLease>> | undefined;
  try {
    const lock = resolve(f.directory, '.another-rae-runtime.lock'); assert.ok(lock.startsWith(resolve(f.directory)));
    await rm(lock, { recursive: true });
    assert.throws(() => first.assertOwned(), /lost/); assert.equal(first.lost, true); assert.equal(notifications, 1);
    second = await acquireRuntimeLease(f.directory); await first.release(); second.assertOwned();
    assertRuntimeLease(second, f.directory); assert.throws(() => assertRuntimeLease(first, f.directory), /no longer owned/);
  } finally { await first.release().catch(() => undefined); await second?.release(); await f.cleanup(); }
});
