import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, unlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import { MockLanguageModelV4 } from './support/model.js';
import { createApp, exportRuntimeData } from '../server/index.js';
import { acquireRuntimeLease, type RuntimeLease } from '../server/runtime-lease.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('HTTP source rebind cannot send a retired A-only payload into B native history after the old file is deleted', async context => {
  const prefix = join(tmpdir(), 'rae-source-boundary-'); const directory = await mkdtemp(prefix);
  const dataDir = join(directory, 'data'); const watched = join(directory, 'authorized-root');
  let lease: RuntimeLease | undefined; let store: Store | undefined; let engine: V2Coordinator | undefined; let app: Server | undefined;
  let businessError: unknown;
  const prompts: string[] = [];
  let freshEventId = '';
  const freshContent = 'B_PREVIEW_' + 'x'.repeat(600) + '\nNEW_CASE_B_PUBLIC_PAYLOAD';
  // A local fixture reads only the explicit event ID from a manually released observation batch.
  const model = new MockLanguageModelV4({
    doGenerate: async options => {
      const prompt = JSON.stringify(options.prompt); prompts.push(prompt);
      assert.doesNotMatch(prompt, /OLD_CASE_A_PRIVATE_PAYLOAD/);
      const names = options.tools?.map(tool => tool.name) ?? [];
      assert.ok(!names.includes('write_workspace') && !names.includes('publish_artifact'));
      if (prompts.length === 1) {
        assert.ok(names.includes('read_event'));
        assert.ok(freshEventId); assert.match(prompt, new RegExp(freshEventId));
        assert.match(prompt, /B_PREVIEW_/);
        assert.doesNotMatch(prompt, /NEW_CASE_B_PUBLIC_PAYLOAD/, 'The bounded preview does not inject the complete source');
        return { content: [{ type: 'tool-call', toolCallId: 'read-fresh-b', toolName: 'read_event', input: JSON.stringify({ eventId: freshEventId }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
      }
      assert.equal(prompts.length, 2, 'Manual review reads once and then completes');
      assert.deepEqual(names, ['finish_review']);
      assert.match(prompt, /NEW_CASE_B_PUBLIC_PAYLOAD/);
      return { content: [{ type: 'tool-call', toolCallId: 'finish-fresh-b', toolName: 'finish_review',
        input: JSON.stringify({ outcome: 'silent', evidenceIds: [freshEventId] }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
    },
  });
  try {
    lease = await acquireRuntimeLease(dataDir); store = new Store(dataDir); store.getApiKey = () => undefined;
    engine = await V2Coordinator.create(store, { dataDir, model, lease }); app = createApp({ store, runtime: engine });
    await new Promise<void>(done => app!.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(base + path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value as T;
    };
    const a = await call<{ id: string }>('/api/v2/cases', 'POST', { title: 'Private A fixture', objective: 'Keep A source private', domain: 'private-a' });
    const b = await call<{ id: string }>('/api/v2/cases', 'POST', { title: 'Independent B fixture', objective: 'Read only the new B source', domain: 'work-b' });
    await mkdir(watched); await writeFile(join(watched, 'a.md'), 'OLD_CASE_A_PRIVATE_PAYLOAD', 'utf8');
    const sourceA = await call<{ generation: string }>('/api/v2/sources/workspace', 'POST', { sourceId: 'reused-alias', root: watched, caseId: a.id, include: ['a.md'] });
    const old = engine.inbox.list().find(event => event.sourceId === 'reused-alias' && event.externalId === 'a.md')!;
    assert.ok(old); assert.equal(old.caseId, a.id); assert.equal(old.sourceGeneration, sourceA.generation);
    assert.ok(old.status === 'pending' || old.status === 'processed'); assert.equal(old.attempts, 0, 'Local capture never claims a model run');
    assert.equal(prompts.length, 0, 'default paused setup must not invoke even the fixture model');

    await call('/api/v2/sources/reused-alias', 'DELETE');
    await unlink(join(watched, 'a.md')); await writeFile(join(watched, 'b.md'), freshContent, 'utf8');
    assert.deepEqual(await readdir(watched), ['b.md'], 'the old private file must actually be absent from the new authorization');
    const sourceB = await call<{ generation: string; caseId: string; include: string[] }>('/api/v2/sources/workspace', 'POST', { sourceId: 'reused-alias', root: watched, caseId: b.id, include: ['b.md'] });
    assert.notEqual(sourceA.generation, sourceB.generation);
    assert.equal(sourceB.caseId, b.id); assert.deepEqual(sourceB.include, ['b.md']);
    const fresh = engine.inbox.list().find(event => event.sourceGeneration === sourceB.generation && event.externalId === 'b.md')!;
    assert.ok(fresh); assert.equal(fresh.caseId, b.id); assert.equal(fresh.payload.content, freshContent);
    freshEventId = fresh.id;
    await call('/api/settings', 'POST', { maxStepsPerRun: 2 });
    await call('/api/control', 'POST', { action: 'resume' });
    await delay(150);
    assert.equal(prompts.length, 0, 'Enabling inference captures passive files locally without starting a model review');
    assert.equal(engine.inbox.get(fresh.id)?.attempts, 0);
    await call('/api/control', 'POST', { action: 'wake' });
    const deadline = Date.now() + 10000;
    while (!engine.inbox.list().some(event => event.kind === 'growth.observation' && event.caseId === b.id && event.status === 'processed') || engine.status().state === 'working') {
      assert.ok(Date.now() < deadline, `B review did not finish: ${JSON.stringify(engine.status())}`); await delay(20);
    }

    const oldAfter = engine.inbox.get(old.id)!;
    assert.equal(oldAfter.caseId, a.id); assert.equal(oldAfter.sourceGeneration, sourceA.generation);
    assert.ok(oldAfter.status === 'pending' || oldAfter.status === 'processed'); assert.equal(oldAfter.attempts, 0, 'a retired source is retained without being dispatched into another case');
    assert.equal(engine.sources.isEventAllowed(oldAfter), false);
    const bView = await call<{ history: unknown }>(`/api/v2/cases/${b.id}`);
    const nativeB = JSON.stringify(await engine.memory.history(b.id)); const nativeA = JSON.stringify(await engine.memory.history(a.id));
    assert.equal(nativeB, '[]', 'background source reviews do not persist raw provider exchanges in the owner chat');
    assert.equal(engine.inbox.get(fresh.id)?.payload.content, freshContent, 'original authorized evidence remains durable');
    const review = engine.inbox.list().find(event => event.kind === 'growth.observation' && event.caseId === b.id)!;
    assert.equal(engine.inbox.reviewDecision(review.id)?.input.outcome, 'silent');
    assert.doesNotMatch(JSON.stringify(bView.history), /OLD_CASE_A_PRIVATE_PAYLOAD/); assert.doesNotMatch(nativeA, /OLD_CASE_A_PRIVATE_PAYLOAD/);
    assert.equal(prompts.length, 2, 'only a manually released B batch makes two local calls');
    assert.doesNotMatch(prompts[0], /NEW_CASE_B_PUBLIC_PAYLOAD/); assert.match(prompts[1], /NEW_CASE_B_PUBLIC_PAYLOAD/);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /OLD_CASE_A_PRIVATE_PAYLOAD/);
    assert.equal(engine.inbox.get(fresh.id)?.attempts, 0, 'Raw source capture never becomes an execution run');
    assert.equal((await engine.listTasks()).length, 0); assert.equal(store.list('artifacts').length, 0);
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 0, 'background summaries must not become unsolicited chat messages');
  } catch (error) { businessError = error; }
  finally {
    const failures: unknown[] = [];
    const clean = async (work: () => unknown) => { try { await work(); } catch (error) { failures.push(error); } };
    await clean(() => app?.listening ? new Promise<void>((done, fail) => app!.close(error => error ? fail(error) : done())) : undefined);
    await clean(() => engine?.close()); await clean(() => store?.close()); await clean(() => lease?.release());
    const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) context.diagnostic(`cleanupDeferred after closing native libSQL: ${target}`);
      else failures.push(error);
    }
    if (failures.length) businessError = new AggregateError([...(businessError ? [businessError] : []), ...failures], 'Source boundary assertions or resource cleanup failed');
  }
  if (businessError) throw businessError;
});

test('same-topic replay excludes stopped source results and the corresponding model answer after restart, while export retains both', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-source-history-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const marker = 'RETIRED_PRIVATE_SOURCE_BODY';
  const publicAnswer = 'The source says ' + marker;
  const prompts: string[] = [];
  let sourceEventId = '';
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    const prompt = JSON.stringify(options.prompt); prompts.push(prompt);
    if (prompts.length === 1 || prompts.length === 3) {
      const toolName = prompts.length === 1 ? 'find_case_evidence' : 'read_event';
      const input = toolName === 'find_case_evidence' ? { query: 'RETIRED_PRIVATE', limit: 1 } : { eventId: sourceEventId };
      return { warnings: [], usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        content: [{ type: 'tool-call', toolCallId: toolName, toolName, input: JSON.stringify(input) }] };
    }
    if (prompts.length === 2 || prompts.length === 4) assert.match(prompt, new RegExp(marker), 'active evidence can be retrieved');
    return { warnings: [], usage, finishReason: { unified: 'stop', raw: 'stop' },
      content: [{ type: 'text', text: prompts.length === 2 || prompts.length === 4 ? publicAnswer : 'Ordinary fixture reply.' }] };
  } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const send = async (message: string, caseId: string) => {
    const event = await runtime.ingestOwnerMessage(message, caseId);
    const deadline = Date.now() + 10_000;
    while (runtime.inbox.get(event.id)?.status !== 'processed') { assert.ok(Date.now() < deadline); await delay(10); }
  };
  try {
    const item = await runtime.createCase({ title: 'Source privacy', objective: 'Constrain native history to current evidence', domain: 'fixture' });
    const root = join(directory, 'watched'); await mkdir(root); await writeFile(join(root, 'file.md'), marker);
    await runtime.registerWorkspaceSource({ sourceId: 'test-source', caseId: item.id, root, include: ['file.md'] });
    sourceEventId = runtime.inbox.list().find(event => event.kind === 'workspace.file')!.id;
    await store.updateSettings({ enabled: true }); runtime.start();
    await send('Find the authorized evidence.', item.id);
    await send('Read the source evidence.', item.id);
    await send('Keep this independent context.', item.id);
    assert.match(prompts.at(-1)!, new RegExp(publicAnswer));
    await runtime.removeWorkspaceSource('test-source');
    await runtime.close();
    runtime = await V2Coordinator.create(store, { dataDir: directory, model }); runtime.start();
    await send('Continue without the stopped source.', item.id);
    assert.equal(prompts.length, 6);
    assert.doesNotMatch(prompts.at(-1)!, new RegExp(marker));
    assert.match(prompts.at(-1)!, /Keep this independent context/);
    const exported = await exportRuntimeData(store, runtime);
    assert.match(JSON.stringify(exported.caseDetails), new RegExp(marker));
    assert.ok(exported.messages.some(message => message.content === publicAnswer));
  } finally { await runtime.close(); store.close(); }
});

test('stopping a source fences the next provider step of an accepted tool call and keeps its result out of logs', { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-source-fence-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const stepEntered = deferred();
  const stepRelease = deferred();
  const aborted = deferred();
  const marker = 'SOURCE_BEFORE_STOP';
  const levels = ['error', 'warn', 'info', 'log', 'debug'] as const;
  const logs = levels.map(level => context.mock.method(console, level, () => undefined));
  let sourceEventId = ''; let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    calls++;
    return { warnings: [], usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      content: [{ type: 'tool-call', toolCallId: 'read-before-stop', toolName: 'read_event', input: JSON.stringify({ eventId: sourceEventId }) }] };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const runCase = runtime.memory.runCase.bind(runtime.memory);
  runtime.memory.runCase = input => {
    input.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
    return runCase({ ...input, onStepFinish: async step => {
      stepEntered.resolve(); await stepRelease.promise; await input.onStepFinish?.(step);
    } });
  };
  try {
    const item = await runtime.createCase({ title: 'Source fence', objective: 'Stop a running source turn', domain: 'fixture' });
    const root = join(directory, 'watched'); await mkdir(root); await writeFile(join(root, 'file.md'), marker);
    await runtime.registerWorkspaceSource({ sourceId: 'test-source', caseId: item.id, root, include: ['file.md'] });
    sourceEventId = runtime.inbox.list().find(event => event.kind === 'workspace.file')!.id;
    await store.updateSettings({ enabled: true }); runtime.start();
    await runtime.ingestOwnerMessage('Read the authorized evidence.', item.id);
    await stepEntered.promise;
    const removal = runtime.removeWorkspaceSource('test-source');
    await aborted.promise;
    stepRelease.resolve(); await removal;
    assert.equal(calls, 1);
    assert.equal(runtime.sources.isEventAllowed(runtime.inbox.get(sourceEventId)!), false);
    assert.doesNotMatch(inspect(logs.flatMap(log => log.mock.calls.map(call => call.arguments)), { depth: 8 }), new RegExp(marker));
  } finally { stepRelease.resolve(); await runtime.close(); store.close(); }
});
