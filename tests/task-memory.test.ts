import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CaseMemory } from '../server/v2/memory.js';
import { putSharedFact } from './support/shared-fact.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const answer = (text = 'LOCAL_FIXTURE_RESPONSE') => ({ content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const call = (toolName: string, input: unknown = {}) => ({ content: [{ type: 'tool-call' as const, toolCallId: 'fixture-tool', toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const prefix = join(tmpdir(), 'rae-task-memory-');
  const directory = await mkdtemp(prefix);
  const url = `file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`;
  return { url, async clean() {
    const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  } };
}

test('task histories retain requirement generations without entering scene conversation, observation or catalog', async () => {
  const f = await fixture(); let memory = new CaseMemory(f.url, 'fixture-owner');
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    prompts.push(JSON.stringify(options.prompt));
    return answer(prompts.length === 2 ? 'TASK_PRIVATE_RESULT' : 'SCENE_OR_TASK_REPLY');
  } });
  const base = { model, instructions: 'Local fixture only.', maxSteps: 1 };
  try {
    const scene = await memory.createCase({ title: '工作场景', objective: '保留长期关系', domain: 'work' });
    await memory.setWorking(scene.id, 'SCENE_PRIVATE_WORKING');
    await putSharedFact(memory, { key: 'working-method', value: 'APPLICABLE_PERSONAL_METHOD', domains: ['work'], evidenceIds: ['owner-teaching'] });
    await putSharedFact(memory, { key: 'unrelated-method', value: 'OTHER_DOMAIN_METHOD', domains: ['food'], evidenceIds: ['other-teaching'] });
    await memory.runCase({ ...base, caseId: scene.id, message: 'SCENE_HISTORY_BEFORE_TASK' });
    let observationCalls = 0;
    const native = (memory as unknown as { memory: { observeCase: (...args: unknown[]) => Promise<void> } }).memory;
    const originalObserve = native.observeCase;
    native.observeCase = async () => { observationCalls++; throw new Error('Task must not observe owner conversation'); };
    const execution = { taskId: 'approved-work', requirementsRevision: 1 };
    const first = await memory.runCase({ ...base, caseId: scene.id, message: 'TASK_PRIVATE_REQUEST', execution,
      observeOwnerConversation: true, maxSteps: 3 });
    native.observeCase = originalObserve;
    assert.equal(observationCalls, 0);
    assert.notEqual(first.threadId, scene.threadId);
    assert.match(prompts[1], /APPLICABLE_PERSONAL_METHOD/);
    assert.doesNotMatch(prompts[1], /SCENE_HISTORY_BEFORE_TASK|SCENE_PRIVATE_WORKING|OTHER_DOMAIN_METHOD/);
    const repeated = await memory.runCase({ ...base, caseId: scene.id, message: 'TASK_CONTINUE_SAME_REQUIREMENTS', execution });
    assert.equal(repeated.threadId, first.threadId);
    assert.match(prompts[2], /TASK_PRIVATE_REQUEST|TASK_PRIVATE_RESULT/);
    await memory.runCase({ ...base, caseId: scene.id, message: 'SCENE_FOREGROUND_CONTINUE' });
    assert.match(prompts[3], /SCENE_HISTORY_BEFORE_TASK/);
    assert.doesNotMatch(prompts[3], /TASK_PRIVATE_REQUEST|TASK_PRIVATE_RESULT|TASK_CONTINUE_SAME_REQUIREMENTS/);
    const changed = await memory.runCase({ ...base, caseId: scene.id, message: 'TASK_NEW_REQUIREMENTS',
      execution: { ...execution, requirementsRevision: 2 } });
    assert.notEqual(changed.threadId, first.threadId);
    assert.doesNotMatch(prompts[4], /TASK_PRIVATE_REQUEST|TASK_PRIVATE_RESULT|TASK_CONTINUE_SAME_REQUIREMENTS/);
    assert.deepEqual((await memory.listCases()).map(item => item.id), [scene.id]);
    assert.doesNotMatch(JSON.stringify(await memory.historyForObservation(scene.id)), /TASK_PRIVATE/);
    const oldSceneHistory = JSON.stringify(await memory.history(scene.id));
    assert.match(oldSceneHistory, /SCENE_HISTORY_BEFORE_TASK/);
    await memory.close(); memory = new CaseMemory(f.url, 'fixture-owner');
    assert.equal(JSON.stringify(await memory.history(scene.id)), oldSceneHistory);
    const exported = await memory.taskHistories(scene.id);
    assert.deepEqual(exported.map(item => item.requirementsRevision).sort(), [1, 2]);
    assert.match(JSON.stringify(exported.find(item => item.requirementsRevision === 1)), /TASK_PRIVATE_RESULT/);
    assert.doesNotMatch(JSON.stringify(exported.find(item => item.requirementsRevision === 2)), /TASK_PRIVATE_RESULT/);
    const reopened = await memory.runCase({ ...base, caseId: scene.id, message: 'TASK_RESUME_AFTER_REOPEN', execution });
    assert.equal(reopened.threadId, first.threadId);
    assert.match(prompts.at(-1)!, /TASK_PRIVATE_RESULT/);
    const otherScene = await memory.createCase({ title: '其他场景', objective: '', domain: 'work' });
    await assert.rejects(memory.runCase({ ...base, caseId: otherScene.id, message: 'Do not rebind task history', execution }), /绑定/);
    const stranger = new CaseMemory(f.url, 'different-owner');
    try { await assert.rejects(stranger.taskHistories(scene.id), /不属于/); }
    finally { await stranger.close(); }
  } finally { await memory.close(); await f.clean(); }
});

test('one task serializes its requirement generations while the same scene and another task remain responsive', { timeout: 20_000 }, async () => {
  const f = await fixture(); const memory = new CaseMemory(f.url, 'fixture-owner');
  const entered = deferred(); const release = deferred();
  let secondStartedBeforeFirstEnded = false; let firstEnded = false;
  const blocking = new MockLanguageModelV4({ doGenerate: async () => { entered.resolve(); await release.promise; firstEnded = true; return answer(); } });
  const second = new MockLanguageModelV4({ doGenerate: async () => { secondStartedBeforeFirstEnded ||= !firstEnded; return answer(); } });
  const fast = new MockLanguageModelV4({ doGenerate: async () => answer('RESPONSIVE') });
  let first: Promise<unknown> | undefined; let next: Promise<unknown> | undefined;
  try {
    const scene = await memory.createCase({ title: '并行场景', objective: '', domain: 'work' });
    const base = { caseId: scene.id, instructions: 'Local fixture.', maxSteps: 1 };
    first = memory.runCase({ ...base, model: blocking, message: 'BLOCKED_TASK', execution: { taskId: 'same-task', requirementsRevision: 1 } });
    await entered.promise;
    next = memory.runCase({ ...base, model: second, message: 'NEXT_REQUIREMENTS', execution: { taskId: 'same-task', requirementsRevision: 2 } });
    const [foreground, independent] = await Promise.all([
      memory.runCase({ ...base, model: fast, message: 'FOREGROUND_QUESTION' }),
      memory.runCase({ ...base, model: fast, message: 'INDEPENDENT_TASK', execution: { taskId: 'other-task', requirementsRevision: 1 } }),
    ]);
    assert.equal(foreground.text, 'RESPONSIVE'); assert.equal(independent.text, 'RESPONSIVE');
    assert.equal(firstEnded, false);
    release.resolve(); await Promise.all([first, next]);
    assert.equal(secondStartedBeforeFirstEnded, false);
  } finally { release.resolve(); await Promise.allSettled([first, next]); await memory.close(); await f.clean(); }
});

test('task replay rechecks scene source scope and preserves retired tool exchanges only for export', async () => {
  const f = await fixture(); const memory = new CaseMemory(f.url, 'fixture-owner');
  let allowed = true; const seenScopes: string[] = []; const prompts: string[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    prompts.push(JSON.stringify(options.prompt));
    if (prompts.length === 1) return call('read_event', { eventId: 'source-event' });
    return answer(prompts.length === 2 ? 'RETIRED_DERIVED_ANSWER' : 'CURRENT_ANSWER');
  } });
  const read = createTool({ id: 'read_event', description: 'Local event fixture.', inputSchema: z.object({ eventId: z.string() }),
    execute: async () => ({ eventId: 'source-event', content: 'RETIRED_TOOL_EVIDENCE' }) });
  try {
    const scene = await memory.createCase({ title: '资料范围', objective: '', domain: 'work' });
    memory.setSourceEvidenceFilter((caseId, eventId) => { seenScopes.push(caseId); return eventId !== 'source-event' || allowed; });
    const base = { caseId: scene.id, model, instructions: 'Local fixture.', maxSteps: 2,
      execution: { taskId: 'source-task', requirementsRevision: 1 } };
    await memory.runCase({ ...base, message: 'READ_SOURCE_FOR_TASK', tools: { read_event: read } });
    assert.match(prompts[1], /RETIRED_TOOL_EVIDENCE/);
    allowed = false;
    await memory.runCase({ ...base, message: 'CONTINUE_WITH_CURRENT_SCOPE' });
    assert.doesNotMatch(prompts.at(-1)!, /RETIRED_TOOL_EVIDENCE|RETIRED_DERIVED_ANSWER|READ_SOURCE_FOR_TASK/);
    assert.ok(seenScopes.length > 0); assert.ok(seenScopes.every(id => id === scene.id));
    assert.match(JSON.stringify(await memory.taskHistories(scene.id)), /RETIRED_TOOL_EVIDENCE/);
    assert.deepEqual(await memory.history(scene.id), []);
  } finally { await memory.close(); await f.clean(); }
});

test('closing drains an accepted task tool and rejects new runs before native storage closes', { timeout: 20_000 }, async () => {
  const f = await fixture(); let memory = new CaseMemory(f.url, 'fixture-owner');
  const entered = deferred(); const release = deferred(); let calls = 0; let closed = false;
  const model = new MockLanguageModelV4({ doGenerate: async () => ++calls === 1 ? call('persist_result') : answer('DRAINED_TASK_RESULT') });
  const tool = createTool({ id: 'persist_result', description: 'Gated native result.', inputSchema: z.object({}),
    execute: async () => { entered.resolve(); await release.promise; return { receipt: 'DRAINED_NATIVE_RECEIPT' }; } });
  let running: Promise<unknown> | undefined; let closing: Promise<void> | undefined;
  try {
    const scene = await memory.createCase({ title: '关闭排空', objective: '', domain: 'work' });
    const base = { caseId: scene.id, model, instructions: 'Local fixture.', maxSteps: 2 };
    running = memory.runCase({ ...base, message: 'ACCEPTED_TASK', tools: { persist_result: tool },
      execution: { taskId: 'draining-task', requirementsRevision: 1 } });
    await entered.promise;
    closing = memory.close().then(() => { closed = true; });
    await assert.rejects(memory.runCase({ ...base, message: 'LATE_FOREGROUND' }), /关闭/);
    assert.equal(closed, false);
    release.resolve(); await running; await closing;
    memory = new CaseMemory(f.url, 'fixture-owner');
    const histories = JSON.stringify(await memory.taskHistories(scene.id));
    assert.match(histories, /DRAINED_NATIVE_RECEIPT/); assert.match(histories, /DRAINED_TASK_RESULT/);
  } finally { release.resolve(); await Promise.allSettled([running, closing]); await memory.close(); await f.clean(); }
});
