import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { localProjectCapability, type ProjectExecutionInput, type ProjectEvent } from '../shared/local-project.js';
import { projectContractV2Capability } from '../shared/project-contract.js';
import { projectFilesCapability, projectFinalFilesCapability, type ProjectFilesUpload } from '../shared/project-files.js';
import { projectStageApproved, projectStageDecision } from '../shared/task-flow.js';
import { projectExecutionCheckpoint } from '../desktop/project-checkpoint.js';
import { sendProjectFiles } from '../desktop/project-files.js';
import type { LocalProjectEntry } from '../desktop/project-journal.js';

async function until(runtime: V2Coordinator, predicate: () => boolean, message: string) {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try { await new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) resolve(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error(message)), 15000); check();
  }); } finally { detach(); clearTimeout(timer); }
}

test('a paused owner-review task exposes exact immutable files before approval without a model or another execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-stage-files-runtime-'));
  const workspace = path.join(directory, 'project'), privateDirectory = path.join(directory, 'private');
  for (const folder of [workspace, path.join(privateDirectory, 'temporary'), path.join(privateDirectory, 'outputs')]) await mkdir(folder, { recursive: true });
  const content = Buffer.from('Stage content for the owner to inspect.');
  const file = path.join(workspace, 'stage.md'); await writeFile(file, content);
  await writeFile(path.join(workspace, 'other.txt'), 'Unrelated local file');
  const store = new Store(path.join(directory, 'data')); store.getApiKey = () => undefined;
  let models = 0, executions = 0, transfers = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: path.join(directory, 'data'), model: new MockLanguageModelV4({
    doGenerate: async () => { models++; throw new Error('Stage file viewing must never invoke a model'); },
  }) });
  let input: ProjectExecutionInput | undefined, entry: LocalProjectEntry | undefined, transfer: Promise<void> | undefined;
  let detach = () => {};
  const device = runtime.devices.enroll({ name: 'Windows stage fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  const record = (event: ProjectEvent['event']) => {
    const operation = runtime.devices.projects.get(input!.operationId)!;
    runtime.devices.projects.record(device.id, { operationId: input!.operationId, sequence: operation.sequence + 1,
      requirementsRevision: input!.requirementsRevision, at: new Date().toISOString(), event });
  };
  try {
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectFilesCapability, projectFinalFilesCapability, projectContractV2Capability] });
    detach = runtime.devices.attach(device.id, message => {
      if (message.kind === 'project-execute') { input = message.input; executions++; }
      if (message.kind === 'project-files') {
        transfers++;
        transfer = sendProjectFiles(entry!, privateDirectory, message, async (part: ProjectFilesUpload) => runtime.devices.projects.fileResults.receive(device.id, part));
        void transfer.catch(error => {
          try { runtime.devices.projects.fileResults.receive(device.id, { action: 'error', requestId: message.requestId, error: String(error) }); } catch {}
        });
      }
      if (message.kind === 'project-cancel') {
        record({ kind: 'environment', state: 'closed', terminals: [] });
        record({ kind: 'finished', state: 'cancelled', output: 'Fixture drained' });
      }
    });
    await store.updateSettings({ enabled: true }); runtime.start();
    const scene = await runtime.createCase({ title: 'Stage review', objective: '', domain: 'fixture' });
    const task = await runtime.requestTask({ requestId: 'stage-review', spec: { caseId: scene.id, title: 'Review staged output',
      objective: 'Produce stages and wait for owner approval', expectedOutput: 'Stage files and final result', capabilities: ['project'],
      project: { deviceId: device.id, root: workspace, access: 'read-write', readAccess: 'project', network: false, create: false },
      acceptance: { mode: 'owner', criteria: [], stageReview: 'owner' } } });
    await until(runtime, () => Boolean(input), 'Project was not dispatched');
    entry = { input: input!, state: 'paused', environment: 'closed', realPath: workspace, identity: 'fixture',
      sequence: 0, acknowledged: 0, appliedRevision: 1, output: '' };
    entry.checkpoint = await projectExecutionCheckpoint(workspace, privateDirectory);
    record({ kind: 'started', threadId: 'stage-fixture', engineVersion: 'fixture', realPath: workspace, identity: entry.identity! });
    const authorized = runtime.devices.projects.authorize(device.id, { operationId: input!.operationId,
      requirementsRevision: input!.requirementsRevision, specHash: input!.specHash });
    const result = await authorized.context.context(authorized.operation, { action: 'stage_review', arguments: {
      stageId: 'input', index: 1, count: 2, title: 'Input review', files: [{ path: file, format: 'md', size: content.length,
        sha256: createHash('sha256').update(content).digest('hex') }],
    } }) as { dependency: { id: string; revision: number } };
    record({ kind: 'workspace_saved', hash: entry.checkpoint, identity: entry.identity! });
    record({ kind: 'environment', state: 'closed', terminals: [] });
    record({ kind: 'paused', reason: 'Owner review' });
    await until(runtime, () => runtime.consent.task(task.id)?.flow?.phase === 'waiting_input', 'Review did not suspend');
    const request = { dependencyId: result.dependency.id, revision: result.dependency.revision };
    const delivery = await runtime.prepareProjectFiles(task.id, request); await transfer;
    assert.deepEqual(delivery.files.map(value => value.sourcePath), [file]);
    const downloaded = await runtime.projectFileContent(task.id, delivery.id, delivery.files[0].path);
    assert.deepEqual(downloaded.bytes, content);
    assert.equal(runtime.devices.projects.forTask(task.id)?.files, undefined);
    assert.equal(executions, 1); assert.equal(models, 0); assert.equal(transfers, 1);
    await assert.rejects(runtime.prepareProjectFiles(task.id, { ...request, revision: request.revision + 1 }), /变化/);
    await runtime.answerTaskInput(task.id, request.dependencyId, request.revision, { 'stage-decision': projectStageApproved });
    assert.equal(projectStageDecision(runtime.consent.dependency(request.dependencyId)!), 'approved');
    await until(runtime, () => executions === 2, 'The approved task did not continue');
    assert.equal(transfers, 1, 'Approval reuses the immutable file copy'); assert.equal(models, 0);
    const decided = runtime.consent.dependency(request.dependencyId)!;
    assert.equal((await runtime.prepareProjectFiles(task.id, { dependencyId: decided.id, revision: decided.revision })).id, delivery.id);
    await runtime.revokeTask(task.id, runtime.consent.get(task.id)!.revision);
    assert.deepEqual((await runtime.projectFileContent(task.id, delivery.id, delivery.files[0].path)).bytes, content);
  } finally { await transfer?.catch(() => {}); await runtime.close(); detach(); store.close(); }
});
