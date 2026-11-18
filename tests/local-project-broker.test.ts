import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ProjectBroker, projectSpecHash, type ProjectExecutionContext } from '../server/devices/projects.js';
import { localProjectCapability, previousLocalProjectCapability, projectContextWindowCapability, localProjectSpecSchema,
  type ProjectExecutionInput, type ProjectEvent, type ProjectServerMessage } from '../shared/local-project.js';

function fixture(result: () => void = () => {}, platform: 'win32' | 'linux' = 'win32') {
  const db = new DatabaseSync(':memory:');
  const messages: ProjectServerMessage[] = [];
  let permitted = true;
  const capabilities = [localProjectCapability];
  const controller = new AbortController();
  const broker = new ProjectBroker(db, { device: id => ({ id, name: 'test', platform, online: true, grants: [],
    capabilities, createdAt: new Date().toISOString() }), assertActive() {}, changed() {}, result,
    send: (_id, message) => { messages.push(message); } });
  const spec = platform === 'linux' ? broker.prepare({ deviceId: 'device' })
    : localProjectSpecSchema.parse({ deviceId: 'device', root: 'D:\\project\\example' });
  const input: ProjectExecutionInput = { operationId: 'operation', taskId: 'task', runId: 'run', approvalRevision: 2,
    requirementsRevision: 1, spec, specHash: projectSpecHash(spec), title: 'Project acceptance', objective: 'Review actual code and verify',
    expectedOutput: 'Evidence and results', ownerRequest: 'Read the whole requested project and accept it', updates: [],
    model: { model: 'fixture', reasoningEffort: 'auto', maxOutputTokens: null }, stepLimit: 2, deadline: null, issuedAt: new Date().toISOString() };
  const context: ProjectExecutionContext = { signal: controller.signal, guard() { if (!permitted) throw new Error('revoked'); },
    onEvent() {}, async model() { throw new Error('No real inference in fixture'); }, async context() { return {}; } };
  const event = (sequence: number, value: ProjectEvent['event'], revision = 1): ProjectEvent => ({
    operationId: input.operationId, sequence, requirementsRevision: revision, at: new Date().toISOString(), event: value,
  });
  return { db, broker, input, context, event, messages, controller, capabilities, revoke() { permitted = false; } };
}

test('a captured model window reaches upgraded executors without breaking older strict clients', async () => {
  const f = fixture();
  try {
    const input = { ...f.input, model: { ...f.input.model, contextWindow: 128_000 } };
    const running = f.broker.run(input, f.context);
    const old = f.messages.at(-1);
    assert.equal(old?.kind === 'project-execute' && old.input.model.contextWindow, undefined);
    assert.equal(f.broker.get(input.operationId)?.input.model.contextWindow, 128_000);

    f.capabilities.push(projectContextWindowCapability);
    f.broker.connected('device');
    const upgraded = f.messages.at(-1);
    assert.equal(upgraded?.kind === 'project-execute' && upgraded.input.model.contextWindow, 128_000);
    f.broker.record('device', f.event(1, { kind: 'finished', state: 'completed', output: 'done' }));
    await running;
  } finally { f.db.close(); }
});

test('a paused Linux workspace holds its resource slot until cancelled and actually cleaned', async () => {
  const f = fixture(undefined, 'linux');
  try {
    const first = f.broker.run(f.input, f.context);
    const pause = f.broker.stop(f.input.operationId, 'pause', 'pause');
    f.broker.record('device', f.event(1, { kind: 'environment', state: 'closed', retainedWorkspace: true, terminals: [] }));
    f.broker.record('device', f.event(2, { kind: 'paused', reason: 'paused' }));
    assert.equal((await pause).state, 'waiting'); await first;
    assert.deepEqual(f.broker.reservedWorkspaces().map(value => value.input.operationId), [f.input.operationId]);
    assert.deepEqual(f.broker.operationsToDrain(), []);

    const second = f.broker.run({ ...f.input, operationId: 'second', taskId: 'second-task', runId: 'second-run' }, f.context);
    assert.deepEqual(f.messages.filter(message => message.kind === 'project-execute').map(message => message.operationId), [f.input.operationId]);
    let stopped = false;
    const stop = f.broker.stop(f.input.operationId, 'cancel').then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    assert.throws(() => f.broker.record('device', f.event(3, { kind: 'finished', state: 'cancelled', output: '' })), /排空回执/);
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'closed', terminals: [] }));
    f.broker.record('device', f.event(4, { kind: 'finished', state: 'cancelled', output: 'drained' }));
    await stop;
    assert.equal(stopped, true);
    assert.equal(f.broker.get(f.input.operationId)?.state, 'cancelled');
    assert.deepEqual(f.messages.filter(message => message.kind === 'project-execute').map(message => message.operationId), [f.input.operationId, 'second']);
    f.broker.record('device', { ...f.event(1, { kind: 'environment', state: 'closed', terminals: [] }), operationId: 'second' });
    f.broker.record('device', { ...f.event(2, { kind: 'finished', state: 'completed', output: 'second done' }), operationId: 'second' });
    await second;
  } finally { f.db.close(); }
});

test('a verified persistent Linux checkpoint releases compute capacity and only its exact restored identity can resume', async () => {
  const f = fixture(undefined, 'linux');
  try {
    const running = f.broker.run(f.input, f.context);
    f.broker.record('device', f.event(1, { kind: 'started', threadId: 'saved-thread', engineVersion: 'fixture', realPath: '/work/one/workspace', identity: 'original-inode' }));
    f.broker.record('device', f.event(2, { kind: 'workspace_saved', hash: 'a'.repeat(64), identity: 'original-inode' }));
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'closed', retainedWorkspace: true, terminals: [] }));
    f.broker.record('device', f.event(4, { kind: 'paused', reason: 'waiting for mail' })); await running;
    assert.equal(f.broker.reservedWorkspaces().length, 0);
    assert.equal(f.broker.get(f.input.operationId)?.environment?.retainedWorkspace, true);
    const second = f.broker.run({ ...f.input, operationId: 'other', taskId: 'other-task', runId: 'other-run' }, f.context);
    assert.deepEqual(f.messages.filter(message => message.kind === 'project-execute').map(message => message.operationId), [f.input.operationId, 'other']);
    f.broker.record('device', { ...f.event(1, { kind: 'environment', state: 'closed', terminals: [] }), operationId: 'other' });
    f.broker.record('device', { ...f.event(2, { kind: 'finished', state: 'completed', output: 'independent work' }), operationId: 'other' }); await second;
    const resumed = f.broker.run(f.input, f.context);
    assert.throws(() => f.broker.record('device', f.event(5, { kind: 'workspace_restored', hash: 'b'.repeat(64), previousIdentity: 'original-inode',
      realPath: '/work/one/workspace', identity: 'new-inode' })), /检查点/);
    f.broker.record('device', f.event(5, { kind: 'workspace_restored', hash: 'a'.repeat(64), previousIdentity: 'original-inode', realPath: '/work/one/workspace', identity: 'new-inode' }));
    f.broker.record('device', f.event(6, { kind: 'started', threadId: 'saved-thread', engineVersion: 'fixture', realPath: '/work/one/workspace', identity: 'new-inode' }));
    f.broker.record('device', f.event(7, { kind: 'environment', state: 'closed', terminals: [] }));
    f.broker.record('device', f.event(8, { kind: 'finished', state: 'completed', output: 'resumed' })); await resumed;
    assert.equal(f.broker.get(f.input.operationId)?.threadId, 'saved-thread');
  } finally { f.db.close(); }
});

test('a stale Linux completion preserves actual output and cannot launch a fresh workspace', async () => {
  const f = fixture(undefined, 'linux');
  try {
    const pending = f.broker.run(f.input, f.context);
    const updated = { ...f.input, requirementsRevision: 2, updates: [{ revision: 2, content: 'Check the output too.' }] };
    f.broker.revise(updated);
    f.broker.record('device', f.event(1, { kind: 'environment', state: 'closed', terminals: [] }));
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'completed', output: 'Original output' }));
    const result = await pending;
    assert.equal(result.state, 'failed');
    assert.equal(result.finalOutput, 'Original output');
    assert.match(result.error ?? '', /补充要求前已结束/);
    assert.throws(() => f.broker.run({ ...updated, requirementsRevision: 3 }, f.context), /重新委托并确认/);
    assert.equal(f.messages.filter(message => message.kind === 'project-execute').length, 1);
    assert.equal(f.broker.reservedWorkspaces().length, 0);
  } finally { f.db.close(); }
});

test('Linux cancellation with an unknown drain rejects until a late closed receipt releases the workspace', async () => {
  const f = fixture(undefined, 'linux');
  try {
    const running = f.broker.run(f.input, f.context);
    const stop = f.broker.stop(f.input.operationId, 'cancel');
    const rejected = assert.rejects(stop, /仍待核对/);
    f.broker.record('device', f.event(1, { kind: 'environment', state: 'unknown', terminals: [] }));
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'unknown', output: '', error: '服务端退出状态仍待核对。' }));
    await rejected; await assert.rejects(running, /仍待核对/);
    assert.equal(f.broker.reservedWorkspaces().length, 1);

    const retry = f.broker.stop(f.input.operationId, 'verify drain');
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'closed', terminals: [] }));
    await retry;
    assert.equal(f.broker.get(f.input.operationId)?.state, 'unknown');
    assert.equal(f.broker.reservedWorkspaces().length, 0);
    assert.equal(f.messages.filter(message => message.kind === 'project-execute').length, 1);
  } finally { f.db.close(); }
});

test('project scope is broad by default, but model/tool gates recheck exact current consent', async () => {
  const f = fixture();
  try {
    assert.equal(f.input.spec.access, 'read-write'); assert.equal(f.input.spec.network, true);
    const pending = f.broker.run(f.input, f.context);
    const authorization = { operationId: 'operation', specHash: f.input.specHash, requirementsRevision: 1 };
    assert.equal(f.broker.authorize('device', authorization).operation.input.objective, f.input.objective);
    assert.throws(() => f.broker.authorize('other', authorization));
    assert.throws(() => f.broker.authorize('device', { ...authorization, specHash: 'f'.repeat(64) }));
    f.revoke(); assert.throws(() => f.broker.authorize('device', authorization), /revoked/);
    // Revocation cannot discard the accepted device's final facts.
    f.broker.record('device', f.event(1, { kind: 'finished', state: 'cancelled', output: 'drained' }));
    assert.equal((await pending).state, 'cancelled');
  } finally { f.db.close(); }
});

test('device events are durable, ordered, idempotent and cannot revive a confirmed outcome', async () => {
  const f = fixture();
  try {
    const done = f.broker.run(f.input, { ...f.context, onEvent() { throw new Error('projection fault'); } });
    assert.throws(() => f.broker.record('device', f.event(2, { kind: 'text', text: 'gap' })), /继续上传/);
    const first = f.event(1, { kind: 'started', threadId: 'thread', engineVersion: '0.167.2', realPath: f.input.spec.root, identity: 'directory-identity' });
    f.broker.record('device', first); f.broker.record('device', first);
    assert.equal(f.broker.workspaces().length, 1);
    assert.throws(() => f.broker.record('device', { ...first, event: { kind: 'text', text: 'rewrite' } }), /不能改写/);
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'completed', output: 'tested real files' }));
    assert.equal((await done).state, 'completed');
    f.broker.record('device', f.event(3, first.event));
    f.broker.record('device', f.event(4, { kind: 'finished', state: 'failed', output: 'late contradiction' }));
    assert.equal(f.broker.get('operation')?.state, 'completed');
    assert.equal(f.broker.export().events.length, 4);
  } finally { f.db.close(); }
});

test('a receipt batch reconciles once and retries a committed prefix without replaying events', async () => {
  let reconciliations = 0;
  const f = fixture(() => { reconciliations++; });
  try {
    const processed: number[] = [];
    const done = f.broker.run(f.input, { ...f.context, onEvent(_operation, event) { processed.push(event.sequence); } });
    const first = Array.from({ length: 49 }, (_, i) => f.event(i + 1, { kind: 'text', text: 'x' }));
    const terminal = f.event(50, { kind: 'finished', state: 'completed', output: 'completed' });
    assert.throws(() => f.broker.recordBatch('device', [...first, { ...terminal, requirementsRevision: 2 }]), /未知要求版本/);
    assert.equal(f.broker.get('operation')?.sequence, 49);
    assert.equal(reconciliations, 1);

    assert.deepEqual(f.broker.recordBatch('device', [...first, terminal]), { sequence: 50 });
    assert.equal((await done).state, 'completed');
    assert.equal(reconciliations, 2);
    assert.deepEqual(f.broker.recordBatch('device', [...first, terminal]), { sequence: 50 });
    assert.equal(reconciliations, 2);
    assert.deepEqual(f.broker.record('device', terminal), { sequence: 50 });
    assert.equal(reconciliations, 2);
    assert.deepEqual(processed, [...first, terminal].map(event => event.sequence));
    assert.equal(f.broker.get('operation')?.output, 'x'.repeat(49));
  } finally { f.db.close(); }
});

test('steering and restart never reset the original provider-call allowance or deadline', async () => {
  const f = fixture();
  try {
    f.input.deadline = Date.now() + 60_000;
    const done = f.broker.run(f.input, f.context);
    f.capabilities[0] = previousLocalProjectCapability;
    assert.throws(() => f.broker.validate(f.input.spec), /更新/);
    assert.equal(f.broker.authorize('device', { operationId: 'operation', specHash: f.input.specHash, requirementsRevision: 1 }).operation.input.stepLimit, 2);
    f.broker.beginModel(f.broker.get('operation')!, 'first');
    f.broker.settleModel('operation', 'first', { inputTokens: 1, outputTokens: 2 });
    f.broker.revise({ ...f.input, requirementsRevision: 2, updates: [{ revision: 2, content: 'also inspect the test result' }], stepLimit: null, deadline: null });
    const updated = f.broker.get('operation')!;
    assert.equal(updated.input.stepLimit, 2); assert.equal(updated.input.deadline, f.input.deadline);
    assert.throws(() => f.broker.authorize('device', { operationId: 'operation', specHash: f.input.specHash, requirementsRevision: 1 }), /要求已更新/);
    f.broker.beginModel(updated, 'second');
    assert.throws(() => f.broker.beginModel(updated, 'third'), /执行步数/);
    assert.throws(() => f.broker.beginModel(updated, 'second'), /已有记录/);
    f.broker.record('device', f.event(1, { kind: 'finished', state: 'completed', output: 'current result' }, 1));
    assert.notEqual(f.broker.get('operation')?.state, 'completed');
    const reattached = f.messages.filter(message => message.kind === 'project-execute');
    assert.equal(reattached.length, 2);
    assert.equal(reattached.at(-1)?.kind === 'project-execute' && reattached.at(-1)?.input.requirementsRevision, 2);
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'completed', output: 'current result' }, 2));
    await done;
  } finally { f.db.close(); }
});

test('historical native questions remain readable, sandbox expansion stays cancelled, and retained environments require a drain receipt', async () => {
  const f = fixture();
  try {
    const done = f.broker.run(f.input, f.context);
    f.broker.record('device', f.event(1, { kind: 'interaction', id: 'permission', type: 'approval',
      method: 'item/permissions/requestApproval', title: 'Read another folder', detail: 'D:\\reference', request: { permissions: { fileSystem: { read: ['D:\\reference'] } } } }));
    assert.equal(f.broker.get('operation')?.interactions[0].state, 'cancelled');
    f.broker.record('device', f.event(2, { kind: 'interaction', id: 'question', type: 'question', method: 'item/tool/call',
      title: 'Clarify layout', detail: 'One native question', request: { questions: [{ id: 'layout', question: 'Which layout?' }] } }));
    assert.equal(f.broker.get('operation')?.interactions[1].request.questions !== undefined, true);
    assert.equal(f.messages.length, 1, 'A historical interaction cannot create an execution command');
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'active', terminals: [{ threadId: 'thread', processId: '1', command: 'node server.mjs', cwd: f.input.spec.root }] }));
    f.broker.record('device', f.event(4, { kind: 'finished', state: 'completed', output: 'preview ready' })); await done;
    let acknowledged = false; const stop = f.broker.stop('operation', 'owner stop').then(() => { acknowledged = true; });
    await Promise.resolve(); assert.equal(acknowledged, false);
    f.broker.record('device', f.event(5, { kind: 'environment', state: 'closed', terminals: [] })); await stop;
    assert.equal(acknowledged, true); assert.equal(f.broker.get('operation')?.state, 'completed');
  } finally { f.db.close(); }
});

test('an unknown old native outcome blocks revised work instead of silently replaying it', async () => {
  const f = fixture();
  try {
    const done = f.broker.run(f.input, f.context); void done.catch(() => {});
    f.broker.revise({ ...f.input, requirementsRevision: 2, updates: [{ revision: 2, content: 'Also inspect mobile' }] });
    f.broker.record('device', f.event(1, { kind: 'finished', state: 'unknown', output: '', error: 'Native stop not confirmed' }, 1));
    await assert.rejects(done, /Native stop not confirmed/);
    assert.equal(f.broker.get('operation')?.state, 'unknown');
    assert.equal(f.messages.filter(message => message.kind === 'project-execute').length, 1);
  } finally { f.db.close(); }
});

test('historical unknown work keeps its reservation without blocking a later global drain', async () => {
  const f = fixture();
  try {
    const done = f.broker.run(f.input, f.context);
    void done.catch(() => {});
    const draining = f.broker.drain();
    f.broker.record('device', f.event(1, { kind: 'environment', state: 'unknown', terminals: [] }));
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'unknown', output: '', error: 'Native stop not confirmed' }));
    await assert.rejects(draining, /Native stop not confirmed/);
    await assert.rejects(done, /Native stop not confirmed/);
    const unknown = f.broker.get('operation');
    const sent = f.messages.length;
    await f.broker.drain();
    assert.equal(f.messages.length, sent);
    assert.deepEqual(f.broker.get('operation'), unknown);
    assert.equal(f.broker.reservedWorkspaces().length, 1);

    const stopped = f.broker.stop('operation', 'Check the original operation');
    assert.equal(f.messages.at(-1)?.kind, 'project-cancel');
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'closed', terminals: [] }));
    await stopped;
    assert.equal(f.broker.reservedWorkspaces().length, 0);
  } finally { f.db.close(); }
});

test('a confirmed client pause drains an overlapping owner cancellation', async () => {
  const f = fixture();
  try {
    const done = f.broker.run(f.input, f.context);
    const stopped = f.broker.stop('operation', 'owner cancelled', 'cancel');
    f.broker.record('device', f.event(1, { kind: 'paused', reason: 'Native processes and output drained' }));
    assert.equal((await stopped).state, 'cancelled');
    assert.equal((await done).state, 'cancelled');
  } finally { f.db.close(); }
});

test('overlapping workspace writers wait through retained preview and waiting work can be cancelled without a device call', async () => {
  const f = fixture();
  try {
    const another = (operationId: string, root: string): ProjectExecutionInput => {
      const spec = localProjectSpecSchema.parse({ ...f.input.spec, root });
      return { ...f.input, operationId, taskId: operationId, runId: operationId, spec, specHash: projectSpecHash(spec) };
    };
    const child = another('child', 'd:\\PROJECT\\example\\child');
    const sibling = another('sibling', 'D:\\project\\example-other');
    const cancelled = another('cancelled', 'D:\\project\\example');
    const first = f.broker.run(f.input, f.context);
    const childResult = f.broker.run(child, f.context);
    const siblingResult = f.broker.run(sibling, f.context);
    const cancelledResult = f.broker.run(cancelled, f.context);
    assert.deepEqual(f.messages.filter(message => message.kind === 'project-execute').map(message => message.operationId), ['operation', 'sibling']);
    assert.match(f.broker.get('child')?.error ?? '', /重叠的项目目录/);
    assert.throws(() => f.broker.authorize('device', { operationId: 'child', specHash: child.specHash, requirementsRevision: 1 }), /没有有效执行会话/);
    await f.broker.stop('cancelled', 'owner cancelled');
    assert.equal((await cancelledResult).state, 'cancelled');
    assert.ok(!f.messages.some(message => message.operationId === 'cancelled'));
    f.broker.record('device', f.event(1, { kind: 'environment', state: 'active',
      terminals: [{ threadId: 'preview', processId: '1', command: 'node preview.mjs', cwd: f.input.spec.root }] }));
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'completed', output: 'Preview running' }));
    await first;
    assert.ok(!f.messages.some(message => message.operationId === 'child'));
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'closed', terminals: [] }));
    assert.equal(f.messages.at(-1)?.operationId, 'child');
    for (const input of [child, sibling]) f.broker.record('device', { ...f.event(1, { kind: 'finished', state: 'completed', output: '' }), operationId: input.operationId });
    await Promise.all([childResult, siblingResult]);
  } finally { f.db.close(); }
});

test('cancellation waits for a retained environment when a completed turn races the stop request', async () => {
  const f = fixture();
  try {
    const done = f.broker.run(f.input, f.context);
    const stopped = f.broker.stop('operation', 'owner cancelled');
    f.broker.record('device', f.event(1, { kind: 'environment', state: 'active',
      terminals: [{ threadId: 'preview', processId: '1', command: 'node preview.mjs', cwd: f.input.spec.root }] }));
    f.broker.record('device', f.event(2, { kind: 'finished', state: 'completed', output: 'The turn ended before the process drained' }));
    let drained = false;
    void stopped.then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    f.broker.record('device', f.event(3, { kind: 'environment', state: 'closed', terminals: [] }));
    await Promise.all([stopped, done]);
    assert.equal(drained, true);
  } finally { f.db.close(); }
});
