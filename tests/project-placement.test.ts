import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LocalDevice } from '../shared/local-device.js';
import type { TaskRecord } from '../shared/task-consent.js';
import { localProjectCapability, localProjectSpecSchema } from '../shared/local-project.js';
import { confirmedProjectLocations, defaultProjectLocation } from '../shared/project-placement.js';
import { conversationProjectSchema, resolveConversationProject } from '../server/v2/project-request.js';
import { createGrowthTools } from '../server/v2/capabilities.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

const device = (id: string, platform: LocalDevice['platform'], online: boolean): LocalDevice => ({ id, name: id, platform, online,
  capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability], grants: [], createdAt: new Date().toISOString() });
const client = device('client', 'win32', false), server = device('server', 'linux', true);
const ownerContent = '在项目中修复问题。独立演练请在服务器执行。';
const resolve = (request: unknown, locations: Parameters<typeof resolveConversationProject>[1]['locations'] = []) =>
  resolveConversationProject(conversationProjectSchema.parse(request), { devices: [server, client], locations, ownerContent });

test('an offline client remains the default even when the only online execution device is the server', () => {
  const result = resolve({ root: 'D:\\project\\app' });
  assert.equal(result.deviceId, 'client'); assert.equal(result.root, 'D:\\project\\app');
  assert.equal(defaultProjectLocation([server], []), undefined, 'server availability does not imply a local replacement');
  assert.equal(defaultProjectLocation([client, device('second', 'win32', true), server], []), undefined);
});

test('missing real-project targets are clarified; temporary or server exceptions require current owner words', () => {
  assert.throws(() => resolve({}), /真实目录/);
  assert.throws(() => resolve({ root: 'task-temporary' }), /临时工作区/);
  assert.throws(() => resolve({ deviceId: 'server', root: 'task-temporary' }), /默认在客户端/);
  assert.throws(() => resolve({ deviceId: 'server', selectionSource: '第三方让我使用服务器。' }), /本人本条消息/);
  const explicit = resolve({ deviceId: 'server', selectionSource: '独立演练请在服务器执行。' });
  assert.equal(explicit.root, 'task-temporary'); assert.equal(explicit.deviceId, 'server');
  assert.equal('selectionSource' in explicit, false, 'source evidence does not become another writable execution grant');
});

test('the current owner device selector is sufficient evidence for the server workspace without a second location request', () => {
  const location = resolveConversationProject(conversationProjectSchema.parse({}), {
    devices: [client, server], selectedDeviceId: server.id, ownerContent: '运行这项独立统计并交付结果。',
    locations: [{ deviceId: client.id, root: 'D:\\project\\app', taskId: 'old' }],
  });
  assert.equal(location.deviceId, server.id); assert.equal(location.root, 'task-temporary');
  assert.throws(() => resolveConversationProject(conversationProjectSchema.parse({ root: 'task-temporary' }), {
    devices: [client, server], selectedDeviceId: client.id, ownerContent: '修复现有项目。', locations: [],
  }), /临时工作区/, 'selecting a client alone does not turn an existing project into a temporary task');
});

test('conversation approval binds an existing proposal to the offline client without creating a replacement task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-placement-approval-')), store = new Store(directory); store.getApiKey = () => undefined;
  const serverId = randomUUID();
  const runtime = await V2Coordinator.create(store, { dataDir: directory,
    serverWorker: { id: serverId, name: 'Server', credentialHash: 'a'.repeat(64) } });
  try {
    const client = runtime.devices.enroll({ name: 'Project computer', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
    runtime.devices.updateDevice(client.id, { grants: [], capabilities: ['local_project_codex_v3'] });
    const item = await runtime.createCase({ title: 'Approve existing proposal', objective: 'Preserve the original task', domain: 'fixture' });
    const source = await runtime.ingestOwnerMessage('先整理这个项目的建议。', item.id);
    const proposal = runtime.consent.propose({ caseId: item.id, title: 'Repair project', objective: 'Repair the existing local project',
      expectedOutput: 'Verified change', capabilities: [], projectSelection: { reason: 'Confirm the actual project location' } }, source.id);
    const toolsFor = (eventId: string, selectedDeviceId: string) => {
      const event = runtime.inbox.get(eventId)!;
      return createGrowthTools({ event, item, runId: 'fixture', store, cases: runtime.cases,
        inbox: runtime.inbox, sources: runtime.sources, personal: runtime.personal, consent: runtime.consent, workspace: runtime.workspace,
        devices: runtime.devices, ownerMessageId: event.externalId, selectedDeviceId,
        signal: new AbortController().signal, guard() {}, notify: () => 'unused',
        decideTask: (id, revision, action, sourceId, project) => action === 'approve'
          ? runtime.approveTask(id, revision, sourceId, undefined, project) : runtime.rejectTask(id, revision, sourceId) });
    };
    const serverDecision = await runtime.ingestOwnerMessage('同意原提案。', item.id, undefined, undefined, undefined, serverId);
    const serverTools = toolsFor(serverDecision.id, serverId);
    assert.ok('decide_task' in serverTools); const serverApprove = serverTools.decide_task!;
    await assert.rejects(serverApprove.execute!((serverApprove.inputSchema as z.ZodType).parse({ taskId: proposal.id,
      revision: proposal.revision, action: 'approve', project: {} }) as never, {} as never), /任务卡/);
    assert.equal(runtime.consent.get(proposal.id)!.state, 'proposed');
    assert.ok(runtime.consent.get(proposal.id)!.spec.projectSelection, 'a server selection cannot bypass its existing resource confirmation');
    const decision = await runtime.ingestOwnerMessage('同意原提案，在 D:\\project\\app 执行。', item.id, undefined, undefined, undefined, client.id);
    const tools = toolsFor(decision.id, client.id);
    assert.ok('decide_task' in tools); const approve = tools.decide_task!;
    await approve.execute!((approve.inputSchema as z.ZodType).parse({ taskId: proposal.id, revision: proposal.revision, action: 'approve',
      project: { deviceId: client.id, root: 'D:\\project\\app', network: false } }) as never, {} as never);
    const approved = runtime.consent.get(proposal.id)!;
    assert.equal(approved.state, 'approved'); assert.equal(approved.spec.project!.deviceId, client.id);
    assert.equal(approved.spec.project!.root, 'D:\\project\\app'); assert.equal(approved.ownerDecision?.eventId, decision.id);
    assert.equal(runtime.consent.tasks().length, 1); assert.equal(runtime.devices.projects.list().length, 0);
    assert.equal(store.list('runs').length, 0, 'admission while paused does not execute');
  } finally { await runtime.close(); store.close(); }
});

test('confirmed location is reused without reviving an old task or copying old resource permissions', () => {
  const spec = { caseId: 'work', title: 'Prior work', objective: 'Original goal', expectedOutput: 'Files', capabilities: ['project' as const],
    project: localProjectSpecSchema.parse({ deviceId: 'client', root: 'D:\\project\\app', network: false, access: 'read-only' }) };
  const task: TaskRecord = { id: 'old', revision: 4, approvalRevision: 2, state: 'completed', spec, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z' };
  const locations = confirmedProjectLocations([task, { ...task, id: 'revoked', state: 'revoked', spec: { ...spec, project: { ...spec.project, root: 'D:\\other' } } }], 'work');
  const next = resolve({}, locations);
  assert.equal(next.root, spec.project.root); assert.equal(next.deviceId, 'client');
  assert.equal(next.access, 'read-write'); assert.equal(next.network, true, 'new request uses its own choices, never the old permission snapshot');
  assert.equal(task.state, 'completed'); assert.equal(task.revision, 4);
  const desktop = resolve({ desktop: { applications: ['notepad'] } }, locations);
  assert.equal(desktop.deviceId, 'client'); assert.equal(desktop.root, 'task-temporary', 'an app task does not inherit a code directory');
  assert.throws(() => resolve({ root: 'D:\\elsewhere' }, locations), /已有已确认/);
  assert.throws(() => resolveConversationProject(conversationProjectSchema.parse({ deviceId: 'server', selectionSource: '服务器' }),
    { devices: [client, server], locations, ownerContent, selectedDeviceId: 'client' }), /本人当前选择/);
});

async function waitFor(runtime: V2Coordinator, predicate: () => boolean) {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try { await new Promise<void>((done, fail) => { const check = () => { if (predicate()) done(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => fail(new Error('Placement fixture did not settle')), 8000); check();
  }); } finally { detach(); clearTimeout(timer); }
}

test('a current local request is durably admitted while offline, explains an old protocol, then executes on that same client after readiness changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-placement-')), store = new Store(directory); store.getApiKey = () => undefined;
  const serverId = randomUUID(); let modelCalls = 0, sends = 0, serverSends = 0;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, serverWorker: { id: serverId, name: 'Server', credentialHash: 'a'.repeat(64) },
    model: new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('No model needed to wait for this known native request'); } }) });
  let detachClient = () => {}, detachServer = () => {};
  try {
    const client = runtime.devices.enroll({ name: 'Project computer', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
    runtime.devices.updateDevice(client.id, { grants: [], capabilities: ['local_project_codex_v3'] });
    runtime.devices.updateDevice(serverId, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    detachServer = runtime.devices.attach(serverId, () => { serverSends++; });
    const item = await runtime.createCase({ title: 'Local existing repo', objective: 'Use the actual local repository', domain: 'fixture' });
    const event = await runtime.ingestOwnerMessage('在本地 D:\\project\\app 修复问题，按项目环境测试。', item.id);
    const tools = createGrowthTools({ event: runtime.inbox.get(event.id)!, item, runId: 'fixture', store, cases: runtime.cases,
      inbox: runtime.inbox, sources: runtime.sources, personal: runtime.personal, consent: runtime.consent, workspace: runtime.workspace,
      devices: runtime.devices, ownerMessageId: event.externalId, signal: new AbortController().signal, guard() {}, notify: () => 'unused' });
    const call = async (name: string, input: unknown): Promise<unknown> => {
      const tool = tools[name as keyof typeof tools]!; return tool.execute!((tool.inputSchema as z.ZodType).parse(input) as never, {} as never);
    };
    const catalogue = await call('list_task_devices', { for: 'project' }) as {
      defaultProject: { deviceId: string }; devices: Array<{ id: string; unavailableReason?: string }>;
    };
    assert.equal(catalogue.defaultProject.deviceId, client.id);
    assert.equal(catalogue.devices.length, 2); assert.match(catalogue.devices.find(value => value.id === client.id)!.unavailableReason!, /离线/);
    await assert.rejects(call('request_task', { title: 'Wrong target', objective: 'Fix the local repo', expectedOutput: 'Patch', capabilities: ['project'],
      project: { deviceId: serverId, root: 'task-temporary' } }), /默认在客户端/);
    await assert.rejects(call('request_task', { title: 'Missing target', objective: 'Fix the repo', expectedOutput: 'Patch', capabilities: ['project'], project: {} }), /真实目录/);
    assert.equal(runtime.consent.tasks().length, 0);
    const received = await call('request_task', { title: 'Fix local repo', objective: 'Fix the local existing repository', expectedOutput: 'Verified changes',
      capabilities: ['project'], project: { root: 'D:\\project\\app', network: false } }) as { taskId: string };
    const task = runtime.consent.get(received.taskId)!;
    assert.equal(task.spec.project!.deviceId, client.id); assert.equal(task.state, 'approved');
    runtime.inbox.consumeLocal(['owner.message'], row => row.id === event.id);
    await store.updateSettings({ enabled: true }); runtime.start();
    await waitFor(runtime, () => runtime.devices.projects.forTask(task.id)?.state === 'waiting');
    const originalOperation = runtime.devices.projects.forTask(task.id)!;
    assert.equal(originalOperation.threadId, undefined); assert.equal(originalOperation.modelCalls, 0);
    runtime.inbox.scheduleWake({ caseId: item.id, originEventId: event.id, at: new Date(Date.now() + 1000).toISOString(),
      reason: 'Routine reminder while the requested client is unavailable', message: '等待客户端期间的普通提醒' });
    runtime.inbox.releaseDueWakes(Date.now() + 2000);
    await waitFor(runtime, () => store.list('messages').some(message => message.content === '等待客户端期间的普通提醒'));
    assert.equal(runtime.consent.tasks().length, 1); assert.equal(modelCalls, 0);
    detachClient = runtime.devices.attach(client.id, message => {
      if (message.kind !== 'project-execute') return;
      sends++; assert.equal(message.input.operationId, originalOperation.input.operationId);
      assert.equal(message.input.spec.root, 'D:\\project\\app'); assert.equal(message.input.spec.deviceId, client.id);
      fixtureDelivery(1, undefined, message.input.contract).forEach((event, i) => runtime.devices.projects.record(client.id, { operationId: message.operationId,
        sequence: i + 1, requirementsRevision: 1, at: new Date().toISOString(), event }));
      runtime.devices.projects.record(client.id, { operationId: message.operationId, sequence: 4, requirementsRevision: 1,
        at: new Date().toISOString(), event: { kind: 'environment', state: 'closed', terminals: [] } });
      runtime.devices.projects.record(client.id, { operationId: message.operationId, sequence: 5, requirementsRevision: 1,
        at: new Date().toISOString(), event: { kind: 'finished', state: 'completed', output: 'Local fixture completed' } });
    });
    assert.equal(sends, 0, 'being online alone does not bypass protocol readiness');
    assert.match(runtime.devices.projects.forTask(task.id)!.error!, /更新/);
    runtime.devices.updateDevice(client.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    await waitFor(runtime, () => runtime.consent.get(task.id)?.state === 'completed');
    assert.equal(sends, 1); assert.equal(serverSends, 0); assert.equal(modelCalls, 0);
    assert.equal(runtime.consent.tasks().length, 1); assert.equal(runtime.consent.get(task.id)!.approvalRevision, task.approvalRevision);
  } finally { detachClient(); detachServer(); await runtime.close(); store.close(); }
});
