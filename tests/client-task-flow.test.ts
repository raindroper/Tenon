import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskFlowDetails } from '../client/components/TaskFlowDetails.js';
import type { TaskRecord } from '../shared/task-consent.js';
import type { Perform } from '../client/api.js';
import { projectStageApproved, projectStageRejected, type TaskDependency } from '../shared/task-flow.js';

const at = '2026-11-16T00:00:00.000Z';
const perform: Perform = async () => true;
const root = (): TaskRecord => ({ id: 'task', revision: 2, state: 'running', createdAt: at, updatedAt: at,
  spec: { caseId: 'scene', title: '订单 P10', objective: '实现订单需求', expectedOutput: '代码和检查结果', capabilities: ['project'],
    project: { deviceId: 'device', root: 'D:\\project', readAccess: 'project', access: 'read-write', network: false, create: false } } });
const render = (task: TaskRecord, busyKeys: string[] = []) => renderToStaticMarkup(createElement(TaskFlowDetails, { task, perform, busy: false, busyKeys }));

test('one task shows exact mail consent, persistent questions and unresolved reply tracking without interpreting external markup', () => {
  const task = root();
  task.flow = { phase: 'waiting_approval', acceptance: { mode: 'owner', criteria: ['验证取消规则'] }, operations: [{ id: 'mail', role: 'clarification', state: 'proposed', revision: 1,
    requirementsRevision: 1, createdAt: at, spec: { caseId: 'scene', title: '确认邮件', objective: '询问接口', expectedOutput: '回执', capabilities: ['mail'],
      mail: { connectionId: 'ews', credentialRevision: 1, mode: 'send', to: ['backend@example.test'], cc: ['pm@example.test'], bcc: ['owner@example.test'],
        subject: 'P10 问题', body: '<script>external text</script>', attachments: [], protection: 'plaintext' } } }], dependencies: [{
    id: 'input', taskId: 'task', operationId: 'task', key: 'cancel', summary: '确认取消口径', requirementsRevision: 1, revision: 2, state: 'waiting',
    questions: [{ key: 'rule', question: '可以取消哪些订单？', blocks: '取消功能', options: [{ label: '未支付', description: '仅未支付订单' }, { label: '任意状态', description: '所有订单' }] }],
    answers: [], candidateEventIds: [], reviewedEventIds: [], mailOperationIds: ['mail'], createdAt: at, updatedAt: at, unresolved: { rule: '回复存在冲突' },
  }] };
  const html = render(task, ['task-operation:mail']);
  for (const content of ['backend@example.test', 'pm@example.test', 'owner@example.test', 'P10 问题', '批准发送这一封', '回复存在冲突', '未支付', '补充已知答案']) assert.ok(html.includes(content), content);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;external text/);
  assert.match(html, /disabled=""[^>]*>批准发送这一封/);
  task.flow.operations[0].state = 'completed';
  task.flow.operations[0].mailReceipt = { operationId: 'native-mail', state: 'submitted', updatedAt: at, replyTracking: false };
  assert.match(render(task), /不会仅凭主题自动继续/);
});

test('simple tasks gain no extra approval form, while manual acceptance requires an explicit owner action', () => {
  const task = root(); assert.equal(render(task), '');
  task.flow = { phase: 'awaiting_acceptance', operations: [], dependencies: [], acceptance: { mode: 'owner', criteria: ['验证实际订单列表'] } };
  const html = render(task);
  assert.match(html, /我已验证，通过验收/); assert.match(html, /验证实际订单列表/);
  assert.doesNotMatch(html, /批准发送/);
});

test('stage approval displays exact files and history and only the current snapshot offers approval buttons', () => {
  const task = root();
  const stage = (id: string, fingerprint: string): TaskDependency => ({ id, taskId: task.id, operationId: task.id,
    key: id, summary: 'Review stage', requirementsRevision: 1, revision: 1, state: 'waiting',
    stageReview: { stageId: 'input', index: 1, count: 2, title: '输入核对', fingerprint,
      files: [{ path: 'outputs/input.xlsx', size: 120, sha256: fingerprint, format: 'xlsx' }] },
    questions: [{ key: 'stage-decision', question: '是否通过', blocks: '下一阶段' }], answers: [],
    candidateEventIds: [], reviewedEventIds: [], mailOperationIds: [], createdAt: at, updatedAt: at });
  task.flow = { phase: 'waiting_input', acceptance: { mode: 'owner', criteria: [] },
    operations: [{ id: task.id, role: 'execution', spec: task.spec, state: 'running', revision: 1, requirementsRevision: 1, createdAt: at }],
    dependencies: [stage('old', 'a'.repeat(64)), stage('current', 'b'.repeat(64))] };
  const html = render(task);
  assert.match(html, /历史版本/); assert.match(html, /outputs\/input.xlsx/); assert.match(html, /SHA-256/);
  assert.ok(html.includes('b'.repeat(64)));
  assert.equal((html.match(new RegExp('>' + projectStageApproved + '</button>', 'g')) ?? []).length, 1);
  assert.equal((html.match(new RegExp('>' + projectStageRejected + '</button>', 'g')) ?? []).length, 1);
  assert.match(html, /查看阶段文件/); assert.doesNotMatch(html, /textarea/);
  task.flow.operations[0].requirementsRevision = 2;
  assert.doesNotMatch(render(task), new RegExp('>' + projectStageApproved + '</button>'));
});
