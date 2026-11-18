import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeView, RuntimeRun, RuntimeMessage } from '../shared/runtime-view.js';
import type { RunProgressOperation } from '../shared/run-progress.js';
import { assistantProgressRun, ownerProgressRuns, pendingOwnerEvent, progressForRun, progressDuration, taskProgressRuns } from '../client/lib/run-progress.js';
import { RunProgress, QueuedRunProgress } from '../client/components/RunProgress.js';
import { projectProgressText } from '../client/lib/local-project.js';

const assets = registerHooks({ load(url, context, nextLoad) {
  if (/\/client\/assets\/tenon-mark\.svg$/.test(url)) return { format: 'module', source: 'export default "fixture-brand.svg";', shortCircuit: true };
  return nextLoad(url, context);
} });
const { Conversation } = await import('../client/components/Conversation.js'); assets.deregister();

const start = '2026-11-10T03:00:00.000Z'; const now = Date.parse(start) + 20_000;
const connection = { state: 'connected' as const, lastHeartbeatAt: now };
const owner = (id = 'owner-one', caseId = 'scene'): RuntimeMessage => ({ id, caseId, role: 'user', content: 'OWNER_PUBLIC_QUESTION', createdAt: start });
function execution(id = 'run-one', changes: Partial<RuntimeRun> = {}): RuntimeRun {
  return { id, caseId: 'scene', eventId: 'event-one', mode: 'growth', trigger: 'chat', status: 'running', startedAt: start,
    steps: 1, inputTokens: 0, outputTokens: 0, progress: { phase: 'model', phaseStartedAt: start, lastActivityAt: start, operations: [] }, ...changes };
}
function view(): RuntimeView {
  return { runtime: 'mastra', schemaVersion: 3,
    settings: { agentName: '榫', ownerName: '', mission: 'Fixture', model: 'fixture', apiBaseUrl: 'https://example.invalid/v1', apiKeyConfigured: true,
      enabled: true, reasoningEffort: 'auto', maxOutputTokens: null, maxOutputContinuations: 1, maxStepsPerRun: 4, timezone: 'Asia/Shanghai' },
    status: { state: 'working', nextWakeAt: null, lastRunAt: start, lastError: null, pending: true, todayUsage: { inputTokens: 0, outputTokens: 0, usageStatus: 'reported' } },
    cases: [{ id: 'scene', threadId: 'scene', title: '当前场景', objective: '', domain: 'fixture', status: 'active', createdAt: start, updatedAt: start }],
    tasks: [], messages: [owner()], understanding: [], sources: [], workspaceSources: [], artifacts: [], feedback: [], grants: [],
    runs: [execution()], events: [{ id: 'event-one', sourceId: 'owner-chat', kind: 'owner.message', operation: 'create', status: 'leased',
      occurredAt: start, caseId: 'scene', messageId: 'owner-one', attempts: 1, lastError: null }],
    history: { runs: { items: [], nextBefore: null }, events: { items: [], nextBefore: null } },
    conversation: { caseId: 'scene', before: null, beforeCreatedAt: null, nextBefore: null }, casePreviews: {},
    archive: { readOnly: true, counts: { memories: 0, initiatives: 0, activities: 0 } } };
}
const operation = (id: string, status: RunProgressOperation['status'] = 'running'): RunProgressOperation => ({ id, label: '查询 GitHub 账号', status, startedAt: start });
const render = (run: RuntimeRun, expanded = false) => renderToStaticMarkup(createElement(RunProgress, { run, timezone: 'Asia/Shanghai', connection, now, expanded }));
const renderConversation = (runtime: RuntimeView) => renderToStaticMarkup(createElement(Conversation, { runtime, connection, caseId: 'scene', reply: null,
  busy: [], perform: async () => true, onBrowse() {},
  onOpenPanel() {}, onReply() {}, onCancelReply() {}, onSent() {} }));

test('owner progress binds the exact message/event and rejects source, timer, task, connection and other-scene runs', () => {
  const runtime = view();
  runtime.runs.push(execution('source', { trigger: 'source' }), execution('timer', { trigger: 'timer' }),
    execution('task', { mode: 'execution', taskId: 'task-one' }), execution('connection', { mode: 'connection' }), execution('other-scene', { caseId: 'elsewhere' }),
    execution('unrelated-owner', { eventId: 'event-other' }));
  assert.deepEqual(ownerProgressRuns(runtime, owner()).map(run => run.id), ['run-one']);
  assert.deepEqual(ownerProgressRuns(runtime, { ...owner(), role: 'assistant' }), []);
  runtime.messages.push({ id: 'source-reply', caseId: 'scene', role: 'assistant', content: 'Background reply', createdAt: start, replyTo: 'owner-one', runId: 'source' });
  assert.equal(assistantProgressRun(runtime, runtime.messages[1]), undefined);
});

test('parallel owner messages and task progress remain separate, including their older requirement runs', () => {
  const runtime = view(); runtime.messages.push(owner('owner-two'));
  runtime.events.push({ ...runtime.events[0], id: 'event-two', messageId: 'owner-two' });
  runtime.runs.push(execution('run-two', { eventId: 'event-two' }));
  assert.deepEqual(ownerProgressRuns(runtime, owner()).map(run => run.id), ['run-one']);
  assert.deepEqual(ownerProgressRuns(runtime, owner('owner-two')).map(run => run.id), ['run-two']);
  const task: RuntimeView['tasks'][number] = { id: 'task-one', revision: 2, requirementsRevision: 2, state: 'running', createdAt: start, updatedAt: start,
    spec: { caseId: 'scene', title: 'Task fixture', objective: '', expectedOutput: '', capabilities: ['artifact'] } };
  runtime.runs.push(execution('task-old', { taskId: task.id, mode: 'execution', status: 'interrupted', taskExecution: { requirementsRevision: 1, deadline: null, stepLimit: 4 } }),
    execution('task-new', { taskId: task.id, mode: 'execution', taskExecution: { requirementsRevision: 2, deadline: null, stepLimit: 4 } }),
    execution('wrong-task-scene', { taskId: task.id, mode: 'execution', caseId: 'elsewhere' }));
  assert.deepEqual(taskProgressRuns(runtime.runs, task).map(run => run.id).sort(), ['task-new', 'task-old']);
});

test('queued messages show receipt only while awaiting their own run and never borrow a background activity', () => {
  const runtime = view(); runtime.runs = [execution('background', { trigger: 'source' })]; runtime.events[0].status = 'pending';
  assert.equal(pendingOwnerEvent(runtime, owner())?.id, 'event-one');
  runtime.runs.push(execution()); assert.equal(pendingOwnerEvent(runtime, owner()), undefined);
  runtime.runs[1] = execution('run-one', { status: 'failed' }); assert.ok(pendingOwnerEvent(runtime, owner()));
  runtime.runs[1] = execution('run-one', { status: 'completed' }); assert.equal(pendingOwnerEvent(runtime, owner()), undefined);
  assert.match(renderToStaticMarkup(createElement(QueuedRunProgress, { enabled: true, connection })), /已收到，等待开始/);
});

test('fresh transport heartbeats do not turn a long silent model or tool wait into activity', () => {
  const late = Date.parse(start) + 70_000;
  const model = progressForRun(execution(), { state: 'connected', lastHeartbeatAt: late }, late)!;
  assert.equal(model.waitingLonger, true); assert.equal(model.reconnecting, false); assert.equal(model.headline, '等待模型响应较久');
  const tool = execution('tool', { progress: { phase: 'tool', phaseStartedAt: start, lastActivityAt: start, operations: [operation('op')] } });
  assert.equal(progressForRun(tool, { state: 'connected', lastHeartbeatAt: late }, late)?.headline, '查询 GitHub 账号 · 等待较久');
  const parallel = { ...tool, progress: { ...tool.progress!, operations: [operation('first'), { ...operation('second'), label: '读取仓库资料' }] } };
  assert.equal(progressForRun(parallel, { state: 'connected', lastHeartbeatAt: late }, late)?.headline, '2 项操作等待较久');
  assert.equal(progressForRun(tool, { state: 'reconnecting', lastHeartbeatAt: late }, late)?.headline, '连接恢复中，最新进度待同步');
  assert.equal(progressForRun(tool, { state: 'connected', lastHeartbeatAt: Date.parse(start) }, late)?.reconnecting, true);
  assert.equal(progressForRun({ ...tool, progress: { ...tool.progress!, lastActivityAt: new Date(late).toISOString() } }, connection, late)?.waitingLonger, false);
});

test('terminal progress keeps truthful fixed durations and legacy runs never invent tool or model stages', () => {
  const done = execution('done', { status: 'completed', endedAt: '2026-11-10T03:00:15.000Z', progress: { phase: 'settling', phaseStartedAt: start,
    lastActivityAt: start, operations: [{ ...operation('op', 'succeeded'), endedAt: '2026-11-10T03:00:10.000Z', summary: '已确认账号' }] } });
  assert.equal(progressForRun(done, { state: 'reconnecting' }, now + 3600000)?.elapsed, '15 秒');
  assert.equal(progressForRun(done, connection, now)?.headline, '本轮已结束');
  const stale = { ...done, progress: { ...done.progress!, operations: [operation('unfinished')] } };
  assert.equal(progressForRun(stale, connection, now)?.operations[0].status, 'unknown');
  assert.match(render(stale, true), /结果待核对/); assert.doesNotMatch(render(stale, true), /进行中/);
  assert.equal(progressDuration(start, undefined, now, false), undefined);
  assert.equal(render(execution('legacy', { status: 'completed', progress: undefined })), '');
  const legacy = render(execution('legacy', { progress: undefined })); assert.match(legacy, /暂无详细进度记录/); assert.doesNotMatch(legacy, /<details|等待模型|查询 GitHub/);
});

test('progress is a closed native details by default, stays explicitly open at completion, and never streams aria announcements', () => {
  const run = execution('private-run-id', { progress: { phase: 'tool', phaseStartedAt: start, lastActivityAt: start,
    operations: [{ ...operation('private-op-id'), summary: '已取得账号信息', args: 'PRIVATE_RAW_ARGS', result: 'PRIVATE_RAW_RESULT', reasoning: 'PRIVATE_THINKING' } as RunProgressOperation] },
    error: 'PRIVATE_EXCEPTION', reasoning: { policy: 'auto', effort: 'high', reason: 'PRIVATE_INTERNAL_REASON', policyVersion: 1 } });
  const closed = render(run); assert.match(closed, /<details class="run-progress"/); assert.doesNotMatch(closed, /<details[^>]*\sopen(?:=|>)/);
  assert.match(closed, /查询 GitHub 账号/); assert.match(closed, /进行中/); assert.match(closed, /已取得账号信息/);
  assert.doesNotMatch(closed, /PRIVATE_|private-run-id|private-op-id|aria-live|role="status"|role="timer"/);
  assert.match(render(run, true), /<details[^>]*\sopen=/);
  assert.match(render({ ...run, status: 'completed', endedAt: '2026-11-10T03:00:15.000Z' }, true), /<details[^>]*\sopen=/);
});

test('operation history initially shows recent entries and a display-only reveal control without dropping recorded data', () => {
  const operations = Array.from({ length: 20 }, (_, index) => ({ ...operation(`op-${index}`, 'succeeded'), label: `实际操作 ${index}` }));
  const run = execution('many', { status: 'completed', endedAt: '2026-11-10T03:00:15.000Z', progress: { phase: 'settling', phaseStartedAt: start, lastActivityAt: start, operations } });
  const html = render(run, true);
  assert.match(html, /还有 14 项/); assert.match(html, /实际操作 19/); assert.doesNotMatch(html, /实际操作 0</);
  assert.equal(progressForRun(run, connection, now)?.operations.length, 20); assert.equal(run.progress?.operations.length, 20);
});

test('project progress shows the latest public sentence or current tool category without exposing commands', () => {
  const at = '2026-11-16T12:00:00.000Z';
  const text = '已经检查输入。正在核对项目结果。\n\n```sh\nprivate-command\n```';
  const completedTool = { id: 'command', type: 'commandExecution', state: 'succeeded', label: 'private-command' } as const;
  const runningTool = { ...completedTool, state: 'running' } as const;
  assert.equal(projectProgressText({ state: 'running', tools: [completedTool] }, text), '正在处理项目 · 正在核对项目结果。');
  const longCode = `正在核对项目结果。\n~~~sh\n${'private-command\n'.repeat(150)}`;
  assert.equal(projectProgressText({ state: 'running', tools: [] }, longCode), '正在处理项目 · 正在核对项目结果。');
  assert.equal(projectProgressText({ state: 'running', tools: [runningTool] }, text), '正在执行本机命令');
  assert.equal(projectProgressText({ state: 'running', tools: [runningTool] }, text, connection, true), '正在执行服务器命令');
  assert.equal(projectProgressText({ state: 'waiting', tools: [runningTool] }, text), '等待继续');
  assert.equal(projectProgressText({ state: 'completed', tools: [runningTool] }, text), '执行结束');
  assert.equal(projectProgressText({ state: 'running', tools: [runningTool] }, text, { state: 'reconnecting' }), '连接恢复中，最新进度待同步');
  assert.equal(projectProgressText({ state: 'running', tools: [completedTool], activity: { kind: 'tool', at } }, '现在开始写入'), '最近操作已返回，正在继续');
  assert.equal(projectProgressText({ state: 'running', tools: [], activity: { kind: 'diff', at } }, '现在开始写入'), '文件已变更，等待后续操作');
  assert.equal(projectProgressText({ state: 'running', tools: [], activity: { kind: 'verification', at } }, '现在开始写入'), '成果检查已记录，正在收尾');
  assert.equal(projectProgressText({ state: 'running', tools: [], activity: { kind: 'model_transport', at },
    modelTransport: { requestId: 'one', state: 'receiving', bytes: 100, at } }, '现在开始写入'), '正在接收模型响应');
});

test('Conversation keeps its streaming text first and binds progress, queueing and retries to their owner', t => {
  t.mock.method(Date, 'now', () => now);
  const runtime = view();
  runtime.messages.push({ id: 'reply-one', role: 'assistant', caseId: 'scene', runId: 'run-one', replyTo: 'owner-one', content: 'ASSISTANT_PUBLIC_ANSWER',
    outputState: 'streaming', createdAt: '2026-11-10T03:00:01.000Z' });
  let html = renderConversation(runtime);
  assert.equal((html.match(/<details class="run-progress"/g) ?? []).length, 1);
  assert.ok(html.indexOf('<details class="run-progress"') > html.indexOf('ASSISTANT_PUBLIC_ANSWER'));
  assert.doesNotMatch(html, /正在思考…|正在生成…|已收到，等待开始/);
  runtime.runs[0] = execution('run-one', { status: 'failed', endedAt: '2026-11-10T03:00:05.000Z' });
  runtime.messages[1].outputState = 'incomplete'; runtime.runs.push(execution('retry', { startedAt: '2026-11-10T03:00:10.000Z' }));
  html = renderConversation(runtime);
  assert.equal((html.match(/<details class="run-progress"/g) ?? []).length, 2); assert.match(html, /本轮未完成/);
});

test('consecutive messages keep separate identities, one parent quote context and one set of run receipts', () => {
  const runtime = view();
  runtime.runs[0].evidenceEventIds = ['source-one', 'source-two'];
  for (const id of ['first', 'second', 'third', 'fourth']) runtime.messages.push({
    id, role: 'assistant', caseId: 'scene', runId: 'run-one', replyTo: 'owner-one', content: id, createdAt: start,
  });
  const html = renderConversation(runtime);
  for (const id of ['first', 'second', 'third', 'fourth']) assert.ok(html.includes(`data-message-id="${id}"`));
  assert.equal((html.match(/class="evidence-link|class="text-link evidence-link"/g) ?? []).length, 1);
  assert.equal((html.match(/<details class="run-progress"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="quoted-message"|class="message-author"|class="day-divider"|class="message-tools"><time/);
  runtime.messages[4].replyTo = 'elsewhere';
  assert.match(renderConversation(runtime), /class="quoted-message"/);
});

test('assistant-only history retains its associated progress and background work cannot appear as a foreground answer', t => {
  t.mock.method(Date, 'now', () => now);
  const runtime = view(); runtime.messages = [{ id: 'reply', role: 'assistant', caseId: 'scene', runId: 'run-one', replyTo: 'owner-one', content: 'OLDER_REPLY', createdAt: start }];
  runtime.runs[0] = execution('run-one', { status: 'completed', endedAt: '2026-11-10T03:00:15.000Z' });
  assert.ok(assistantProgressRun(runtime, runtime.messages[0]));
  assert.doesNotMatch(renderConversation(runtime), /<details class="run-progress"/);
  runtime.runs[0].progress!.operations.push(operation('lookup', 'succeeded'));
  assert.match(renderConversation(runtime), /本轮已结束/);
  runtime.runs[0] = execution('run-one', { trigger: 'timer' });
  assert.equal(assistantProgressRun(runtime, runtime.messages[0]), undefined); assert.doesNotMatch(renderConversation(runtime), /<details class="run-progress"|正在思考…/);
});

test('Conversation can stop only the selected scene reply and keeps the stop outcome before any reply text', () => {
  const runtime = view();
  runtime.runs.unshift(execution('background', { trigger: 'source' }), execution('other-scene', { caseId: 'elsewhere' }));
  const running = renderConversation(runtime);
  assert.match(running, /<button type="button"[^>]*aria-label="停止回复"/);
  assert.match(running, /<button type="submit"[^>]*aria-label="发送消息"/);

  runtime.events[0] = { ...runtime.events[0], status: 'failed', lastError: '已停止回复。' };
  runtime.runs[2].stopReason = 'owner_stopped';
  const draining = renderConversation(runtime);
  assert.match(draining, /<button type="button"[^>]*aria-label="正在停止回复"[^>]*disabled/);
  assert.doesNotMatch(draining, /重试这条/);

  runtime.runs[2] = execution('run-one', { status: 'interrupted', stopReason: 'owner_stopped', progress: undefined, endedAt: start });
  const stopped = renderConversation(runtime);
  assert.doesNotMatch(stopped, /aria-label="停止回复"|已收到，等待开始/);
  assert.equal((stopped.match(/已停止回复。/g) ?? []).length, 1);
  assert.match(stopped, /重试这条/);

  runtime.runs[2].progress = execution().progress;
  runtime.messages.push({ id: 'partial', role: 'assistant', caseId: 'scene', replyTo: 'owner-one', runId: 'run-one',
    content: '已经生成的正文', outputState: 'incomplete', outputNote: '已停止回复。', createdAt: start });
  const partial = renderConversation(runtime);
  assert.match(partial, /已经生成的正文/);
  assert.equal((partial.match(/已停止回复。/g) ?? []).length, 1);
});

test('Conversation keeps streaming tables inline and only creates reading entries for saved replies', () => {
  const runtime = view();
  const content = '结论保持可见。\n\n## 项目对比\n\n| 项目 | 运行位置 |\n| --- | --- |\n| A | 本地 |\n| B | 云端 |';
  runtime.messages.push({ id: 'table-reply', role: 'assistant', caseId: 'scene', runId: 'run-one', content,
    outputState: 'streaming', createdAt: start });
  const streaming = renderConversation(runtime);
  assert.match(streaming, /data-streaming="true"/);
  assert.match(streaming, /<table/);
  assert.doesNotMatch(streaming, /class="reading-entry"/);
  runtime.messages[1].outputState = 'complete';
  const complete = renderConversation(runtime);
  assert.match(complete, /结论保持可见/);
  assert.match(complete, /aria-label="展开阅读：项目对比"/);
  assert.match(complete, /<table/);
  assert.doesNotMatch(complete, /data-streaming="true"/);
  assert.equal(runtime.messages[1].content, content);
});
