import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { DeviceBroker } from '../server/devices/broker.js';
import { localProjectCapability, serverProjectResources } from '../shared/local-project.js';

test('operator-managed Linux worker cannot enroll as Windows or advertise additional authority', async () => {
  const id = randomUUID();
  const token = 'w'.repeat(43);
  const credentialHash = createHash('sha256').update(token).digest('hex');
  const broker = new DeviceBroker({ file: ':memory:', serverWorker: { id, name: 'Server Linux', credentialHash } });
  try {
    const pairingToken = broker.createPairing().token;
    assert.throws(() => broker.enroll({ pairingToken, name: 'Imposter', platform: 'linux' as 'win32' }));
    const windows = broker.enroll({ pairingToken, name: 'Windows fixture', platform: 'win32' });
    assert.equal(broker.authenticate(windows.credential)?.platform, 'win32');
    assert.equal(broker.authenticate(token)?.platform, 'linux');
    assert.equal(broker.authenticate(token)?.online, false);
    assert.throws(() => broker.renameDevice(id, { name: '重命名服务器' }), /部署配置/);
    assert.throws(() => broker.updateDevice(id, { grants: [], capabilities: ['local_directory_lookup'] }), /只提供隔离/);
    broker.updateDevice(id, { grants: [], capabilities: [localProjectCapability] });
    const project = broker.projects.prepare({ deviceId: id, network: false });
    assert.deepEqual(project.serverResources, serverProjectResources(false));
    assert.equal(project.readAccess, 'project');
    assert.throws(() => broker.projects.prepare({ deviceId: id, root: 'C:\\production' }), /只支持/);
    assert.throws(() => broker.projects.validate({ ...project, network: true }), /资源范围不一致/);
    assert.throws(() => broker.projects.validate({ ...project, deviceId: windows.device.id }), /不适用于 Windows/);
    await broker.revokeDevice(id);
    assert.equal(broker.authenticate(token), undefined);
  } finally { await broker.close(); }
});
