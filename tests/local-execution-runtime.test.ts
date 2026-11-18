import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createExecutionTools, createGrowthTools } from '../server/v2/capabilities.js';
import { taskSpecSchema } from '../server/v2/consent.js';
import { routeRuntime } from '../server/v2/http.js';
import { DeviceBroker, DeviceOutcomeUnknownError } from '../server/devices/broker.js';
import { deviceDirectoryLookupCapability, taskCommandCapability, taskDeviceCommandSpecSchema, type DeviceCommandSpec, type DeviceDirectoryLookupSpec,
  type DeviceOperation, type DeviceOperationReceipt, type TaskDeviceCommandSpec } from '../shared/local-device.js';
import type { TaskSpec } from '../shared/task-consent.js';
import { MockLanguageModelV4 } from './support/model.js';

const command: DeviceCommandSpec = { deviceId: 'fixture-device', grantId: 'fixture-grant', grantRevision: 1,
  executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'echo fixture'], cwd: 'D:\\fixture', timeoutMs: 5000 };
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const answer = () => ({ content: [{ type: 'text' as const, text: '以设备回执为准。' }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const tool = () => ({ content: [], usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not settle')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(respond: MockLanguageModelV4['doGenerate'] = async () => { throw new Error('Concrete local tasks must not invoke the model'); }) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-local-execution-runtime-')); const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  const item = await runtime.createCase({ title: 'Local command fixture', objective: 'Exercise explicit device authority offline', domain: 'fixture' });
  // A scripted transport substitutes for a paired Windows device; no local process is spawned.
  runtime.devices.validate = received => { assert.deepEqual(received, command); };
  const spec: TaskSpec = { caseId: item.id, title: 'List the granted fixture', objective: 'Only the exact approved command', expectedOutput: 'A real command receipt', capabilities: ['local-command'], command: structuredClone(command) };
  return { directory, store, runtime, spec, async close() { await runtime.close(); store.close(); } };
}
function settled(runtime: V2Coordinator, id: string) {
  return bounded(new Promise<void>(done => {
    const check = () => { if (['completed', 'failed', 'revoked'].includes(runtime.consent.get(id)?.state ?? '')) { detach(); done(); } };
    const detach = runtime.subscribe(check); check();
  }));
}
function handled(runtime: V2Coordinator, id: string) {
  return bounded(new Promise<void>(done => {
    const check = () => { if (['processed', 'failed'].includes(runtime.inbox.get(id)?.status ?? '')) { detach(); done(); } };
    const detach = runtime.subscribe(check); check();
  }));
}
function directoryTaskInput(input: Partial<DeviceDirectoryLookupSpec> & Pick<DeviceDirectoryLookupSpec, 'deviceId' | 'root'>, directoryAnalysis?: true) {
  return { title: '查看本次指定目录', objective: '按本人指定的设备、目录和筛选条件读取元数据',
    expectedOutput: directoryAnalysis ? '本次查询结果和基于元数据的整理建议' : '本次目录查询结果',
    capabilities: ['local-command'], command: { kind: 'list_directory', timeoutMs: 30000, limit: 100, ...input },
    ...(directoryAnalysis ? { directoryAnalysis } : {}) };
}

test('manual executable commands retain exact arguments while native queries can share a text-delivery goal', async () => {
  const f = await fixture();
  try {
    assert.equal(taskSpecSchema.safeParse({ ...f.spec, command: undefined }).success, false);
    assert.equal(taskSpecSchema.safeParse({ ...f.spec, capabilities: ['artifact'] }).success, false);
    assert.equal(taskSpecSchema.safeParse({ ...f.spec, capabilities: ['local-command', 'artifact'] }).success, false);
    assert.equal(taskSpecSchema.safeParse({ ...f.spec, capabilities: ['local-command', 'artifact'], command: {
      kind: 'list_directory', deviceId: 'fixture-device', root: 'D:\\fixture', limit: 100, timeoutMs: 30000 } }).success, true);
    assert.equal(taskSpecSchema.safeParse({ ...f.spec, command: { ...command, timeoutMs: 300001 } }).success, false);
    assert.equal(taskSpecSchema.safeParse({ ...f.spec, command: { ...command, executable: 'powershell.exe' } }).success, false);
    const task = await f.runtime.requestTask({ requestId: 'fixture-exact-command', spec: f.spec });
    assert.deepEqual(task.spec.command, command);
    assert.equal(f.store.list('runs').length, 0);
    await assert.rejects(f.runtime.requestTask({ requestId: 'fixture-exact-command', spec: { ...f.spec, command: { ...command, args: [...command.args].reverse() } } }));
    assert.ok(task.spec.command && 'args' in task.spec.command);
    task.spec.command.args.push('attempted captured-object mutation');
    assert.deepEqual(f.runtime.consent.get(task.id)!.spec.command, command);
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
  } finally { await f.close(); }
});

test('the task-scoped shape binds a single access scope and rejects ambiguous Windows paths', () => {
  const spec = { deviceId: 'device', executable: 'C:\\Windows\\System32\\cmd.exe', args: [], timeoutMs: 1000,
    access: { kind: 'directory', root: 'D:\\approved', readOnly: true } };
  assert.equal(taskDeviceCommandSpecSchema.safeParse(spec).success, true);
  assert.equal(taskDeviceCommandSpecSchema.safeParse({ ...spec, executable: 'windows-powershell' }).success, false);
  assert.equal(taskDeviceCommandSpecSchema.safeParse({ ...spec, grantId: 'old' }).success, false);
  for (const root of ['relative', '\\\\server\\share', 'D:\\approved:secret', 'D:\\approved\\..\\other']) {
    assert.equal(taskDeviceCommandSpecSchema.safeParse({ ...spec, access: { ...spec.access, root } }).success, false);
  }
});

test('chat proposals and direct admission reject arbitrary executables while manual exact commands remain available', async () => {
  const f = await fixture();
  try {
    f.runtime.devices.validate = DeviceBroker.prototype.validate.bind(f.runtime.devices);
    const { device } = f.runtime.devices.enroll({ name: 'Fixture Windows', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token });
    f.runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability, taskCommandCapability] });
    const detach = f.runtime.devices.attach(device.id, () => assert.fail('proposal must not dispatch'));
    try {
      const source = await f.runtime.ingestOwnerMessage('帮我找到项目目录', f.spec.caseId, undefined, undefined, undefined, device.id);
      const event = f.runtime.inbox.get(source.id)!;
      const context = { event, item: (await f.runtime.cases.get(f.spec.caseId))!, runId: 'fixture', store: f.store, cases: f.runtime.cases,
        inbox: f.runtime.inbox, sources: f.runtime.sources, personal: f.runtime.personal, consent: f.runtime.consent, workspace: f.runtime.workspace,
        devices: f.runtime.devices, ownerMessageId: event.externalId, selectedDeviceId: device.id,
        signal: new AbortController().signal, guard() {}, notify: () => 'unused' };
      const tools = createGrowthTools(context);
      assert.equal('run_local_command' in tools, false);
      assert.ok('propose_task' in tools);
      assert.ok('request_task' in tools);
      for (const executable of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\tools\\renamed.exe']) {
        const raw: TaskDeviceCommandSpec = { deviceId: device.id, executable, args: ['arbitrary input'], timeoutMs: 1000, access: { kind: 'scratch' } };
        const rejected: unknown = await tools.propose_task!.execute!({ title: 'raw', objective: 'raw', expectedOutput: 'raw', capabilities: ['local-command'], command: raw } as never, {} as never);
        assert.ok(!rejected || !('taskId' in Object(rejected)), 'invalid tool input must not create a task');
        assert.throws(() => f.runtime.consent.propose({ ...f.spec, command: raw }, event.id), /只接受.*原生只读查询/);
        assert.throws(() => f.runtime.consent.requestOwnerTask({ ...f.spec, command: raw }, event.id), /对话只能登记原生只读目录操作/);
      }
      assert.deepEqual(await f.runtime.listTasks(), []); assert.deepEqual(f.runtime.devices.listOperations(), []);
      const direct = await f.runtime.requestTask({ requestId: 'owner-exact-program', spec: { ...f.spec, command: {
        deviceId: device.id, executable: 'C:\\tools\\owner-chosen.exe', args: ['--version'], timeoutMs: 1000, access: { kind: 'scratch' } } } });
      assert.equal(direct.state, 'approved');
      assert.equal('run_local_command' in createExecutionTools({ ...context, task: direct }), false);
    } finally { detach(); }
  } finally { await f.close(); }
});

test('a directory list needs one model turn and its receipt is available only in the same topic after restart', async () => {
  let deviceId!: string;
  let calls = 0;
  let lookupTaskId!: string;
  const followUp = '刚才查到的 PDF 有多少字节？';
  const unrelated = '这是另一个主题里的独立问题。';
  const fileName = /\[fixture\]\(plain\)\.pdf/;
  const deviceReplied = deferred();
  const respond: MockLanguageModelV4['doGenerate'] = async options => {
    calls++;
    assert.ok(options.tools?.some(value => value.name === 'request_task'));
    assert.ok(!options.tools?.some(value => value.name === 'run_local_command'));
    const recent = options.prompt.at(-1);
    const current = JSON.stringify(recent);
    const prompt = JSON.stringify(options.prompt);
    if (current.includes(unrelated)) {
      assert.doesNotMatch(prompt, fileName);
      assert.ok(!prompt.includes(lookupTaskId));
      assert.ok(!options.tools?.some(value => value.name === 'read_local_file_result'));
      return answer();
    }
    if (current.includes(followUp)) {
      assert.match(prompt, /recentDirectoryResult/);
      assert.ok(prompt.includes(lookupTaskId));
      assert.doesNotMatch(prompt, fileName);
      assert.ok(options.tools?.some(value => value.name === 'read_local_file_result'));
      return { ...tool(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'read_local_file_result',
        input: JSON.stringify({ taskId: lookupTaskId }) }] };
    }
    if (recent?.role === 'tool') {
      const result = recent.content.find(value => value.type === 'tool-result' && value.toolName === 'read_local_file_result');
      assert.ok(result?.type === 'tool-result');
      const output = JSON.stringify(result.output);
      assert.match(output, fileName);
      assert.match(output, /2025-01-01T00:00:00\.000Z/);
      return { ...answer(), content: [{ type: 'text', text: '刚才查到的 PDF 有 20 字节。' }] };
    }
    return { ...tool(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'request_task',
      input: JSON.stringify(directoryTaskInput({ deviceId, root: 'D:\\download', extension: 'pdf' })) }] };
  };
  const f = await fixture(respond);
  let resumed: V2Coordinator | undefined;
  let detach: (() => void) | undefined;
  try {
    f.runtime.devices.validate = DeviceBroker.prototype.validate.bind(f.runtime.devices);
    const { device } = f.runtime.devices.enroll({ name: 'Fixture computer', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token });
    deviceId = device.id;
    f.runtime.devices.updateDevice(deviceId, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    let dispatched = 0;
    detach = f.runtime.devices.attach(deviceId, message => {
      if (message.kind !== 'execute') return;
      dispatched++;
      assert.deepEqual(message.spec, { kind: 'list_directory', deviceId, root: 'D:\\download', extension: 'pdf', limit: 100, timeoutMs: 30000 });
      assert.equal(f.runtime.consent.get(message.taskId)?.state, 'running');
      f.runtime.devices.admit(deviceId, { operationId: message.operationId, specHash: message.specHash });
      const receipt = { operationId: message.operationId, state: 'completed' as const, exitCode: 0,
        stdout: JSON.stringify({ directory: 'D:\\download', files: [{ name: '[fixture](plain).pdf', size: 20, modifiedAt: '2025-01-01T00:00:00.000Z' }], scanned: 2, truncated: true }) };
      assert.throws(() => f.runtime.devices.recordResult(deviceId, { ...receipt, stdout: receipt.stdout.replace('D:\\\\download', 'D:\\\\different') }), /批准范围/);
      f.runtime.devices.recordResult(deviceId, receipt);
      deviceReplied.resolve();
    });
    const source = await f.runtime.ingestOwnerMessage('帮我看看D盘download有哪些PDF文件。', f.spec.caseId, undefined, undefined, undefined, deviceId);
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 4 });
    f.runtime.start();
    await handled(f.runtime, source.id);
    const [task] = await f.runtime.listTasks();
    assert.notEqual(task.state, 'proposed', 'A clear owner request does not wait for a second approval');
    await bounded(deviceReplied.promise);
    lookupTaskId = task.id;
    assert.equal(task.sourceEventId, source.id);
    assert.ok(task.approvedAt && task.executionEventId);
    await settled(f.runtime, task.id);
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.equal(dispatched, 1);
    assert.equal(calls, 1, 'a list-only request ends model inference once its lookup is registered');
    const run = f.store.list('runs').find(value => value.taskId === task.id);
    assert.equal(run?.steps, 0);
    const result = f.store.list('messages').find(message => message.runId === run?.id);
    assert.equal(result?.caseId, f.spec.caseId);
    assert.equal(result?.replyTo, source.externalId);
    assert.ok(result?.content.includes('\\[fixture\\]\\(plain\\)\\.pdf'));
    assert.match(result?.content ?? '', /列表已截断/);

    detach(); detach = undefined;
    await f.runtime.close();
    resumed = await V2Coordinator.create(f.store, { dataDir: f.directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
    const other = await resumed.createCase({ title: 'Unrelated topic', objective: 'Prove directory results stay in the originating topic', domain: 'fixture' });
    resumed.start();
    const otherEvent = await resumed.ingestOwnerMessage(unrelated, other.id);
    await handled(resumed, otherEvent.id);
    assert.equal(resumed.inbox.get(otherEvent.id)?.status, 'processed');

    const next = await resumed.ingestOwnerMessage(followUp, f.spec.caseId);
    await handled(resumed, next.id);
    assert.equal(resumed.inbox.get(next.id)?.status, 'processed');
    assert.ok(f.store.list('messages').some(message => message.replyTo === next.externalId && message.content.includes('20 字节')));
    assert.equal(calls, 4);
    assert.equal(dispatched, 1);
    assert.equal(resumed.devices.listOperations().length, 1);
    assert.equal((await resumed.listTasks()).length, 1);
  } finally { detach?.(); await resumed?.close(); await f.close(); }
});

for (const analysisFails of [false, true]) test(`directory advice keeps the device list when analysis ${analysisFails ? 'fails' : 'completes'}`, async () => {
  const root = 'D:\\download';
  const request = analysisFails ? '帮我看看D盘download下有哪些没用的文件，按可能的用途分一下。' : '看看我D盘download下有多少没用的文件，能不能删一删';
  const listing = { directory: root, files: [{ name: 'fixture-installer.exe', size: 512, modifiedAt: '2025-01-01T00:00:00.000Z' },
    { name: 'fixture-invoice.pdf', size: 123, modifiedAt: '2024-01-01T00:00:00.000Z' }], scanned: 3, truncated: true };
  const advice = 'fixture-installer.exe 可列入待确认候选，fixture-invoice.pdf 先保留。';
  const analysisEntered = deferred(); const allowAnalysis = deferred();
  let deviceId!: string; let dispatched = 0; let analysisCalls = 0; let analysisPrompt = '';
  const f = await fixture(async options => {
    if (options.tools?.some(value => value.name === 'request_task')) {
      assert.notEqual(options.prompt.at(-1)?.role, 'tool');
      return { ...tool(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'request_task',
        input: JSON.stringify(directoryTaskInput({ deviceId, root }, true)) }] };
    }
    analysisCalls++;
    analysisPrompt = JSON.stringify(options.prompt);
    analysisEntered.resolve();
    await allowAnalysis.promise;
    assert.equal(options.tools?.length ?? 0, 0);
    if (analysisFails) throw new Error('Offline model failed during directory analysis');
    return { ...answer(), content: [{ type: 'text', text: advice }] };
  });
  let detach: (() => void) | undefined;
  try {
    f.runtime.devices.validate = DeviceBroker.prototype.validate.bind(f.runtime.devices);
    const { device } = f.runtime.devices.enroll({ name: 'Fixture computer', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token });
    deviceId = device.id;
    f.runtime.devices.updateDevice(deviceId, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    detach = f.runtime.devices.attach(deviceId, message => {
      if (message.kind !== 'execute') return;
      dispatched++;
      assert.deepEqual(message.spec, { kind: 'list_directory', deviceId, root, limit: 100, timeoutMs: 30000 });
      assert.equal(f.runtime.consent.get(message.taskId)?.state, 'running');
      f.runtime.devices.admit(deviceId, { operationId: message.operationId, specHash: message.specHash });
      f.runtime.devices.recordResult(deviceId, { operationId: message.operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(listing) });
    });
    const source = await f.runtime.ingestOwnerMessage(request, f.spec.caseId, undefined, undefined, undefined, deviceId);
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 4 });
    f.runtime.start();
    await handled(f.runtime, source.id);
    const [task] = await f.runtime.listTasks();
    assert.notEqual(task.state, 'proposed');
    await bounded(analysisEntered.promise);
    assert.equal(task.sourceEventId, source.id);
    assert.equal(task.spec.directoryAnalysis, true);
    const run = f.store.list('runs').find(value => value.taskId === task.id)!;
    assert.equal(run.eventId, task.executionEventId);
    const before = f.store.list('messages').find(message => message.runId === run.id)!;
    assert.equal(before.caseId, f.spec.caseId);
    assert.equal(before.replyTo, source.externalId);
    assert.ok(before.content.includes('fixture\\-installer\\.exe'));
    assert.ok(before.content.includes('fixture\\-invoice\\.pdf'));
    assert.match(before.content, /列表已截断/);
    assert.ok(analysisPrompt.includes(request));
    for (const file of listing.files) {
      assert.ok(analysisPrompt.includes(file.name));
      assert.ok(analysisPrompt.includes(String(file.size)));
      assert.ok(analysisPrompt.includes(file.modifiedAt));
    }

    allowAnalysis.resolve();
    await settled(f.runtime, task.id);
    const result = f.store.get('messages', before.id)!;
    assert.ok(result.content.startsWith(before.content));
    assert.equal(result.content.includes(advice), !analysisFails);
    assert.equal(result.outputState, analysisFails ? 'incomplete' : 'complete');
    assert.equal(f.runtime.consent.get(task.id)?.state, analysisFails ? 'failed' : 'completed');
    assert.equal(f.runtime.inbox.get(task.executionEventId!)?.status, 'processed');
    assert.equal(f.runtime.devices.operationForTask(task.id)?.receipt.state, 'completed');
    assert.equal(f.runtime.devices.listOperations().length, 1);
    assert.equal((await f.runtime.listTasks()).length, 1);
    assert.equal(dispatched, 1);
    assert.equal(analysisCalls, 1);
    if (!analysisFails) assert.equal(f.store.get('runs', run.id)?.steps, 1);
  } finally { allowAnalysis.resolve(); detach?.(); await f.close(); }
});

test('a failed directory operation replies to the original request with the actual failure', async () => {
  const root = 'D:\\download';
  const error = '设备无法打开该目录。';
  let deviceId!: string;
  let calls = 0;
  let dispatched = 0;
  const f = await fixture(async () => {
    calls++;
    return { ...tool(), content: [{ type: 'tool-call', toolCallId: randomUUID(), toolName: 'request_task',
      input: JSON.stringify(directoryTaskInput({ deviceId, root }, true)) }] };
  });
  let detach: (() => void) | undefined;
  try {
    f.runtime.devices.validate = DeviceBroker.prototype.validate.bind(f.runtime.devices);
    const { device } = f.runtime.devices.enroll({ name: 'Fixture computer', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token });
    deviceId = device.id;
    f.runtime.devices.updateDevice(deviceId, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    const received = deferred();
    detach = f.runtime.devices.attach(deviceId, message => {
      if (message.kind !== 'execute') return;
      dispatched++;
      f.runtime.devices.admit(deviceId, { operationId: message.operationId, specHash: message.specHash });
      f.runtime.devices.recordResult(deviceId, { operationId: message.operationId, state: 'failed', error });
      received.resolve();
    });
    const source = await f.runtime.ingestOwnerMessage('看看D盘download里的文件能怎么整理。', f.spec.caseId, undefined, undefined, undefined, deviceId);
    await f.store.updateSettings({ enabled: true });
    f.runtime.start();
    await handled(f.runtime, source.id);
    const [task] = await f.runtime.listTasks();
    assert.notEqual(task.state, 'proposed');
    await bounded(received.promise);
    await settled(f.runtime, task.id);
    assert.equal(f.runtime.consent.get(task.id)?.state, 'failed');
    const run = f.store.list('runs').find(value => value.taskId === task.id);
    const reply = f.store.list('messages').find(value => value.runId === run?.id);
    assert.equal(reply?.replyTo, source.externalId);
    assert.equal(reply?.outputState, 'incomplete');
    assert.ok(reply?.outputNote?.includes(error));
    assert.equal(dispatched, 1);
    assert.equal(calls, 1);
  } finally { detach?.(); await f.close(); }
});

test('naming an offline device cannot redirect a read-only lookup to the sole online device', async () => {
  const f = await fixture();
  let detach: (() => void) | undefined;
  try {
    const enroll = (name: string) => f.runtime.devices.enroll({ name, platform: 'win32', pairingToken: f.runtime.devices.createPairing().token }).device;
    const offline = enroll('办公电脑');
    const online = enroll('客厅电脑');
    for (const device of [offline, online]) f.runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    detach = f.runtime.devices.attach(online.id, () => assert.fail('unexpected operation'));
    const event = await f.runtime.ingestOwnerMessage('帮我看看办公电脑D盘download有哪些PDF。', f.spec.caseId, undefined, undefined, undefined, offline.id);
    const item = (await f.runtime.cases.get(f.spec.caseId))!;
    const tools = createGrowthTools({ event: f.runtime.inbox.get(event.id)!, item, runId: 'fixture-lookup', store: f.store, cases: f.runtime.cases,
      inbox: f.runtime.inbox, sources: f.runtime.sources, personal: f.runtime.personal, consent: f.runtime.consent, workspace: f.runtime.workspace,
      devices: f.runtime.devices, ownerMessageId: event.externalId, selectedDeviceId: offline.id,
      signal: new AbortController().signal, guard() {}, notify: () => 'unused' });
    assert.ok('request_task' in tools);
    const command: DeviceDirectoryLookupSpec = { kind: 'list_directory', deviceId: online.id, root: 'D:\\download', extension: 'pdf', limit: 100, timeoutMs: 30000 };
    await assert.rejects(async () => tools.request_task!.execute!(directoryTaskInput(command) as never, {} as never), /当前消息允许且在线的设备/);
    assert.throws(() => f.runtime.consent.requestOwnerTask({ ...f.spec, command }, event.id), /任务设备与本人当前选择不一致/);
    const ambiguous = await f.runtime.ingestOwnerMessage('帮我看看D盘下载目录有哪些PDF。', f.spec.caseId);
    const proposal = f.runtime.consent.propose({ ...f.spec, command: { ...command, root: 'windows-downloads' } }, ambiguous.id);
    assert.equal(proposal.state, 'proposed', 'An unresolved resource choice stays a proposal; the consent boundary does not classify wording');
    assert.ok((await f.runtime.listTasks()).every(task => task.state === 'proposed' && !task.executionEventId));
    assert.deepEqual(f.runtime.devices.listOperations(), []);
  } finally { detach?.(); await f.close(); }
});

for (const receiptState of ['completed', 'failed', 'unknown'] as const) test(`a ${receiptState} device receipt is authoritative, with no message or command replay`, async () => {
  const f = await fixture(); let sends = 0; let operation: DeviceOperation | undefined; let originalDeadline = 0;
  try {
    f.runtime.devices.run = async (received, options) => {
      options.guard(); sends++; originalDeadline = options.deadline;
      assert.ok(originalDeadline <= Date.now() + 300000 && originalDeadline > Date.now());
      assert.deepEqual(received, command);
      assert.ok(options.operationId, 'The executor supplies the durable identity before dispatch');
      const receipt: DeviceOperationReceipt = { operationId: options.operationId, state: receiptState, ...(receiptState === 'completed'
        ? { exitCode: 0, stdout: 'fixture.txt' } : receiptState === 'failed'
          ? { exitCode: -65536, stderr: '无法启动此 shell：不允许所请求的注册表访问权。' } : { error: 'connection lost after dispatch' }) };
      operation = { operationId: receipt.operationId, taskId: options.taskId, taskRevision: options.taskRevision, runId: options.runId,
        specHash: 'fixture-exact-spec', spec: structuredClone(received), deadline: options.deadline, issuedAt: new Date().toISOString(), receipt };
      return receipt;
    };
    f.runtime.devices.operationForTask = (id, operationId) => operation?.taskId === id
      && (operationId === undefined || operation.operationId === operationId) ? operation : undefined;
    const task = await f.runtime.requestTask({ requestId: `fixture-${receiptState}`, spec: f.spec });
    await f.store.updateSettings({ enabled: true, maxStepsPerRun: 3 }); f.runtime.start(); await settled(f.runtime, task.id);
    assert.equal(sends, 1);
    assert.equal(f.runtime.consent.get(task.id)!.state, receiptState === 'completed' ? 'completed' : 'failed');
    assert.equal(f.runtime.inbox.get(task.executionEventId!)!.status, 'processed');
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    assert.equal(f.store.list('runs').length, 1);
    assert.equal(f.store.list('runs')[0].steps, 0, 'exact local tasks execute without a model loop');
    if (receiptState === 'failed') {
      assert.match(f.store.list('runs')[0].error!, /退出码 -65536/);
      assert.match(f.store.list('runs')[0].error!, /注册表访问权/);
      assert.doesNotMatch(f.store.list('runs')[0].error!, /没有匹配/);
      assert.match(f.runtime.consent.get(task.id)!.error!, /注册表访问权/);
    }
    if (receiptState === 'unknown') assert.match(f.store.list('runs')[0].error!, /尚未确认.*不会自动重新执行/);
  } finally { await f.close(); }
});

test('model text alone never completes a local command task', async () => {
  const f = await fixture(async () => answer());
  try {
    const task = await f.runtime.requestTask({ requestId: 'fixture-no-operation', spec: f.spec });
    await f.store.updateSettings({ enabled: true }); f.runtime.start(); await settled(f.runtime, task.id);
    assert.equal(f.runtime.consent.get(task.id)!.state, 'failed');
    assert.equal(f.runtime.devices.operationForTask(task.id), undefined);
  } finally { await f.close(); }
});

test('an unrelated receipt cannot replace the missing authorization-match error or reveal its stderr', async () => {
  const f = await fixture();
  try {
    let operation: DeviceOperation | undefined;
    f.runtime.devices.run = async (spec, context) => {
      assert.ok(context.operationId);
      const receipt: DeviceOperationReceipt = { operationId: context.operationId, state: 'failed', exitCode: 3, stderr: 'OTHER-TASK-OUTPUT' };
      operation = { operationId: receipt.operationId, taskId: context.taskId, taskRevision: context.taskRevision + 1, runId: context.runId,
        specHash: 'fixture', spec, deadline: context.deadline, issuedAt: new Date().toISOString(), receipt };
      return receipt;
    };
    f.runtime.devices.operationForTask = (id, operationId) => operation?.taskId === id
      && (operationId === undefined || operation.operationId === operationId) ? operation : undefined;
    const task = await f.runtime.requestTask({ requestId: 'fixture-mismatched-receipt', spec: f.spec });
    await f.store.updateSettings({ enabled: true }); f.runtime.start(); await settled(f.runtime, task.id);
    assert.match(f.store.list('runs')[0].error!, /没有匹配本次许可/);
    assert.doesNotMatch(f.store.list('runs')[0].error!, /OTHER-TASK-OUTPUT/);
  } finally { await f.close(); }
});

test('task revocation does not acknowledge until an already dispatched device command drains', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred(); const aborted = deferred();
  let operation: DeviceOperation | undefined;
  let cancellation: Promise<unknown> | undefined;
  try {
    f.runtime.devices.operationForTask = (id, operationId) => operation?.taskId === id
      && (operationId === undefined || operation.operationId === operationId) ? operation : undefined;
    f.runtime.devices.run = async (received, options) => {
      options.guard(); assert.ok(options.operationId);
      operation = { operationId: options.operationId, taskId: options.taskId, taskRevision: options.taskRevision, runId: options.runId,
        specHash: 'fixture-command', spec: structuredClone(received), issuedAt: new Date().toISOString(), deadline: options.deadline,
        receipt: { operationId: options.operationId, state: 'running' } };
      options.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve();
      await release.promise;
      operation.receipt = { operationId: options.operationId, state: 'cancelled' };
      return operation.receipt;
    };
    const task = await f.runtime.requestTask({ requestId: 'fixture-cancel-command', spec: f.spec });
    await f.store.updateSettings({ enabled: true }); f.runtime.start(); await bounded(entered.promise);
    assert.equal(f.runtime.consent.get(task.id)?.state, 'running');
    assert.equal(operation?.receipt.state, 'running');
    let acknowledged = false;
    cancellation = f.runtime.revokeTask(task.id, f.runtime.consent.get(task.id)!.revision).then(() => { acknowledged = true; });
    await bounded(aborted.promise);
    assert.equal(f.runtime.consent.get(task.id)!.state, 'revoked');
    assert.equal(acknowledged, false);
    release.resolve(); await bounded(cancellation);
    assert.equal(acknowledged, true); assert.equal(f.runtime.consent.get(task.id)!.state, 'revoked');
    assert.equal(f.store.list('runs').length, 1);
  } finally { release.resolve(); await cancellation; await f.close(); }
});

test('an unconfirmed device stop revokes consent but refuses a stopped acknowledgement until a late receipt', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred(); const aborted = deferred();
  const listOperations = f.runtime.devices.listOperations.bind(f.runtime.devices);
  const operationForTask = f.runtime.devices.operationForTask.bind(f.runtime.devices);
  let operation: DeviceOperation | undefined; let cancellation: Promise<unknown> | undefined;
  try {
    f.runtime.devices.listOperations = () => operation ? [structuredClone(operation)] : [];
    f.runtime.devices.operationForTask = (id, operationId) => operation?.taskId === id
      && (operationId === undefined || operation.operationId === operationId) ? structuredClone(operation) : undefined;
    f.runtime.devices.run = async (received, options) => {
      options.guard(); assert.ok(options.operationId);
      operation = { operationId: options.operationId, taskId: options.taskId, taskRevision: options.taskRevision, runId: options.runId,
        specHash: 'fixture-command', spec: structuredClone(received), issuedAt: new Date().toISOString(), deadline: options.deadline,
        receipt: { operationId: options.operationId, state: 'running' } };
      options.signal.addEventListener('abort', aborted.resolve, { once: true }); entered.resolve(); await release.promise;
      operation.receipt = { operationId: operation.operationId, state: 'unknown', error: 'No device stop receipt' };
      throw new DeviceOutcomeUnknownError(operation.receipt);
    };
    const task = await f.runtime.requestTask({ requestId: 'fixture-unknown-stop', spec: f.spec });
    await f.store.updateSettings({ enabled: true }); f.runtime.start(); await bounded(entered.promise);
    cancellation = f.runtime.revokeTask(task.id, f.runtime.consent.get(task.id)!.revision);
    // Attach the rejection observer before releasing the deterministic transport gate.
    const rejected = assert.rejects(cancellation, DeviceOutcomeUnknownError);
    await bounded(aborted.promise); assert.equal(f.runtime.consent.get(task.id)!.state, 'revoked');
    const stopped = assert.rejects(f.runtime.stop(), DeviceOutcomeUnknownError);
    await Promise.resolve();
    release.resolve(); await bounded(rejected); await bounded(stopped);
    await f.runtime.stop();
    assert.equal(operation!.receipt.state, 'unknown', 'historical unknown is retained without blocking a later drain');
    assert.equal(f.runtime.status().state, 'paused');
    operation!.receipt = { operationId: operation!.operationId, state: 'cancelled' };
    await f.runtime.stop();
    assert.equal(f.runtime.consent.get(task.id)!.state, 'revoked', 'A late device fact cannot reopen a task');
    assert.equal(f.store.list('runs').length, 1);
  } finally {
    release.resolve(); await cancellation?.catch(() => undefined);
    f.runtime.devices.listOperations = listOperations; f.runtime.devices.operationForTask = operationForTask;
    await f.close();
  }
});

test('device owner HTTP routes use runtime commands and reject extra pairing fields', async () => {
  const f = await fixture();
  try {
    const pairing = await routeRuntime(f.runtime, '/api/devices/pairings', 'POST', {});
    assert.equal(pairing.status, 201); assert.equal(typeof (pairing.body as { token: string }).token, 'string');
    await assert.rejects(routeRuntime(f.runtime, '/api/devices/pairings', 'POST', { token: 'forged' }));
    assert.deepEqual((await routeRuntime(f.runtime, '/api/devices', 'GET')).body, []);
    assert.deepEqual((await routeRuntime(f.runtime, '/api/device-operations', 'GET')).body, []);
  } finally { await f.close(); }
});
