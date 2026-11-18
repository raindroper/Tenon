import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { DeviceBroker } from '../server/devices/broker.js';
import { deviceDirectoryEntriesCapability, deviceDirectoryLookupCapability } from '../shared/local-device.js';
import type { TaskSpec } from '../shared/task-consent.js';
import { LocalHand } from '../desktop/hand.js';
import { OperationJournal } from '../desktop/journal.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const tool = () => ({ content: [], usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
async function fixture(respond: MockLanguageModelV4['doGenerate']) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-native-directory-flow-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  const item = await runtime.createCase({ title: 'Project lookup', objective: 'Native read-only directory lookup', domain: 'fixture' });
  const spec: TaskSpec = { caseId: item.id, title: 'Project lookup', objective: 'Find the owner project', expectedOutput: 'Actual folder path', capabilities: ['local-command'] };
  return { directory, store, runtime, spec, async close() { await runtime.close(); store.close(); } };
}
async function waitUntil(runtime: V2Coordinator, predicate: () => boolean): Promise<void> {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try { await new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) resolve(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error('Native directory flow did not settle')), 10000); check();
  }); } finally { detach(); clearTimeout(timer); }
}
const handled = (runtime: V2Coordinator, id: string) => waitUntil(runtime, () => ['processed', 'failed'].includes(runtime.inbox.get(id)?.status ?? ''));
const settled = (runtime: V2Coordinator, id: string) => waitUntil(runtime, () => ['completed', 'failed'].includes(runtime.consent.get(id)?.state ?? ''));

test('project lookup flows from a clear owner request through one durable consent and the real native hand into a visible folder result', { skip: process.platform !== 'win32' }, async () => {
  let deviceId = ''; let parent = ''; let modelCalls = 0;
  const f = await fixture(async options => {
    modelCalls++;
    assert.ok(options.tools?.some(value => value.name === 'request_task'));
    return { ...tool(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'request_task',
      input: JSON.stringify({ title: '查找项目目录', objective: '在指定目录中找到本人项目', expectedOutput: '实际项目文件夹路径',
        capabilities: ['local-command'], command: { kind: 'list_directory', deviceId, root: parent,
          entryType: 'directory', nameContains: 'another', limit: 100, timeoutMs: 30000 } }) }] };
  });
  let hand: LocalHand | undefined; let detach: (() => void) | undefined;
  try {
    f.runtime.devices.validate = DeviceBroker.prototype.validate.bind(f.runtime.devices);
    parent = join(f.directory, 'project'); const privateDirectory = join(f.directory, 'device-private');
    await mkdir(parent); await mkdir(join(parent, 'AnotherRae')); await mkdir(join(parent, 'OtherProject'));
    await writeFile(join(parent, 'AnotherRae.txt'), 'not a directory'); await mkdir(privateDirectory);
    deviceId = f.runtime.devices.enroll({ name: '我的 Windows 电脑', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token }).device.id;
    f.runtime.devices.updateDevice(deviceId, { grants: [], capabilities: [deviceDirectoryLookupCapability, deviceDirectoryEntriesCapability] });
    hand = new LocalHand(deviceId, [], new OperationJournal(join(privateDirectory, 'operations')), undefined, privateDirectory,
      async receipt => { f.runtime.devices.recordResult(deviceId, receipt); }, undefined,
      async message => { f.runtime.devices.admit(deviceId, { operationId: message.operationId, specHash: message.specHash }); });
    detach = f.runtime.devices.attach(deviceId, message => hand!.accept(message));
    const event = await f.runtime.ingestOwnerMessage('找到本机d盘project/another-rae项目', f.spec.caseId, undefined, undefined, undefined, deviceId);
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 3 }); f.runtime.start(); await handled(f.runtime, event.id);
    const [task] = await f.runtime.listTasks(); assert.notEqual(task.state, 'proposed');
    await settled(f.runtime, task.id);
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed'); assert.equal(modelCalls, 1);
    const operation = f.runtime.devices.operationForTask(task.id)!;
    const result = JSON.parse(operation.receipt.stdout!);
    assert.equal(result.directory, parent); assert.equal(result.entryType, 'directory');
    assert.deepEqual(result.files.map((entry: { name: string }) => entry.name), ['AnotherRae']);
    const run = f.store.list('runs').find(value => value.taskId === task.id)!;
    assert.equal(run.steps, 0);
    const reply = f.store.list('messages').find(message => message.runId === run.id)!;
    assert.equal(reply.outputState, 'complete'); assert.match(reply.content, /AnotherRae/); assert.match(reply.content, /文件夹/);
    assert.doesNotMatch(reply.content, /0 B|拒绝访问|管理员/);
  } finally { await hand?.stop(); detach?.(); await f.close(); }
});
