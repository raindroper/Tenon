import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { localProjectCapability, localProjectSpecSchema, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { MockLanguageModelV4 } from './support/model.js';

test('archiving a scene and revoking a device wait for a completed project preview to drain', { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rae-project-lifecycle-'));
  const store = new Store(dataDir);
  store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir,
    model: new MockLanguageModelV4({ doGenerate: async () => { throw new Error('Unexpected model call'); } }) });
  const device = runtime.devices.enroll({ name: 'Fixture computer', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
  const sequences = new Map<string, number>();
  const cancelled = new Set<string>();
  const cancelRequests = new Map<string, () => void>();
  const waitForCancel = (operationId: string) => new Promise<void>(resolve => { cancelRequests.set(operationId, resolve); });
  const record = (input: ProjectExecutionInput, event: ProjectEvent['event']) => {
    const sequence = (sequences.get(input.operationId) ?? 0) + 1;
    sequences.set(input.operationId, sequence);
    runtime.devices.projects.record(device.id, { operationId: input.operationId, sequence,
      requirementsRevision: input.requirementsRevision, at: new Date().toISOString(), event });
  };
  const detach = runtime.devices.attach(device.id, message => {
    if (message.kind === 'project-execute') {
      const input = message.input;
      record(input, { kind: 'started', threadId: input.taskId, engineVersion: 'fixture', realPath: input.spec.root, identity: input.spec.root });
      record(input, { kind: 'tool', item: { id: 'check', type: 'projectCheck', label: 'Check preview', state: 'succeeded', exitCode: 0 } });
      for (const event of fixtureDelivery(input.requirementsRevision, 'check', input.contract).slice(1)) record(input, event);
      record(input, { kind: 'environment', state: 'active', terminals: [
        { threadId: input.taskId, processId: 'preview', command: 'node preview.js', cwd: input.spec.root },
      ] });
      record(input, { kind: 'finished', state: 'completed', output: 'Preview ready' });
    }
    if (message.kind === 'project-cancel') {
      cancelled.add(message.operationId);
      cancelRequests.get(message.operationId)?.();
    }
  });
  const until = async (predicate: () => boolean, message: string) => {
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => { if (predicate()) resolve(); };
        unsubscribe = runtime.subscribe(check);
        timeout = setTimeout(() => reject(new Error(message)), 5000);
        check();
      });
    } finally { unsubscribe(); clearTimeout(timeout); }
  };
  try {
    await store.updateSettings({ enabled: true });
    runtime.start();
    const preview = async (title: string) => {
      const scene = await runtime.createCase({ title, objective: 'Review a local preview', domain: 'test' });
      const project = localProjectSpecSchema.parse({ deviceId: device.id, root: 'D:\\fixture\\' + title });
      const task = await runtime.requestTask({ requestId: title, spec: { caseId: scene.id, title, objective: scene.objective,
        expectedOutput: 'Preview ready', capabilities: ['project'], project } });
      await until(() => runtime.consent.get(task.id)?.state === 'completed' && !runtime['taskExecutor'].hasTask(task.id), 'Preview did not settle: ' + title);
      const operation = runtime.devices.projects.forTask(task.id)!;
      assert.equal(operation.environment?.state, 'active');
      return { scene, operation };
    };
    const archive = await preview('archive');
    await runtime.updateCase(archive.scene.id, { title: 'Renamed' });
    assert.equal(cancelled.size, 0, 'editing the scene title keeps its completed preview');
    let archived = false;
    const archiveCancel = waitForCancel(archive.operation.input.operationId);
    const archiving = runtime.cancelCase(archive.scene.id).then(value => { archived = true; return value; });
    // The transport dispatch is synchronous, but archive does not acknowledge until the receipt.
    await archiveCancel;
    assert.equal(archived, false);
    assert.equal((await runtime.getCase(archive.scene.id))?.status, 'active');
    record(archive.operation.input, { kind: 'environment', state: 'closed', terminals: [] });
    assert.equal((await archiving).status, 'cancelled');
    const revoke = await preview('revoke');
    let revoked = false;
    const revokeCancel = waitForCancel(revoke.operation.input.operationId);
    const revoking = runtime.revokeDevice(device.id).then(value => { revoked = true; return value; });
    await revokeCancel;
    assert.equal(revoked, false);
    assert.equal(runtime.devices.isDeviceActive(device.id), false, 'the permission is fenced before the drain');
    record(revoke.operation.input, { kind: 'environment', state: 'closed', terminals: [] });
    assert.equal((await revoking).revoked, true);
  } finally {
    for (const operation of runtime.devices.projects.reservedWorkspaces()) {
      record(operation.input, { kind: 'environment', state: 'closed', terminals: [] });
      if (operation.state === 'running') record(operation.input, { kind: 'finished', state: 'cancelled', output: '' });
    }
    await runtime.close(); detach(); store.close();
  }
});
