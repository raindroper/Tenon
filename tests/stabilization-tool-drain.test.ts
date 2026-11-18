import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from './support/model.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function waitFor(promise: Promise<void>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function cleanup(directory: string, prefix: string, diagnostic: (message: string) => void) {
  assert.ok(resolve(directory).startsWith(resolve(prefix)));
  try { await rm(directory, { recursive: true, force: true }); }
  catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; diagnostic(`cleanupDeferred=${directory}`); }
}

for (const cancellationMode of ['case', 'task'] as const) test(`${cancellationMode === 'case' ? 'case cancellation' : 'task revocation'} drains an owner-approved native write before acknowledging and revoking its task`, async context => {
  const prefix = join(tmpdir(), 'rae-consented-tool-drain-'); const directory = await mkdtemp(prefix);
  const repo = join(directory, 'fixture-repository'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); writeFileSync(join(repo, 'fixture.json'), '{"fixture":false}\n'); git('add', 'fixture.json');
  git('-c', 'user.name=Software Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Disposable fixture baseline');
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls++; assert.ok(options.tools?.some(tool => tool.name === 'write_workspace'));
    return { content: [{ type: 'tool-call', toolCallId: 'fixture-write', toolName: 'write_workspace', input: JSON.stringify({ path: 'fixture.json', content: '{"fixture":true}\n' }) }],
      usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'fixture' } };
  } });
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'runtime'), model });
  const release = deferred(); const entered = deferred(); let toolFinishedAt = 0; let cancelFinishedAt = 0;
  let cancellation: Promise<unknown> | undefined;
  try {
    const item = await engine.createCase({ title: 'Explicit execution fixture', objective: 'Native tool cancellation ordering', domain: 'fixture' });
    const grant = await engine.prepareWorkspace({ caseId: item.id, repoRoot: repo, allowedFiles: ['fixture.json'] });
    const original = engine.workspace.write.bind(engine.workspace);
    engine.workspace.write = async (...args) => { entered.resolve(); await release.promise; const result = await original(...args); toolFinishedAt = Date.now(); return result; };
    const task = await engine.requestTask({ requestId: 'owner-drain-fixture', spec: { caseId: item.id, title: 'Change the approved fixture value',
      objective: 'Exercise a native write cancellation barrier', expectedOutput: 'The approved fixture JSON change', capabilities: ['workspace'],
      workspace: { revision: grant.revision, files: [...grant.allowedFiles] } } });
    assert.equal(task.state, 'approved'); assert.equal(calls, 0, 'The stopped runtime does not infer when owner consent is saved');
    await store.updateSettings({ enabled: true, maxStepsPerRun: 3 }); engine.start();
    await waitFor(entered.promise, 'Approved native write did not start');
    const runningTask = engine.consent.get(task.id)!;
    cancellation = (cancellationMode === 'case' ? engine.cancelCase(item.id) : engine.revokeTask(task.id, runningTask.revision)).then(() => { cancelFinishedAt = Date.now(); });
    await delay(100);
    assert.equal(cancelFinishedAt, 0, 'Cancel cannot acknowledge while the native write can still commit');
    assert.equal(readFileSync(join(grant.worktreePath, 'fixture.json'), 'utf8'), '{"fixture":false}\n');
    release.resolve(); await cancellation;
    assert.ok(toolFinishedAt > 0 && toolFinishedAt <= cancelFinishedAt);
    assert.equal((await engine.getCase(item.id))?.status, cancellationMode === 'case' ? 'cancelled' : 'active');
    assert.equal(engine.consent.get(task.id)?.state, 'revoked');
    assert.equal(engine.inbox.get(task.executionEventId!)?.status, 'processed', 'A revoked attempt is consumed, never replayed as a fresh task');
    assert.equal(calls, 1); assert.equal(readFileSync(join(repo, 'fixture.json'), 'utf8'), '{"fixture":false}\n');
  } finally {
    release.resolve(); await cancellation; await engine.close(); store.close();
    await cleanup(directory, prefix, message => context.diagnostic(message));
  }
});

test('global stop drains growth method learning without granting deliverable or workspace capabilities', async context => {
  const prefix = join(tmpdir(), 'rae-growth-tool-drain-'); const directory = await mkdtemp(prefix);
  const evidence = '先用最小例子验证，再修改完整方案。'; let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    calls++; const names = options.tools?.map(tool => tool.name) ?? [];
    assert.ok(names.includes('learn_method')); assert.ok(!names.includes('write_workspace')); assert.ok(!names.includes('publish_artifact'));
    return { content: [{ type: 'tool-call', toolCallId: 'fixture-learn-method', toolName: 'learn_method',
      input: JSON.stringify({ key: 'fixture.method.small-example', value: '先用最小例子验证，再修改完整方案', evidenceExcerpt: evidence, scope: 'case' }) }],
      usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'fixture' } };
  } });
  const store = new Store(join(directory, 'store')); store.getApiKey = () => undefined;
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'runtime'), model });
  const release = deferred(); const entered = deferred(); let learnedAt = 0; let pausedAt = 0;
  let stopping: Promise<void> | undefined;
  try {
    const item = await engine.createCase({ title: 'Method learning fixture', objective: 'Internal learning cancellation ordering', domain: 'fixture' });
    const original = engine.personal.learnMethod.bind(engine.personal);
    engine.personal.learnMethod = async (...args) => { entered.resolve(); await release.promise; const learned = await original(...args); learnedAt = Date.now(); return learned; };
    await store.updateSettings({ enabled: true });
    const event = await engine.ingestOwnerMessage(`方法教导：${evidence}`, item.id); engine.start();
    await waitFor(entered.promise, 'Growth learning tool did not start');
    stopping = engine.stop().then(() => { pausedAt = Date.now(); });
    await delay(100);
    assert.equal(pausedAt, 0, 'Stop cannot acknowledge while internal method persistence can still finish');
    assert.equal((await engine.listPersonalMemory()).length, 0);
    release.resolve(); await stopping;
    assert.ok(learnedAt > 0 && learnedAt <= pausedAt);
    assert.equal(engine.inbox.get(event.id)?.status, 'failed', 'Learning already committed; resuming must not replay the original input'); assert.equal(engine.status().state, 'paused');
    assert.equal((await engine.listPersonalMemory())[0]?.subject, 'agent');
    assert.equal((await engine.listTasks()).length, 0); assert.equal(store.list('artifacts').length, 0);
    assert.equal(engine.inbox.list().some(value => value.kind === 'task.execute'), false); assert.equal(calls, 1);
  } finally {
    release.resolve(); await stopping; await engine.close(); store.close();
    await cleanup(directory, prefix, message => context.diagnostic(message));
  }
});
