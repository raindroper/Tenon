import * as fs from 'node:fs';
import { mkdir, realpath, stat, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as lockfile from 'proper-lockfile';

export const RUNTIME_LEASE_STALE_MS = 30000;
export const RUNTIME_LEASE_UPDATE_MS = 10000;
export interface RuntimeLease {
  readonly dataDir: string;
  readonly id: string;
  readonly lost: boolean;
  readonly released: boolean;
  assertOwned(expectedDataDir?: string): void;
  onLost(listener: (error: Error) => void): () => void;
  release(): Promise<void>;
}
export interface RuntimeLeaseOptions { onLost?: (error: Error) => void }
const issued = new WeakSet<object>();
const identity = (value: { dev: number | bigint; ino: number | bigint }) => `${value.dev}:${value.ino}`;

/** The lease must be acquired before opening Store or recovering any runtime state. */
export async function acquireRuntimeLease(dataDir: string, options: RuntimeLeaseOptions = {}): Promise<RuntimeLease> {
  await mkdir(resolve(dataDir), { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolve(dataDir)); const directoryIdentity = identity(await stat(canonical));
  const lockPath = join(canonical, '.another-rae-runtime.lock'); const ownerPath = join(canonical, '.another-rae-runtime.owner.json');
  const id = randomUUID(); let lost = false; let released = false; let releaseOperation: Promise<void> | undefined;
  let lockIdentity = ''; let phase: 'acquiring' | 'owned' | 'releasing' | 'lost' = 'acquiring';
  const listeners = new Set<(error: Error) => void>(); if (options.onLost) listeners.add(options.onLost);
  const compromise = (cause: unknown) => {
    if (lost || released) return; lost = true; phase = 'lost';
    const error = cause instanceof Error ? cause : new Error('Runtime data-directory lease was lost');
    for (const listener of listeners) { try { void Promise.resolve(listener(error)).catch(() => undefined); } catch { /* Ownership remains lost even if notification fails. */ } }
  };
  const ownerMatches = () => {
    try { const value = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as { id?: string; dataDir?: string }; return value.id === id && value.dataDir === canonical; } catch { return false; }
  };
  // Guard the native release from deleting a replacement lock after compromise.
  // Acquisition/stale recovery remains entirely proper-lockfile's responsibility.
  const guardedFs = { ...fs, rmdirSync(path: fs.PathLike) {
    // proper-lockfile also performs synchronous cleanup on process exit.
    if (String(path) === lockPath && (phase === 'lost' || phase !== 'acquiring' && (identity(fs.statSync(lockPath)) !== lockIdentity || !ownerMatches()))) {
      throw Object.assign(new Error('Runtime lock identity changed before process-exit cleanup'), { code: 'ECOMPROMISED' });
    }
    fs.rmdirSync(path);
  }, rmdir(path: fs.PathLike, callback: fs.NoParamCallback) {
    if (String(path) === lockPath && phase !== 'acquiring') {
      try {
        if (phase !== 'releasing' || identity(fs.statSync(lockPath)) !== lockIdentity || !ownerMatches()) {
          callback(Object.assign(new Error('Runtime lock identity changed before release'), { code: 'ECOMPROMISED' })); return;
        }
      } catch (error) { callback(error as NodeJS.ErrnoException); return; }
    }
    fs.rmdir(path, callback);
  } };
  const releaseNative = await lockfile.lock(canonical, { realpath: true, lockfilePath: lockPath,
    stale: RUNTIME_LEASE_STALE_MS, update: RUNTIME_LEASE_UPDATE_MS, retries: 0, fs: guardedFs, onCompromised: compromise });
  try {
    lockIdentity = identity(await stat(lockPath));
    const temporary = `${ownerPath}.${id}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ id, dataDir: canonical, pid: process.pid, acquiredAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); await rename(temporary, ownerPath); }
    finally { await rm(temporary, { force: true }); }
    phase = 'owned';
  } catch (error) { phase = 'acquiring'; await releaseNative().catch(() => undefined); throw error; }
  const lease: RuntimeLease = Object.freeze({
    dataDir: canonical, id,
    get lost() { return lost; }, get released() { return released; },
    assertOwned(expectedDataDir?: string) {
      if (lost || released) throw new Error('Runtime data-directory lease is no longer owned');
      if (expectedDataDir !== undefined) {
        let expected: string; try { expected = fs.realpathSync(resolve(expectedDataDir)); } catch { throw new Error('Runtime lease caller supplied an invalid data directory'); }
        if (expected !== canonical) throw new Error('Runtime lease belongs to another data directory');
      }
      try {
        if (fs.realpathSync(canonical) !== canonical || identity(fs.statSync(canonical)) !== directoryIdentity
          || identity(fs.statSync(lockPath)) !== lockIdentity || !ownerMatches()) throw new Error('Runtime data-directory or lock identity changed');
      } catch (error) {
        compromise(error); throw new Error('Runtime data-directory lease was lost');
      }
    },
    onLost(listener: (error: Error) => void) {
      listeners.add(listener); if (lost) { try { void Promise.resolve(listener(new Error('Runtime data-directory lease was already lost'))).catch(() => undefined); } catch {} }
      return () => { listeners.delete(listener); };
    },
    release() {
      if (releaseOperation) return releaseOperation;
      releaseOperation = (async () => {
        if (released) return;
        if (lost) { released = true; listeners.clear(); return; }
        try { lease.assertOwned(); phase = 'releasing'; await releaseNative();
          if (ownerMatches()) await rm(ownerPath, { force: true });
        } catch (error) { compromise(error); throw error; }
        finally { released = true; listeners.clear(); }
      })();
      return releaseOperation;
    },
  });
  issued.add(lease); lease.assertOwned(); return lease;
}

/** Reject structural lookalikes as well as genuine leases for another directory. */
export function assertRuntimeLease(lease: unknown, dataDir: string): asserts lease is RuntimeLease {
  if (!lease || typeof lease !== 'object' || !issued.has(lease)) throw new Error('A genuine owned RuntimeLease is required');
  (lease as RuntimeLease).assertOwned(dataDir);
}
