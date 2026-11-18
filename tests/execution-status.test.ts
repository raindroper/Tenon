import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceBroker } from '../server/devices/broker.js';
import { executionStatus } from '../server/v2/execution-status.js';
import { createGrowthTools } from '../server/v2/capabilities.js';
import { legacyLocalProjectCapability, localProjectCapability, localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectSpecHash } from '../server/devices/projects.js';
import type { TaskRecord } from '../shared/task-consent.js';

test('passive review can refresh true local capability and startup failure without receiving an execution tool', async () => {
  const devices = new DeviceBroker({ file: ':memory:' });
  const device = devices.enroll({ pairingToken: devices.createPairing().token, name: 'Owner computer', platform: 'win32' }).device;
  const detach = devices.attach(device.id, () => {});
  const spec = localProjectSpecSchema.parse({ deviceId: device.id, root: 'D:\\project\\fixture' });
  devices.updateDevice(device.id, { grants: [], capabilities: [legacyLocalProjectCapability] });
  assert.equal(executionStatus(devices, []).devices[0].localProjectExecution, false);
  assert.throws(() => devices.projects.validate(spec), /更新/);
  devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability] });
  const at = new Date().toISOString();
  const task: TaskRecord = { id: 'task', state: 'running', revision: 2, approvalRevision: 1, requirementsRevision: 1,
    spec: { caseId: 'scene', title: 'Local code acceptance', objective: 'Read and verify local code', expectedOutput: 'Actual evidence',
      capabilities: ['project'], project: spec }, createdAt: at, updatedAt: at };
  const input: ProjectExecutionInput = { operationId: 'operation', taskId: task.id, runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: task.spec.title, objective: task.spec.objective, expectedOutput: task.spec.expectedOutput,
    ownerRequest: 'Accept local code', updates: [], model: { model: 'fixture', reasoningEffort: 'high', maxOutputTokens: null },
    stepLimit: 20, deadline: null, issuedAt: at };
  const pending = devices.projects.run(input, { signal: new AbortController().signal, guard() {}, onEvent() {}, async model() {}, async context() {} });
  try {
    const before = executionStatus(devices, [task]);
    assert.equal(before.devices[0].localProjectExecution, true);
    devices.projects.record(device.id, { operationId: 'operation', sequence: 1, requirementsRevision: 1, at,
      event: { kind: 'finished', state: 'failed', output: '', error: '启动许可核对发生 HTTP 502' } });
    await pending; task.state = 'failed';
    let reads = 0;
    const tools = createGrowthTools({ event: { kind: 'growth.observation', actor: 'external', id: 'observation' }, item: { id: 'scene' },
      guard() {}, executionStatus: () => { reads++; return executionStatus(devices, [task]); },
    } as unknown as Parameters<typeof createGrowthTools>[0]);
    assert.ok(tools.read_execution_status);
    assert.ok(!Object.keys(tools).some(name => ['request_task', 'run_command', 'write_workspace', 'publish_artifact'].includes(name)));
    const result = await (tools.read_execution_status.execute as (input: object) => Promise<ReturnType<typeof executionStatus>>)({});
    assert.equal(reads, 1);
    assert.equal(result.localTasks[0].native?.state, 'failed');
    assert.equal(result.localTasks[0].native?.modelCalls, 0);
    assert.equal(result.localTasks[0].native?.sessionCreated, false);
    assert.equal(result.devices[0].localProjectExecution, true);
  } finally { detach(); await devices.close(); }
});
