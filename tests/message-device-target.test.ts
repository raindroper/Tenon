import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { taskCommandCapability } from '../shared/local-device.js';
import type { RuntimeView } from '../shared/runtime-view.js';
import type { Message } from '../shared/types.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-owner-device-target-'));
  async function open() {
    const store = new Store(directory);
    store.getApiKey = () => undefined;
    const runtime = await V2Coordinator.create(store, { dataDir: directory });
    const app = createApp({ store, runtime });
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    return { store, runtime, app };
  }
  let active = await open();
  async function close() {
    await new Promise<void>((resolve, reject) => active.app.close(error => error ? reject(error) : resolve()));
    await active.runtime.close();
    active.store.close();
  }
  return {
    get runtime() { return active.runtime; },
    get store() { return active.store; },
    request(path: string, body?: unknown) {
      const address = active.app.address();
      assert.ok(address && typeof address === 'object');
      return fetch(`http://127.0.0.1:${address.port}${path}`, body === undefined ? undefined : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    },
    async restart() { await close(); active = await open(); },
    close,
  };
}

test('a selected device belongs to the current durable owner message and exposes only selector metadata', async () => {
  const f = await fixture();
  try {
    const pairing = f.runtime.devices.createPairing();
    const { device } = f.runtime.devices.enroll({ pairingToken: pairing.token, platform: 'win32', name: '办公电脑' });
    f.runtime.devices.updateDevice(device.id, {
      capabilities: [taskCommandCapability],
      grants: [{ id: 'fixture-private-grant', revision: 1, root: 'D:\\fixture-private-path', executable: 'C:\\fixture\\allowed.exe', readOnly: true }],
    });
    for (const deviceId of ['', null, '../wrong', ['device']]) {
      const malformed = await f.request('/api/messages', { content: '拒绝无效的设备选项', deviceId });
      assert.equal(malformed.status, 400);
    }
    const unknown = await f.request('/api/messages', { content: '拒绝不存在的设备', deviceId: randomUUID() });
    assert.equal(unknown.status, 404);
    assert.equal(f.store.list('messages').length, 0);

    const sent = await f.request('/api/messages', { content: '先聊聊这台设备', deviceId: device.id });
    assert.equal(sent.status, 202);
    const message = await sent.json() as Message;
    assert.equal(message.deviceId, device.id, 'The paired device remains selectable while offline');
    const ownerEvent = f.runtime.inbox.list().find(event => event.payload.messageId === message.id);
    assert.equal(ownerEvent?.actor, 'owner');
    assert.equal(ownerEvent?.sourceId, 'owner-chat');
    assert.equal(ownerEvent?.payload.deviceId, device.id);

    const reply = await f.request('/api/messages', { content: '回复这条，但这次不指定设备', replyTo: message.id });
    assert.equal(reply.status, 202);
    const replyMessage = await reply.json() as Message;
    assert.equal(replyMessage.deviceId, undefined);
    assert.equal(f.runtime.inbox.list().find(event => event.payload.messageId === replyMessage.id)?.payload.deviceId, undefined);

    const view = await (await f.request('/api/state')).json() as RuntimeView;
    assert.deepEqual(view.devices, [{ id: device.id, name: '办公电脑', platform: 'win32', online: false, capabilities: [taskCommandCapability] }]);
    assert.equal(view.messages.find(item => item.id === message.id)?.deviceId, device.id);
    assert.equal(f.store.list('runs').length, 0);
    assert.deepEqual(await f.runtime.listTasks(), []);

    await f.runtime.revokeDevice(device.id);
    const revoked = await f.request('/api/messages', { content: '拒绝已撤销的设备', deviceId: device.id });
    assert.equal(revoked.status, 404);
    assert.equal(f.store.list('messages').length, 2);

    // Simulate interruption after the durable owner message but before its inbox event.
    const interrupted: Message = { ...message, id: randomUUID(), content: '还未同步到事件库的历史消息' };
    f.store.insert('messages', interrupted);
    await f.restart();
    assert.equal(f.store.get('messages', message.id)?.deviceId, device.id);
    const recovered = f.runtime.inbox.list().filter(event => event.kind === 'owner.message');
    assert.equal(recovered.length, 3);
    assert.equal(recovered.find(event => event.payload.messageId === interrupted.id)?.payload.deviceId, device.id);
    assert.deepEqual((await f.runtime.snapshot()).devices, []);
    assert.equal(f.store.list('runs').length, 0);
    assert.deepEqual(await f.runtime.listTasks(), []);
  } finally { await f.close(); }
});
