import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceBroker, DeviceOutcomeUnknownError } from '../server/devices/broker.js';
import { deviceDirectoryEntriesCapability, deviceDirectoryLookupCapability, taskCommandCapability, type DeviceCommandSpec, type DeviceGrant, type DeviceServerMessage, type TaskDeviceCommandSpec } from '../shared/local-device.js';

const grant: DeviceGrant = { id: 'local-files', revision: 1, root: 'C:\\Owner\\Work', executable: 'C:\\Windows\\System32\\cmd.exe', readOnly: true, available: true };
async function fixture(options: Pick<ConstructorParameters<typeof DeviceBroker>[0], 'now' | 'settlementTimeoutMs' | 'onResult'> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-local-device-')); const file = join(directory, 'v2-events.sqlite');
  const broker = new DeviceBroker({ file, settlementTimeoutMs: 20, ...options }); const pairing = broker.createPairing();
  const enrollment = broker.enroll({ pairingToken: pairing.token, name: 'Owner PC', platform: 'win32' });
  broker.updateDevice(enrollment.device.id, { grants: [grant], capabilities: ['mxc'] });
  const spec: DeviceCommandSpec = { deviceId: enrollment.device.id, grantId: grant.id, grantRevision: grant.revision,
    executable: grant.executable, args: ['/d', '/c', 'echo fixture'], cwd: grant.root, timeoutMs: 1000 };
  return { broker, file, pairing, enrollment, spec };
}
function context(taskId = 'task-one', signal = new AbortController().signal) { return { taskId, taskRevision: 2, runId: 'run-one', deadline: Date.now() + 10000, signal, guard() {} }; }

test('one task retains distinct operations and exact lookups never return an earlier task receipt', async () => {
  const f = await fixture(); const sent: DeviceServerMessage[] = [];
  const detach = f.broker.attach(f.spec.deviceId, message => {
    sent.push(message); if (message.kind !== 'execute') return;
    assert.equal('requirementsRevision' in message, false, 'Keep the existing desktop wire protocol.');
    f.broker.admit(f.spec.deviceId, { operationId: message.operationId, specHash: message.specHash });
    f.broker.recordResult(f.spec.deviceId, { operationId: message.operationId, state: 'completed', exitCode: 0, stdout: message.operationId });
  });
  try {
    const first = { ...context(), operationId: 'first-operation', requirementsRevision: 1 };
    const second = { ...context(), operationId: 'second-operation', requirementsRevision: 2, taskRevision: 3 };
    await f.broker.run(f.spec, first); await f.broker.run(f.spec, second);
    assert.equal(f.broker.listOperations(first.taskId).length, 2);
    assert.equal(f.broker.operationForTask(first.taskId, second.operationId)?.receipt.stdout, second.operationId);
    assert.equal(f.broker.operationForTask(first.taskId, 'missing-operation'), undefined);
    assert.equal(f.broker.operationForTask('unrelated-task', second.operationId), undefined);
    assert.equal(f.broker.getOperation(second.operationId)?.requirementsRevision, 2);
    assert.throws(() => f.broker.run(f.spec, { ...second, requirementsRevision: 3 }), /不能改变/);
    assert.equal((await f.broker.run(f.spec, first)).stdout, first.operationId);
    assert.equal(sent.length, 2, 'A repeated operation reads its receipt without re-dispatch.');
  } finally { detach(); await f.broker.close(); }
});

test('legacy unique-task operation storage migrates atomically without changing old rows or identifiers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-device-migration-')); const file = join(directory, 'events.sqlite');
  const old = new DatabaseSync(file);
  const saved = { operationId: 'old-operation', taskId: 'old-task', taskRevision: 2, runId: 'old-run', specHash: 'old-hash',
    spec: { deviceId: 'old-device' }, issuedAt: '2026-11-07T00:00:00.000Z', deadline: 1,
    receipt: { operationId: 'old-operation', state: 'completed', exitCode: 0, stdout: 'preserved receipt' } };
  old.exec('CREATE TABLE local_device_operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, json TEXT NOT NULL)');
  const serialized = JSON.stringify(saved);
  old.prepare('INSERT INTO local_device_operations(rowid,id,task_id,device_id,json) VALUES(?,?,?,?,?)').run(17, saved.operationId, saved.taskId, 'old-device', serialized);
  old.close();
  const broker = new DeviceBroker({ file });
  try { assert.deepEqual(broker.getOperation(saved.operationId), saved); } finally { await broker.close(); }
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('SELECT version FROM local_device_schema WHERE id=1').get()?.version, 2);
    assert.deepEqual(db.prepare('SELECT rowid,json FROM local_device_operations WHERE id=?').get(saved.operationId),
      Object.assign(Object.create(null), { rowid: 17, json: serialized }));
    db.prepare('INSERT INTO local_device_operations(id,task_id,device_id,json) VALUES(?,?,?,?)').run('second-operation', saved.taskId, 'old-device',
      JSON.stringify({ ...saved, operationId: 'second-operation', receipt: { ...saved.receipt, operationId: 'second-operation' } }));
  } finally { db.close(); }
  const reopened = new DeviceBroker({ file });
  try { assert.equal(reopened.listOperations(saved.taskId).length, 2); assert.deepEqual(reopened.getOperation(saved.operationId), saved); }
  finally { await reopened.close(); }
});

test('retired shell hints from old clients are ignored and do not create program-specific permissions', async () => {
  const f = await fixture();
  try {
    const legacyStatus = { grants: [], capabilities: [taskCommandCapability], commandShell: { kind: 'cmd', executable: 'C:\\old\\cmd.exe' } };
    f.broker.updateDevice(f.spec.deviceId, legacyStatus);
    assert.equal('commandShell' in f.broker.listDevices()[0], false);
    for (const executable of ['C:\\tools\\anything.exe', 'C:\\Windows\\System32\\cmd.exe', 'C:\\tools\\pwsh.exe']) {
      assert.doesNotThrow(() => f.broker.validate({ deviceId: f.spec.deviceId, executable, args: [], timeoutMs: 1000, access: { kind: 'scratch' } }));
    }
    assert.equal(f.broker.listOperations().length, 0);
  } finally { await f.broker.close(); }
});

test('device labels persist through reconnect without changing identity, grants or native credentials', async () => {
  const { broker, file, enrollment, spec } = await fixture();
  try {
    broker.enroll({ pairingToken: broker.createPairing().token, name: 'Office PC', platform: 'win32' });
    assert.throws(() => broker.renameDevice(spec.deviceId, { name: ' office pc ' }), /已有设备/);
    assert.throws(() => broker.renameDevice(spec.deviceId, { name: 'Home\nPC' }));
    assert.equal(broker.renameDevice(spec.deviceId, { name: ' 家里电脑 ' }).online, false);
  } finally { await broker.close(); }
  const reopened = new DeviceBroker({ file });
  try {
    const detach = reopened.attach(spec.deviceId, () => {});
    reopened.updateDevice(spec.deviceId, { grants: [grant], capabilities: ['mxc'] });
    const paired = reopened.authenticate(enrollment.credential);
    assert.equal(paired?.id, spec.deviceId);
    assert.equal(paired?.name, '家里电脑');
    assert.equal(paired?.online, true);
    assert.deepEqual(paired?.grants, [grant]);
    assert.doesNotThrow(() => reopened.validate(spec));
    detach();
  } finally { await reopened.close(); }
});

test('native directory scope requires a capable client and receipt entry type cannot change after approval', async () => {
  const f = await fixture();
  try {
    const deviceId = f.spec.deviceId;
    const spec: DeviceCommandSpec = { kind: 'list_directory', deviceId, root: 'D:\\project', entryType: 'directory', nameContains: 'another', limit: 100, timeoutMs: 1000 };
    f.broker.updateDevice(deviceId, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    assert.throws(() => f.broker.validate(spec), /更新 Windows 客户端/);
    assert.throws(() => f.broker.validate({ ...spec, entryType: 'file' }), /更新 Windows 客户端/);
    f.broker.updateDevice(deviceId, { grants: [], capabilities: [deviceDirectoryLookupCapability, deviceDirectoryEntriesCapability] });
    const detach = f.broker.attach(deviceId, message => {
      if (message.kind !== 'execute') return;
      f.broker.admit(deviceId, { operationId: message.operationId, specHash: message.specHash });
      const result = { directory: 'D:\\project', files: [{ name: 'AnotherRae', size: 0, modifiedAt: new Date().toISOString() }], scanned: 1, truncated: false };
      assert.throws(() => f.broker.recordResult(deviceId, { operationId: message.operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(result) }), /批准范围/);
      f.broker.recordResult(deviceId, { operationId: message.operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify({ ...result, entryType: 'directory' }) });
    });
    assert.equal((await f.broker.run(spec, context('native-directory'))).state, 'completed');
    detach();
  } finally { await f.broker.close(); }
});

test('pairing expires in ten minutes, is one-use, and only hashes of pairing and device credentials persist', async () => {
  let now = Date.now(); const f = await fixture({ now: () => now });
  try {
    assert.throws(() => f.broker.enroll({ pairingToken: f.pairing.token, name: 'Other', platform: 'win32' }), /配对码/);
    assert.equal(f.broker.authenticate(f.enrollment.credential)?.id, f.spec.deviceId);
    assert.equal(f.broker.authenticate('invalid'), undefined);
    const expiry = f.broker.createPairing(); assert.equal(Date.parse(expiry.expiresAt), now + 600000); now += 600000;
    assert.throws(() => f.broker.enroll({ pairingToken: expiry.token, name: 'Expired', platform: 'win32' }), /配对码/);
    const db = new DatabaseSync(f.file);
    try {
      const stored = JSON.stringify([...db.prepare('SELECT * FROM local_device_pairings').all(), ...db.prepare('SELECT * FROM local_devices').all()]);
      for (const value of [f.pairing.token, expiry.token, f.enrollment.credential]) assert.equal(stored.includes(value), false);
    } finally { db.close(); }
  } finally { await f.broker.close(); }
});

test('command scope pins executable, grant revision and a contained Windows working directory', async () => {
  const f = await fixture();
  try {
    assert.doesNotThrow(() => f.broker.validate(f.spec));
    for (const change of [{ executable: 'C:\\other.exe' }, { grantRevision: 2 }, { cwd: 'C:\\Owner\\Work-sibling' }, { cwd: 'C:\\Owner\\Work\\..\\Other' }]) {
      assert.throws(() => f.broker.validate({ ...f.spec, ...change }));
    }
    assert.throws(() => f.broker.updateDevice(f.spec.deviceId, { grants: [{ ...grant, root: 'C:\\Other' }] }), /增加版本/);
    f.broker.updateDevice(f.spec.deviceId, { grants: [{ ...grant, available: false, reason: 'MXC unavailable' }] });
    assert.throws(() => f.broker.validate(f.spec), /MXC unavailable/);
    assert.throws(() => f.broker.run(f.spec, context()), /MXC unavailable/);
  } finally { await f.broker.close(); }
});

test('an offline device never receives a queued operation or creates an execution intent', async () => {
  const f = await fixture();
  try { assert.throws(() => f.broker.run(f.spec, context()), /离线/); assert.deepEqual(f.broker.listOperations(), []); }
  finally { await f.broker.close(); }
});

test('removing a grant leaves a durable revision fence so an old grant cannot revive an approved scope', async () => {
  const f = await fixture();
  f.broker.updateDevice(f.spec.deviceId, { grants: [] }); await f.broker.close();
  const reopened = new DeviceBroker({ file: f.file });
  try {
    assert.throws(() => reopened.updateDevice(f.spec.deviceId, { grants: [grant] }), /增加版本/);
    reopened.updateDevice(f.spec.deviceId, { grants: [{ ...grant, revision: 2 }] });
    assert.throws(() => reopened.validate(f.spec), /版本/);
    assert.doesNotThrow(() => reopened.validate({ ...f.spec, grantRevision: 2 }));
  } finally { await reopened.close(); }
});

test('task-scoped commands use the advertised capability without creating a reusable grant', async () => {
  const f = await fixture(); const sent: DeviceServerMessage[] = []; const detach = f.broker.attach(f.spec.deviceId, message => sent.push(message));
  try {
    const spec: TaskDeviceCommandSpec = { deviceId: f.spec.deviceId, executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'echo fixture'],
      timeoutMs: 1000, access: { kind: 'scratch' } };
    assert.throws(() => f.broker.validate(spec), /尚未提供/);
    f.broker.updateDevice(f.spec.deviceId, { grants: [], capabilities: [taskCommandCapability] });
    const execution = f.broker.run(spec, context('task-scope-no-grant'));
    const operation = f.broker.operationForTask('task-scope-no-grant')!;
    assert.deepEqual(operation.spec, spec);
    assert.deepEqual(f.broker.listDevices()[0].grants, []);
    f.broker.updateDevice(f.spec.deviceId, { grants: [], capabilities: [] });
    assert.throws(() => f.broker.admit(f.spec.deviceId, { operationId: operation.operationId, specHash: operation.specHash }), /不能再次启动/);
    f.broker.recordResult(f.spec.deviceId, { operationId: operation.operationId, state: 'cancelled' });
    assert.equal((await execution).state, 'cancelled');
    assert.deepEqual(sent.map(message => message.kind), ['execute', 'cancel']);
  } finally { detach(); await f.broker.close(); }
});

test('intent commits before dispatch; a repeated task waits for or returns its single durable result', async () => {
  const acceptedReceipts: string[] = [];
  const f = await fixture({ onResult: operation => acceptedReceipts.push(operation.receipt.state) }); const sent: DeviceServerMessage[] = [];
  const detach = f.broker.attach(f.spec.deviceId, message => {
    sent.push(message);
    if (message.kind === 'execute') assert.equal(f.broker.getOperation(message.operationId)?.specHash, message.specHash);
  });
  try {
    const first = f.broker.run(f.spec, context()); const second = f.broker.run(f.spec, context()); assert.equal(first, second);
    const operation = f.broker.operationForTask('task-one')!; assert.equal(sent.length, 1);
    assert.throws(() => f.broker.run({ ...f.spec, args: ['different'] }, context()), /不能改变/);
    const receipt = { operationId: operation.operationId, state: 'completed' as const, exitCode: 0, stdout: 'actual output' };
    assert.throws(() => f.broker.recordResult(f.spec.deviceId, receipt), /未取得启动准入/);
    const admission = { operationId: operation.operationId, specHash: operation.specHash };
    f.broker.admit(f.spec.deviceId, admission); assert.throws(() => f.broker.admit(f.spec.deviceId, admission), /不能再次启动/);
    const running = { operationId: operation.operationId, state: 'running' as const };
    f.broker.recordResult(f.spec.deviceId, running);
    f.broker.recordResult(f.spec.deviceId, running);
    assert.deepEqual(f.broker.recordResult(f.spec.deviceId, receipt), receipt); assert.deepEqual(await first, receipt);
    assert.deepEqual(await f.broker.run(f.spec, context()), receipt); assert.equal(sent.length, 1);
    assert.deepEqual(f.broker.recordResult(f.spec.deviceId, receipt), receipt);
    assert.throws(() => f.broker.recordResult(f.spec.deviceId, { ...receipt, stdout: 'rewritten' }), /不能改写/);
    assert.throws(() => f.broker.recordResult('another-device', receipt), /不属于/);
    assert.deepEqual(acceptedReceipts, ['running', 'completed']);
  } finally { detach(); await f.broker.close(); }
});

test('device heartbeat validates live commands without loading historical operation payloads', async t => {
  const f = await fixture();
  const sent: DeviceServerMessage[] = [];
  const detach = f.broker.attach(f.spec.deviceId, message => sent.push(message));
  const history = t.mock.method(f.broker, 'listOperations', () => assert.fail('live device control must not read all historical operations'));
  const execution = f.broker.run(f.spec, context());
  try {
    f.broker.updateDevice(f.spec.deviceId, { grants: [], capabilities: [] });
    assert.deepEqual(sent.map(message => message.kind), ['execute', 'cancel']);
    assert.equal(history.mock.callCount(), 0);
  } finally {
    f.broker.recordResult(f.spec.deviceId, { operationId: sent[0].operationId, state: 'cancelled' });
    await execution;
    detach();
    await f.broker.close();
  }
});

test('cancellation remains pending until an actual device terminal receipt drains', async () => {
  const f = await fixture({ settlementTimeoutMs: 1000 }); const sent: DeviceServerMessage[] = [];
  const detach = f.broker.attach(f.spec.deviceId, message => sent.push(message)); const controller = new AbortController();
  try {
    let settled = false; const operation = f.broker.run(f.spec, context('cancel-task', controller.signal)).finally(() => { settled = true; });
    controller.abort(); await delay(5); assert.equal(settled, false); assert.equal(sent.at(-1)?.kind, 'cancel');
    const record = f.broker.operationForTask('cancel-task')!; assert.equal(record.receipt.state, 'cancel_requested');
    f.broker.recordResult(f.spec.deviceId, { operationId: record.operationId, state: 'cancelled', exitCode: 1, stderr: 'process actually terminated' });
    assert.equal((await operation).state, 'cancelled');
  } finally { detach(); await f.broker.close(); }
});

test('deadline plus an absent stop receipt yields explicit unknown, and a later receipt reconciles without another execute', async () => {
  const f = await fixture(); const sent: DeviceServerMessage[] = []; const detach = f.broker.attach(f.spec.deviceId, message => sent.push(message));
  try {
    const promise = f.broker.run({ ...f.spec, timeoutMs: 10 }, context('timed-out')); const rejected = assert.rejects(promise, DeviceOutcomeUnknownError);
    await delay(60); await rejected; const operation = f.broker.operationForTask('timed-out')!;
    assert.equal(operation.receipt.state, 'unknown'); assert.equal(sent.filter(message => message.kind === 'execute').length, 1);
    f.broker.recordResult(f.spec.deviceId, { operationId: operation.operationId, state: 'failed', exitCode: 1, error: 'device confirms timeout termination' });
    assert.equal(f.broker.operationForTask('timed-out')?.receipt.state, 'failed'); assert.equal(sent.filter(message => message.kind === 'execute').length, 1);
  } finally { detach(); await f.broker.close(); }
});

test('disconnect and restart quarantine operations; reconnect never replays the command', async () => {
  const f = await fixture(); let detach = f.broker.attach(f.spec.deviceId, () => {});
  const operation = f.broker.run(f.spec, context('disconnected')); const rejected = assert.rejects(operation, DeviceOutcomeUnknownError); detach(); await delay(40); await rejected;
  const id = f.broker.operationForTask('disconnected')!.operationId; await f.broker.close();
  const reopened = new DeviceBroker({ file: f.file }); const sent: DeviceServerMessage[] = []; detach = reopened.attach(f.spec.deviceId, message => sent.push(message));
  try {
    assert.equal(reopened.getOperation(id)?.receipt.state, 'unknown'); await assert.rejects(reopened.run(f.spec, context('disconnected')), DeviceOutcomeUnknownError); assert.deepEqual(sent, []);
    reopened.recordResult(f.spec.deviceId, { operationId: id, state: 'failed', exitCode: 1 }); assert.equal(reopened.getOperation(id)?.receipt.state, 'failed');
  } finally { detach(); await reopened.close(); }
});

test('prelaunch admission rechecks live task authority and rejects a command already delivered before revocation', async () => {
  const f = await fixture(); let allowed = true; const detach = f.broker.attach(f.spec.deviceId, () => {});
  const execution = f.broker.run(f.spec, { ...context('stale-task'), guard() { if (!allowed) throw new Error('task revoked'); } });
  const operation = f.broker.operationForTask('stale-task')!; allowed = false;
  assert.throws(() => f.broker.admit(f.spec.deviceId, { operationId: operation.operationId, specHash: operation.specHash }), /未授予启动准入/);
  assert.equal(f.broker.getOperation(operation.operationId)?.admittedAt, undefined);
  assert.equal(f.broker.getOperation(operation.operationId)?.receipt.state, 'cancel_requested');
  f.broker.recordResult(f.spec.deviceId, { operationId: operation.operationId, state: 'cancelled', exitCode: 1 }); await execution;
  detach(); await f.broker.close();
});

test('prelaunch admission cannot start a queued command after disconnect or authorize another device', async () => {
  const f = await fixture(); const detach = f.broker.attach(f.spec.deviceId, () => {}); const execution = f.broker.run(f.spec, context('stale-connection'));
  const operation = f.broker.operationForTask('stale-connection')!;
  const admission = { operationId: operation.operationId, specHash: operation.specHash };
  assert.throws(() => f.broker.admit('different-device', admission), /不一致/); detach();
  assert.throws(() => f.broker.admit(f.spec.deviceId, admission), /不能再次启动/); assert.equal(f.broker.getOperation(operation.operationId)?.admittedAt, undefined);
  f.broker.recordResult(f.spec.deviceId, { operationId: operation.operationId, state: 'cancelled', exitCode: 1 }); await execution; await f.broker.close();
});

test('revoking a device with an unknown operation reports that access was revoked without claiming physical stop', async () => {
  const f = await fixture(); const detach = f.broker.attach(f.spec.deviceId, () => {});
  const execution = f.broker.run(f.spec, context('unknown-revoke')); const rejected = assert.rejects(execution, DeviceOutcomeUnknownError);
  detach(); await delay(40); await rejected;
  await assert.rejects(f.broker.revokeDevice(f.spec.deviceId), /许可已撤销.*不能确认/);
  assert.ok(f.broker.listDevices()[0].revokedAt); assert.equal(f.broker.operationForTask('unknown-revoke')?.receipt.state, 'unknown');
  await f.broker.close();
});

test('device revocation fences new work immediately while preserving authorization for terminal receipt upload', async () => {
  const f = await fixture(); const sent: DeviceServerMessage[] = []; const detach = f.broker.attach(f.spec.deviceId, message => sent.push(message));
  try {
    const execution = f.broker.run(f.spec, context('revoked')); let acknowledged = false; const revoke = f.broker.revokeDevice(f.spec.deviceId).then(() => { acknowledged = true; });
    await delay(5); assert.equal(acknowledged, false); assert.equal(f.broker.authenticate(f.enrollment.credential), undefined);
    assert.ok(f.broker.authenticate(f.enrollment.credential, { allowRevoked: true })); assert.throws(() => f.broker.validate(f.spec), /撤销/);
    const operationId = f.broker.operationForTask('revoked')!.operationId; f.broker.recordResult(f.spec.deviceId, { operationId, state: 'cancelled', exitCode: 1 });
    await execution; await revoke; assert.equal(acknowledged, true); assert.equal(sent.at(-1)?.kind, 'cancel');
  } finally { detach(); await f.broker.close(); }
});

test('shutdown keeps the channel available until termination settles and reports unknown honestly', async () => {
  const f = await fixture(); let closed = false; const sent: DeviceServerMessage[] = [];
  const detach = f.broker.attach(f.spec.deviceId, message => sent.push(message), () => { closed = true; });
  const execution = f.broker.run(f.spec, context('shutdown')); const rejected = assert.rejects(execution, DeviceOutcomeUnknownError);
  const shutdown = f.broker.beginShutdown(); const shutdownRejected = assert.rejects(shutdown, /不能确认全部停止/);
  assert.equal(closed, false); assert.equal(sent.at(-1)?.kind, 'cancel'); assert.throws(() => f.broker.createPairing(), /正在关闭/);
  await delay(40); await rejected; await shutdownRejected; assert.equal(closed, true);
  detach(); await assert.rejects(f.broker.close(), /不能确认全部停止/);
});
