import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectJournal, type LocalProjectEntry } from '../desktop/project-journal.js';
import { captureProject, projectResources } from '../desktop/project-configuration.js';
import { localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectSpecHash } from '../server/devices/projects.js';
import { ProjectHand } from '../desktop/project-hand.js';
import { ProjectRunner } from '../desktop/project-runner.js';
import { CodexDrainTimeoutError, CodexRpc } from '../desktop/codex-rpc.js';
import { ProjectWorkspaces } from '../desktop/project-workspaces.js';
import type { ProjectEvent } from '../shared/local-project.js';

function input(): ProjectExecutionInput {
  const spec = localProjectSpecSchema.parse({ deviceId: 'device' });
  return { operationId: 'task-a', taskId: 'a', runId: 'run', approvalRevision: 1, requirementsRevision: 1, spec, specHash: projectSpecHash(spec),
    title: 'Local work without a project', objective: 'Use a temporary execution workspace', expectedOutput: 'Saved result',
    ownerRequest: 'Process this file', updates: [], model: { model: 'offline', reasoningEffort: 'auto', maxOutputTokens: null },
    stepLimit: 5, deadline: null, issuedAt: new Date().toISOString() };
}

test('a late clean Codex exit remains observable after the initial drain times out', { timeout: 5000 }, async () => {
  let allowNativeRequest!: () => void;
  const requestDrained = new Promise<void>(resolve => { allowNativeRequest = resolve; });
  let receivedRequest!: () => void;
  const requestStarted = new Promise<void>(resolve => { receivedRequest = resolve; });
  const rpc = new CodexRpc({ executable: process.execPath, args: ['-e',
    'process.stdout.write(JSON.stringify({id:1,method:"fixture/owned"})+"\\n");process.stdin.resume();'],
    cwd: process.cwd(), env: process.env, onNotification() {}, onFailure() {},
    async onRequest() { receivedRequest(); await requestDrained; return {}; },
  });
  try {
    await requestStarted;
    await assert.rejects(rpc.close(0), CodexDrainTimeoutError);
    let drained = false;
    const completion = rpc.waitForDrain().then(() => { drained = true; });
    await assert.rejects(rpc.close(0), CodexDrainTimeoutError);
    assert.equal(drained, false);
    allowNativeRequest();
    await completion;
    assert.equal(rpc.running, false);
  } finally {
    allowNativeRequest();
    await rpc.waitForDrain();
  }
});

test('an abnormal Codex exit cannot certify that its native operations drained', { timeout: 5000 }, async () => {
  const rpc = new CodexRpc({ executable: process.execPath, args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(3));'],
    cwd: process.cwd(), env: process.env, onNotification() {}, onFailure() {}, async onRequest() {} });
  await assert.rejects(rpc.close(), /未正常退出/);
  await assert.rejects(rpc.waitForDrain(), /未正常退出/);
});

test('Codex transport contains malformed envelopes and synchronous notification failures', { timeout: 5000 }, async () => {
  const failures: string[] = [];
  let received!: () => void;
  const notification = new Promise<void>(resolve => { received = resolve; });
  const rpc = new CodexRpc({ executable: process.execPath, args: ['-e',
    'for(const value of [null,[],{method:"fixture/notice"}])process.stdout.write(JSON.stringify(value)+"\\n");process.stdin.resume();'],
    cwd: process.cwd(), env: process.env, onFailure: error => { failures.push(error.message); },
    onNotification() { received(); throw new Error('Notification persistence failed'); }, async onRequest() {} });
  rpc.subscribe(() => { throw new Error('Subscriber failed'); });
  try {
    await notification;
    assert.deepEqual(failures, ['内置 Codex 返回了无效协议数据。', 'Subscriber failed', 'Notification persistence failed']);
  } finally { await rpc.close(); }
});

test('Codex drain waits for accepted asynchronous progress after the process exits', { timeout: 5000 }, async () => {
  let received!: () => void; let persist!: () => void; let exited!: () => void;
  const notification = new Promise<void>(resolve => { received = resolve; });
  const persistence = new Promise<void>(resolve => { persist = resolve; });
  const processClosed = new Promise<void>(resolve => { exited = resolve; });
  const rpc = new CodexRpc({ executable: process.execPath, args: ['-e',
    'process.stdout.write(JSON.stringify({method:"fixture/progress"})+"\\n",()=>process.exit(0));'],
    cwd: process.cwd(), env: process.env, onFailure() { exited(); }, async onRequest() {},
    async onNotification() { received(); await persistence; } });
  try {
    await notification; await processClosed;
    assert.equal(rpc.running, false);
    await assert.rejects(rpc.close(0), CodexDrainTimeoutError);
    let drained = false;
    const completion = rpc.waitForDrain().then(() => { drained = true; });
    await assert.rejects(rpc.close(0), CodexDrainTimeoutError);
    assert.equal(drained, false);
    persist(); await completion;
  } finally { persist(); await rpc.waitForDrain(); }
});
test('packaged runtime resolves the complete standalone Node distribution outside app dependency pruning', () => {
  const app = path.resolve('fixture/resources/app/desktop');
  const vendor = path.resolve('fixture/resources/vendor');
  const resources = projectResources(app, vendor);
  assert.equal(resources.node, path.join(vendor, 'node/node.exe'));
  assert.equal(resources.engine, path.join(vendor, 'codex/bin/codex-app-server.exe'));
  assert.equal(resources.hook, path.join(app, 'project-hook.js'));
  assert.equal(projectResources(app).node, path.join(app, '../vendor/node/node.exe'));
});
test('local tasks without a project get separate task workspaces and preserve results after execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-project-spaces-'));
  const journal = new ProjectJournal(root); const a = input(); const b = { ...a, operationId: 'task-b', taskId: 'b' };
  assert.equal(a.spec.root, 'task-temporary');
  const first = await captureProject(a, undefined, path.join(journal.directory(a.operationId), 'workspace'));
  const second = await captureProject(b, undefined, path.join(journal.directory(b.operationId), 'workspace'));
  assert.notEqual(first.realPath, second.realPath);
  await writeFile(path.join(first.realPath, 'result.txt'), 'retained result');
  assert.deepEqual(await captureProject(a, first, first.realPath), first);
  assert.equal(await readFile(path.join(first.realPath, 'result.txt'), 'utf8'), 'retained result');
  await rename(first.realPath, first.realPath + '-original'); await mkdir(first.realPath);
  await assert.rejects(captureProject(a, first, first.realPath), /身份已改变/);
});

test('local workspace scheduling treats a junction and its target as one root and cancels queued acquisition', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-project-junction-'));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await mkdir(actual);
  await symlink(actual, alias, 'junction');
  const capture = (root: string) => captureProject({ ...input(), spec: { ...input().spec, root } });
  const first = await capture(actual);
  const second = await capture(alias);
  assert.deepEqual(first, second);
  const queue = new ProjectWorkspaces();
  const signal = new AbortController().signal;
  const releaseRead = await queue.acquire('read', { root: first.realPath, writable: false }, signal);
  const cancelled = new AbortController();
  const queued = queue.acquire('cancelled', { root: second.realPath, writable: true }, cancelled.signal);
  let writeStarted = false;
  const writer = queue.acquire('writer', { root: second.realPath, writable: true }, signal)
    .then(release => { writeStarted = true; return release; });
  let readerStarted = false;
  const reader = queue.acquire('later-reader', { root: first.realPath, writable: false }, signal)
    .then(release => { readerStarted = true; return release; });
  cancelled.abort(new Error('Owner cancelled queued work'));
  await assert.rejects(queued, /cancelled queued work/);
  assert.equal(writeStarted, false);
  assert.equal(readerStarted, false);
  releaseRead();
  const releaseWrite = await writer;
  assert.equal(readerStarted, false);
  releaseWrite();
  (await reader)();
});

test('journal serializes concurrent progress and receipts and repairs an event-before-checkpoint crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-project-journal-'));
  const journal = new ProjectJournal(root);
  const entry: LocalProjectEntry = { input: input(), state: 'running', sequence: 0, acknowledged: 0, appliedRevision: 1, output: '' };
  await journal.save(entry);
  const written = await Promise.all(Array.from({ length: 20 }, (_, index) => journal.append(entry, { kind: 'text', text: String(index) })));
  assert.deepEqual(written.map(event => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  await Promise.all([journal.acknowledge(entry, 5), journal.append(entry, { kind: 'text', text: 'late' }), journal.acknowledge(entry, 10)]);
  assert.equal(entry.sequence, 21); assert.equal(entry.acknowledged, 10);
  entry.sequence = 20; await journal.save(entry);
  const recovered = (await journal.get('task-a'))!;
  assert.equal((await journal.pending(recovered)).at(-1)?.sequence, 21); assert.equal(recovered.sequence, 21);
  await journal.acknowledge(recovered, 21); assert.equal((await journal.pending(recovered)).length, 0);
});

test('a failed acknowledgment checkpoint keeps durable progress eligible for retry without restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-project-checkpoint-'));
  const journal = new ProjectJournal(root);
  const entry: LocalProjectEntry = { input: input(), state: 'running', sequence: 0, acknowledged: 0, appliedRevision: 1, output: '' };
  const event = await journal.append(entry, { kind: 'text', text: 'Durable progress' });
  const file = path.join(journal.directory(entry.input.operationId), 'operation.json');
  await rename(file, file + '.previous');
  await mkdir(file); // Deterministic filesystem failure at the checkpoint rename.
  try {
    await assert.rejects(journal.acknowledge(entry, event.sequence));
    assert.equal(entry.acknowledged, 0);
    assert.deepEqual(await journal.pending(entry), [event]);
  } finally {
    await rename(file, file + '.blocked');
    await rename(file + '.previous', file);
  }
  await journal.acknowledge(entry, event.sequence);
  assert.equal((await journal.get(entry.input.operationId))!.acknowledged, event.sequence);
  assert.deepEqual(await journal.pending(entry), []);
});

test('disconnect pause drains controls accepted before their runner is registered', async t => {
  const journal = new ProjectJournal(await mkdtemp(path.join(tmpdir(), 'rae-project-pause-')));
  let saving!: () => void; let continueSave!: () => void; let completeRun!: () => void;
  const saveStarted = new Promise<void>(resolve => { saving = resolve; });
  const saveAllowed = new Promise<void>(resolve => { continueSave = resolve; });
  const run = new Promise<void>(resolve => { completeRun = resolve; });
  const save = journal.save.bind(journal);
  t.mock.method(journal, 'save', async (entry: LocalProjectEntry) => { saving(); await saveAllowed; await save(entry); });
  t.mock.method(journal, 'pending', async () => []);
  let runs = 0; let stops = 0;
  t.mock.method(ProjectRunner.prototype, 'run', () => { runs++; return run; });
  t.mock.method(ProjectRunner.prototype, 'stop', async (_reason: string, mode: string) => {
    assert.equal(mode, 'pause'); stops++; completeRun(); await run;
  });
  const hand = new ProjectHand({ deviceId: 'device', baseUrl: 'https://fixture.invalid', credential: 'fixture', journal,
    resources: { engine: '', node: '', hook: '', browser: '' }, status() {}, post: async () => ({ sequence: 0 }) });
  try {
    const task = input();
    hand.accept({ kind: 'project-execute', operationId: task.operationId, input: task });
    await saveStarted;
    let paused = false;
    const pause = hand.pause('Connection ended').then(() => { paused = true; });
    const lateTask = { ...task, operationId: 'task-b', taskId: 'b' };
    hand.accept({ kind: 'project-execute', operationId: lateTask.operationId, input: lateTask });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(paused, false);
    continueSave(); await pause;
    assert.equal(runs, 1); assert.equal(stops, 1);
    assert.equal(await journal.get(lateTask.operationId), undefined);
  } finally { continueSave(); completeRun(); await hand.stop(); }
});

test('disconnect pause drains a late cancellation before acknowledging completion', async t => {
  const journal = new ProjectJournal(await mkdtemp(path.join(tmpdir(), 'rae-project-late-cancel-')));
  let started!: () => void; let completeRun!: () => void; let pausing!: () => void; let canceling!: () => void;
  let pauseAllowed!: () => void; let cancelAllowed!: () => void;
  const runStarted = new Promise<void>(resolve => { started = resolve; });
  const run = new Promise<void>(resolve => { completeRun = resolve; });
  const pauseStarted = new Promise<void>(resolve => { pausing = resolve; });
  const cancelStarted = new Promise<void>(resolve => { canceling = resolve; });
  const pauseGate = new Promise<void>(resolve => { pauseAllowed = resolve; });
  const cancelGate = new Promise<void>(resolve => { cancelAllowed = resolve; });
  t.mock.method(ProjectRunner.prototype, 'run', () => { started(); return run; });
  t.mock.method(ProjectRunner.prototype, 'stop', async (_reason: string, mode: string) => {
    if (mode === 'pause') { pausing(); await pauseGate; }
    else { canceling(); await cancelGate; }
    completeRun();
  });
  const hand = new ProjectHand({ deviceId: 'device', baseUrl: 'https://fixture.invalid', credential: 'fixture', journal,
    resources: { engine: '', node: '', hook: '', browser: '' }, status() {}, post: async () => ({ sequence: 0 }) });
  try {
    const task = input();
    hand.accept({ kind: 'project-execute', operationId: task.operationId, input: task });
    await runStarted;
    let paused = false;
    const pause = hand.pause('Connection ended').then(() => { paused = true; });
    await pauseStarted;
    hand.accept({ kind: 'project-cancel', operationId: task.operationId, reason: 'Owner cancelled', mode: 'cancel' });
    await cancelStarted;
    pauseAllowed();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(paused, false);
    cancelAllowed(); await pause;
  } finally { pauseAllowed(); cancelAllowed(); completeRun(); await hand.stop(); }
});

test('long progress uploads in bounded batches and retries a lost acknowledgment without changing any event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-project-batches-'));
  const journal = new ProjectJournal(root);
  const entry: LocalProjectEntry = { input: input(), state: 'completed', environment: 'closed', sequence: 0, acknowledged: 0, appliedRevision: 1, output: '' };
  await journal.save(entry);
  for (let index = 0; index < 200; index++) await journal.append(entry, { kind: 'text', text: 'progress ' + index });
  const received = new Map<number, string>();
  let calls = 0;
  const hand = new ProjectHand({ deviceId: 'device', baseUrl: 'https://fixture.invalid', credential: 'fixture', journal,
    resources: { engine: '', node: '', hook: '', browser: '' }, status() {},
    post: async (events: ProjectEvent[]) => {
      calls++;
      assert.ok(events.length <= 50);
      for (const event of events) {
        const serialized = JSON.stringify(event);
        if (received.has(event.sequence)) assert.equal(received.get(event.sequence), serialized);
        received.set(event.sequence, serialized);
        if (calls === 1 && event.sequence === 3) throw new Error('Lost connection after committing a prefix');
      }
      return { sequence: events.at(-1)!.sequence };
    } });
  await hand.recover(); await hand.flush();
  assert.equal(received.size, 3);
  await hand.flush();
  assert.equal(received.size, 200); assert.equal(calls, 5);
  const persisted = (await journal.get(entry.input.operationId))!;
  assert.equal(persisted.acknowledged, 200); assert.equal((await journal.pending(persisted)).length, 0);
  await hand.stop();
});
