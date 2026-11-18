import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { deviceDirectoryLookupCapability, type DeviceDirectoryLookupSpec } from '../shared/local-device.js';
import type { TaskRecord, TaskSpec } from '../shared/task-consent.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'The consent recovery fixture did not reach its durable outcome');
    await delay(10);
  }
}

test('a clear owner message creates one generic text task through the common admission tool without another approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-owner-task-admission-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
  let admissionCalls = 0; let executionCalls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const tools = options.tools?.map(tool => tool.name) ?? [];
    if (tools.includes('request_task')) {
      admissionCalls++;
      assert.equal(tools.includes('publish_artifact'), false, 'The conversation only records consent');
      assert.equal(options.prompt.at(-1)?.role === 'tool', false, 'A deterministic acknowledgement ends the admission turn');
      return { content: [{ type: 'tool-call', toolCallId: 'owner-text-task', toolName: 'request_task',
        input: JSON.stringify({ title: '整理说明', objective: '将本人给出的安排整理成一份说明',
          expectedOutput: '一份简短Markdown说明', capabilities: ['artifact'] }) }],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [] };
    }
    executionCalls++;
    assert.ok(tools.includes('publish_artifact'));
    const final = options.prompt.at(-1)?.role === 'tool';
    return { content: final ? [{ type: 'text' as const, text: '说明已经保存，待你验收。' }]
      : [{ type: 'tool-call' as const, toolCallId: 'owner-text-output', toolName: 'publish_artifact',
        input: JSON.stringify({ title: '整理说明', content: '周三下午核对会议材料。', format: 'markdown' }) }],
      finishReason: { unified: final ? 'stop' as const : 'tool-calls' as const, raw: 'fixture' }, usage, warnings: [] };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const source = await runtime.ingestOwnerMessage('请把“周三下午核对会议材料”整理成一份简短说明。');
    assert.equal(admissionCalls, 0);
    await store.updateSettings({ enabled: true, maxStepsPerRun: 4 }); runtime.start();
    await until(() => runtime.consent.list().some(task => task.sourceEventId === source.id && task.state === 'completed'));
    const [task] = runtime.consent.list();
    assert.equal(runtime.consent.list().length, 1); assert.equal(task.sourceEventId, source.id);
    assert.equal(task.requirementsRevision, 1); assert.ok(task.approvedAt);
    assert.equal(runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    assert.equal(admissionCalls, 1); assert.equal(executionCalls, 2);
    const [artifact] = store.list('artifacts');
    assert.equal(store.list('artifacts').length, 1); assert.equal(artifact.taskId, task.id);
    assert.equal(artifact.status, 'prepared', 'Delivery does not claim owner acceptance');
    assert.equal(runtime.inbox.get(source.id)?.status, 'processed');
  } finally { await runtime.close(); store.close(); }
});

test('a paused approved task resumes across runtime restart with one execution event and one artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-consent-recovery-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls++;
    if (calls === 1) {
      const signal = options.abortSignal; assert.ok(signal);
      await new Promise<never>((_accept, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    const final = options.prompt.at(-1)?.role === 'tool';
    return { content: final ? [{ type: 'text', text: 'The original approved task is ready for review.' }]
      : [{ type: 'tool-call', toolCallId: 'recovered-artifact', toolName: 'publish_artifact',
        input: JSON.stringify({ title: 'Recovered fixture deliverable', content: 'Output of the original owner-approved task.' }) }],
      finishReason: { unified: final ? 'stop' : 'tool-calls', raw: 'fixture' }, usage, warnings: [] };
  } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const context = await runtime.createCase({ title: 'Consent recovery fixture', objective: 'Continue the same permission after interruption', domain: 'test' });
    const approved = await runtime.requestTask({ requestId: 'owner-recovery-fixture', spec: { caseId: context.id,
      title: 'Explicit fixture task', objective: 'Prepare the agreed text after an interruption', expectedOutput: 'One Markdown text',
      capabilities: ['artifact'] } });
    await store.updateSettings({ enabled: true, maxStepsPerRun: 3 });
    runtime.start(); await until(() => calls === 1);
    await runtime.stop();
    const paused = runtime.consent.get(approved.id)!;
    assert.equal(paused.state, 'running'); assert.equal(paused.approvalRevision, approved.approvalRevision);
    // Admission is consumed once; the native workflow now owns the paused
    // execution checkpoint instead of replaying the original inbox event.
    assert.equal(runtime.inbox.get(approved.executionEventId!)?.status, 'processed');
    assert.equal(store.list('artifacts').length, 0);
    assert.equal(store.list('runs').filter(run => run.taskId === approved.id)[0]?.status, 'interrupted');

    await runtime.close();
    runtime = await V2Coordinator.create(store, { dataDir: directory, model });
    assert.deepEqual(runtime.consent.get(approved.id), paused);
    assert.equal(calls, 1, 'Opening native memory and recovering state do not invoke the model');
    runtime.start(); await until(() => runtime.consent.get(approved.id)?.state === 'completed');
    const completed = runtime.consent.get(approved.id)!;
    assert.equal(completed.approvalRevision, approved.approvalRevision);
    assert.equal(completed.executionEventId, approved.executionEventId);
    assert.equal(runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    assert.equal(runtime.inbox.get(approved.executionEventId!)?.status, 'processed');
    assert.equal(store.list('artifacts').length, 1); assert.equal(store.list('artifacts')[0].taskId, approved.id);
    assert.equal(calls, 3, 'One interrupted request is followed by the resumed tool call and final answer');
    runtime.request('recovery'); await delay(50);
    assert.equal(calls, 3); assert.equal(store.list('artifacts').length, 1);
  } finally { await runtime.close(); store.close(); }
});

test('restart retires unstarted implicit directory permits and preserves reviewed consent and dispatched operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-legacy-lookup-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const model = new MockLanguageModelV4({ doGenerate: () => { throw new Error('Recovery must not invoke the model'); } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const item = await runtime.createCase({ title: 'Legacy directory lookup', objective: 'Preserve old records and fence uncertain authority', domain: 'test' });
    const { device } = runtime.devices.enroll({ name: 'Fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token });
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    const command: DeviceDirectoryLookupSpec = { kind: 'list_directory', deviceId: device.id, root: 'D:\\download', limit: 100, timeoutMs: 30000 };
    const spec: TaskSpec = { caseId: item.id, title: 'Read directory', objective: 'List file metadata', expectedOutput: 'List of file names',
      capabilities: ['local-command'], command };
    const owner = (content: string) => runtime.ingestOwnerMessage(content, item.id, undefined, undefined, undefined, device.id);
    // Fixture for the retired implicit writer, including its original outbox provenance.
    const legacy = async (content: string) => {
      const source = await owner(content);
      const oldWriter = runtime.consent as unknown as { authorize(spec: TaskSpec, key: string, sourceId: string): TaskRecord };
      return oldWriter.authorize(spec, `owner-local-lookup:${source.id}`, source.id);
    };
    const uncertain = await legacy('只想看“D:\\download”里带发票的三个 PDF。');
    const exact = await legacy('帮我看看D盘download有哪些文件。');
    const dispatched = await legacy('只想看“D:\\download”里一个文件。');
    const reviewedSource = await owner('确认这次查询计划。');
    const proposal = runtime.consent.propose(spec, reviewedSource.id);
    const reviewed = runtime.consent.approve(proposal.id, proposal.revision);
    const detach = runtime.devices.attach(device.id, message => {
      if (message.kind === 'execute') runtime.devices.recordResult(device.id, { operationId: message.operationId, state: 'cancelled' });
    });
    await runtime.devices.run(command, { taskId: dispatched.id, taskRevision: dispatched.revision, runId: 'legacy-run',
      deadline: Date.now() + 30000, signal: new AbortController().signal, guard() {} });
    detach();
    await runtime.close();
    runtime = await V2Coordinator.create(store, { dataDir: directory, model });
    const preserved = runtime.consent.get(uncertain.id)!;
    assert.equal(preserved.state, 'revoked');
    assert.match(preserved.error ?? '', /重新委托/);
    assert.deepEqual(preserved.spec, uncertain.spec);
    assert.equal(preserved.sourceEventId, uncertain.sourceEventId);
    assert.equal(preserved.executionEventId, uncertain.executionEventId);
    assert.ok(runtime.inbox.get(uncertain.executionEventId!));
    assert.equal(runtime.consent.get(exact.id)?.state, 'revoked');
    for (const retained of [dispatched, reviewed]) assert.equal(runtime.consent.get(retained.id)?.state, 'approved');
    assert.equal(runtime.devices.operationForTask(dispatched.id)?.receipt.state, 'cancelled');
  } finally { await runtime.close(); store.close(); }
});
