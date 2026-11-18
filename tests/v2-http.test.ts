import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV4 } from 'ai/test';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { routeRuntime } from '../server/v2/http.js';
import type { RuntimeApi } from '../server/runtime.js';
import type { CaseRecord } from '../server/v2/memory.js';
import type { RuntimeView } from '../shared/runtime-view.js';
import { isSceneThemeId } from '../shared/scene-theme.js';

const execute = promisify(execFile);
test('scene creation accepts optional background, preserves history on edits, and first delegation uses the general scene', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rae-scene-http-'));
  const store = new Store(dataDir);
  let calls = 0;
  const runtime = await V2Coordinator.create(store, { dataDir,
    model: new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('Paused fixture'); } }) });
  try {
    const createInput = { title: '学习', objective: '', domain: 'personal', requestId: randomUUID() };
    const [created, replayed] = await Promise.all([
      routeRuntime(runtime, '/api/cases', 'POST', createInput),
      routeRuntime(runtime, '/api/cases', 'POST', createInput),
    ]);
    assert.equal(created.status, 201);
    const scene = created.body as CaseRecord;
    assert.equal((replayed.body as CaseRecord).id, scene.id);
    assert.ok(isSceneThemeId(scene.themeId));
    assert.equal((replayed.body as CaseRecord).themeId, scene.themeId);
    assert.equal((await runtime.listCases()).length, 1);
    const message = await runtime.ingestOwnerMessage('保留这段交流。', scene.id);
    await runtime.memory.setWorking(scene.id, '保留已讨论的进度。');
    const edited = await routeRuntime(runtime, `/api/cases/${scene.id}`, 'PATCH', { title: '阅读与学习', objective: '当前背景' });
    assert.equal((edited.body as CaseRecord).id, scene.id);
    await routeRuntime(runtime, `/api/cases/${scene.id}`, 'PATCH', { objective: '' });
    const afterEditRetry = await routeRuntime(runtime, '/api/cases', 'POST', createInput);
    assert.equal((afterEditRetry.body as CaseRecord).title, '阅读与学习');
    assert.equal((afterEditRetry.body as CaseRecord).themeId, scene.themeId);
    await assert.rejects(routeRuntime(runtime, '/api/cases', 'POST', { ...createInput, title: '另一场景' }), { status: 409 });
    assert.equal((await runtime.getCase(scene.id))?.objective, '');
    assert.equal(store.get('messages', message.externalId)?.caseId, scene.id);
    assert.equal((await runtime.getCaseDetails(scene.id)).working, '保留已讨论的进度。');

    const delegated = await routeRuntime(runtime, '/api/tasks', 'POST', { requestId: 'first-general-scene-task', spec: {
      caseId: 'personal-growth', title: '明确委托', objective: '准备一份合成说明', expectedOutput: '文本草稿', capabilities: ['artifact'],
    } });
    assert.equal(delegated.status, 201);
    assert.equal((await runtime.getCase('personal-growth'))?.domain, 'personal');
    assert.equal((await runtime.listTasks()).length, 1);
    assert.equal(runtime.status().state, 'paused');
    assert.equal(calls, 0);
  } finally { await runtime.close(); store.close(); }
});

test('a cancellation PATCH forwards title and objective together through the case write service', async () => {
  const item: CaseRecord = { id: 'case-patch', threadId: 'case-patch', title: 'old', objective: 'old objective', domain: 'test', themeId: 'sage', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let received: unknown; let earlyCancellationCalls = 0;
  const api = { getCase: async () => item,
    updateCase: async (_id: string, patch: Partial<CaseRecord>) => { received = patch; return { ...item, ...patch }; },
    cancelCase: async () => { earlyCancellationCalls++; return { ...item, status: 'cancelled' }; } } as unknown as RuntimeApi;
  const patch = { title: 'new title', objective: 'new objective', status: 'cancelled' };
  const response = await routeRuntime(api, '/api/v2/cases/case-patch', 'PATCH', patch);
  assert.deepEqual(received, patch); assert.equal(earlyCancellationCalls, 0);
  assert.equal((response.body as CaseRecord).title, patch.title); assert.equal((response.body as CaseRecord).objective, patch.objective);
  assert.equal((response.body as CaseRecord).status, 'cancelled');
});

test('owner HTTP -> scoped native memory -> real directory inbox -> verified Git handoff; paused inference stays off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-v2-http-'));
  const store = new Store(join(directory, 'data'));
  let modelCalls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('Paused inference must not run'); } });
  const engine = await V2Coordinator.create(store, { dataDir: join(directory, 'v2'), model });
  const app = createApp({ store, runtime: engine });
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const call = async <T = unknown>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: T }> => {
    const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const content = await response.text();
    assert.ok(content, `${method} ${path} must return its JSON result`);
    return { status: response.status, data: JSON.parse(content) as T };
  };
  try {
    store.setMeta('settings', { model: 'saved-model', apiBaseUrl: 'https://example.com/v1', enabled: false, dailyBudgetCny: 0.5 });
    store.insert('runs', { id: 'legacy-complete', trigger: 'manual', status: 'completed', startedAt: new Date().toISOString(),
      steps: 1, inputTokens: 50, outputTokens: 20, usageStatus: 'reported', ...{ costCny: 0.05, reservedCostCny: 0 } });
    store.insert('runs', { id: 'partial-usage', trigger: 'manual', status: 'interrupted', startedAt: new Date().toISOString(),
      steps: 1, inputTokens: 10, outputTokens: 0, usageStatus: 'partial' });
    const usageView = await call<RuntimeView>('/api/state');
    assert.equal(usageView.data.settings.model, 'saved-model'); assert.equal('dailyBudgetCny' in usageView.data.settings, false);
    assert.deepEqual(usageView.data.status.todayUsage, { inputTokens: 60, outputTokens: 20, usageStatus: 'partial' });
    assert.equal(usageView.data.status.state, 'paused');
    assert.equal(usageView.data.runs.some(run => 'costCny' in run || 'reservedCostCny' in run), false);
    assert.equal('costCny' in store.get('runs', 'legacy-complete')!, true, 'retiring the view must preserve historical records');
    const usageExport = await call<{ runs: RuntimeView['runs'] }>('/api/export');
    assert.equal(usageExport.data.runs.some(run => 'costCny' in run || 'reservedCostCny' in run), false);
    const ui = await call<{ id: string }>('/api/v2/cases', 'POST', { title: '界面配置', objective: '维护这一项目的配置', domain: 'ui' });
    const meal = await call<{ id: string }>('/api/v2/cases', 'POST', { title: '今日午餐', objective: '了解今天的饮食安排条件', domain: 'food' });
    assert.equal(ui.status, 201); assert.equal(meal.status, 201);
    const task = await call<{ id: string; revision: number; state: string }>('/api/tasks', 'POST', { requestId: 'paused-owner-fixture',
      spec: { caseId: ui.data.id, title: '暂停状态的本人委托', objective: '验证明确范围授权只保存，不启动模型', expectedOutput: '一份以后再准备的文本草稿', capabilities: ['artifact'] } });
    assert.equal(task.status, 201); assert.equal(task.data.state, 'approved');
    const duplicateTask = await call<{ id: string }>('/api/tasks', 'POST', { requestId: 'paused-owner-fixture',
      spec: { caseId: ui.data.id, title: '暂停状态的本人委托', objective: '验证明确范围授权只保存，不启动模型', expectedOutput: '一份以后再准备的文本草稿', capabilities: ['artifact'] } });
    assert.equal(duplicateTask.data.id, task.data.id);
    assert.equal((await call('/api/tasks', 'POST', { requestId: 'paused-owner-fixture',
      spec: { caseId: ui.data.id, title: '暂停状态的本人委托', objective: '验证明确范围授权只保存，不启动模型', expectedOutput: '更改已经确认的交付范围', capabilities: ['artifact'] } })).status, 409);
    assert.equal((await call(`/api/tasks/${task.data.id}/revoke`, 'POST', { revision: task.data.revision + 1 })).status, 409);
    assert.equal((await call('/api/tasks/missing-task/approve', 'POST', { revision: 1 })).status, 404);
    const revoked = await call<{ state: string }>(`/api/tasks/${task.data.id}/revoke`, 'POST', { revision: task.data.revision });
    assert.equal(revoked.status, 200); assert.equal(revoked.data.state, 'revoked'); assert.equal(modelCalls, 0);
    await engine.memory.setWorking(ui.data.id, 'UI_ONLY_CANARY');
    await engine.memory.setWorking(meal.data.id, 'FOOD_ONLY_CANARY');
    await call('/api/v2/shared-facts', 'POST', { key: 'food-example', value: '仅食物事项可见', domains: ['food'], evidenceIds: ['fixture-owner-statement'] });
    const uiView = await call<{ working: string; shared: unknown[] }>(`/api/v2/cases/${ui.data.id}`);
    const mealView = await call<{ working: string; shared: unknown[] }>(`/api/v2/cases/${meal.data.id}`);
    assert.equal(uiView.data.working, 'UI_ONLY_CANARY'); assert.equal(uiView.data.shared.length, 0);
    assert.equal(mealView.data.working, 'FOOD_ONLY_CANARY'); assert.equal(mealView.data.shared.length, 1);
    const watched = join(directory, 'watched'); await mkdir(watched);
    await writeFile(join(watched, 'brief.md'), '第一版资料', 'utf8');
    const connection = await call('/api/v2/sources/workspace', 'POST', { sourceId: 'workspace-fixture', root: watched, caseId: ui.data.id });
    assert.equal(connection.status, 201);
    await writeFile(join(watched, 'brief.md'), '第二版资料', 'utf8');
    const end = Date.now() + 5_000;
    while (engine.inbox.list().filter(event => event.sourceId === 'workspace-fixture').length < 2 && Date.now() < end) await delay(25);
    const fileEvents = engine.inbox.list().filter(event => event.sourceId === 'workspace-fixture');
    assert.equal(fileEvents.length, 2); assert.equal(fileEvents[1].operation, 'update');
    assert.equal(fileEvents[1].actor, 'external');
    const message = await call('/api/messages', 'POST', { content: '这条背景只属于界面事项。', caseId: ui.data.id });
    assert.equal(message.status, 202);
    assert.ok(engine.inbox.list().some(event => event.kind === 'owner.message' && event.caseId === ui.data.id));
    assert.equal(modelCalls, 0); assert.equal(engine.status().state, 'paused');
    const exported = await call<{ version: number; caseDetails: unknown[] }>('/api/export');
    assert.equal(exported.data.version, 3); assert.equal(exported.data.caseDetails.length, 2);
    assert.equal((await call('/api/messages', 'POST', { content: 'bad', caseId: 'missing-case' })).status, 404);
    assert.equal((await call(`/api/v2/cases/${ui.data.id}`, 'PATCH', { status: 'completed' })).status, 400);

    const repo = join(directory, 'repo'); await mkdir(repo);
    await execute('git', ['init', repo], { windowsHide: true });
    await writeFile(join(repo, 'config.json'), '{"layout":"dense","keep":true}\n', 'utf8');
    await execute('git', ['-C', repo, 'add', 'config.json'], { windowsHide: true });
    await execute('git', ['-C', repo, '-c', 'user.name=Rae Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '-m', 'fixture baseline'], { windowsHide: true });
    const prepared = await call<{ revision: number; allowedFiles: string[] }>('/api/v2/workspaces', 'POST', { caseId: ui.data.id, repoRoot: repo, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['layout'], equals: 'quiet' }] });
    assert.equal(prepared.status, 201);
    const fileTaskInput = { requestId: 'paused-exact-files-fixture', spec: { caseId: ui.data.id, title: '只处理本人列出的文件', objective: '验证任务许可与文件许可的精确交集', expectedOutput: 'config.json的核验回执', capabilities: ['workspace'],
      workspace: { revision: prepared.data.revision, files: prepared.data.allowedFiles } } };
    assert.equal((await call('/api/tasks', 'POST', { ...fileTaskInput, spec: { ...fileTaskInput.spec, workspace: { revision: prepared.data.revision + 1, files: ['config.json'] } } })).status, 409);
    assert.equal((await call('/api/tasks', 'POST', { ...fileTaskInput, spec: { ...fileTaskInput.spec, workspace: { revision: prepared.data.revision, files: ['elsewhere.json'] } } })).status, 409);
    const fileTask = await call<{ id: string; revision: number; spec: { workspace: { files: string[] } } }>('/api/tasks', 'POST', fileTaskInput);
    assert.equal(fileTask.status, 201); assert.deepEqual(fileTask.data.spec.workspace.files, ['config.json']);
    assert.equal((await call(`/api/tasks/${fileTask.data.id}/revoke`, 'POST', { revision: fileTask.data.revision })).status, 200); assert.equal(modelCalls, 0);
    const original = await engine.workspace.read(ui.data.id, 'config.json');
    await engine.workspace.write(ui.data.id, 'config.json', '{"layout":"quiet","keep":true}\n', original.sha256);
    const receipt = await engine.workspace.verify(ui.data.id);
    assert.equal(receipt.status, 'verified'); assert.match(receipt.patch, /quiet/);
    const handoff = await call<{ status: string; receipt: { fileHashes: unknown } }>(`/api/v2/workspaces/${ui.data.id}/handoff`);
    assert.equal(handoff.status, 200); assert.equal(handoff.data.status, 'verified');
    assert.equal(JSON.parse(await readFile(join(repo, 'config.json'), 'utf8')).layout, 'dense');
    assert.equal((await call(`/api/v2/workspaces/${ui.data.id}`, 'DELETE')).status, 200);
    await assert.rejects(engine.workspace.write(ui.data.id, 'config.json', '{}'));
    assert.equal((await call(`/api/v2/cases/${meal.data.id}`, 'PATCH', { title: '暂不安排午餐', objective: '保留用户更正后取消事项', status: 'cancelled' })).status, 200);
    const cancelledMeal = await engine.memory.getCase(meal.data.id);
    assert.equal(cancelledMeal?.status, 'cancelled'); assert.equal(cancelledMeal?.title, '暂不安排午餐'); assert.equal(cancelledMeal?.objective, '保留用户更正后取消事项');
    assert.equal((await call('/api/v2/sources/workspace-fixture', 'DELETE')).status, 200);
    assert.equal(modelCalls, 0);
  } finally {
    app.closeAllConnections(); await new Promise<void>(done => app.close(() => done()));
    await engine.close(); store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
