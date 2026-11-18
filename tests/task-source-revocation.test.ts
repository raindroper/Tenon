import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { TaskContext } from '../server/v2/task-context.js';
import { MockLanguageModelV4 } from './support/model.js';
import { deviceDirectoryLookupCapability, type DeviceExecuteMessage } from '../shared/local-device.js';
import type { TaskSpec } from '../shared/task-consent.js';

const usage = { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], warnings: [], usage, finishReason: { unified: 'stop' as const, raw: 'fixture' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolName, toolCallId: randomUUID(), input: JSON.stringify(input) }],
  warnings: [], usage, finishReason: { unified: 'tool-calls' as const, raw: 'fixture' } });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, reason: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), 10_000); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean, reason: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await delay(10); }
}

test('retiring one source drains its cross-scene tasks, preserves unrelated source work and keeps retired text out after restart', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-source-revocation-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const entered = gate(), aborted = gate(), release = gate();
  let sourceA = '', sourceB = '', taskA = ''; let stageA = 0, stageB = 0, chatCalls = 0, totalCalls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    totalCalls++; const prompt = JSON.stringify(options.prompt);
    if (!options.tools?.some(tool => tool.name === 'publish_artifact')) {
      chatCalls++; assert.doesNotMatch(prompt, /PRIVATE_SOURCE_A_BODY|DERIVED_FROM_SOURCE_A/);
      if (chatCalls === 1) return call('read_task_result', { taskId: taskA });
      assert.match(prompt, /unavailable/); return answer('The task source is no longer available.');
    }
    if (prompt.includes('TASK_A_ACTIVE')) {
      stageA++;
      if (stageA === 1) return call('read_event', { eventId: sourceA });
      assert.match(prompt, /PRIVATE_SOURCE_A_BODY/);
      if (stageA === 2) {
        const next = call('read_event', { eventId: sourceA });
        return { ...next, content: [{ type: 'text' as const, text: 'DERIVED_FROM_SOURCE_A' }, ...next.content] };
      }
      options.abortSignal?.addEventListener('abort', aborted.release, { once: true });
      entered.release(); await release.promise;
      return call('publish_artifact', { title: 'Do not publish', content: 'A late response from the retired source must not be saved.', format: 'text' });
    }
    assert.match(prompt, /TASK_B_UNRELATED/);
    stageB++;
    if (stageB === 1) return call('read_event', { eventId: sourceB });
    assert.match(prompt, /PRIVATE_SOURCE_B_BODY/);
    return stageB === 2 ? call('publish_artifact', { title: 'Independent result', content: 'The authorized source B remains available.', format: 'text' })
      : answer('The independent result is saved.');
  } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const sourceScene = await runtime.createCase({ title: 'Two independent sources', objective: '', domain: 'sources' });
  const targetScene = await runtime.createCase({ title: 'Task destination', objective: '', domain: 'work' });
  const roots = [join(directory, 'source-a'), join(directory, 'source-b')];
  for (const root of roots) await mkdir(root);
  await writeFile(join(roots[0], 'evidence.md'), 'PRIVATE_SOURCE_A_BODY');
  await writeFile(join(roots[1], 'evidence.md'), 'PRIVATE_SOURCE_B_BODY');
  await runtime.registerWorkspaceSource({ sourceId: 'source-a', caseId: sourceScene.id, root: roots[0], include: ['evidence.md'] });
  await runtime.registerWorkspaceSource({ sourceId: 'source-b', caseId: sourceScene.id, root: roots[1], include: ['evidence.md'] });
  sourceA = runtime.inbox.list().find(event => event.kind === 'workspace.file' && event.sourceId === 'source-a')!.id;
  sourceB = runtime.inbox.list().find(event => event.kind === 'workspace.file' && event.sourceId === 'source-b')!.id;
  const context = new TaskContext({ inbox: runtime.inbox, sources: runtime.sources });
  const device = runtime.devices.enroll({ name: 'Independent device', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
  let execution: DeviceExecuteMessage | undefined; let unrelatedCancels = 0;
  let detach = runtime.devices.attach(device.id, message => {
    if (message.kind === 'cancel') {
      unrelatedCancels++;
      runtime.devices.recordResult(device.id, { operationId: message.operationId, state: 'cancelled', error: 'Unrelated source task was cancelled.' });
      return;
    }
    if (message.kind !== 'execute') return;
    execution = message; runtime.devices.admit(device.id, { operationId: message.operationId, specHash: message.specHash });
  });
  const request = (title: string, eventId: string, command = false) => {
    const id = randomUUID();
    const source = runtime.inbox.ingest({ sourceId: 'owner-chat', externalId: id, caseId: targetScene.id, kind: 'owner.message', actor: 'owner',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { messageId: id, content: `Please complete ${title} using the selected source.` } }).event;
    const spec: TaskSpec = { caseId: targetScene.id, title, objective: `Complete ${title} within the selected sources.`, expectedOutput: 'A saved text result.',
      capabilities: command ? ['local-command', 'artifact'] : ['artifact'],
      ...(command ? { command: { kind: 'list_directory' as const, deviceId: device.id, root: 'D:\\independent', limit: 10, timeoutMs: 30000 } } : {}) };
    const task = runtime.consent.requestOwnerTask(spec, source.id, context.capture([eventId], [sourceScene.id]));
    const [leased] = runtime.inbox.claim(1, 60_000, [source.id]); assert.ok(leased?.leaseToken); runtime.inbox.ack(source.id, leased.leaseToken);
    return task;
  };
  const unrelated = request('TASK_B_UNRELATED', sourceB, true);
  const active = request('TASK_A_ACTIVE', sourceA); taskA = active.id;
  const queued = request('TASK_A_QUEUED', sourceA);
  let removing: Promise<void> | undefined;
  try {
    await store.updateSettings({ enabled: true, maxStepsPerRun: 8 }); runtime.start();
    await bounded(entered.promise, 'The linked task did not read the cross-scene source.');
    assert.ok(execution); assert.equal(unrelatedCancels, 0);
    let removalFinished = false;
    removing = runtime.removeWorkspaceSource('source-a').then(() => { removalFinished = true; });
    await bounded(aborted.promise, 'The linked task was not interrupted when its source changed.');
    assert.equal(removalFinished, false, 'Source mutation must wait for the accepted model/tool work to drain.');
    release.release(); await removing;
    assert.equal(unrelatedCancels, 0, 'Source A removal must not cancel a task linked only to source B in the same source scene.');
    assert.equal(store.list('artifacts').some(artifact => artifact.taskId === active.id || artifact.taskId === queued.id), false);
    assert.equal(runtime.consent.get(unrelated.id)?.state, 'running');
    runtime.devices.recordResult(device.id, { operationId: execution!.operationId, state: 'completed', exitCode: 0,
      stdout: JSON.stringify({ directory: 'D:\\independent', files: [], scanned: 0, truncated: false }) });
    await until(() => runtime.consent.get(unrelated.id)?.state === 'completed', 'The unrelated source task did not continue.');
    await until(() => runtime.consent.get(queued.id)?.state === 'failed', 'The queued task still attempted to use retired evidence.');
    assert.equal(stageA, 3); assert.equal(stageB, 3);
    const history = JSON.stringify(await runtime.memory.taskHistories(targetScene.id));
    assert.match(history, /PRIVATE_SOURCE_A_BODY|DERIVED_FROM_SOURCE_A/);
    const originalText = store.list('messages').find(message => message.content.includes('DERIVED_FROM_SOURCE_A'));
    assert.ok(originalText, 'Accepted public text remains visible after cancellation.');
    detach(); detach = () => {}; await runtime.close();
    runtime = await V2Coordinator.create(store, { dataDir: directory, model }); runtime.start();
    const chat = await runtime.ingestOwnerMessage('What is the status of the earlier task?', targetScene.id);
    await until(() => runtime.inbox.get(chat.id)?.status === 'processed', 'The post-restart inquiry did not complete.');
    assert.equal(chatCalls, 2);
    assert.equal(store.get('messages', originalText.id)?.content, originalText.content);
    assert.match(JSON.stringify(await runtime.memory.taskHistories(targetScene.id)), /PRIVATE_SOURCE_A_BODY|DERIVED_FROM_SOURCE_A/);
    const calls = totalCalls; await delay(1200); assert.equal(totalCalls, calls, 'Retirement and retained history must not introduce model polling.');
  } finally {
    release.release(); await removing?.catch(() => undefined);
    if (execution && !['completed', 'failed', 'cancelled'].includes(runtime.devices.getOperation(execution.operationId)?.receipt.state ?? '')) {
      runtime.devices.recordResult(device.id, { operationId: execution.operationId, state: 'cancelled', error: 'Fixture shutdown.' });
    }
    detach(); await runtime.close(); store.close();
  }
});

test('task-result lookup cannot reintroduce a retired source consumed during execution without an upfront link', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-result-source-revocation-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let eventId = '', taskId = '', taskCalls = 0, chatCalls = 0;
  const afterLookup: string[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    if (options.tools?.some(tool => tool.name === 'publish_artifact')) {
      taskCalls++;
      if (taskCalls === 1) return call('read_event', { eventId });
      if (taskCalls === 2) {
        assert.match(JSON.stringify(options.prompt), /LOCAL_PRIVATE_SOURCE_BODY/);
        return call('publish_artifact', { title: 'Authorized summary', content: 'DERIVED_LOCAL_PRIVATE_SOURCE_BODY', format: 'text' });
      }
      return answer('The authorized summary was saved.');
    }
    chatCalls++;
    if (chatCalls === 1) return call('read_task_result', { taskId });
    afterLookup.push(JSON.stringify(options.prompt)); return answer('The current task result availability has been checked.');
  } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  try {
    const scene = await runtime.createCase({ title: 'Existing scene source', objective: '', domain: 'fixture' });
    const root = join(directory, 'watched'); await mkdir(root); await writeFile(join(root, 'context.md'), 'LOCAL_PRIVATE_SOURCE_BODY');
    await runtime.registerWorkspaceSource({ sourceId: 'local-source', caseId: scene.id, root, include: ['context.md'] });
    eventId = runtime.inbox.list().find(event => event.kind === 'workspace.file' && event.sourceId === 'local-source')!.id;
    const task = await runtime.requestTask({ requestId: 'task-with-runtime-source-read', spec: { caseId: scene.id, title: 'Summarize the existing notes',
      objective: 'Use the already authorized scene notes to save a short summary.', expectedOutput: 'One saved text summary.', capabilities: ['artifact'] } });
    taskId = task.id;
    await store.updateSettings({ enabled: true, maxStepsPerRun: 8 }); runtime.start();
    await until(() => runtime.consent.get(taskId)?.state === 'completed', 'The authorized source-backed task did not finish.');
    assert.equal(store.list('artifacts').find(artifact => artifact.taskId === taskId)?.content, 'DERIVED_LOCAL_PRIVATE_SOURCE_BODY');
    await runtime.removeWorkspaceSource('local-source'); await runtime.close();
    runtime = await V2Coordinator.create(store, { dataDir: directory, model }); runtime.start();
    const query = await runtime.ingestOwnerMessage('Read the previous task result if its sources are still available.', scene.id);
    await until(() => runtime.inbox.get(query.id)?.status === 'processed', 'The result lookup did not complete.');
    assert.equal(chatCalls, 2); assert.equal(afterLookup.length, 1);
    assert.doesNotMatch(afterLookup[0], /LOCAL_PRIVATE_SOURCE_BODY|DERIVED_LOCAL_PRIVATE_SOURCE_BODY/,
      'A task artifact must not bypass the withdrawal of evidence actually consumed by that task.');
    assert.match(afterLookup[0], /unavailable/);
    assert.equal(store.list('artifacts').find(artifact => artifact.taskId === taskId)?.content, 'DERIVED_LOCAL_PRIVATE_SOURCE_BODY',
      'Retirement changes model access, not the retained original artifact.');
    assert.match(JSON.stringify(await runtime.memory.taskHistories(scene.id)), /LOCAL_PRIVATE_SOURCE_BODY/);
  } finally { await runtime.close(); store.close(); }
});
