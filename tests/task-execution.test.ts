import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { deviceDirectoryLookupCapability, type DeviceExecuteMessage } from '../shared/local-device.js';

const usage = { inputTokens: { total: 13, noCache: 13, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Task fixture did not reach its gate')), 10000); })]); }
  finally { clearTimeout(timer); }
}
function waitFor(runtime: V2Coordinator, condition: () => boolean): Promise<void> {
  return bounded(new Promise<void>(done => {
    const check = () => { if (condition()) { detach(); done(); } };
    const detach = runtime.subscribe(check); check();
  }));
}
async function fixture(respond: MockLanguageModelV4['doGenerate']) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-kernel-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  const scene = await runtime.createCase({ title: 'Kernel fixture', objective: 'A persistent personal conversation', domain: 'fixture' });
  await store.updateSettings({ enabled: true, maxStepsPerRun: 8 });
  return { directory, store, runtime, scene, async close() { await runtime.close(); store.close(); } };
}

test('a background task leaves the same scene responsive and keeps its tool history in its own thread', async () => {
  const entered = gate(); const release = gate(); let taskCalls = 0;
  const f = await fixture(async options => {
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      taskCalls++;
      if (taskCalls === 1) { entered.resolve(); await release.promise; return call('publish_artifact', { title: 'Prepared result', content: 'TASK_PRIVATE_RESULT', format: 'text' }); }
      return answer('任务的交付文本已保存。');
    }
    return answer('FOREGROUND_RESPONDED');
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'background-with-front', spec: { caseId: f.scene.id, title: 'Background',
      objective: 'Produce the assigned text', expectedOutput: 'Saved text', capabilities: ['artifact'] } });
    f.runtime.start(); await bounded(entered.promise);
    const chat = await f.runtime.ingestOwnerMessage('While you work, answer this separate question.', f.scene.id);
    await waitFor(f.runtime, () => f.runtime.inbox.get(chat.id)?.status === 'processed');
    assert.equal(f.runtime.consent.get(task.id)?.state, 'running');
    assert.ok(f.store.list('messages').some(message => message.replyTo === chat.externalId && message.content.includes('FOREGROUND_RESPONDED')));
    assert.equal(f.store.list('artifacts').length, 0);
    release.resolve();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    const sceneHistory = await f.runtime.memory.history(f.scene.id);
    assert.doesNotMatch(JSON.stringify(sceneHistory), /TASK_PRIVATE_RESULT/);
    const histories = await f.runtime.memory.taskHistories(f.scene.id);
    assert.equal(histories.length, 1); assert.equal(histories[0].taskId, task.id);
    assert.match(JSON.stringify(histories[0].history), /TASK_PRIVATE_RESULT/);
  } finally { release.resolve(); await f.close(); }
});

test('a directory operation and saved text are one task; partial success cannot complete it', async () => {
  const analysisEntered = gate(); const release = gate(); const dispatched = gate();
  let calls = 0; let execution: DeviceExecuteMessage | undefined;
  const f = await fixture(async options => {
    assert.ok(options.tools?.some(tool => tool.name === 'publish_artifact'));
    if (++calls === 1) {
      assert.match(JSON.stringify(options.prompt), /keep\.pdf/);
      analysisEntered.resolve(); await release.promise;
      return call('publish_artifact', { title: 'Directory summary', content: 'keep.pdf is a candidate to review, not permission to delete.', format: 'text' });
    }
    return answer('目录清单已保存，尚未删除文件。');
  });
  const device = f.runtime.devices.enroll({ name: 'Fixture machine', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token }).device;
  f.runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
  const detach = f.runtime.devices.attach(device.id, message => {
    if (message.kind === 'execute') { execution = message; f.runtime.devices.admit(device.id, { operationId: message.operationId, specHash: message.specHash }); dispatched.resolve(); }
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'combined-task', spec: { caseId: f.scene.id, title: 'Query and summarize',
      objective: 'Query the specified directory and save a text summary', expectedOutput: 'A saved summary based on the real directory result',
      capabilities: ['local-command', 'artifact'], command: { kind: 'list_directory', deviceId: device.id, root: 'D:\\fixture', timeoutMs: 30000, limit: 10 } } });
    f.runtime.start(); await bounded(dispatched.promise);
    assert.equal(f.runtime.consent.get(task.id)?.state, 'running');
    const receipt = { operationId: execution!.operationId, state: 'completed' as const, exitCode: 0,
      stdout: JSON.stringify({ directory: 'D:\\fixture', files: [{ name: 'keep.pdf', size: 20, modifiedAt: '2026-11-07T00:00:00.000Z' }], scanned: 1, truncated: false }) };
    f.runtime.devices.recordResult(device.id, receipt);
    await bounded(analysisEntered.promise);
    f.runtime.devices.recordResult(device.id, receipt);
    assert.equal(f.runtime.consent.get(task.id)?.state, 'running', 'A device success is not the compound task result');
    assert.equal(f.store.list('artifacts').length, 0);
    release.resolve(); await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    assert.equal(f.runtime.devices.listOperations(task.id).length, 1);
    assert.equal(f.store.list('artifacts').filter(value => value.taskId === task.id).length, 1);
    assert.equal(calls, 2);
  } finally { release.resolve(); detach(); await f.close(); }
});

test('an owner requirement change fences the old model result and continues within the original task budget', async () => {
  const entered = gate(); const release = gate(); let taskId = ''; let first = true; let revisionSent = false;
  let runtime!: V2Coordinator;
  const f = await fixture(async options => {
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      if (first) { first = false; entered.resolve(); await release.promise; return call('publish_artifact', { title: 'Old', content: 'OBSOLETE_RESULT', format: 'text' }); }
      if (options.prompt.at(-1)?.role === 'tool') return answer('按补充要求交付了新版本。');
      assert.match(JSON.stringify(options.prompt), /CHANGE_OUTPUT_SENTINEL/);
      return call('publish_artifact', { title: 'Current', content: 'CURRENT_REQUIREMENTS_RESULT', format: 'text' });
    }
    if (!revisionSent && JSON.stringify(options.prompt).includes('CHANGE_OUTPUT_SENTINEL')) {
      revisionSent = true;
      return call('revise_task', { taskId, revision: runtime.consent.get(taskId)!.revision });
    }
    return answer('补充要求已登记。');
  });
  runtime = f.runtime;
  try {
    const task = await runtime.requestTask({ requestId: 'requirements-task', spec: { caseId: f.scene.id, title: 'Versioned output',
      objective: 'Write a summary', expectedOutput: 'Saved text', capabilities: ['artifact'] } }); taskId = task.id;
    runtime.start(); await bounded(entered.promise);
    const originalRun = f.store.list('runs').find(run => run.taskId === taskId)!;
    const change = await runtime.ingestOwnerMessage('CHANGE_OUTPUT_SENTINEL 请把清单写得简短一些，其他范围保持原样。', f.scene.id);
    await waitFor(runtime, () => runtime.consent.get(taskId)?.requirementsRevision === 2);
    release.resolve();
    await waitFor(runtime, () => runtime.consent.get(taskId)?.state === 'completed');
    await waitFor(runtime, () => runtime.inbox.get(change.id)?.status === 'processed');
    const runs = f.store.list('runs').filter(run => run.taskId === taskId);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.taskExecution?.deadline === originalRun.taskExecution?.deadline));
    assert.ok(runs.reduce((sum, run) => sum + run.steps, 0) <= 8);
    assert.equal(runs.find(run => run.taskExecution?.requirementsRevision === 1)?.status, 'interrupted');
    const artifacts = f.store.list('artifacts').filter(value => value.taskId === taskId);
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].requirementsRevision, 2);
    assert.equal(artifacts[0].content, 'CURRENT_REQUIREMENTS_RESULT');
  } finally { release.resolve(); await f.close(); }
});

test('changing delivery requirements during a native query reuses that query without canceling or resubmitting it', async () => {
  const dispatched = gate(); let execution: DeviceExecuteMessage | undefined; let executions = 0; let cancellations = 0;
  let runtime!: V2Coordinator; let taskId = ''; let revised = false;
  const f = await fixture(async options => {
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      assert.match(JSON.stringify(options.prompt), /CHANGE_QUERY_SENTINEL/);
      return options.prompt.at(-1)?.role === 'tool' ? answer('已按新要求保存清单。')
        : call('publish_artifact', { title: 'Short list', content: 'Retained query: keep.pdf', format: 'text' });
    }
    if (!revised && JSON.stringify(options.prompt).includes('CHANGE_QUERY_SENTINEL')) {
      revised = true; return call('revise_task', { taskId, revision: runtime.consent.get(taskId)!.revision });
    }
    return answer('要求已保存，原查询继续进行。');
  });
  runtime = f.runtime;
  const device = runtime.devices.enroll({ name: 'Fixture machine', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
  const detach = runtime.devices.attach(device.id, message => {
    if (message.kind === 'cancel') { cancellations++; return; }
    if (message.kind !== 'execute') return;
    executions++; execution = message;
    runtime.devices.admit(device.id, { operationId: message.operationId, specHash: message.specHash }); dispatched.resolve();
  });
  try {
    const task = await runtime.requestTask({ requestId: 'query-with-requirement-change', spec: { caseId: f.scene.id,
      title: 'Query then deliver', objective: 'Query the directory and save the list', expectedOutput: 'Saved list',
      capabilities: ['local-command', 'artifact'], command: { kind: 'list_directory', deviceId: device.id, root: 'D:\\fixture', timeoutMs: 30000, limit: 10 } } });
    taskId = task.id; runtime.start(); await bounded(dispatched.promise);
    const change = await runtime.ingestOwnerMessage('CHANGE_QUERY_SENTINEL 查询范围保持不变，交付只写简短清单。', f.scene.id);
    await waitFor(runtime, () => runtime.inbox.get(change.id)?.status === 'processed');
    assert.equal(runtime.consent.get(taskId)?.requirementsRevision, 2);
    assert.equal(executions, 1); assert.equal(cancellations, 0);
    assert.equal(runtime.devices.getOperation(execution!.operationId)?.receipt.state, 'dispatched');
    runtime.devices.recordResult(device.id, { operationId: execution!.operationId, state: 'completed', exitCode: 0,
      stdout: JSON.stringify({ directory: 'D:\\fixture', files: [{ name: 'keep.pdf', size: 20, modifiedAt: '2026-11-07T00:00:00.000Z' }], scanned: 1, truncated: false }) });
    await waitFor(runtime, () => runtime.consent.get(taskId)?.state === 'completed');
    const runs = f.store.list('runs').filter(run => run.taskId === taskId);
    assert.equal(runs.length, 2); assert.equal(runs[0].taskExecution?.deadline, runs[1].taskExecution?.deadline);
    assert.equal(executions, 1); assert.equal(cancellations, 0);
    const artifacts = f.store.list('artifacts').filter(artifact => artifact.taskId === taskId);
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].requirementsRevision, 2);
  } finally {
    if (execution && !['completed', 'failed', 'cancelled'].includes(runtime.devices.getOperation(execution.operationId)?.receipt.state ?? '')) {
      runtime.devices.recordResult(device.id, { operationId: execution.operationId, state: 'cancelled', error: 'Fixture cleanup' });
    }
    detach(); await f.close();
  }
});

test('cold recovery can commit an already saved artifact while paused and past its original model deadline', async () => {
  let calls = 0;
  const f = await fixture(async options => {
    calls++;
    return options.prompt.at(-1)?.role === 'tool' ? answer('已保存原任务文本。')
      : call('publish_artifact', { title: 'Persisted', content: 'Completed before the final task commit.', format: 'text' });
  });
  let recovered: V2Coordinator | undefined;
  try {
    const task = await f.runtime.requestTask({ requestId: 'completion-commit-boundary', spec: { caseId: f.scene.id,
      title: 'Persisted result', objective: 'Save a text result', expectedOutput: 'One saved text', capabilities: ['artifact'] } });
    f.runtime.start(); await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    await f.runtime.close();
    const run = f.store.list('runs').find(value => value.taskId === task.id)!;
    assert.equal(run.taskExecution?.modelFinished, true);
    const originalMessages = f.store.list('messages');
    f.store.put('runs', { ...run, status: 'running', endedAt: undefined,
      taskExecution: { ...run.taskExecution!, deadline: Date.now() - 1000 } });
    const db = new DatabaseSync(join(f.directory, 'v2-events.sqlite'));
    try { db.prepare("UPDATE task_consents SET state='running',revision=2,json=json_set(json,'$.state','running','$.revision',2) WHERE id=?").run(task.id); }
    finally { db.close(); }
    await f.store.updateSettings({ enabled: false });
    recovered = await V2Coordinator.create(f.store, { dataDir: f.directory,
      model: new MockLanguageModelV4({ doGenerate: async () => assert.fail('Completion reconciliation must not call the provider') }) });
    assert.equal(recovered.consent.get(task.id)?.state, 'completed');
    assert.equal(f.store.get('runs', run.id)?.status, 'completed');
    assert.deepEqual(f.store.list('messages'), originalMessages);
    assert.equal(f.store.list('artifacts').length, 1);
    assert.equal(calls, 2);
  } finally { await recovered?.close(); await f.close(); }
});
