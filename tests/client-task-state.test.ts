import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { localProjectCapability } from '../shared/local-project.js';
import type { RuntimeView } from '../shared/runtime-view.js';
import type { Run } from '../shared/types.js';

// The app bundler normally resolves this asset; SSR tests need only its URL.
const assets = registerHooks({ load(url, context, nextLoad) {
  if (/\/client\/assets\/tenon-mark\.svg$/.test(url)) return { format: 'module', source: 'export default "fixture-brand.svg";', shortCircuit: true };
  return nextLoad(url, context);
} });
const { Conversation } = await import('../client/components/Conversation.js');
assets.deregister();

const timestamp = '2026-11-07T03:00:00.000Z';
function view(): RuntimeView {
  return { runtime: 'mastra', schemaVersion: 3,
    settings: { agentName: '榫', ownerName: '', mission: 'Fixture', model: 'fixture', apiBaseUrl: 'https://example.invalid/v1',
      apiKeyConfigured: false, enabled: true, reasoningEffort: 'auto', maxOutputTokens: null, maxOutputContinuations: 1,
      maxStepsPerRun: 4, timezone: 'Asia/Shanghai' },
    status: { state: 'working', nextWakeAt: null, lastRunAt: timestamp, lastError: null, pending: true,
      todayUsage: { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' } },
    cases: [{ id: 'scene', threadId: 'scene', title: '当前场景', objective: 'Fixture', domain: 'fixture', status: 'active', createdAt: timestamp, updatedAt: timestamp }],
    tasks: [{ id: 'task', revision: 3, requirementsRevision: 2, state: 'running', approvalRevision: 1,
      spec: { caseId: 'scene', title: '整理材料', objective: '保留原始目标', expectedOutput: '原始交付说明', capabilities: ['artifact'] },
      requirementUpdates: [{ revision: 2, sourceEventId: 'owner-update', content: '请单列尚未核实的事项。', createdAt: timestamp }],
      createdAt: timestamp, updatedAt: timestamp }],
    messages: [], understanding: [], sources: [], workspaceSources: [], artifacts: [], feedback: [], runs: [], events: [], grants: [],
    history: { runs: { items: [], nextBefore: null }, events: { items: [], nextBefore: null } },
    conversation: { caseId: 'scene', before: null, beforeCreatedAt: null, nextBefore: null }, casePreviews: {},
    archive: { readOnly: true, counts: { memories: 0, initiatives: 0, activities: 0 } } };
}
function execution(id: string, revision: number, startedAt = timestamp, status: Run['status'] = 'running'): Run {
  return { id, mode: 'execution', trigger: 'manual', taskId: 'task', caseId: 'scene', status, startedAt,
    steps: 0, inputTokens: 0, outputTokens: 0, taskExecution: { requirementsRevision: revision, deadline: Date.parse(timestamp) + 300000, stepLimit: 4 } };
}
function render(runtime: RuntimeView, caseId = 'scene') {
  return renderToStaticMarkup(createElement(Conversation, { runtime, caseId, reply: null, busy: [], perform: async () => true,
    onBrowse() {},
    onOpenPanel() {}, onReply() {}, onCancelReply() {}, onSent() {} }));
}

test('task cards preserve the original goal, show owner amendments and hide a stale-requirements artifact', () => {
  const runtime = view();
  runtime.runs = [execution('current', 2)];
  runtime.artifacts = [{ id: 'old-artifact', taskId: 'task', requirementsRevision: 1, title: 'Old result', content: 'Old requirements',
    format: 'markdown', status: 'prepared', createdAt: timestamp, caseId: 'scene' }];
  const original = structuredClone(runtime.tasks[0].spec);
  const html = render(runtime);
  assert.match(html, /原始交付要求：原始交付说明/);
  assert.match(html, /保留原始目标/);
  assert.match(html, /请单列尚未核实的事项/);
  assert.match(html, /后台执行，可继续交流/);
  assert.doesNotMatch(html, /允许这项任务|查看交付内容/);
  assert.doesNotMatch(html, /榫正在思考/);
  assert.deepEqual(runtime.tasks[0].spec, original);
  runtime.artifacts[0].requirementsRevision = 2;
  assert.match(render(runtime), /查看交付内容/);
});

test('a server project card discloses the saved resource scope before allowing this run', () => {
  const runtime = view();
  runtime.devices = [{ id: 'montreal', name: '服务器', platform: 'linux', online: true, capabilities: [localProjectCapability] }];
  const task = runtime.tasks[0];
  task.state = 'proposed';
  task.approvalRevision = undefined;
  task.spec.capabilities = ['project'];
  task.spec.project = { deviceId: 'montreal', root: 'task-temporary', access: 'read-write', readAccess: 'project', network: true, create: false,
    serverResources: { cpuMillis: 750, memoryMiB: 512, diskMiB: 96, maxProcesses: 54, workspaceRetention: 'until-task-ends', network: 'public' } };

  const html = render(runtime);
  assert.match(html, /<dt>执行位置<\/dt><dd>服务器<\/dd>/);
  assert.doesNotMatch(html, /aria-label="这段对话的执行设备"/);
  assert.match(html, /任务独立临时目录 · 读写/);
  assert.match(html, /允许访问公网/);
  assert.match(html, /0\.75 核/);
  assert.match(html, /512 MiB/);
  assert.match(html, /96 MiB/);
  assert.match(html, /进程上限<\/dt><dd>54/);
  assert.match(html, /临时目录保留至任务结束/);
  assert.match(html, /<button class="button button-primary">允许本次服务器执行/);
  assert.match(html, /取消并改用 Windows/);

  runtime.devices[0].online = false;
  const offline = render(runtime);
  assert.match(offline, /<button class="button button-primary" disabled="">允许本次服务器执行/);
  assert.match(offline, /服务器执行设备目前离线/);
});

test('GitHub scope and real receipts remain visible in the actual conversation after the task ends', () => {
  const runtime = view();
  runtime.tasks[0].state = 'completed';
  runtime.tasks[0].spec.capabilities = ['github'];
  runtime.tasks[0].spec.github = { connectionId: 'connection', repository: 'owner/repo', repositoryId: 123, credentialRevision: 1,
    operations: ['commit'], branch: 'codex/change', files: ['src/app.ts'], issueNumbers: [], pullRequestNumbers: [], issueFields: [], pullRequestFields: [] };
  runtime.tasks[0].githubReceipts = [{ operationId: 'operation', tool: 'push_files', state: 'submitted', updatedAt: timestamp,
    sha: 'b'.repeat(40), url: `https://github.com/owner/repo/commit/${'b'.repeat(40)}` }];
  const html = render(runtime);
  assert.match(html, /GitHub 任务范围和真实回执/);
  assert.match(html, /codex\/change/); assert.match(html, /src\/app.ts/);
  assert.match(html, /GitHub 已接受提交/);
  assert.match(html, /在 GitHub 查看实际结果/);
});

test('background activity uses the newest run of the current task requirements and never guesses a wait phase', () => {
  const runtime = view();
  runtime.runs = [execution('old-requirements', 1)];
  assert.doesNotMatch(render(runtime), /后台执行，可继续交流/);
  runtime.runs = [execution('old-current-attempt', 2), execution('latest-current-attempt', 2, '2026-11-07T03:01:00.000Z', 'failed')];
  const html = render(runtime);
  assert.doesNotMatch(html, /后台执行，可继续交流|等待设备|等待媒体/);
  runtime.runs.push(execution('unrelated-task', 2, '2026-11-07T03:02:00.000Z'));
  runtime.runs.at(-1)!.taskId = 'another-task';
  assert.doesNotMatch(render(runtime), /后台执行，可继续交流/);
});

test('foreground progress requires the real owner message/event and never uses an unrelated scene run', t => {
  t.mock.method(Date, 'now', () => Date.parse(timestamp) + 10_000);
  const runtime = view();
  runtime.runs = [execution('background', 2)];
  assert.doesNotMatch(render(runtime), /榫正在思考/);
  runtime.runs.push({ id: 'foreground', trigger: 'chat', mode: 'growth', caseId: 'scene', status: 'running', startedAt: timestamp,
    steps: 0, inputTokens: 0, outputTokens: 0, progress: { phase: 'model', phaseStartedAt: timestamp, lastActivityAt: timestamp, operations: [] } });
  assert.doesNotMatch(render(runtime), /<details class="run-progress"|榫正在思考/);
  runtime.messages = [{ id: 'owner-message', caseId: 'scene', role: 'user', content: 'Fixture question', createdAt: timestamp }];
  runtime.events = [{ id: 'owner-event', kind: 'owner.message', sourceId: 'owner-chat', operation: 'create', status: 'leased',
    occurredAt: timestamp, caseId: 'scene', messageId: 'owner-message', attempts: 1, lastError: null }];
  runtime.runs[1].eventId = 'owner-event';
  assert.match(render(runtime), /<details class="run-progress"/);
  assert.match(render(runtime), /正在等待模型响应/);
  assert.doesNotMatch(render(runtime), /榫正在思考/);
});

test('a continued task appears once between the surrounding messages without exposing private source identifiers', () => {
  const runtime = view();
  runtime.cases[0].title = '原来的工作场景';
  runtime.cases.push({ ...runtime.cases[0], id: 'continued', threadId: 'continued', title: '接着讨论' });
  runtime.tasks[0] = { ...runtime.tasks[0], state: 'completed', requirementsRevision: 3, createdAt: '2026-01-01T00:00:00.000Z',
    evidenceRefs: [{ eventId: 'PRIVATE_EVENT_ID', sourceId: 'PRIVATE_SOURCE_ID', sourceCaseId: 'PRIVATE_SOURCE_CASE', sourceGeneration: 'PRIVATE_GENERATION' },
      { eventId: 'OTHER_PRIVATE_EVENT', sourceId: 'OTHER_PRIVATE_SOURCE', sourceCaseId: 'OTHER_PRIVATE_CASE' }],
    requirementUpdates: [
      { revision: 2, caseId: 'continued', sourceEventId: 'PRIVATE_OWNER_EVENT', content: '在这里继续原任务。', createdAt: '2026-11-07T03:15:00.000Z' },
      { revision: 3, caseId: 'elsewhere', sourceEventId: 'ANOTHER_PRIVATE_EVENT', content: '之后补充的要求。', createdAt: '2026-11-07T04:30:00.000Z' },
    ] };
  runtime.messages = [
    { id: 'before', caseId: 'continued', role: 'user', content: 'BEFORE_CARD', createdAt: '2026-11-07T03:00:00.000Z' },
    { id: 'after', caseId: 'continued', role: 'assistant', content: 'AFTER_CARD', createdAt: '2026-11-07T03:30:00.000Z' },
  ];
  runtime.conversation = { caseId: 'continued', before: null, beforeCreatedAt: null, nextBefore: 'lower-page' };
  const html = render(runtime, 'continued');
  const cardIndex = html.indexOf('<h2>整理材料</h2>');
  assert.ok(cardIndex > html.indexOf('BEFORE_CARD')); assert.ok(cardIndex < html.indexOf('AFTER_CARD'));
  assert.equal(html.match(/<h2>整理材料<\/h2>/g)?.length, 1);
  assert.match(html, /任务归属：原来的工作场景/); assert.match(html, /来源资料 2 条 · 按原授权范围读取/);
  assert.doesNotMatch(html, /PRIVATE_EVENT_ID|PRIVATE_SOURCE_ID|PRIVATE_SOURCE_CASE|PRIVATE_GENERATION|PRIVATE_OWNER_EVENT|OTHER_PRIVATE_EVENT|ANOTHER_PRIVATE_EVENT/);
  assert.equal(runtime.tasks.length, 1); assert.equal(runtime.tasks[0].spec.caseId, 'scene');
  assert.doesNotMatch(render(runtime, 'unrelated'), /<h2>整理材料<\/h2>|来源资料 2 条/);

  runtime.messages[0].createdAt = '2026-11-07T03:15:00.000Z';
  assert.match(render(runtime, 'continued'), /<h2>整理材料<\/h2>/, 'The oldest visible message is an inclusive lower boundary');
  runtime.messages[0].createdAt = '2026-11-07T03:16:00.000Z';
  assert.doesNotMatch(render(runtime, 'continued'), /<h2>整理材料<\/h2>/, 'Cards outside the current page stay out of that page');
});

test('home task ordering and older task records keep their original conversation behavior', () => {
  const runtime = view();
  runtime.tasks[0] = { ...runtime.tasks[0], state: 'completed', requirementUpdates: undefined, requirementsRevision: undefined };
  runtime.messages = [
    { id: 'before', caseId: 'scene', role: 'user', content: 'HOME_BEFORE', createdAt: '2026-11-07T02:59:00.000Z' },
    { id: 'after', caseId: 'scene', role: 'assistant', content: 'HOME_AFTER', createdAt: '2026-11-07T03:01:00.000Z' },
  ];
  const html = render(runtime);
  assert.ok(html.indexOf('<h2>整理材料</h2>') > html.indexOf('HOME_BEFORE'));
  assert.ok(html.indexOf('<h2>整理材料</h2>') < html.indexOf('HOME_AFTER'));
  assert.doesNotMatch(html, /任务归属：|来源资料|你的补充要求/);
  assert.doesNotMatch(render(runtime, 'unrelated'), /<h2>整理材料<\/h2>/);
});
