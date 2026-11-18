import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { fixtureDelivery } from './support/project-delivery.js';
import { localProjectCapability, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import { projectInputContext, projectInputs } from '../server/v2/project-inputs.js';
import type { TaskRecord } from '../shared/task-consent.js';
import type { InboxEvent } from '../server/v2/events.js';
import sharp from 'sharp';

async function until(runtime: V2Coordinator, predicate: () => boolean) {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (predicate()) resolve(); };
      detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error('Expected project state was not reached')), 10000); check();
    });
  } finally { detach(); clearTimeout(timer); }
}

test('an approved external proposal hands over its actual owner approval attachments and retains their source through result reuse', { timeout: 30000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-approval-inputs-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let modelCalls = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: directory,
    model: new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('This fixture must not run a model'); } }) });
  const inputs: ProjectExecutionInput[] = [];
  let detach = () => {};
  try {
    const scene = await runtime.createCase({ title: 'Approved project', objective: '', domain: 'fixture' });
    const unrelatedScene = await runtime.createCase({ title: 'Unrelated files', objective: '', domain: 'fixture' });
    const device = runtime.devices.enroll({ name: 'Fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    detach = runtime.devices.attach(device.id, message => {
      if (message.kind === 'project-execute') inputs.push(message.input);
      if (message.kind === 'project-cancel') {
        const operation = runtime.devices.projects.get(message.operationId)!;
        runtime.devices.projects.record(device.id, { operationId: message.operationId, sequence: operation.sequence + 1,
          requirementsRevision: operation.input.requirementsRevision, at: new Date().toISOString(), event: { kind: 'environment', state: 'closed', terminals: [] } });
        runtime.devices.projects.record(device.id, { operationId: message.operationId, sequence: operation.sequence + 2,
          requirementsRevision: operation.input.requirementsRevision, at: new Date().toISOString(), event: { kind: 'finished', state: 'cancelled', output: 'Fixture drained' } });
      }
    });
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    const quotedBytes = Buffer.from('Earlier original file\r\n此前原件');
    const approvedBytes = Buffer.from('Approval attachment\r\n本次批准原件');
    const quoted = await runtime.ingestOwnerMessage('这份资料随后会引用。', scene.id, undefined,
      [{ name: 'reference.png', data: image.toString('base64') }], undefined, device.id, undefined,
      [{ name: 'reference.txt', mediaType: 'text/plain', data: quotedBytes.toString('base64') }]);
    const unrelated = await runtime.ingestOwnerMessage('别的场景资料。', unrelatedScene.id, undefined, undefined, undefined, undefined, undefined,
      [{ name: 'unrelated.txt', mediaType: 'text/plain', data: Buffer.from('unrelated').toString('base64') }]);
    const proposalSource = runtime.inbox.ingestProcessed({ sourceId: 'fixture-research', externalId: 'external-suggestion',
      caseId: scene.id, kind: 'web.search', actor: 'external', operation: 'create', occurredAt: new Date().toISOString(),
      payload: { content: 'External material suggests producing a report.' } });
    const proposal = runtime.consent.propose({ caseId: scene.id, title: 'Prepare project output', objective: 'Use the owner original files',
      expectedOutput: 'Verified report', capabilities: ['project'], project: { deviceId: device.id, root: 'D:\\fixture', access: 'read-write', readAccess: 'project', network: false, create: false } }, proposalSource.id);
    await assert.rejects(runtime.approveTask(proposal.id, proposal.revision, proposalSource.id), /本人/);
    const approved = await runtime.ingestOwnerMessage('同意这项提案，结合引用资料和本条附件执行。', scene.id, quoted.externalId,
      [{ name: 'approval.png', data: image.toString('base64') }], undefined, device.id, undefined,
      [{ name: 'approval.txt', mediaType: 'text/plain', data: approvedBytes.toString('base64') }]);
    const task = await runtime.approveTask(proposal.id, proposal.revision, approved.id);
    runtime.inbox.consumeLocal(['owner.message'], () => true);
    await store.updateSettings({ enabled: true }); runtime.start();
    await until(runtime, () => inputs.length === 1);
    const input = inputs[0];
    assert.equal(input.ownerRequest, approved.payload.content);
    const authorization = { operationId: input.operationId, specHash: input.specHash, requirementsRevision: input.requirementsRevision };
    const authorized = runtime.devices.projects.authorize(device.id, authorization);
    const catalog = await authorized.context.context(authorized.operation, { action: 'catalog' }) as {
      inputFiles: Array<{ id: string; name: string; messageId: string; sha256: string }>; images: Array<{ type: string; url: string }>;
    };
    assert.deepEqual(catalog.inputFiles.map(file => file.name).sort(), ['approval.txt', 'reference.txt']);
    for (const [name, bytes] of [['approval.txt', approvedBytes], ['reference.txt', quotedBytes]] as const) {
      const file = catalog.inputFiles.find(file => file.name === name)!;
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
      const loaded = await authorized.context.context(authorized.operation, { action: 'input_file', id: file.id, offset: 0 }) as { data: string };
      assert.deepEqual(Buffer.from(loaded.data, 'base64'), bytes);
    }
    assert.equal(catalog.images.length, 2);
    const expectedImages = [approved, quoted].map(event => {
      const message = store.get('messages', event.externalId)!;
      const saved = store.readImage(message.attachments![0].id)!;
      return 'data:' + saved.attachment.mediaType + ';base64,' + saved.data.toString('base64');
    });
    assert.deepEqual(catalog.images.map(image => image.url).sort(), expectedImages.sort());
    const currentOnly = await authorized.context.context(authorized.operation, { action: 'catalog', sinceRevision: 1 }) as { images: unknown[] };
    assert.deepEqual(currentOnly.images, []);
    const direct = projectInputContext({ ...task, sourceEventId: approved.id }, store, runtime.inbox, runtime.sources);
    assert.equal(direct.messages.length, 2, 'Repeated references to the approval event are deduplicated');
    assert.deepEqual(new Set(store.get('runs', input.runId)!.taskExecution!.ownerInputEventIds), new Set([approved.id, quoted.id]));
    const message = store.get('messages', approved.externalId)!;
    store.put('messages', { ...message, replyTo: unrelated.externalId });
    assert.deepEqual(projectInputs(task, store, runtime.inbox, runtime.sources).map(file => file.manifest.name), ['approval.txt']);
    store.put('messages', message);
    const isAllowed = runtime.sources.isEventAllowed.bind(runtime.sources);
    let withdrawn = false;
    context.mock.method(runtime.sources, 'isEventAllowed', (event: InboxEvent) => !withdrawn || event.id !== approved.id ? isAllowed(event) : false);
    withdrawn = true;
    await assert.rejects(authorized.context.context(authorized.operation, { action: 'input_file', id: catalog.inputFiles[0].id, offset: 0 }), /来源已失效/);
    withdrawn = false;
    const record = (event: ProjectEvent['event']) => runtime.devices.projects.record(device.id, { operationId: input.operationId,
      sequence: runtime.devices.projects.get(input.operationId)!.sequence + 1, requirementsRevision: input.requirementsRevision, at: new Date().toISOString(), event });
    fixtureDelivery(input.requirementsRevision, 'check', input.contract).forEach(record);
    record({ kind: 'environment', state: 'closed', terminals: [] }); record({ kind: 'finished', state: 'completed', output: 'Actual approved input was used.' });
    await until(runtime, () => runtime.consent.get(task.id)!.state === 'completed');
    const run = store.get('runs', input.runId)!;
    const outcome = runtime.inbox.get(run.taskOutcomeEventId!)!;
    assert.ok((outcome.payload.outcome as { sourceEventIds: string[] }).sourceEventIds.includes(approved.id));
    const readResult = (runtime as unknown as { readTaskResult(task: TaskRecord): { unavailable?: boolean; ownerInputEventIds?: string[] } }).readTaskResult.bind(runtime);
    assert.ok(readResult(runtime.consent.get(task.id)!).ownerInputEventIds!.includes(approved.id));
    withdrawn = true;
    assert.equal(readResult(runtime.consent.get(task.id)!).unavailable, true);
    assert.equal(runtime.sources.isEventAllowed(outcome), false, 'A withdrawn approval source cannot re-enter method learning through its outcome');
    withdrawn = false;

    await store.updateSettings({ enabled: false }); await runtime.stop();
    const followup = await runtime.ingestOwnerMessage('沿用刚才的结果继续整理。', scene.id);
    const child = runtime.consent.requestOwnerTask({ ...task.spec, title: 'Continue the related result' }, followup.id, [], [task.id]);
    runtime.inbox.consumeLocal(['owner.message'], () => true);
    await store.updateSettings({ enabled: true }); runtime.start();
    await until(runtime, () => inputs.length === 2);
    const next = inputs[1];
    const childAuthorized = runtime.devices.projects.authorize(device.id, { operationId: next.operationId, specHash: next.specHash, requirementsRevision: next.requirementsRevision });
    await childAuthorized.context.context(childAuthorized.operation, { action: 'catalog' });
    assert.ok(store.get('runs', next.runId)!.taskExecution!.ownerInputEventIds!.includes(approved.id));
    withdrawn = true;
    await assert.rejects(childAuthorized.context.context(childAuthorized.operation, { action: 'catalog' }), /来源已失效/);
    withdrawn = false;
    await runtime.revokeTask(child.id, runtime.consent.get(child.id)!.revision);
    assert.equal(modelCalls, 0);
  } finally { await runtime.close(); detach(); store.close(); }
});
