import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { NativeDrainError, runSandbox, sandboxRequest, type MxcAdapter } from '../desktop/mxc.js';
import type { MxcProcess } from '@microsoft/mxc-sdk/v1';
import type { LocalGrant } from '../desktop/security.js';

function gate<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject }; }
test('desktop sandbox forbids fallback, credentials, networking and UI', () => {
  const grant = { root: 'C:\\work', executable: 'C:\\tools\\node.exe', toolchainRoot: 'C:\\tools', readOnly: false } as LocalGrant;
  const request = sandboxRequest({ deviceId: 'd', grantId: 'g', grantRevision: 1, executable: grant.executable, args: [], cwd: grant.root, timeoutMs: 1000 }, grant, 'C:\\private', { SYSTEMROOT: 'C:\\Windows', LOCALAPPDATA: 'C:\\user\\AppData\\Local', RAE_DEVICE_CREDENTIAL: 'secret' });
  assert.equal(request.environment?.RAE_DEVICE_CREDENTIAL, undefined); assert.equal(request.inheritDefaultEnvironment, false);
  assert.equal(request.network?.egress?.default, 'deny'); assert.equal(request.ui?.disable, false); assert.equal(request.ui?.allowInputInjection, false); assert.equal(request.ui?.clipboard, 'none');
  assert.deepEqual(request.containment, { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\private\\isolation-anchor'] }, ui: { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false } } });
});
test('desktop cancellation waits for native wait AND streams before disposal', async () => {
  const native = gate<{ exitCode: number; timedOut: boolean }>(); const spawned = gate<void>();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let killed = false; let disposed = false;
  const adapter = { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }), spawn: async () => {
    spawned.resolve(); return { standardOutput: stdout, standardError: stderr, kill() { killed = true; }, wait: () => native.promise, dispose() { disposed = true; } } as unknown as MxcProcess;
  } } as MxcAdapter;
  const controller = new AbortController(); let returned = false;
  const execution = runSandbox(adapter, { command: 'fixture' }, controller.signal).then(result => { returned = true; return result; });
  await spawned.promise; controller.abort(); await Promise.resolve(); assert.equal(killed, true); assert.equal(returned, false);
  native.resolve({ exitCode: -1, timedOut: false }); await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false); assert.equal(disposed, false);
  stdout.end('durable output'); stderr.end(); const result = await execution;
  assert.equal(result.stdout, 'durable output'); assert.equal(result.cancelled, true); assert.equal(disposed, true);
});
test('desktop native failure does not claim disposal as proven stop', async () => {
  let disposed = false;
  const adapter = { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }), spawn: async () => ({ standardOutput: null, standardError: null,
    kill() {}, wait: async () => { throw new Error('native cleanup fault'); }, dispose() { disposed = true; } } as unknown as MxcProcess) } as MxcAdapter;
  await assert.rejects(runSandbox(adapter, { command: 'fixture' }, new AbortController().signal), NativeDrainError); assert.equal(disposed, false);
});
test('desktop rejects DACL fallback before spawning', async () => {
  let spawned = false;
  const adapter = { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'appcontainer-dacl', needsDaclAugmentation: true }), spawn: async () => { spawned = true; throw new Error('unexpected'); } } as MxcAdapter;
  await assert.rejects(runSandbox(adapter, { command: 'fixture' }, new AbortController().signal)); assert.equal(spawned, false);
});
