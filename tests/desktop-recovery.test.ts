import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalHand } from '../desktop/hand.js';
import { OperationJournal } from '../desktop/journal.js';
import type { DeviceExecuteMessage } from '../shared/local-device.js';
import type { MxcAdapter } from '../desktop/mxc.js';
import { specHash } from '../desktop/security.js';

for (const state of ['dispatched', 'running', 'cancel_requested', 'unknown'] as const) test(`native read-only ${state} journals recover without replay or a global stop fence`, { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rae-readonly-recovery-'));
  const privateDirectory = path.join(dir, 'private'); const approved = path.join(dir, 'approved');
  await mkdir(privateDirectory); await mkdir(approved); await mkdir(path.join(approved, 'Project'));
  const journal = new OperationJournal(path.join(privateDirectory, 'operations'));
  const spec = { kind: 'list_directory' as const, deviceId: 'device', root: approved, entryType: 'directory' as const, limit: 100, timeoutMs: 30000 };
  const message: DeviceExecuteMessage = { kind: 'execute', operationId: `old-${state}`, taskId: 'old-task', taskRevision: 1, runId: 'old-run',
    spec, specHash: specHash(spec), issuedAt: new Date().toISOString(), deadline: Date.now() + 30000 };
  const oldReceipt = { operationId: message.operationId, state, error: 'original interrupted state' };
  await journal.save({ message, receipt: oldReceipt, delivered: true });
  let admissions = 0; const receipts: string[] = [];
  const hand = new LocalHand('device', [], journal, undefined, privateDirectory, async receipt => { receipts.push(receipt.operationId); },
    undefined, async () => { admissions++; });
  await hand.recover();
  assert.deepEqual((await journal.get(message.operationId))?.interruptedReceipt, oldReceipt);
  assert.equal((await journal.get(message.operationId))?.receipt.state, 'failed');
  assert.ok((await hand.advertisedCapabilities([])).includes('local_directory_entries'));
  hand.accept(message); await hand.flushReceipts(); assert.equal(admissions, 0, 'original operation is never executed again');
  hand.accept({ ...message, operationId: 'new-query', taskId: 'new-task' }); await hand.flushReceipts();
  assert.equal(admissions, 1); assert.equal((await journal.get('new-query'))?.receipt.state, 'completed');
  await hand.stop();
  const recoveredAgain = await new OperationJournal(path.join(privateDirectory, 'operations')).recover();
  assert.equal(recoveredAgain.find(entry => entry.message.operationId === message.operationId)?.receipt.state, 'failed');
  assert.deepEqual(recoveredAgain.find(entry => entry.message.operationId === message.operationId)?.interruptedReceipt, oldReceipt);
  assert.ok(receipts.includes(message.operationId));
});

test('an arbitrary program with a readOnly file grant retains the side-effect uncertainty fence', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rae-command-recovery-'));
  const journal = new OperationJournal(dir);
  const spec = { deviceId: 'device', executable: 'C:\\tools\\program.exe', args: [], timeoutMs: 1000,
    access: { kind: 'directory' as const, root: 'C:\\work', readOnly: true } };
  const message: DeviceExecuteMessage = { kind: 'execute', operationId: 'program', taskId: 'task', taskRevision: 1, runId: 'run',
    spec, specHash: specHash(spec), issuedAt: new Date().toISOString(), deadline: Date.now() + 1000 };
  await journal.save({ message, receipt: { operationId: 'program', state: 'running' } });
  const hand = new LocalHand('device', [], journal, undefined, dir, async () => {});
  await hand.recover();
  assert.equal((await journal.get('program'))?.receipt.state, 'unknown');
  assert.deepEqual(await hand.advertisedCapabilities([]), []);
  await assert.rejects(hand.stop(), /未确认/);
});

test('desktop unknown journal retains the stop/admission fence across reconstruction', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rae-recovery-'));
  try {
    const journal = new OperationJournal(dir); const message = { kind: 'execute', operationId: 'op', specHash: 'h' } as DeviceExecuteMessage;
    await journal.save({ message, receipt: { operationId: 'op', state: 'unknown', error: 'unconfirmed native cleanup' } });
    let spawned = false;
    const adapter = { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }), spawn: async () => { spawned = true; throw new Error('unexpected'); } } as MxcAdapter;
    const hand = new LocalHand('device', [], new OperationJournal(dir), adapter, dir, async () => {});
    await hand.recover(); hand.accept({ ...message, operationId: 'new-operation' });
    await assert.rejects(hand.stop(), /未确认/); assert.equal(spawned, false);
    assert.equal(await journal.get('new-operation'), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('desktop reconnect and heartbeat coalesce durable receipt retries without repeating native execution', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rae-receipt-retry-'));
  try {
    const journal = new OperationJournal(dir); const message = { kind: 'execute', operationId: 'done', specHash: 'h' } as DeviceExecuteMessage;
    await journal.save({ message, receipt: { operationId: 'done', state: 'completed', exitCode: 0, stdout: 'saved-output' }, delivered: false });
    let online = false; let posts = 0; let spawns = 0;
    let markEntered!: () => void; let markDelivered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    const adapter = { spawn: async () => { spawns++; throw new Error('unexpected execution'); } } as unknown as MxcAdapter;
    const hand = new LocalHand('device', [], journal, adapter, dir, async receipt => {
      posts++; assert.equal(receipt.stdout, 'saved-output'); if (!online) throw new Error('offline');
      markEntered(); await delivered;
    });
    await hand.recover(); assert.equal((await journal.get('done'))?.delivered, false);
    online = true;
    const heartbeat = hand.flushReceipts({ whileRunning: true });
    await entered;
    const reconnect = hand.flushReceipts();
    assert.equal(posts, 2);
    markDelivered(); await Promise.all([heartbeat, reconnect]);
    assert.equal((await journal.get('done'))?.delivered, true);
    await hand.flushReceipts(); assert.equal(posts, 2); assert.equal(spawns, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
