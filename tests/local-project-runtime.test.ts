import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { localProjectCapability, projectContextWindowCapability, projectRequestSchema, serverProjectResources,
  type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { taskOutcomeEvidenceSchema } from '../shared/personal-memory.js';
import type { RuntimeView } from '../shared/runtime-view.js';
import type { TaskRecord } from '../shared/task-consent.js';
import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';

async function until(runtime: V2Coordinator, predicate: () => boolean, detail = 'Project runtime did not settle') {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try { await new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) resolve(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error(detail)), 15000); check();
  }); } finally { detach(); clearTimeout(timer); }
}

test('a continuing owner task receives the previous result and exact attachment under the current device consent', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-project-handoff-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let previousTask = '', deviceId = '', admissionCalls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
    admissionCalls++;
    const text = JSON.stringify(prompt);
    assert.match(text, /11 列 Excel/);
    assert.match(text, new RegExp(previousTask));
    return { content: [{ type: 'tool-call', toolCallId: 'accept', toolName: 'request_task', input: JSON.stringify({
      title: 'Generate the requested plan', objective: 'Use the previous skill and original attachment', expectedOutput: '按所选 Skill 的 11 列 Excel 规则交付',
      acceptance: { finalFiles: [{ description: '所选 Skill 要求的 11 列 Excel', format: 'xlsx' }] },
      contextTaskIds: [previousTask], capabilities: ['project'], project: { deviceId, root: 'D:\\fixture', network: false },
    }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, warnings: [],
      usage: { inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } } };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const inputs: ProjectExecutionInput[] = [];
  let detach = () => {};
  try {
    const scene = await runtime.createCase({ title: 'Handoff', objective: '', domain: 'test' });
    deviceId = runtime.devices.enroll({ name: 'Fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device.id;
    runtime.devices.updateDevice(deviceId, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    detach = runtime.devices.attach(deviceId, message => {
      if (message.kind === 'project-execute') inputs.push(message.input);
      if (message.kind === 'project-cancel') {
        const operation = runtime.devices.projects.get(message.operationId)!;
        runtime.devices.projects.record(deviceId, { operationId: message.operationId, sequence: operation.sequence + 1,
          requirementsRevision: operation.input.requirementsRevision, at: new Date().toISOString(), event: { kind: 'finished', state: 'cancelled', output: 'Drained fixture' } });
      }
    });
    await store.updateSettings({ enabled: true }); runtime.start();
    const prior = await runtime.requestTask({ requestId: 'inspect', spec: { caseId: scene.id, title: 'Inspect skill', objective: 'Read existing skill', expectedOutput: 'Skill rules',
      capabilities: ['project'], project: { deviceId, root: 'D:\\fixture', access: 'read-only', readAccess: 'project', network: false, create: false } } });
    previousTask = prior.id;
    await until(runtime, () => inputs.length === 1);
    const completed = [...fixtureDelivery(1, undefined, inputs[0].contract), { kind: 'environment' as const, state: 'closed' as const, terminals: [] },
      { kind: 'finished', state: 'completed', output: '实际读取 Skill，要求 11 列 Excel，并执行原有校验。' } as const];
    completed.forEach((event, i) => runtime.devices.projects.record(deviceId, { operationId: inputs[0].operationId, sequence: i + 1, requirementsRevision: 1, at: new Date().toISOString(), event }));
    await until(runtime, () => runtime.consent.get(prior.id)?.state === 'completed');
    const bytes = Buffer.from('原始项目数据，保持完整字节');
    const owner = await runtime.ingestOwnerMessage('按刚才的 Skill 生成项目计划，自动审核。', scene.id, undefined, undefined, undefined, deviceId, undefined,
      [{ name: '项目.txt', mediaType: 'text/plain', data: bytes.toString('base64') }]);
    await until(runtime, () => inputs.length === 2);
    const current = inputs[1];
    assert.equal(inputs[0].contract?.version === 2 ? inputs[0].contract.finalFiles : null, undefined);
    assert.deepEqual(current.contract?.version === 2 ? current.contract.finalFiles : null,
      [{ description: '所选 Skill 要求的 11 列 Excel', format: 'xlsx' }]);
    const authorized = runtime.devices.projects.authorize(deviceId, { operationId: current.operationId, specHash: current.specHash, requirementsRevision: 1 });
    const catalog = await authorized.context.context(authorized.operation, { action: 'catalog' }) as { inputFiles: Array<{ id: string; size: number }>; relatedResults: unknown[] };
    assert.equal(catalog.inputFiles.length, 1); assert.equal(catalog.inputFiles[0].size, bytes.length);
    assert.match(JSON.stringify(catalog.relatedResults), /11 列 Excel/);
    const received = await authorized.context.context(authorized.operation, { action: 'input_file', id: catalog.inputFiles[0].id, offset: 0 }) as { data: string };
    assert.deepEqual(Buffer.from(received.data, 'base64'), bytes);
    await assert.rejects(authorized.context.context(authorized.operation, { action: 'input_file', id: 'other-message-file', offset: 0 }), /不属于/);
    assert.equal(runtime.consent.get(current.taskId)?.sourceEventId, owner.id);
    assert.equal(admissionCalls, 1);
    await runtime.revokeTask(current.taskId, runtime.consent.get(current.taskId)!.revision);
    await assert.rejects(authorized.context.context(authorized.operation, { action: 'input_file', id: catalog.inputFiles[0].id, offset: 0 }));
  } finally { await runtime.close(); detach(); store.close(); }
});

test('Linux dispatch requires the owner to confirm the exact displayed resources and uses no Windows client', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-linux-project-approval-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const model = store.models.upsert({ name: 'Fixture', kind: 'api-key', protocol: 'openai-responses', endpoint: 'https://fixture.invalid/v1',
    apiKey: 'offline-fixture', contextWindows: [{ modelId: 'fixture', contextWindow: 128_000 }] });
  store.models.setDefaults({ global: { connectionId: model.id, modelId: 'fixture', reasoning: 'default', maxOutputTokens: null },
    expectedRevision: store.models.directory().defaults.revision });
  const id = randomUUID();
  let conversationCalls = 0;
  let deviceLookupResult = '';
  const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
  const tool = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName,
    input: JSON.stringify(input) }], usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory,
    serverWorker: { id, name: 'Server fixture', credentialHash: 'a'.repeat(64) },
    model: new MockLanguageModelV4({ doGenerate: async ({ prompt }) => {
      conversationCalls++;
      if (conversationCalls === 1) return tool('list_task_devices', { for: 'project' });
      deviceLookupResult = JSON.stringify(prompt.filter(message => message.role === 'tool'));
      return tool('request_task', { title: 'Check the Server network', objective: 'Check connectivity from the Server execution device',
        expectedOutput: 'Actual network result', capabilities: ['project'], project: { deviceId: id, network: true,
          root: 'task-temporary', selectionSource: '请从我们的服务器检查接口连通性。' } });
    } }),
  });
  const app = createApp({ store, runtime });
  let detach: (() => void) | undefined;
  let dispatched: ProjectExecutionInput | undefined;
  try {
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const scene = await runtime.createCase({ title: 'Linux execution', objective: 'Resource confirmation', domain: 'test' });
    runtime.devices.updateDevice(id, { grants: [], capabilities: [localProjectCapability, projectContextWindowCapability, projectFilesCapability, projectContractCapability, projectContractV2Capability] });
    detach = runtime.devices.attach(id, message => {
      if (message.kind === 'project-execute') dispatched = message.input;
      if (message.kind === 'project-files') {
        const started = runtime.devices.projects.fileResults.receive(id, { action: 'begin', requestId: message.requestId,
          manifest: { snapshot: message.snapshot, files: [], omittedLinks: 0 } });
        if (!started.ready) runtime.devices.projects.fileResults.receive(id, { action: 'commit', requestId: message.requestId, deliveryId: started.deliveryId! });
      }
      if (message.kind === 'project-cancel' && dispatched) {
        const operation = runtime.devices.projects.get(dispatched.operationId)!;
        runtime.devices.projects.record(id, { operationId: dispatched.operationId, sequence: operation.sequence + 1,
          requirementsRevision: dispatched.requirementsRevision, at: new Date().toISOString(),
          event: { kind: 'environment', state: 'closed', terminals: [] } });
        if (!['completed', 'failed'].includes(operation.state)) runtime.devices.projects.record(id, { operationId: dispatched.operationId, sequence: operation.sequence + 2,
          requirementsRevision: dispatched.requirementsRevision, at: new Date().toISOString(),
          event: { kind: 'finished', state: 'cancelled', output: 'Fixture drained' } });
      }
    });
    const spec = { caseId: scene.id, title: 'Run Linux tests', objective: 'Build and test in Server', expectedOutput: 'Test receipt',
      capabilities: ['project'], project: projectRequestSchema.parse({ deviceId: id, network: false }) } as const;
    const resources = serverProjectResources(false);
    const forged = await post('/api/tasks', { requestId: 'forged', spec: { ...spec, project: { ...spec.project, serverResources: resources } } });
    assert.equal(forged.status, 400); await forged.body?.cancel();
    await store.updateSettings({ enabled: true }); runtime.start();
    const response = await post('/api/tasks', { requestId: 'owner-linux-task', spec });
    assert.equal(response.status, 201);
    const pending = await response.json() as TaskRecord;
    assert.equal(pending.state, 'proposed');
    assert.equal(pending.spec.project?.readAccess, 'project');
    assert.deepEqual(pending.spec.project?.serverResources, resources);
    assert.equal(pending.executionEventId, undefined);
    assert.equal(runtime.devices.projects.forTask(pending.id), undefined);
    const source = runtime.inbox.ingest({ sourceId: 'owner-chat', externalId: 'chat-owner-approval', caseId: scene.id,
      kind: 'owner.message', actor: 'owner', operation: 'create', occurredAt: new Date().toISOString(),
      payload: { messageId: 'chat-owner-approval', content: '同意执行。' } }).event;
    const [leased] = runtime.inbox.claim(1, 60_000, [source.id]);
    assert.ok(leased.leaseToken);
    assert.throws(() => runtime.consent.approve(pending.id, pending.revision, source.id, resources), /在任务卡/);
    runtime.inbox.ack(source.id, leased.leaseToken);
    const path = `/api/tasks/${pending.id}/approve`;
    for (const serverResources of [undefined, serverProjectResources(true)]) {
      const denied = await post(path, { revision: pending.revision, serverResources });
      assert.equal(denied.status, 409); await denied.body?.cancel();
    }
    assert.equal(runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 0);
    assert.equal(dispatched, undefined);

    const confirmed = await post(path, { revision: pending.revision, serverResources: resources });
    assert.equal(confirmed.status, 200);
    const approval = await confirmed.json() as TaskRecord;
    assert.equal(approval.state, 'approved');
    assert.ok(runtime.consent.isExecutionEvent(runtime.inbox.get(approval.executionEventId!)!));
    await until(runtime, () => Boolean(dispatched));
    const input = dispatched!;
    assert.equal(input.specHash, approval.serverApproval?.projectSpecHash);
    assert.deepEqual(input.spec, pending.spec.project);
    assert.equal(input.model.model, 'fixture');
    assert.equal(input.model.contextWindow, 128_000);
    const completion: ProjectEvent = { operationId: input.operationId, sequence: 7, requirementsRevision: input.requirementsRevision,
      at: new Date().toISOString(), event: { kind: 'finished', state: 'completed', output: 'Fixture tests passed' } };
    assert.throws(() => runtime.devices.projects.record(id, { ...completion, sequence: 1 }), /排空回执|执行方案/);
    runtime.devices.projects.record(id, { ...completion, sequence: 1, event: { kind: 'started', threadId: 'fixture', engineVersion: 'fixture', realPath: '/work/workspace', identity: 'fixture' } });
    runtime.devices.projects.record(id, { ...completion, sequence: 2, event: { kind: 'workspace_saved', hash: 'a'.repeat(64), identity: 'fixture' } });
    runtime.devices.projects.record(id, { ...completion, sequence: 3, event: { kind: 'environment', state: 'closed', retainedWorkspace: true, terminals: [] } });
    fixtureDelivery(input.requirementsRevision, undefined, input.contract).forEach((event, i) => runtime.devices.projects.record(id, { ...completion, sequence: 4 + i, event }));
    runtime.devices.projects.record(id, completion);
    await until(runtime, () => runtime.consent.get(pending.id)?.state === 'completed');
    assert.throws(() => runtime.devices.projects.run({ ...input, requirementsRevision: input.requirementsRevision + 1 }, {
      signal: new AbortController().signal, guard() {}, onEvent() {}, async model() {}, async context() {},
    }), /服务端任务环境已经结束/);
    assert.equal(conversationCalls, 0, 'admission and project dispatch do not require another model loop');

    const chat = await runtime.ingestOwnerMessage('请从我们的服务器检查接口连通性。', scene.id);
    await until(runtime, () => runtime.inbox.get(chat.id)?.status === 'processed');
    assert.equal(conversationCalls, 2);
    assert.match(deviceLookupResult, /Server fixture/);
    assert.match(deviceLookupResult, /linux/);
    assert.match(deviceLookupResult, /task-temporary/);
    assert.match(deviceLookupResult, /requiresResourceApproval/);
    const proposedInChat = (await runtime.listTasks()).find(task => task.sourceEventId === chat.id);
    assert.equal(proposedInChat?.state, 'proposed');
    assert.equal(proposedInChat.spec.project?.deviceId, id);
    assert.deepEqual(proposedInChat.spec.project?.serverResources, serverProjectResources(true));
    assert.equal(proposedInChat.executionEventId, undefined);
    assert.equal(runtime.devices.projects.forTask(proposedInChat.id), undefined);
  } finally {
    if (app.listening) { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
    try { await runtime.close(); } finally { detach?.(); store.close(); }
  }
});

test('full project objective enters one consent, preserves its native session on steer, then publishes its actual result', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-project-runtime-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let modelCalls = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({
    doGenerate: async () => { modelCalls++; throw new Error('The Mastra task must delegate to the native harness, not run a second model loop.'); },
  }) });
  let detach: (() => void) | undefined;
  try {
    const scene = await runtime.createCase({ title: 'Project', objective: 'Code acceptance', domain: 'test' });
    const device = runtime.devices.enroll({ name: 'Computer', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    let input: ProjectExecutionInput | undefined; let sequence = 0; let steered = false;
    let dispatches = 0;
    const record = (event: ProjectEvent['event']) => runtime.devices.projects.record(device.id, {
      operationId: input!.operationId, sequence: ++sequence, requirementsRevision: input!.requirementsRevision, at: new Date().toISOString(), event,
    });
    detach = runtime.devices.attach(device.id, message => {
      if (message.kind === 'project-execute') {
        dispatches++;
        input = message.input;
        record({ kind: 'started', threadId: 'native-thread', engineVersion: 'fixture', realPath: input.spec.root, identity: 'real-directory' });
      } else if (message.kind === 'project-steer') { input = { ...input!, ...message }; steered = true; }
      else if (message.kind === 'project-cancel') {
        record({ kind: 'environment', state: 'closed', terminals: [] });
        record(message.mode === 'pause' ? { kind: 'paused', reason: message.reason }
          : { kind: 'finished', state: 'cancelled', output: 'drained' });
      }
    });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 6 }); runtime.start();
    const task = await runtime.requestTask({ requestId: 'full-project', spec: { caseId: scene.id, title: 'Accept the whole frontend',
      objective: 'Read implementation, compare requirements, run checks and preview the app', expectedOutput: 'Evidence-backed findings and actual checks',
      capabilities: ['project'], project: { deviceId: device.id, root: 'D:\\fixture\\frontend', access: 'read-write', readAccess: 'device', network: true, create: false } } });
    await until(runtime, () => Boolean(input));
    assert.equal(input!.objective, task.spec.objective); assert.equal(input!.deadline, null);
    assert.equal(input!.stepLimit, null);
    record({ kind: 'tool', item: { id: 'read', type: 'commandExecution', label: 'read code', state: 'succeeded', exitCode: 0 } });
    runtime.devices.projects.beginModel(runtime.devices.projects.forTask(task.id)!, 'accepted-before-pause');
    await store.updateSettings({ enabled: false }); await runtime.stop();
    runtime.devices.projects.settleModel(input!.operationId, 'accepted-before-pause', { usageStatus: 'unknown' }, 'task_stopped');
    assert.equal(runtime.devices.projects.forTask(task.id)?.state, 'waiting');
    assert.equal(store.list('runs').find(run => run.taskId === task.id)?.taskExecution?.projectPaused, true);
    await store.updateSettings({ enabled: true }); runtime.start();
    await until(runtime, () => dispatches === 2, 'Paused project did not resume').catch(error => {
      throw new Error(error.message + ': ' + JSON.stringify({ dispatches, task: runtime.consent.get(task.id), runs: store.list('runs'),
        operation: runtime.devices.projects.forTask(task.id), error: store.getMeta('v2.lastError', '') }));
    });
    assert.equal(input!.stepLimit, null);
    assert.equal(runtime.devices.projects.forTask(task.id)?.modelCalls, 1);
    const imageData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=', 'base64');
    const attachment = { id: 'steer-image', name: 'layout.png', mediaType: 'image/png' as const, size: imageData.length, width: 1, height: 1 };
    store.insertOwnerMessage({ id: 'steer', role: 'user', content: 'Also compare the responsive mobile view.', caseId: scene.id,
      createdAt: new Date().toISOString(), attachments: [attachment] }, [{ attachment, data: imageData }]);
    const source = runtime.inbox.ingest({ sourceId: 'owner-chat', externalId: 'steer', caseId: scene.id, kind: 'owner.message',
      actor: 'owner', operation: 'create', occurredAt: new Date().toISOString(), payload: { messageId: 'steer', content: 'Also compare the responsive mobile view.' } }).event;
    const [leased] = runtime.inbox.claim(1, 60000, [source.id]); assert.ok(leased.leaseToken);
    await runtime.reviseTask(task.id, runtime.consent.get(task.id)!.revision, source.id); runtime.inbox.ack(source.id, leased.leaseToken);
    assert.equal(steered, true); assert.equal(input!.requirementsRevision, 2); assert.equal(input!.stepLimit, null);
    const authorized = runtime.devices.projects.authorize(device.id, { operationId: input!.operationId, specHash: input!.specHash, requirementsRevision: 2 });
    for (let i = 0; i < 21; i++) runtime.devices.projects.beginModel(authorized.operation, 'model-after-steer-' + i);
    assert.equal(runtime.devices.projects.forTask(task.id)?.modelCalls, 22);
    assert.throws(() => runtime.devices.projects.beginModel(authorized.operation, 'model-after-steer-20'), /已有记录/);
    for (let i = 0; i < 21; i++) runtime.devices.projects.settleModel(input!.operationId, 'model-after-steer-' + i, { usageStatus: 'unknown' });
    const context = await authorized.context.context(authorized.operation, { action: 'catalog', sinceRevision: 1 }) as {
      images: Array<{ type: string; url: string }>; tools: Array<{ name: string }>;
    };
    assert.equal(context.images.length, 1); assert.ok(context.images[0].url.endsWith(imageData.toString('base64')));
    assert.ok(context.tools.some(tool => tool.name === 'find_case_evidence'));
    assert.ok(!context.tools.some(tool => ['request_task', 'save_working_state', 'publish_artifact'].includes(tool.name)));
    const alreadyApplied = await authorized.context.context(authorized.operation, { action: 'catalog', sinceRevision: 2 }) as { images: unknown[] };
    assert.equal(alreadyApplied.images.length, 0);
    record({ kind: 'tool', item: { id: 'check-failed', type: 'commandExecution', label: 'First check', state: 'failed', exitCode: 1 } });
    record({ kind: 'tool', item: { id: 'test', type: 'commandExecution', label: 'npm test', state: 'succeeded', output: '7 tests passed', exitCode: 0 } });
    fixtureDelivery(2, 'delivery-check', input!.contract).forEach(record);
    record({ kind: 'environment', state: 'closed', terminals: [] });
    record({ kind: 'finished', state: 'unknown', output: '', error: 'Waiting for the original final receipt' });
    await until(runtime, () => runtime.consent.get(task.id)?.state === 'failed', 'Unknown native outcome must remain explicit');
    record({ kind: 'finished', state: 'completed', output: 'Read actual implementation. Seven checks passed; responsive view verified.' });
    await until(runtime, () => runtime.consent.get(task.id)?.state === 'completed', 'Revised project did not complete').catch(error => {
      throw new Error(error.message + ': ' + JSON.stringify({ dispatches, task: runtime.consent.get(task.id), runs: store.list('runs'),
        operation: runtime.devices.projects.forTask(task.id), error: store.getMeta('v2.lastError', '') }));
    });
    assert.equal(modelCalls, 0);
    assert.equal(runtime.consent.get(task.id)?.projectResolution?.previousState, 'failed');
    const reply = store.list('messages').find(message => message.runId === input!.runId);
    assert.match(reply!.content, /Seven checks/); assert.equal(reply!.outputState, 'complete');
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.projectWorkspaces?.length, 1); assert.equal(snapshot.projectOperations?.[0].state, 'completed');
    const run = store.get('runs', input!.runId)!;
    const outcome = taskOutcomeEvidenceSchema.parse(runtime.inbox.get(run.taskOutcomeEventId!)?.payload.outcome);
    assert.deepEqual(outcome.operations.map(({ kind, state, requirementsRevision }) => ({ kind, state, requirementsRevision })),
      [{ kind: 'project', state: 'completed', requirementsRevision: 2 }]);
    assert.deepEqual(outcome.checks.filter(check => check.name === 'project.command_exit').map(check => check.passed), [false, true],
      'Only commands from the current requirements enter learning evidence, including a failed check');
    const deliveryCheck = outcome.checks.find(check => check.name === 'project.delivery_check');
    assert.equal(deliveryCheck?.passed, true);
    assert.match(deliveryCheck!.detail, /关联 2 项要求/);
    assert.doesNotMatch(runtime.inbox.get(run.taskOutcomeEventId!)!.payload.content as string, /7 tests passed/,
      'Learning keeps check coverage without copying native command output');

    sequence = 0; input = undefined;
    const textOnly = await runtime.requestTask({ requestId: 'project-no-tools', spec: { ...task.spec, title: 'Run a check' } });
    await until(runtime, () => Boolean(input));
    assert.throws(() => record({ kind: 'finished', state: 'completed', output: 'The project turn returned without any tools.' }), /执行方案/);
    sequence--;
    record({ kind: 'finished', state: 'failed', output: 'The project turn returned without any tools.', error: '缺少当前要求版本的执行方案。' });
    await until(runtime, () => store.list('runs').some(item => item.taskId === textOnly.id && Boolean(item.taskOutcomeEventId)));
    const noToolsRun = store.list('runs').find(item => item.taskId === textOnly.id)!;
    const noToolsReply = store.list('messages').find(message => message.runId === noToolsRun.id)!;
    assert.ok(noToolsReply);
    const noTools = taskOutcomeEvidenceSchema.parse(runtime.inbox.get(noToolsRun.taskOutcomeEventId!)?.payload.outcome);
    assert.equal(noTools.checks.find(check => check.name === 'project.tool_receipt')?.passed, false);
  } finally { detach?.(); await runtime.close(); store.close(); }
});

test('project receipt HTTP retries leave live state responsive without loading unrelated history', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-project-receipt-retry-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  let modelCalls = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({
    doGenerate: async () => { modelCalls++; throw new Error('Receipt synchronization cannot call a model.'); },
  }) });
  const app = createApp({ store, runtime });
  let detach: (() => void) | undefined;
  const stream = new AbortController();
  const originalList = store.list;
  const originalOperations = runtime.devices.listOperations;
  const originalProject = runtime.devices.projects.get;
  const originalProjects = runtime.devices.projects.list;
  try {
    const scene = await runtime.createCase({ title: 'Project receipt retries', objective: 'Keep live state available', domain: 'test' });
    const at = '2026-11-07T00:00:00.000Z';
    store.atomic(() => {
      for (let index = 0; index < 1_000; index++) store.insert('runs', {
        id: 'archived-' + index, taskId: 'other-' + index, caseId: scene.id, mode: 'execution', trigger: 'manual',
        status: 'completed', startedAt: at, steps: 3, inputTokens: 100, outputTokens: 40,
        taskExecution: { requirementsRevision: 1, deadline: null, stepLimit: null },
      });
    });
    const { device, credential } = runtime.devices.enroll({
      name: 'Receipt retry fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token,
    });
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    let input: ProjectExecutionInput | undefined;
    let dispatches = 0;
    detach = runtime.devices.attach(device.id, message => {
      if (message.kind === 'project-execute') {
        input = message.input;
        dispatches++;
      } else if (message.kind === 'project-cancel' && input) {
        const operation = runtime.devices.projects.get(input.operationId)!;
        runtime.devices.projects.record(device.id, {
          operationId: input.operationId, sequence: operation.sequence + 1, requirementsRevision: input.requirementsRevision,
          at: new Date().toISOString(), event: { kind: 'finished', state: 'cancelled', output: 'Fixture stopped.' },
        });
      }
    });
    await store.updateSettings({ enabled: true });
    runtime.start();
    const task = await runtime.requestTask({ requestId: 'project-receipt-retry', spec: {
      caseId: scene.id, title: 'Read a fixture project', objective: 'Collect evidence', expectedOutput: 'A report',
      capabilities: ['project'], project: { deviceId: device.id, root: 'D:\\fixture', access: 'read-only', readAccess: 'project', network: false, create: false },
    } });
    await until(runtime, () => Boolean(input));
    await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
    const current = input!;
    const eventsDb = new DatabaseSync(join(directory, 'v2-events.sqlite'));
    try {
      const oldProject = runtime.devices.projects.get(current.operationId)!;
      eventsDb.prepare('INSERT INTO local_project_operations(id,task_id,device_id,json) VALUES(?,?,?,?)')
        .run('archived-operation', 'archived-project', device.id, JSON.stringify({
          ...oldProject,
          input: { ...oldProject.input, operationId: 'archived-operation', taskId: 'archived-project' },
          state: 'completed', workspaceReserved: false, updatedAt: at, sequence: 4,
          output: 'ARCHIVED_PROJECT_OUTPUT '.repeat(20_000), environment: { state: 'closed', terminals: [] },
        }));
    } finally { eventsDb.close(); }
    const event = (sequence: number, value: ProjectEvent['event']): ProjectEvent => ({
      operationId: current.operationId, sequence, requirementsRevision: current.requirementsRevision, at: new Date().toISOString(), event: value,
    });
    const batch = Array.from({ length: 50 }, (_, index) => index === 0
      ? event(1, { kind: 'started', threadId: 'native-fixture', engineVersion: 'fixture', realPath: current.spec.root, identity: 'fixture-directory' })
      : event(index + 1, { kind: 'text', text: 'delta-' + index + '\n' }));
    const post = async (events: ProjectEvent[]) => {
      const response = await fetch(origin + '/api/device/projectevents', {
        method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
        body: JSON.stringify(events),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    let allRunReads = 0;
    let allDeviceOperationReads = 0;
    let allProjectReads = 0;
    let projectReads = 0;
    store.list = ((name: Parameters<Store['list']>[0]) => {
      if (name === 'runs') allRunReads++;
      return originalList.call(store, name);
    }) as Store['list'];
    runtime.devices.listOperations = taskId => {
      if (taskId === undefined) allDeviceOperationReads++;
      return originalOperations.call(runtime.devices, taskId);
    };
    runtime.devices.projects.get = operationId => {
      if (operationId === current.operationId) projectReads++;
      return originalProject.call(runtime.devices.projects, operationId);
    };
    runtime.devices.projects.list = () => {
      allProjectReads++;
      return originalProjects.call(runtime.devices.projects);
    };
    const initial = await fetch(origin + '/api/state/stream?caseId=' + scene.id, {
      signal: AbortSignal.any([stream.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(initial.status, 200);
    assert.match(initial.headers.get('content-type') ?? '', /^text\/event-stream/);
    const reader = initial.body!.pipeThrough(new TextDecoderStream()).getReader();
    const live = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Live state closed before the project finished.');
          buffer += value;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!data || !/^event: state$/m.test(frame)) continue;
            const view = JSON.parse(data) as RuntimeView;
            if (view.projectOperations?.some(operation => operation.taskId === task.id && operation.state === 'completed')
              && view.tasks.some(value => value.id === task.id && value.state === 'completed')) return view;
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })();
    try {
      assert.deepEqual(await post(batch), { sequence: 50 });
      const readsBeforeReplay = projectReads;
      const responses = await Promise.all([
        ...Array.from({ length: 6 }, () => post(batch)),
        fetch(origin + '/api/health').then(async response => {
          assert.equal(response.status, 200);
          return response.json();
        }),
      ]);
      assert.deepEqual(responses.slice(0, 6), Array.from({ length: 6 }, () => ({ sequence: 50 })));
      assert.deepEqual(responses[6], { ok: true, runtime: 'mastra' });
      assert.equal(projectReads - readsBeforeReplay, 0, 'replayed batches must not load the full project projection');
      assert.equal(runtime.devices.projects.forTask(task.id)?.output,
        Array.from({ length: 49 }, (_, index) => 'delta-' + (index + 1) + '\n').join(''));
      await post(fixtureDelivery(current.requirementsRevision, undefined, current.contract).map((item, i) => event(51 + i, item)));
      await post([event(54, { kind: 'environment', state: 'closed', terminals: [] })]);
      const terminal = event(55, { kind: 'finished', state: 'completed', output: 'Fixture report delivered.' });
      assert.deepEqual(await post([terminal]), { sequence: 55 });
      assert.deepEqual(await post([terminal]), { sequence: 55 });
      const view = await live;
      assert.ok(view.history.runs.items.length <= 40);
      assert.equal(view.projectOperations?.find(operation => operation.taskId === task.id)?.sequence, 55);
      assert.deepEqual(view.projectOperations?.find(operation => operation.taskId === 'archived-project'),
        { taskId: 'archived-project', sequence: 4, state: 'completed', updatedAt: at, environment: 'closed' });
      assert.doesNotMatch(JSON.stringify(view), /ARCHIVED_PROJECT_OUTPUT/);
      const projectReadsBeforeView = allProjectReads;
      const snapshot = await fetch(origin + '/api/state?caseId=' + scene.id);
      assert.equal(snapshot.status, 200);
      assert.equal(allProjectReads, projectReadsBeforeView, 'live state must not read historical project bodies to render summaries');
      assert.equal(allRunReads, 0, 'live receipts must not load unrelated runs');
      assert.equal(allDeviceOperationReads, 0, 'project receipts must not scan legacy command receipts');
      assert.equal(dispatches, 1);
      assert.equal(modelCalls, 0);
    } finally { stream.abort(); await live.catch(() => {}); }
  } finally {
    stream.abort();
    store.list = originalList;
    runtime.devices.listOperations = originalOperations;
    runtime.devices.projects.get = originalProject;
    runtime.devices.projects.list = originalProjects;
    if (app.listening) { app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); }
    try { await runtime.close(); } finally { detach?.(); store.close(); }
  }
});
