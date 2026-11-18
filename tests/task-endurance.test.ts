import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { CaseMemory } from '../server/v2/memory.js';
import { deviceDirectoryLookupCapability, type DeviceExecuteMessage } from '../shared/local-device.js';
import type { TaskRecord, TaskSpec } from '../shared/task-consent.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 13, noCache: 13, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'fixture' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolName, toolCallId: randomUUID(), input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'fixture' } });
async function until(check: () => boolean, reason: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, reason); await delay(10); }
}
function directoryReceipt(message: DeviceExecuteMessage) {
  assert.ok('kind' in message.spec);
  return { operationId: message.operationId, state: 'completed' as const, exitCode: 0,
    stdout: JSON.stringify({ directory: message.spec.root, files: [{ name: 'retained.txt', size: 12,
      modifiedAt: '2026-11-07T00:00:00.000Z' }], scanned: 1, truncated: false }) };
}

test('bounded task endurance preserves revised work, late outcomes and usage across repeated restarts without idle inference', { timeout: 60_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-endurance-'));
  let store = new Store(directory); store.getApiKey = () => undefined;
  let calls = 0; let executions = 0; let cancellations = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls++;
    assert.ok(options.tools?.some(tool => tool.name === 'publish_artifact'), 'Only the explicitly assigned artifact needs inference.');
    return options.prompt.at(-1)?.role === 'tool' ? answer('The assigned artifact has been saved.')
      : call('publish_artifact', { title: 'Revised directory summary', content: 'A short list based on the original directory receipt.', format: 'text' });
  } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const scenes = [await runtime.createCase({ title: 'Task endurance A', objective: '', domain: 'fixture' }),
    await runtime.createCase({ title: 'Task endurance B', objective: '', domain: 'fixture' })];
  const device = runtime.devices.enroll({ name: 'Endurance device', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
  const submitted = new Map<string, DeviceExecuteMessage>(); const allTasks: TaskRecord[] = [];
  const attach = () => runtime.devices.attach(device.id, message => {
    if (message.kind === 'cancel') { cancellations++; return; }
    if (message.kind !== 'execute') return;
    executions++; submitted.set(message.taskId, message);
    runtime.devices.admit(device.id, { operationId: message.operationId, specHash: message.specHash });
    const task = runtime.consent.get(message.taskId)!;
    if (task.spec.title.startsWith('known')) runtime.devices.recordResult(device.id, directoryReceipt(message));
    else if (task.spec.title.startsWith('unknown')) runtime.devices.recordResult(device.id,
      { operationId: message.operationId, state: 'unknown', error: 'The original operation is waiting for its terminal receipt.' });
  });
  let detach = attach(); let open = true;
  try {
    await store.updateSettings({ enabled: true, maxStepsPerRun: 8 }); runtime.start();
    for (let wave = 0; wave < 3; wave++) {
      const specification = (kind: string): TaskSpec => ({ caseId: scenes[wave % scenes.length].id, title: `${kind}-${wave}`,
        objective: kind === 'compound' ? 'Query this directory and save the owner-approved summary.' : 'Read this exact directory.',
        expectedOutput: kind === 'compound' ? 'One saved summary.' : 'The actual directory receipt.',
        capabilities: kind === 'compound' ? ['local-command', 'artifact'] : ['local-command'],
        command: { kind: 'list_directory', deviceId: device.id, root: `D:\\fixture-${wave}`, limit: 10, timeoutMs: 30000 } });
      const known = await runtime.requestTask({ requestId: `known-${wave}`, spec: specification('known') });
      const unknown = await runtime.requestTask({ requestId: `unknown-${wave}`, spec: specification('unknown') });
      const compound = await runtime.requestTask({ requestId: `compound-${wave}`, spec: specification('compound') });
      allTasks.push(known, unknown, compound);
      await until(() => submitted.has(compound.id) && runtime.consent.get(known.id)?.state === 'completed'
        && runtime.consent.get(unknown.id)?.state === 'failed', 'The independent native tasks did not settle.');
      const originalDeadline = store.list('runs').find(run => run.taskId === compound.id)!.taskExecution!.deadline;
      for (let revision = 2; revision <= 3; revision++) {
        const id = `requirement-${wave}-${revision}`;
        const source = runtime.inbox.ingest({ sourceId: 'owner-chat', externalId: id, caseId: compound.spec.caseId,
          kind: 'owner.message', actor: 'owner', operation: 'create', occurredAt: new Date().toISOString(),
          payload: { messageId: id, content: `Keep the original query and use concise delivery version ${revision}.` } }).event;
        // This fixture owns processing of the direct owner command; the source
        // lease keeps a separate conversation turn from consuming it first.
        const [leased] = runtime.inbox.claim(1, 60_000, [source.id]); assert.ok(leased?.leaseToken);
        await runtime.reviseTask(compound.id, runtime.consent.get(compound.id)!.revision, source.id);
        runtime.inbox.ack(source.id, leased.leaseToken);
        await until(() => store.list('runs').some(run => run.taskId === compound.id && run.taskExecution?.requirementsRevision === revision),
          'The next requirement generation was not admitted.');
      }
      assert.equal(cancellations, 0, 'Unchanged native work must survive delivery-only requirement updates.');
      runtime.devices.recordResult(device.id, directoryReceipt(submitted.get(compound.id)!));
      await until(() => runtime.consent.get(compound.id)?.state === 'completed', 'The revised compound task did not finish.');
      const generations = store.list('runs').filter(run => run.taskId === compound.id);
      assert.equal(generations.length, 3); assert.ok(generations.every(run => run.taskExecution?.deadline === originalDeadline));
      assert.equal(generations.reduce((sum, run) => sum + run.steps, 0), 2);
      const artifacts = store.list('artifacts').filter(artifact => artifact.taskId === compound.id);
      assert.equal(artifacts.length, 1); assert.equal(artifacts[0].requirementsRevision, 3);
      detach(); await runtime.close(); store.close(); open = false;
      store = new Store(directory); store.getApiKey = () => undefined;
      runtime = await V2Coordinator.create(store, { dataDir: directory, model }); open = true; detach = attach();
      const pending = submitted.get(unknown.id)!;
      assert.equal(runtime.devices.getOperation(pending.operationId)?.receipt.state, 'unknown');
      const terminal = wave === 0 ? directoryReceipt(pending)
        : { operationId: pending.operationId, state: wave === 1 ? 'failed' as const : 'cancelled' as const, error: `TERMINAL_WAVE_${wave}` };
      runtime.devices.recordResult(device.id, terminal);
      await until(() => wave === 0 ? runtime.consent.get(unknown.id)?.state === 'completed'
        : runtime.consent.get(unknown.id)?.error?.includes(`TERMINAL_WAVE_${wave}`) === true, 'The late terminal receipt was not reconciled.');
      const messages = JSON.stringify(store.list('messages')); runtime.devices.recordResult(device.id, terminal);
      assert.equal(JSON.stringify(store.list('messages')), messages);
      assert.equal(executions, (wave + 1) * 3); assert.equal(calls, (wave + 1) * 2); runtime.start();
    }
    await delay(1100); // Let the final receipt hashes finish their local projection.
    const settled = JSON.stringify({ runs: store.list('runs'), messages: store.list('messages'), operations: runtime.devices.listOperations() });
    const callsBeforeIdle = calls; let durableWrites = 0; const unsubscribe = store.subscribe(() => { durableWrites++; });
    await delay(2200); unsubscribe();
    assert.equal(calls, callsBeforeIdle, 'Waiting and terminal tasks must not poll the model.');
    assert.equal(durableWrites, 0, 'Unchanged final receipts must not restart workflows or rewrite projections on every tick.');
    assert.equal(JSON.stringify({ runs: store.list('runs'), messages: store.list('messages'), operations: runtime.devices.listOperations() }), settled);
    assert.equal(runtime.devices.listOperations().length, allTasks.length);
    assert.equal(store.list('artifacts').length, 3); assert.equal(calls, 6);
    assert.equal(store.list('runs').reduce((sum, run) => sum + run.inputTokens, 0), calls * 13);
    assert.equal(store.list('runs').reduce((sum, run) => sum + run.outputTokens, 0), calls * 4);
    context.diagnostic(JSON.stringify({ tasks: allTasks.length, requirementGenerations: 9, restarts: 3, nativeSubmissions: executions,
      mockModelCalls: calls, idleModelCalls: calls - callsBeforeIdle, idleRecordWrites: durableWrites }));
  } finally { detach(); if (open) { await runtime.close(); store.close(); } }
});

test('source retirement filters every affected task after cold reopening while retaining its original history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-source-endurance-'));
  const url = `file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`;
  let memory = new CaseMemory(url, 'endurance-owner'); let allowed = true;
  const filter = (_caseId: string, eventId: string) => eventId !== 'retired-source-event' || allowed;
  memory.setSourceEvidenceFilter(filter);
  const first = new MockLanguageModelV4({ doGenerate: async options => options.prompt.at(-1)?.role === 'tool'
    ? answer('DERIVED_RETIRED_TASK_ANSWER') : call('read_event', { eventId: 'retired-source-event' }) });
  const read = createTool({ id: 'read_event', description: 'Read the authorized fixture.', inputSchema: z.object({ eventId: z.string() }),
    execute: async () => ({ eventId: 'retired-source-event', content: 'RETIRED_TASK_SOURCE_SENTINEL' }) });
  try {
    const scene = await memory.createCase({ title: 'Shared source', objective: '', domain: 'fixture' });
    const tasks = ['source-task-one', 'source-task-two', 'source-task-three'];
    for (const taskId of tasks) await memory.runCase({ caseId: scene.id, execution: { taskId, requirementsRevision: 1 }, model: first,
      message: 'READ_RETIRED_TASK_SOURCE', instructions: 'Offline fixture.', tools: { read_event: read }, maxSteps: 2 });
    allowed = false; await memory.close(); memory = new CaseMemory(url, 'endurance-owner'); memory.setSourceEvidenceFilter(filter);
    let calls = 0;
    const current = new MockLanguageModelV4({ doGenerate: async options => {
      calls++; assert.doesNotMatch(JSON.stringify(options.prompt), /RETIRED_TASK_SOURCE_SENTINEL|DERIVED_RETIRED_TASK_ANSWER|READ_RETIRED_TASK_SOURCE/);
      return answer('Only current authorized context is used.');
    } });
    for (const taskId of tasks) await memory.runCase({ caseId: scene.id, execution: { taskId, requirementsRevision: 1 }, model: current,
      message: 'Continue with currently authorized context.', instructions: 'Offline fixture.', maxSteps: 1 });
    assert.equal(calls, tasks.length);
    const histories = await memory.taskHistories(scene.id);
    assert.equal(histories.length, tasks.length);
    for (const task of histories) assert.match(JSON.stringify(task.history), /RETIRED_TASK_SOURCE_SENTINEL/);
    assert.deepEqual(await memory.history(scene.id), []);
  } finally { await memory.close(); }
});

test('a stopped full-directory backup restores all three databases and private binary files without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rae-task-backup-endurance-'));
  const directory = join(root, 'live'), backup = join(root, 'backup'), preserved = join(root, 'preserved-live');
  const worker = async (action: 'seed' | 'verify') => {
    const child = spawn(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx',
      'tests/support/task-backup-worker.ts', directory, action], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += String(value); }); child.stderr.on('data', value => { output += String(value); });
    const timer = setTimeout(() => child.kill(), 20_000);
    try { const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('exit', done); }); assert.equal(code, 0, output); }
    finally { clearTimeout(timer); }
  };
  // Restore requires the old service process to exit, including its native
  // SQLite clients. A logical close inside the same Windows process is weaker.
  await worker('seed');
  await cp(directory, backup, { recursive: true, errorOnExist: true, force: false });
  for (const path of [directory, backup, preserved]) assert.equal(dirname(resolve(path)), resolve(root), 'Only move this fixture\'s exact isolated directories.');
  await rename(directory, preserved); await cp(backup, directory, { recursive: true, errorOnExist: true, force: false });
  await worker('verify');
  assert.equal((await readFile(join(preserved, 'media', 'original.bin'))).toString(), 'PRIVATE_MEDIA_BACKUP_SENTINEL',
    'Restore must preserve the newer pre-rollback copy too.');
  for (const name of ['rae.sqlite', 'v2-events.sqlite', 'v2-memory.sqlite']) {
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try { assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']); }
    finally { db.close(); }
  }
});
