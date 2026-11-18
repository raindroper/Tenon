import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalHand } from '../desktop/hand.js';
import { OperationJournal } from '../desktop/journal.js';
import { captureGrant, specHash } from '../desktop/security.js';
import type { MxcAdapter } from '../desktop/mxc.js';
import type { DeviceExecuteMessage, DeviceOperationReceipt } from '../shared/local-device.js';

test('an indeterminate native launch seals the hand and cannot acknowledge a later stop as confirmed', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-device-review-')); const work = path.join(directory, 'work'); const program = path.join(directory, 'fixture.exe');
  await mkdir(work); await writeFile(program, 'offline identity fixture; never executed');
  let launches = 0; let terminal!: (receipt: DeviceOperationReceipt) => void;
  const receipt = new Promise<DeviceOperationReceipt>(resolve => { terminal = resolve; });
  const adapter: MxcAdapter = { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }),
    spawn: async () => { launches++; throw new Error('fault injection: native launch result unavailable'); } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const grant = await captureGrant({ id: 'grant', revision: 1, root: work, executable: program, readOnly: true });
    const spec = { deviceId: 'device', grantId: grant.id, grantRevision: 1, executable: grant.executable, cwd: grant.root, args: [], timeoutMs: 1000 };
    const message: DeviceExecuteMessage = { kind: 'execute', operationId: 'review-operation', taskId: 'review-task', taskRevision: 1, runId: 'review-run',
      spec, specHash: specHash(spec), deadline: Date.now() + 20000, issuedAt: new Date().toISOString() };
    const hand = new LocalHand('device', [grant], new OperationJournal(path.join(directory, 'journal')), adapter, path.join(directory, 'private'),
      async value => { if (['unknown', 'failed', 'cancelled', 'completed'].includes(value.state)) terminal(value); }, () => {}, async () => {});
    hand.accept(message);
    const outcome = await Promise.race([receipt, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('fixture did not settle')), 3000); })]);
    assert.equal(launches, 1); assert.equal(outcome.state, 'unknown');
    await assert.rejects(hand.stop(), /未确认|不能确认/);
    assert.equal((await hand.advertisedGrants())[0].available, false);
  } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
});

test('a recovered unknown operation remains a stop barrier in a new hand instance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-device-review-recover-'));
  try {
    const journal = new OperationJournal(directory); const message = { operationId: 'old-operation', specHash: 'old-hash' } as DeviceExecuteMessage;
    await journal.save({ message, receipt: { operationId: message.operationId, state: 'unknown', error: 'previous native outcome was not confirmed' } });
    const hand = new LocalHand('device', [], journal, { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }),
      spawn: async () => { throw new Error('must never spawn'); } }, directory, async () => {});
    await hand.recover(); await assert.rejects(hand.stop(), /未确认|不能确认/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
