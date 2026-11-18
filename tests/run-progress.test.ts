import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from '@ai-sdk/provider';
import type { Run } from '../shared/types.js';
import { Store } from '../server/store.js';
import { CaseMemory } from '../server/v2/memory.js';
import { RunProgressRecorder, interruptRunProgress, persistRunProgress, progressOutcome } from '../server/v2/run-progress.js';
import { MockLanguageModelV4 } from './support/model.js';

const run = (): Run => ({ id: 'progress-run', mode: 'growth', trigger: 'chat', status: 'running', startedAt: new Date().toISOString(), steps: 0, inputTokens: 0, outputTokens: 0 });
test('parallel native tool identities remain separate and a following real model dispatch clears tool phase', () => {
  const value = run(); let clock = 1000; const progress = new RunProgressRecorder(value, () => undefined, () => clock++);
  const first = progress.startTool('read_github_repository', 'call-one', { tool: 'get_me', input: { token: 'PRIVATE_ARGS' } });
  const second = progress.startTool('read_github_repository', 'call-two', { tool: 'search_repositories', input: { query: 'PRIVATE_QUERY' } });
  assert.notEqual(first, second); assert.equal(value.progress?.operations.length, 2); assert.equal(value.progress?.phase, 'tool');
  progress.endTool(first, { profile: 'PRIVATE_RESULT' }); assert.equal(value.progress?.phase, 'tool');
  assert.equal(value.progress?.operations[1].status, 'running'); progress.endTool(second, { items: [] });
  progress.activity({ phase: 'model' }); assert.equal(value.progress?.phase, 'model');
  assert.deepEqual(value.progress?.operations.map(operation => operation.label), ['查看GitHub账号', '搜索GitHub仓库']);
  assert.doesNotMatch(JSON.stringify(value.progress), /PRIVATE|call-one|call-two/); progress.dispose();
});

test('progress stores compact operations without a business call quota or raw input, result, error or reasoning fields', () => {
  const value = run(); const progress = new RunProgressRecorder(value, () => undefined);
  for (let index = 0; index < 150; index++) {
    const id = progress.startTool(index === 0 ? 'PRIVATE_TOOL_NAME' : 'web_search', `native-${index}`, { query: 'PRIVATE_ARGS', reasoning: 'PRIVATE_CHAIN' });
    progress.endTool(id, { content: 'PRIVATE_RESULT', reasoning: 'PRIVATE_CHAIN' });
  }
  progress.finish(); assert.equal(value.progress?.operations.length, 150);
  assert.doesNotMatch(JSON.stringify(value.progress), /PRIVATE/);
  assert(value.progress?.operations.every(operation => Object.keys(operation).every(key => ['id', 'label', 'status', 'startedAt', 'endedAt', 'summary'].includes(key))));
  progress.dispose();
});

test('unknown native writes stay unknown, definite rejection stays failed and only safe failure metadata is shown', () => {
  assert.equal(progressOutcome('github_push_files', undefined, Object.assign(new Error('PRIVATE_ERROR'), { outcomeUnknown: true })).status, 'unknown');
  assert.equal(progressOutcome('github_push_files', undefined, Object.assign(new Error('PRIVATE_ERROR'), { outcomeUnknown: false })).status, 'failed');
  assert.equal(progressOutcome('submit_mail_body', { state: 'unknown', error: 'PRIVATE_ERROR' }).status, 'unknown');
  assert.equal(progressOutcome('web_search', { status: 'unavailable', content: 'PRIVATE_RESPONSE' }).status, 'failed');
  assert.equal(progressOutcome('web_search', undefined, new DOMException('PRIVATE_TIMEOUT', 'TimeoutError')).summary, '请求超时');
  const api = new APICallError({ message: 'PRIVATE_BODY', url: 'https://private.invalid', requestBodyValues: {}, statusCode: 403 });
  assert.equal(progressOutcome('web_search', undefined, api).summary, '接口返回HTTP 403');
  assert.doesNotMatch(JSON.stringify(progressOutcome('web_search', undefined, api)), /PRIVATE|private.invalid/);
});

test('display-only getters and save failures cannot throw or expose their raw details', () => {
  const hostile = Object.create(null);
  for (const field of ['state', 'status', 'isError', 'validationErrors', 'name', 'outcomeUnknown']) Object.defineProperty(hostile, field, { get() { throw new Error('PRIVATE_GETTER'); } });
  assert.doesNotThrow(() => progressOutcome('web_search', hostile)); assert.doesNotThrow(() => progressOutcome('web_search', undefined, hostile));
  const value = run(); const progress = new RunProgressRecorder(value, () => { throw new Error('PRIVATE_SAVE_FAILURE'); });
  const id = progress.startTool('web_search', 'call', hostile); assert.doesNotThrow(() => progress.endTool(id, hostile));
  assert.doesNotThrow(() => progress.endOperation(id, 'failed', 'PRIVATE_SUMMARY')); progress.dispose();
  assert.doesNotMatch(JSON.stringify(value.progress), /PRIVATE/);
});

test('reply activity is persisted with throttling and flushing never invents a later activity time', () => {
  const value = run(); let clock = 1000; let saves = 0; const progress = new RunProgressRecorder(value, () => { saves++; }, () => clock);
  progress.activity({ phase: 'model' });
  for (let index = 0; index < 100; index++) { clock++; progress.activity({ phase: 'reply' }); }
  assert.equal(saves, 3); const receivedAt = value.progress!.lastActivityAt; clock += 10000;
  progress.dispose(); assert.equal(saves, 4); assert.equal(value.progress!.lastActivityAt, receivedAt);
});

test('a failed display write followed by terminal business save cannot resurrect a stale running Run on dispose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-progress-merge-')); const store = new Store(directory); const value = run(); store.insert('runs', value);
  const put = store.put.bind(store); let failNext = false;
  const progress = new RunProgressRecorder(value, () => { if (failNext) { failNext = false; throw new Error('display fault'); } persistRunProgress(store, value); });
  try {
    failNext = true; progress.finish();
    const endedAt = new Date().toISOString(); put('runs', { ...value, status: 'failed', endedAt, error: 'Real business failure', steps: 7, inputTokens: 37 });
    progress.dispose(); const saved = store.get('runs', value.id)!;
    assert.equal(saved.status, 'failed'); assert.equal(saved.endedAt, endedAt); assert.equal(saved.error, 'Real business failure');
    assert.equal(saved.steps, 7); assert.equal(saved.inputTokens, 37); assert.equal(saved.progress?.phase, 'settling');
  } finally { progress.dispose(); store.close(); }
});

test('saved unfinished display state becomes unknown after recovery without changing business state or replaying work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-progress-reopen-')); let store = new Store(directory); const value = run(); store.insert('runs', value);
  const progress = new RunProgressRecorder(value, () => persistRunProgress(store, value)); progress.startTool('web_search', 'saved-call'); progress.dispose(); store.close();
  store = new Store(directory);
  try { const saved = store.get('runs', value.id)!; const originalActivity = saved.progress?.lastActivityAt;
    interruptRunProgress(saved); store.put('runs', saved);
    assert.equal(saved.status, 'running'); assert.equal(saved.progress?.operations[0].status, 'unknown'); assert.equal(saved.progress?.phase, 'settling');
    assert.equal(saved.progress?.lastActivityAt, originalActivity);
  } finally { store.close(); }
});

test('a failing progress callback cannot change a real model result or expose the callback error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-progress-callback-')); const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`);
  try { const item = await memory.createCase({ title: 'Progress isolation', objective: 'Keep display independent', domain: 'fixture' });
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'The actual answer.' }],
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } }) });
    const result = await memory.runCase({ caseId: item.id, model, message: 'Fixture', instructions: 'Answer plainly', onProgress: () => { throw new Error('PRIVATE_PROGRESS_FAILURE'); } });
    assert.equal(result.text, 'The actual answer.');
  } finally { await memory.close(); }
});
