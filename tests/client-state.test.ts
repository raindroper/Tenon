import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeCase, RuntimeMessage, RuntimeView, RuntimeViewScope } from '../shared/runtime-view.js';
import { api, ApiError, connectRuntime, onSessionExpired, type RuntimeConnector } from '../client/api.js';
import { createRuntimeController as createRealRuntimeController } from '../client/state/useRuntime.js';
import { deriveConversation, initialSceneChoice, initialUiState, openSceneChoices, sceneCreationRequest, taskConversationDate, uiReducer, type SceneCreationAttempt } from '../client/state/ui-state.js';
import { KERNEL_SCHEMA_VERSION } from '../server/store.js';

const timestamp = '2026-11-03T08:00:00.000Z';
const createRuntimeController = (read: (signal: AbortSignal) => Promise<RuntimeView>, connect: RuntimeConnector = () => () => {}) => createRealRuntimeController(read, connect);
const topic = (id: string): RuntimeCase => ({ id, threadId: id, title: id, objective: 'Isolated fixture', domain: 'test',
  status: 'active', createdAt: timestamp, updatedAt: timestamp });
const message = (id: string, caseId?: string): RuntimeMessage => ({ id, caseId, role: 'assistant', content: id, createdAt: timestamp });
function snapshot(name = 'Rae', scope: RuntimeViewScope = {}): RuntimeView {
  return { runtime: 'mastra', schemaVersion: 3,
    settings: { agentName: name, ownerName: '', mission: 'Fixture only', model: 'fixture-model', apiBaseUrl: 'https://example.invalid/v1',
      apiKeyConfigured: false, enabled: false, reasoningEffort: 'auto', maxOutputTokens: null, maxOutputContinuations: 1, maxStepsPerRun: 3, timezone: 'Asia/Shanghai' },
    status: { state: 'paused', nextWakeAt: null, lastRunAt: null, lastError: null, pending: false,
      todayUsage: { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' } },
    cases: [], messages: [], tasks: [], understanding: [], sources: [], workspaceSources: [], artifacts: [], feedback: [], runs: [], events: [], grants: [],
    history: { runs: { items: [], nextBefore: null }, events: { items: [], nextBefore: null } },
    conversation: { caseId: scope.caseId ?? null, before: scope.before ?? null, beforeCreatedAt: null, nextBefore: null }, casePreviews: {},
    archive: { readOnly: true, counts: { memories: 0, initiatives: 0, activities: 0 } } };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let count = 0; count < 5; count++) await Promise.resolve(); }

test('the current kernel snapshot remains compatible with the RuntimeApi view while unknown schemas stay rejected', async () => {
  let current = { ...snapshot(), schemaVersion: KERNEL_SCHEMA_VERSION } as RuntimeView;
  const controller = createRuntimeController(async () => current);
  const stop = controller.start();
  try {
    await flush(); assert.equal(controller.getSnapshot().runtime?.schemaVersion, KERNEL_SCHEMA_VERSION);
    current = { ...snapshot(), schemaVersion: KERNEL_SCHEMA_VERSION + 1 } as never;
    await controller.refresh();
    assert.equal(controller.getSnapshot().runtime?.schemaVersion, KERNEL_SCHEMA_VERSION, 'an incompatible update must not replace the accepted current view');
    assert.match(controller.getSnapshot().connectionError, /版本不兼容/);
  } finally { stop(); }
});

test('changing scenes retargets live HTTP and SSE and fences the previous scene', async () => {
  const reads: { signal: AbortSignal; scope?: RuntimeViewScope; reply: ReturnType<typeof deferred<RuntimeView>> }[] = [];
  const streams: { scope?: RuntimeViewScope; receive(snapshot: RuntimeView): void; closed: boolean }[] = [];
  const controller = createRealRuntimeController((signal, scope) => {
    const reply = deferred<RuntimeView>(); reads.push({ signal, scope, reply }); return reply.promise;
  }, (receive, _fail, scope) => {
    const stream = { scope, receive, closed: false }; streams.push(stream); return () => { stream.closed = true; };
  });
  controller.setScope({ caseId: 'personal-growth' });
  const stop = controller.start();
  try {
    streams[0].receive(snapshot('Latest', streams[0].scope));
    controller.setScope({ caseId: 'another-scene' });
    assert.equal(streams[0].closed, true); assert.equal(reads[0].signal.aborted, true);
    assert.deepEqual(streams[1].scope, { caseId: 'another-scene' });
    assert.deepEqual(reads[1].scope, streams[1].scope);
    streams[0].receive(snapshot('Stale scene', streams[0].scope)); reads[0].reply.resolve(snapshot('Stale read', reads[0].scope));
    await flush(); assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Latest');
    streams[1].receive(snapshot('Current scene', streams[1].scope)); reads[1].reply.resolve(snapshot('Late scene read', reads[1].scope));
    await flush(); assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Current scene');
  } finally { stop(); }
});

test('opening another panel replaces the previous focus owner without changing the active conversation', () => {
  const replying = uiReducer(initialUiState, { type: 'replyTo', message: message('quoted', 'design') });
  const memory = uiReducer(replying, { type: 'openPanel', panel: { type: 'memory' } });
  const settings = uiReducer(memory, { type: 'openPanel', panel: { type: 'settings' } });
  assert.deepEqual(settings.panel, { type: 'settings' }); assert.equal(settings.caseId, 'design'); assert.equal(settings.reply?.id, 'quoted');
  assert.equal(uiReducer(settings, { type: 'closePanel' }).panel, null);
  const switched = uiReducer(settings, { type: 'selectCase', caseId: 'lunch' });
  assert.deepEqual(switched, { caseId: 'lunch', reply: null, panel: null });
});

test('a completed send clears only the quote that belonged to that send', () => {
  let state = uiReducer(initialUiState, { type: 'replyTo', message: message('old', 'design') });
  state = uiReducer(state, { type: 'replyTo', message: message('new', 'lunch') });
  state = uiReducer(state, { type: 'messageSent', replyId: 'old' });
  assert.equal(state.reply?.id, 'new'); assert.equal(state.caseId, 'lunch');
  assert.equal(uiReducer(state, { type: 'messageSent' }).reply?.id, 'new');
  assert.equal(uiReducer(state, { type: 'messageSent', replyId: 'new' }).reply, null);
  assert.deepEqual(uiReducer(state, { type: 'selectCase', caseId: null }), initialUiState);
  assert.deepEqual(uiReducer(initialUiState, { type: 'openPanel', panel: { type: 'taskRequest', draft: 'Captured draft' } }).panel,
    { type: 'taskRequest', draft: 'Captured draft' });
});

test('an old asynchronous panel save cannot dismiss a newer panel', () => {
  const savingPanel = { type: 'source' as const, id: 'first' };
  let state = uiReducer(initialUiState, { type: 'openPanel', panel: savingPanel });
  state = uiReducer(state, { type: 'openPanel', panel: { type: 'source', id: 'second' } });
  const next = uiReducer(state, { type: 'closePanel', expected: savingPanel });
  assert.equal(next, state); assert.equal(next.panel?.type, 'source');
  assert.equal(uiReducer(next, { type: 'closePanel', expected: next.panel }).panel, null);
  assert.equal(uiReducer(state, { type: 'closePanel' }).panel, null, 'an explicit close still works without an owner');
});

test('a submitted scene or task only navigates while its panel still owns the screen', () => {
  const submitting = { type: 'caseEditor' as const };
  const start = uiReducer(initialUiState, { type: 'openPanel', panel: submitting });
  assert.deepEqual(uiReducer(start, { type: 'panelSubmitted', expected: submitting, caseId: 'new-scene' }),
    { caseId: 'new-scene', reply: null, panel: null });
  const changedScene = uiReducer(start, { type: 'selectCase', caseId: 'other-conversation' });
  assert.equal(uiReducer(changedScene, { type: 'panelSubmitted', expected: submitting, caseId: 'new-scene' }), changedScene);
  const newPanel = uiReducer(start, { type: 'openPanel', panel: { type: 'taskRequest', mediaKind: 'video' } });
  assert.equal(uiReducer(newPanel, { type: 'panelSubmitted', expected: submitting, caseId: 'new-scene' }), newPanel);
  assert.deepEqual(uiReducer(newPanel, { type: 'panelSubmitted', expected: newPanel.panel!, caseId: 'new-delivery' }),
    { caseId: 'new-delivery', reply: null, panel: null });
  const closed = uiReducer(start, { type: 'closePanel', expected: submitting });
  assert.equal(uiReducer(closed, { type: 'panelSubmitted', expected: submitting, caseId: 'new-scene' }), closed);
});

test('task and media forms default to the current open scene or general, even before general has been saved', () => {
  const cases = [topic('project'), { ...topic('stopped'), status: 'cancelled' as const }];
  const initialChoices = openSceneChoices(cases);
  assert.deepEqual(initialChoices.map(item => item.id), ['personal-growth', 'project']);
  assert.equal(initialSceneChoice(initialChoices), 'personal-growth');
  assert.equal(initialSceneChoice(initialChoices, 'project'), 'project');
  assert.equal(initialSceneChoice(initialChoices, 'stopped'), 'personal-growth');
  assert.equal(initialSceneChoice(openSceneChoices([{ ...topic('personal-growth'), status: 'cancelled' }])), '');
});

test('retrying scene creation reuses its request ID until the creation input changes', () => {
  const attempt = { current: null as SceneCreationAttempt | null };
  const input = { title: 'Travel', objective: '', domain: 'personal' };
  const first = sceneCreationRequest(input, attempt);
  assert.match(first.requestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.deepEqual(sceneCreationRequest({ ...input }, attempt), first);
  let previous = first;
  for (const changed of [{ ...input, title: 'Work' }, { ...input, objective: 'Draft' }, { ...input, domain: 'other' }]) {
    const next = sceneCreationRequest(changed, attempt);
    assert.notEqual(next.requestId, previous.requestId);
    assert.deepEqual(sceneCreationRequest(changed, attempt), next);
    previous = next;
  }
});

test('the home conversation uses the stable server identity and never combines unrelated or unscoped history', () => {
  const runtime = snapshot(); runtime.cases = [topic('project'), { ...topic('personal-growth'), title: 'Owner renamed this topic' }];
  runtime.messages = [message('project-only', 'project'), message('old-unscoped'), message('personal-only', 'personal-growth')];
  runtime.tasks = [{ id: 'project-task', revision: 1, state: 'proposed', spec: { caseId: 'project', title: 'Fixture', objective: 'Fixture', expectedOutput: 'Text', capabilities: ['artifact'] }, createdAt: timestamp, updatedAt: timestamp }];
  const home = deriveConversation(runtime, null);
  assert.equal(home.caseId, 'personal-growth'); assert.equal(home.item?.title, 'Owner renamed this topic');
  assert.deepEqual(home.messages.map(item => item.id), ['personal-only']); assert.deepEqual(home.tasks, []);
  runtime.cases = [topic('project')];
  assert.deepEqual(deriveConversation(runtime, null).messages, []);
  assert.deepEqual(deriveConversation(runtime, 'project').messages.map(item => item.id), ['project-only']);
  runtime.cases = [];
  assert.equal(deriveConversation(runtime, 'project').item, undefined);
  assert.deepEqual(deriveConversation(runtime, 'project').messages.map(item => item.id), ['project-only'], 'retired topics remain readable');
});

test('an owner continuation exposes the same task in that scene without copying home messages or granting other scene membership', () => {
  const runtime = snapshot(); runtime.cases = [topic('home'), topic('continued'), topic('unrelated')];
  runtime.messages = [message('home-message', 'home'), message('continued-message', 'continued'), message('unrelated-message', 'unrelated')];
  const task: RuntimeView['tasks'][number] = { id: 'shared-task', revision: 3, state: 'running', requirementsRevision: 2,
    spec: { caseId: 'home', title: 'One task', objective: 'Original goal', expectedOutput: 'One result', capabilities: ['artifact'] },
    createdAt: timestamp, updatedAt: timestamp,
    evidenceRefs: [{ eventId: 'private-source-id', sourceId: 'private-source', sourceCaseId: 'unrelated' }],
    requirementUpdates: [{ revision: 2, sourceEventId: 'continued-request', caseId: 'continued', content: 'Continue this task here.', createdAt: timestamp }] };
  runtime.tasks = [task];
  const home = deriveConversation(runtime, 'home'); const continued = deriveConversation(runtime, 'continued');
  assert.equal(home.tasks[0], task); assert.equal(continued.tasks[0], task, 'Both scenes refer to the same authoritative record');
  assert.deepEqual(continued.messages.map(item => item.id), ['continued-message']);
  assert.deepEqual(deriveConversation(runtime, 'unrelated').tasks, [], 'A linked source does not make its scene a task conversation');
  assert.equal(runtime.tasks.length, 1); assert.equal(runtime.messages.length, 3); assert.equal(task.spec.caseId, 'home');
});

test('task history dates use the latest continuation in that scene and preserve legacy and home ordering', () => {
  const task: RuntimeView['tasks'][number] = { id: 'history-task', revision: 5, state: 'completed',
    spec: { caseId: 'home', title: 'Task', objective: 'Goal', expectedOutput: 'Output', capabilities: ['artifact'] },
    createdAt: timestamp, updatedAt: '2026-11-07T05:00:00.000Z', requirementUpdates: [
      { revision: 4, sourceEventId: 'continued-later', caseId: 'continued', content: 'Later', createdAt: '2026-11-07T04:00:00.000Z' },
      { revision: 2, sourceEventId: 'legacy', content: 'Legacy amendment without a conversation', createdAt: '2026-11-07T01:00:00.000Z' },
      { revision: 3, sourceEventId: 'continued-earlier', caseId: 'continued', content: 'Earlier', createdAt: '2026-11-07T03:00:00.000Z' },
      { revision: 5, sourceEventId: 'elsewhere', caseId: 'another', content: 'Elsewhere', createdAt: '2026-11-07T05:00:00.000Z' },
    ] };
  assert.equal(taskConversationDate(task, 'home'), timestamp);
  assert.equal(taskConversationDate(task, 'continued'), '2026-11-07T04:00:00.000Z');
  assert.equal(taskConversationDate(task, 'another'), '2026-11-07T05:00:00.000Z');
  const runtime = snapshot(); runtime.tasks = [{ ...task, requirementUpdates: task.requirementUpdates?.filter(update => !update.caseId) }];
  assert.equal(deriveConversation(runtime, 'home').tasks.length, 1);
  assert.deepEqual(deriveConversation(runtime, 'continued').tasks, []);
  assert.equal(taskConversationDate({ ...task, requirementUpdates: undefined }, 'home'), timestamp);
});

test('a newer read wins even when a cancelled older transport resolves or fails late', async () => {
  const requests: Array<ReturnType<typeof deferred<RuntimeView>> & { signal: AbortSignal }> = [];
  const controller = createRuntimeController(signal => { const request = { ...deferred<RuntimeView>(), signal }; requests.push(request); return request.promise; });
  const stop = controller.start();
  try {
    const latest = controller.refresh(); assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve(snapshot('Current')); assert.equal(await latest, true);
    requests[0].reject(new Error('Obsolete failure')); await flush();
    assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Current'); assert.equal(controller.getSnapshot().connectionError, '');
    const stale = controller.refresh(); const newest = controller.refresh();
    requests[3].resolve(snapshot('Newest')); await newest;
    requests[2].resolve(snapshot('Stale')); assert.equal(await stale, false);
    assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Newest');
  } finally { stop(); }
});

test('stopping aborts reads and suppresses late updates, while a restarted lifecycle can read again', async () => {
  const requests: Array<ReturnType<typeof deferred<RuntimeView>> & { signal: AbortSignal }> = [];
  const controller = createRuntimeController(signal => { const request = { ...deferred<RuntimeView>(), signal }; requests.push(request); return request.promise; });
  let updates = 0; const unsubscribe = controller.subscribe(() => { updates++; });
  const stop = controller.start(); stop(); const stoppedUpdates = updates;
  assert.equal(requests[0].signal.aborted, true); requests[0].resolve(snapshot('Old lifecycle')); await flush();
  assert.equal(updates, stoppedUpdates); assert.equal(controller.getSnapshot().runtime, null);
  const stopAgain = controller.start();
  try {
    stop(); // A stale effect cleanup must not stop its replacement.
    assert.equal(requests[1].signal.aborted, false);
    requests[1].resolve(snapshot('New lifecycle')); await flush();
    assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'New lifecycle');
  } finally { stopAgain(); unsubscribe(); }
});

test('a slow initial read and an idle connection never create background polling', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred<RuntimeView>(); let reads = 0;
  const controller = createRuntimeController(async () => { reads++; return reads === 1 ? first.promise : snapshot(); });
  const stop = controller.start();
  context.mock.timers.tick(60_000); await flush(); assert.equal(reads, 1);
  first.resolve(snapshot()); await flush(); context.mock.timers.tick(60_000); await flush(); assert.equal(reads, 1);
  stop(); context.mock.timers.tick(60_000); await flush(); assert.equal(reads, 1);
});

test('live partial and final output supersede a stale HTTP read without another request', async () => {
  let receive!: (value: RuntimeView) => void; let reads = 0; let signal!: AbortSignal;
  const first = deferred<RuntimeView>();
  const controller = createRuntimeController(async abort => { reads++; signal = abort; return first.promise; }, next => { receive = next; return () => {}; });
  const stop = controller.start();
  try {
    const working = snapshot(); working.status.state = 'working'; working.messages = [{ ...message('answer'), content: '第一段', outputState: 'streaming' }];
    receive(working); assert.equal(signal.aborted, true); assert.equal(controller.getSnapshot().runtime?.messages[0].content, '第一段');
    first.resolve(snapshot('Stale')); await flush(); assert.equal(controller.getSnapshot().runtime?.status.state, 'working');
    const completed = snapshot(); completed.messages = [{ ...message('answer'), content: '第一段，第二段', outputState: 'complete' }];
    receive(completed); assert.equal(controller.getSnapshot().runtime?.messages[0].outputState, 'complete');
    assert.equal(controller.getSnapshot().runtime?.messages[0].content, '第一段，第二段'); assert.equal(reads, 1);
  } finally { stop(); }
});

test('a reconnect replaces retained partial output and stopping fences late live events', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0; let disconnected = 0; let receive!: (value: RuntimeView) => void; let fail!: (cause: unknown) => void;
  const working = snapshot(); working.status.state = 'working';
  const controller = createRuntimeController(async () => { reads++; return working; }, (next, error) => { receive = next; fail = error; return () => { disconnected++; }; });
  const stop = controller.start();
  try {
    await flush(); fail(new Error('offline')); assert.equal(controller.getSnapshot().connectionError, 'offline');
    assert.equal(controller.getSnapshot().runtime?.status.state, 'working');
    context.mock.timers.tick(60_000); await flush(); assert.equal(reads, 1);
    receive(snapshot('Recovered')); assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Recovered'); assert.equal(controller.getSnapshot().connectionError, '');
    stop(); receive(snapshot('Late')); fail(new Error('Late failure'));
    assert.equal(disconnected, 1); assert.equal(controller.getSnapshot().runtime, null); assert.equal(controller.getSnapshot().connectionError, '');
  } finally { stop(); }
});

test('manual reconnect replaces only the live stream and fences callbacks without clearing the conversation or replaying work', async () => {
  let reads = 0; let closed = 0;
  const connections: Array<{ receive(value: RuntimeView): void; fail(cause: unknown): void }> = [];
  const saved = snapshot('Saved conversation'); saved.messages = [message('existing', 'personal-growth')];
  const controller = createRuntimeController(async () => { reads++; return saved; }, (receive, fail) => {
    connections.push({ receive, fail }); return () => { closed++; };
  });
  const stop = controller.start();
  try {
    await flush(); connections[0].fail(new Error('closed transport'));
    controller.reconnect(); assert.equal(connections.length, 2); assert.equal(closed, 1); assert.equal(reads, 1);
    assert.equal(controller.getSnapshot().runtime?.messages[0].id, 'existing');
    connections[1].receive(snapshot('Recovered'));
    connections[0].receive(snapshot('Obsolete')); connections[0].fail(new Error('Obsolete error'));
    assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Recovered'); assert.equal(controller.getSnapshot().connectionError, '');
  } finally { stop(); }
  controller.reconnect(); assert.equal(connections.length, 2); assert.equal(closed, 2);
});

test('duplicate mutation keys dispatch once and keep pending state until the accepted operation settles', async () => {
  const controller = createRuntimeController(async () => snapshot()); const stop = controller.start(); const operation = deferred<unknown>(); let calls = 0;
  try {
    await flush();
    const first = controller.perform('approve:task', async () => { calls++; return operation.promise; }, 'Accepted');
    assert.deepEqual(controller.getSnapshot().busy, ['approve:task']);
    assert.equal(await controller.perform('approve:task', async () => { calls++; }), false);
    operation.resolve(undefined); assert.equal(await first, true);
    assert.equal(calls, 1); assert.deepEqual(controller.getSnapshot().busy, []); assert.equal(controller.getSnapshot().notice, 'Accepted');
    controller.dismissNotice(); assert.equal(controller.getSnapshot().notice, '');
  } finally { stop(); }
});

test('a failed refresh does not turn an already accepted mutation into a retryable operation failure', async () => {
  let available = true; let writes = 0;
  const controller = createRuntimeController(async () => { if (!available) throw new Error('Read offline'); return snapshot(); }); const stop = controller.start();
  try {
    await flush(); available = false;
    assert.equal(await controller.perform('message', async () => { writes++; }, 'Message saved'), true);
    assert.equal(writes, 1); assert.equal(controller.getSnapshot().error, ''); assert.equal(controller.getSnapshot().connectionError, 'Read offline');
    assert.equal(controller.getSnapshot().notice, 'Message saved'); assert.ok(controller.getSnapshot().runtime);
    assert.equal(await controller.perform('revoke', async () => { throw new Error('Permission already withdrawn'); }), false);
    assert.equal(controller.getSnapshot().error, 'Permission already withdrawn'); assert.deepEqual(controller.getSnapshot().busy, []);
    controller.dismissError(); assert.equal(controller.getSnapshot().error, '');
    available = true; await controller.refresh(); assert.equal(controller.getSnapshot().connectionError, '');
  } finally { stop(); }
});

test('a message acknowledgement can release the composer while the state refresh is still in flight', async () => {
  const refreshing = deferred<RuntimeView>();
  let reads = 0;
  const controller = createRuntimeController(async () => ++reads === 1 ? snapshot() : refreshing.promise);
  const stop = controller.start();
  try {
    await flush();
    assert.equal(await controller.perform('message', async () => {}, undefined, { refreshInBackground: true }), true);
    assert.equal(reads, 2);
    assert.deepEqual(controller.getSnapshot().busy, []);
    refreshing.resolve(snapshot('Refreshed'));
    await flush();
    assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Refreshed');
  } finally { stop(); }
});

test('a mutation completing while unmounted cannot publish a toast or leave stale busy state on restart', async () => {
  let reads = 0; const operation = deferred<unknown>();
  const controller = createRuntimeController(async () => { reads++; return snapshot(); }); const stop = controller.start(); await flush();
  let updates = 0; const unsubscribe = controller.subscribe(() => { updates++; });
  const pending = controller.perform('save', () => operation.promise, 'Late success'); stop(); const stoppedUpdates = updates;
  operation.resolve(undefined); assert.equal(await pending, false); assert.equal(updates, stoppedUpdates); assert.equal(reads, 1);
  const stopAgain = controller.start();
  try { await flush(); assert.deepEqual(controller.getSnapshot().busy, []); assert.equal(controller.getSnapshot().notice, ''); }
  finally { stopAgain(); unsubscribe(); }
});

test('invalid runtime responses retain the last good snapshot and expose the protocol error', async () => {
  let next = snapshot('Saved'); const controller = createRuntimeController(async () => next); const stop = controller.start();
  try {
    await flush(); next = { ...snapshot(), schemaVersion: 2 } as never;
    assert.equal(await controller.refresh(), false); assert.equal(controller.getSnapshot().runtime?.settings.agentName, 'Saved');
    assert.match(controller.getSnapshot().connectionError, /数据版本不兼容/);
  } finally { stop(); }
});

test('JSON transport preserves server errors, rejects unreadable success bodies, and forwards abort signals', async context => {
  let mode: 'success' | 'error' | 'invalid' = 'success'; let received: RequestInit | undefined;
  context.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    received = init;
    return mode === 'error' ? new Response(JSON.stringify({ error: 'This task was revoked' }), { status: 409 })
      : mode === 'invalid' ? new Response('not JSON', { status: 200 }) : new Response(JSON.stringify({ saved: true }), { status: 201 });
  });
  const abort = new AbortController();
  assert.deepEqual(await api('/api/messages', 'POST', { content: 'Fixture only' }, abort.signal), { saved: true });
  assert.equal(received?.signal, abort.signal); assert.equal(received?.cache, 'no-store');
  assert.equal(received?.body, '{"content":"Fixture only"}');
  mode = 'error'; await assert.rejects(api('/api/tasks/id/revoke', 'POST', {}), /This task was revoked/);
  mode = 'invalid'; await assert.rejects(api('/api/state'), /数据无法读取/);
});

test('session expiry clears private runtime data, closes updates, and never replays a rejected mutation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0; let writes = 0;
  const controller = createRuntimeController(async () => { reads++; return snapshot('Private owner'); });
  const stop = controller.start();
  try {
    await flush(); assert.ok(controller.getSnapshot().runtime);
    assert.equal(await controller.perform('private-write', async () => { writes++; throw new ApiError(401, 'Expired'); }), false);
    assert.equal(controller.getSnapshot().runtime, null); assert.equal(controller.getSnapshot().error, '');
    context.mock.timers.tick(60_000); await flush(); assert.equal(reads, 1); assert.equal(writes, 1);
    assert.equal(await controller.perform('private-write', async () => { writes++; }), false); assert.equal(writes, 1);
  } finally { stop(); }
});

test('native live transport forwards public snapshots, reports errors, and closes after rejected session reconnect', async context => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let source!: FakeEventSource;
  class FakeEventSource extends EventTarget {
    closed = false; onerror?: () => void;
    constructor(readonly url: string) { super(); source = this; }
    close() { this.closed = true; }
    state(value: unknown) { this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(value), lastEventId: '1' })); }
    delta(value: unknown) { this.dispatchEvent(new MessageEvent('state-delta', { data: JSON.stringify(value), lastEventId: '2' })); }
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  const received: RuntimeView[] = []; const errors: unknown[] = []; let expired = 0; let sessionReads = 0;
  const detach = onSessionExpired(() => { expired++; });
  context.mock.method(globalThis, 'fetch', async (path: unknown) => {
    assert.equal(path, '/api/auth/session'); sessionReads++;
    return new Response(JSON.stringify({ required: true, authenticated: false }), { status: 200 });
  });
  const close = connectRuntime(value => received.push(value), cause => errors.push(cause));
  try {
    assert.equal(source.url, '/api/state/stream?delta=1');
    source.state({ ...snapshot('Live'), devices: [] }); assert.equal(received[0].settings.agentName, 'Live');
    source.delta({ base: '1', replace: { messages: [message('updated')] }, remove: ['devices'] });
    assert.equal(received[1].settings, received[0].settings);
    assert.equal(received[1].messages[0].id, 'updated'); assert.equal(received[1].devices, undefined);
    source.onerror?.(); source.onerror?.(); await flush(); await flush();
    assert.equal(sessionReads, 1); assert.equal(expired, 1); assert.equal(source.closed, true); assert.equal(errors.length, 2);
    source.state(snapshot('Late private')); assert.equal(received.length, 2);
  } finally {
    close(); detach();
    if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

test('a delta with a missing base reconnects for a new complete snapshot', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let source!: FakeEventSource;
  class FakeEventSource extends EventTarget {
    closed = false;
    constructor() { super(); source = this; }
    close() { this.closed = true; }
    frame(event: string, data: unknown, lastEventId: string) {
      this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data), lastEventId }));
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'EventSource', original); else Reflect.deleteProperty(globalThis, 'EventSource');
  });
  const views: RuntimeView[] = []; const errors: unknown[] = [];
  const close = connectRuntime(view => views.push(view), error => errors.push(error));
  try {
    const initial = source;
    initial.frame('state', snapshot('Original'), '3');
    initial.frame('state-delta', { base: '4', replace: { settings: snapshot('Wrong').settings } }, '5');
    assert.equal(initial.closed, true); assert.equal(errors.length, 1); assert.equal(views.length, 1);
    context.mock.timers.tick(2000);
    assert.notEqual(source, initial);
    source.frame('state', snapshot('Recovered'), '6');
    assert.equal(views[1].settings.agentName, 'Recovered');
  } finally { close(); }
});
