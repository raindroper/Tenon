import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { LocalHand } from '../desktop/hand.js';
import { OperationJournal } from '../desktop/journal.js';
import { MockLanguageModelV4 } from './support/model.js';
import type { RuntimeView } from '../shared/runtime-view.js';
import type { DeviceOperationReceipt } from '../shared/local-device.js';

test('native query, lost result upload, durable retry and restart converge through the HTTP receipt boundary', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-native-receipt-http-'));
  const approved = join(directory, 'approved'); const privateDirectory = join(directory, 'device-private');
  await mkdir(approved); await mkdir(privateDirectory); await mkdir(join(approved, 'SavedProject'));
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: join(directory, 'runtime'), model: new MockLanguageModelV4({
    doGenerate: () => { throw new Error('No model is permitted for concrete local execution or recovery'); },
  }) });
  const app = createApp({ store, runtime }); await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const { device, credential } = runtime.devices.enroll({ name: 'Native fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token });
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: ['local_directory_lookup', 'local_directory_entries'] });
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  let connected = false; let admissions = 0; let dispatched = 0; let lostUploads = 0;
  const journal = new OperationJournal(join(privateDirectory, 'operations'));
  const upload = async (receipt: DeviceOperationReceipt) => {
    if (receipt.state === 'completed' && !connected) { lostUploads++; throw new Error('injected connection loss before upload'); }
    await post('/api/device/results', receipt);
  };
  const hand = new LocalHand(device.id, [], journal, undefined, privateDirectory, upload, undefined, async message => {
    admissions++; await post('/api/device/admit', { operationId: message.operationId, specHash: message.specHash });
  });
  let markDispatched!: () => void; const sent = new Promise<void>(resolve => { markDispatched = resolve; });
  const detach = runtime.devices.attach(device.id, message => { if (message.kind === 'execute') dispatched++; hand.accept(message); markDispatched(); });
  try {
    const item = await runtime.createCase({ title: 'Native HTTP recovery', objective: 'Verify actual result delivery', domain: 'fixture' });
    const task = await runtime.requestTask({ requestId: 'native-http', spec: { caseId: item.id, title: 'Read folders', objective: 'Read selected fixture', expectedOutput: 'Directory result',
      capabilities: ['local-command'], command: { kind: 'list_directory', deviceId: device.id, root: approved, entryType: 'directory', limit: 100, timeoutMs: 30000 } } });
    await store.updateSettings({ enabled: true }); runtime.start(); await sent; await hand.flushReceipts();
    assert.equal(lostUploads, 2, 'terminal result remains pending after initial delivery and flush');
    const operation = runtime.devices.operationForTask(task.id)!;
    assert.equal((await journal.get(operation.operationId))?.receipt.state, 'completed');
    await post('/api/device/results', { operationId: operation.operationId, state: 'unknown', error: 'server has no terminal receipt yet' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { detachListener(); reject(new Error('Missing failed outcome')); }, 10000);
      const check = () => { if (runtime.consent.get(task.id)?.state === 'failed') { clearTimeout(timer); detachListener(); resolve(); } };
      const detachListener = runtime.subscribe(check); check();
    });
    await store.updateSettings({ enabled: false });
    connected = true; await hand.flushReceipts({ whileRunning: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { detachListener(); reject(new Error('Missing reconciled task outcome')); }, 10000);
      const check = () => { if (runtime.consent.get(task.id)?.state === 'completed'
        && store.list('runs').some(run => run.taskId === task.id && run.status === 'completed')) {
        clearTimeout(timer); detachListener(); resolve();
      } };
      const detachListener = runtime.subscribe(check); check();
    });
    const view = await (await fetch(`${base}/api/state?caseId=${item.id}`)).json() as RuntimeView;
    assert.equal(view.tasks.find(value => value.id === task.id)?.state, 'completed');
    assert.equal(view.runs.find(value => value.taskId === task.id)?.status, 'completed');
    assert.equal(view.messages.filter(message => message.content.includes('SavedProject')).length, 1);
    const before = JSON.stringify(view.messages);
    await hand.stop();
    const restarted = new LocalHand(device.id, [], new OperationJournal(join(privateDirectory, 'operations')), undefined, privateDirectory, upload);
    await restarted.recover(); await restarted.flushReceipts(); await restarted.stop();
    assert.equal(JSON.stringify((await runtime.snapshot({ caseId: item.id })).messages), before);
    assert.equal(dispatched, 1); assert.equal(admissions, 1); assert.equal(store.getSettings().enabled, false);
  } finally {
    await hand.stop(); detach(); await new Promise<void>(resolve => app.close(() => resolve())); await runtime.close(); store.close();
  }
});
