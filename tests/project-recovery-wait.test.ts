import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { fixtureDelivery } from './support/project-delivery.js';
import { localProjectCapability, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';

async function until(runtime: V2Coordinator, predicate: () => boolean) {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (predicate()) resolve(); };
      detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error('Expected task state was not reached')), 10000); check();
    });
  } finally { detach(); clearTimeout(timer); }
}

/** Deterministic event/queue boundary, not a wall-clock delay before asserting no dispatch. */
async function settleScheduler(runtime: V2Coordinator) {
  const executor = (runtime as unknown as { taskExecutor: { tick(): void; queue: { onIdle(): Promise<void> } } }).taskExecutor;
  await new Promise<void>(resolve => setImmediate(resolve));
  executor.tick(); await executor.queue.onIdle();
  await new Promise<void>(resolve => setImmediate(resolve));
}

for (const restart of [false, true]) test(`a recoverable v2 fault waits for the owner and the original drain before resuming (restart: ${restart})`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-project-recovery-wait-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let modelCalls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('No inference belongs to waiting or local reconciliation'); } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const scene = await runtime.createCase({ title: 'Fault recovery', objective: '', domain: 'fixture' });
  const device = runtime.devices.enroll({ name: 'Fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
  let input: ProjectExecutionInput | undefined;
  let dispatches = 0, stops = 0;
  const record = (event: ProjectEvent['event']) => runtime.devices.projects.record(device.id, {
    operationId: input!.operationId, requirementsRevision: input!.requirementsRevision,
    sequence: runtime.devices.projects.get(input!.operationId)!.sequence + 1, at: new Date().toISOString(), event,
  });
  const attach = () => runtime.devices.attach(device.id, message => {
    if (message.kind === 'project-execute') {
      input = message.input; dispatches++;
      record({ kind: 'started', threadId: 'same-native-thread', engineVersion: 'fixture', realPath: input.spec.root, identity: 'same-workspace' });
    }
    if (message.kind === 'project-cancel') {
      stops++;
      record({ kind: 'environment', state: 'closed', terminals: [] });
      record(message.mode === 'pause' ? { kind: 'paused', reason: message.reason } : { kind: 'finished', state: 'cancelled', output: 'Fixture drained' });
    }
  });
  let detach = attach();
  try {
    await store.updateSettings({ enabled: true }); runtime.start();
    const task = await runtime.requestTask({ requestId: 'recover-one-task', spec: { caseId: scene.id, title: 'Recover original work',
      objective: 'Finish current project and preserve completed work', expectedOutput: 'Verified report', capabilities: ['project'],
      project: { deviceId: device.id, root: 'D:\\fixture', access: 'read-write', readAccess: 'project', network: false, create: false } } });
    await until(runtime, () => dispatches === 1);
    const original = structuredClone(input!);
    const authorized = runtime.devices.projects.authorize(device.id, { operationId: input!.operationId, specHash: input!.specHash, requirementsRevision: 1 });
    const waiting = await authorized.context.context(authorized.operation, { action: 'call', name: 'ask_rae_owner', arguments: {
      questions: [{ id: 'recover', header: '继续', question: '已有成果保留，核对原操作状态后继续吗？' }],
    } }) as { taskSuspended: boolean; dependency: { id: string; revision: number } };
    assert.equal(waiting.taskSuspended, true);
    assert.equal(store.get('runs', original.runId)!.taskExecution!.projectPaused, true);
    if (!restart) {
      await runtime.answerTaskInput(task.id, waiting.dependency.id, waiting.dependency.revision, { recover: '核对原操作状态后继续。' });
    }
    record({ kind: 'environment', state: 'unknown', terminals: [] });
    record({ kind: 'finished', state: 'unknown', output: 'Saved partial result', error: 'Waiting for the accepted command to drain' });
    await settleScheduler(runtime);
    assert.equal(runtime.consent.get(task.id)!.state, 'running');
    assert.equal(dispatches, 1); assert.equal(modelCalls, 0);
    assert.equal(runtime.devices.projects.forTask(task.id)!.state, 'unknown');

    if (restart) {
      await runtime.close(); detach();
      assert.equal(stops, 0, 'An already unknown, unowned native operation must not block another global drain');
      // Simulate a crash after the durable question but before its Store flag.
      const saved = store.get('runs', original.runId)!;
      delete saved.taskExecution!.projectPaused; store.put('runs', saved);
      runtime = await V2Coordinator.create(store, { dataDir: directory, model });
      detach = attach(); runtime.start();
      await settleScheduler(runtime);
      assert.equal(store.get('runs', original.runId)!.taskExecution!.projectPaused, true);
      assert.equal(runtime.consent.task(task.id)!.flow!.phase, 'waiting_input');
      await runtime.answerTaskInput(task.id, waiting.dependency.id, waiting.dependency.revision, { recover: '核对原操作状态后继续。' });
    }
    await settleScheduler(runtime);
    assert.equal(dispatches, 1, 'Answering while the original operation is unknown cannot dispatch work');
    assert.equal(runtime.consent.get(task.id)!.state, 'running');
    record({ kind: 'environment', state: 'closed', terminals: [] });
    await settleScheduler(runtime);
    assert.equal(dispatches, 1, 'An environment close alone is insufficient to resume an unknown operation');
    record({ kind: 'paused', reason: 'Original operation drained; saved checkpoint can continue' });
    await until(runtime, () => dispatches === 2);
    assert.equal(input!.taskId, original.taskId); assert.equal(input!.operationId, original.operationId);
    assert.equal(input!.approvalRevision, original.approvalRevision); assert.equal(input!.specHash, original.specHash);
    assert.equal(input!.deadline, original.deadline); assert.equal(input!.stepLimit, original.stepLimit);
    assert.equal(runtime.devices.projects.forTask(task.id)!.threadId, 'same-native-thread');
    assert.equal(runtime.devices.projects.forTask(task.id)!.finishedAt, undefined);
    fixtureDelivery(input!.requirementsRevision, 'resumed-check', input!.contract).forEach(event => record(event));
    record({ kind: 'environment', state: 'closed', terminals: [] });
    record({ kind: 'finished', state: 'completed', output: 'Completed from original work' });
    await until(runtime, () => runtime.consent.task(task.id)!.state === 'completed');
    assert.equal(modelCalls, 0); assert.equal(dispatches, 2); assert.equal(runtime.consent.tasks().length, 1);
  } finally { await runtime.close(); detach(); store.close(); }
});
