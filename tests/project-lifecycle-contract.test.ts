import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventInbox } from '../server/v2/events.js';
import { TaskConsent } from '../server/v2/consent.js';
import { ProjectBroker, projectInputForDevice, projectSpecHash } from '../server/devices/projects.js';
import { localProjectCapability, localProjectSpecSchema, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectCheckScope, projectContractCapability, projectContractV2Capability, projectDeliveryRequestSchema, projectDeliverySchema, projectPlanSchema,
  type ProjectFinalFile, type ProjectRequirement } from '../shared/project-contract.js';
import { projectStageApproved, projectStageRejected, projectStageReviewContent } from '../shared/task-flow.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(stageReview?: 'auto' | 'owner', network = false, finalFiles?: ProjectFinalFile[]) {
  const file = join(await mkdtemp(join(tmpdir(), 'rae-project-lifecycle-contract-')), 'events.sqlite');
  const inbox = new EventInbox(file);
  const consent = new TaskConsent({ file, inbox });
  const db = new DatabaseSync(file);
  const device = { id: 'device', name: 'Fixture', platform: 'win32' as const, online: true, grants: [],
    capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability], createdAt: new Date().toISOString() };
  let changes = 0;
  const broker = new ProjectBroker(db, { device: () => device, send() {}, changed() {}, assertActive() {}, result() { changes++; } });
  const spec = localProjectSpecSchema.parse({ deviceId: device.id, root: 'D:\\fixture', network });
  const task = consent.request({ caseId: 'case', title: 'Review actual files', objective: 'Check current project output',
    expectedOutput: 'Verified project output', capabilities: ['project'], project: spec,
    acceptance: { mode: 'delivery', criteria: ['Project check passes'], ...(stageReview ? { stageReview } : {}),
      ...(finalFiles ? { finalFiles } : {}) } }, 'owner-request');
  consent.begin(task.id, task.approvalRevision!);
  const requirements: ProjectRequirement[] = [{ id: 'initial', text: 'Project check passes', revision: 1 }];
  const input: ProjectExecutionInput = { operationId: 'operation', taskId: task.id, runId: 'run-one', approvalRevision: task.approvalRevision!, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: task.spec.title, objective: task.spec.objective, expectedOutput: task.spec.expectedOutput,
    ownerRequest: 'Check current project output', updates: [], model: { model: 'fixture', reasoningEffort: 'default', maxOutputTokens: null },
    stepLimit: null, deadline: null, issuedAt: new Date().toISOString(), contract: { version: 2, requirements, ...(finalFiles ? { finalFiles } : {}) } };
  const pending = broker.run(input, { signal: new AbortController().signal, guard() {}, onEvent() {}, async model() { throw new Error('Offline fixture'); }, async context() {} });
  const record = (event: ProjectEvent['event'], requirementsRevision = broker.get('operation')!.input.requirementsRevision) => {
    broker.record(device.id, { operationId: input.operationId, sequence: broker.get('operation')!.sequence + 1, requirementsRevision,
      at: new Date().toISOString(), event });
  };
  return { db, inbox, consent, broker, device, task, input, pending, record, get changes() { return changes; },
    close() { db.close(); consent.close(); inbox.close(); } };
}

function delivery(requirements: ProjectRequirement[], revision = 1, toolId = 'check-run') {
  const request = projectDeliveryRequestSchema.parse({ summary: 'Actual project check', outputs: [],
    checks: [{ id: 'check', requirementIds: requirements.map(requirement => requirement.id), criterion: 'Project check passes',
      required: true, command: { argv: ['node', 'check.cjs'] } }] });
  const check = request.checks[0];
  const plan = projectPlanSchema.parse({ objective: 'Check current project output', basis: [{ kind: 'owner', reference: 'fixture', detail: 'Owner task' }],
    method: 'Actual project check', environment: [], outputs: [], checks: [{ id: check.id, criterion: check.criterion, required: true, basis: 'owner', method: 'node check.cjs' }] });
  const planHash = hash(plan);
  return projectDeliverySchema.parse({ version: 2, request, plan, planHash, requirementsRevision: revision, missing: [],
    evidence: [{ id: check.id, requirementIds: check.requirementIds, toolId, definitionHash: hash({ outputs: request.outputs, check }),
      requirementsRevision: revision, files: [], command: check.command, assertions: check.assertions, status: 'passed', detail: 'Actual command succeeded' }],
    verification: { planHash, requirementsRevision: revision, files: [], checkedAt: new Date().toISOString(),
      checks: [{ id: check.id, status: 'passed', toolIds: [toolId], detail: 'Actual command succeeded', validator: 'node check.cjs' }] } });
}

test('new projects require v2 executors while historical v1 and unversioned inputs retain their captured protocol', async () => {
  const f = await fixture();
  try {
    assert.equal(f.consent.get(f.task.id)?.executionContractVersion, 2);
    const old = { ...f.device, capabilities: [localProjectCapability, projectContractCapability] };
    assert.throws(() => projectInputForDevice(f.input, old), /更新/);
    assert.throws(() => projectInputForDevice(f.input, { ...old, capabilities: [...old.capabilities, 'local_project_contract_v2'] }), /更新/);
    assert.equal(projectInputForDevice({ ...f.input, contract: { version: 1, criteria: [] } }, old).contract?.version, 1);
    assert.equal(projectInputForDevice({ ...f.input, contract: undefined }, old).contract, undefined);
    f.record({ kind: 'finished', state: 'failed', output: 'Fixture ends' }); await f.pending;
  } finally { f.close(); }
});

test('the broker retains partial check evidence while refusing a final result without the frozen file', async () => {
  const f = await fixture(undefined, false, [{ description: 'Final project workbook', format: 'xlsx' }]);
  try {
    const requirements = f.input.contract?.version === 2 ? f.input.contract.requirements : [];
    const partial = delivery(requirements);
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'projectCheck', label: 'Actual verification', state: 'succeeded', exitCode: 0 } });
    f.record({ kind: 'delivery', delivery: partial });
    assert.deepEqual(f.broker.get(f.input.operationId)?.delivery, partial);
    assert.throws(() => f.record({ kind: 'finished', state: 'completed', output: 'Only a partial check ran' }), /Final project workbook/);
    f.record({ kind: 'finished', state: 'failed', output: 'Fixture ends' });
    await f.pending;
  } finally { f.close(); }
});

test('v2 delivery binds a fresh check definition and rejects legacy or unrelated successful operation claims', async () => {
  const f = await fixture();
  try {
    const evidence = delivery(f.input.contract!.version === 2 ? f.input.contract!.requirements : []);
    assert.throws(() => f.record({ kind: 'plan', plan: evidence.plan, planHash: evidence.planHash }), /旧版/);
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'commandExecution', label: 'echo hello', state: 'succeeded', exitCode: 0 } });
    assert.throws(() => f.record({ kind: 'delivery', delivery: evidence }), /真实执行/);
    const genuine = delivery(f.input.contract!.version === 2 ? f.input.contract!.requirements : [], 1, 'genuine');
    f.record({ kind: 'tool', item: { id: 'genuine', type: 'projectCheck', label: 'Actual verification', state: 'succeeded', exitCode: 0 } });
    const forged = structuredClone(genuine); forged.evidence![0].definitionHash = 'a'.repeat(64);
    assert.throws(() => f.record({ kind: 'delivery', delivery: forged }), /检查定义/);
    f.record({ kind: 'delivery', delivery: genuine });
    const scoped = structuredClone(genuine);
    scoped.evidence![0].definitionVersion = 2;
    assert.throws(() => f.record({ kind: 'delivery', delivery: scoped }), /检查定义/);
    scoped.evidence![0].definitionHash = createHash('sha256').update(projectCheckScope(scoped.request, scoped.request.checks[0]).definition).digest('hex');
    f.record({ kind: 'delivery', delivery: scoped });
    f.record({ kind: 'environment', state: 'closed', terminals: [] });
    f.record({ kind: 'finished', state: 'completed', output: 'Actual checks saved' }); await f.pending;
    assert.equal(f.consent.projectCompletionProblem(f.task.id, 1), undefined);
  } finally { f.close(); }
});

test('a passed scoped receipt must include each helper and match the current helper fingerprint to finish', async () => {
  const f = await fixture();
  try {
    const requirements = f.input.contract?.version === 2 ? f.input.contract.requirements : [];
    const original = delivery(requirements);
    const received = structuredClone(original);
    const check = received.request.checks[0];
    check.assertions.push({ kind: 'json', path: 'audit.json', key: ['verified'], equals: true });
    const evidence = received.evidence[0];
    evidence.definitionVersion = 2;
    evidence.assertions = check.assertions;
    evidence.definitionHash = createHash('sha256').update(projectCheckScope(received.request, check).definition).digest('hex');
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'projectCheck', label: 'Read actual helper JSON', state: 'succeeded' } });
    assert.throws(() => f.record({ kind: 'delivery', delivery: received }), /检查定义/);
    const helper = { path: 'audit.json', format: 'file', publishedPath: 'temporary/audit.json', sha256: 'a'.repeat(64), size: 18 };
    evidence.dependencies = [helper];
    received.verification!.dependencies = [{ ...helper, path: 'unrequested.json' }];
    assert.throws(() => f.record({ kind: 'delivery', delivery: received }), /辅助验证文件未绑定/);
    received.verification!.dependencies = [{ ...helper, sha256: 'b'.repeat(64) }];
    f.record({ kind: 'delivery', delivery: received });
    assert.throws(() => f.record({ kind: 'finished', state: 'completed', output: 'Helper was modified' }), /实际验证记录/);
    received.verification!.dependencies = [helper];
    f.record({ kind: 'delivery', delivery: received });
    f.record({ kind: 'environment', state: 'closed', terminals: [] });
    f.record({ kind: 'finished', state: 'completed', output: 'Current helper was verified' }); await f.pending;
    assert.equal(f.consent.projectCompletionProblem(f.task.id, 1), undefined);
  } finally { f.close(); }
});

test('a late native tool result keeps the requirement revision under which the operation was accepted', async () => {
  const f = await fixture();
  try {
    f.record({ kind: 'tool', item: { id: 'old-check', type: 'commandExecution', label: 'Check first revision', state: 'running' } });
    f.broker.revise({ ...f.input, runId: 'run-two', requirementsRevision: 2, updates: [{ revision: 2, content: 'Use revised data' }] });
    assert.throws(() => f.record({ kind: 'tool', item: { id: 'old-check', type: 'commandExecution', label: 'Check first revision', state: 'succeeded', exitCode: 0 } }, 2), /版本 1/);
    f.record({ kind: 'tool', item: { id: 'old-check', type: 'commandExecution', label: 'Check first revision', state: 'succeeded', exitCode: 0 } }, 1);
    assert.equal(f.broker.toolsForRevision('operation', 2).length, 0);
    assert.equal(f.broker.toolsForRevision('operation', 1)[0].state, 'succeeded');
    f.record({ kind: 'finished', state: 'failed', output: 'Fixture ends' }); await f.pending;
  } finally { f.close(); }
});

test('model receipts bind accepted versions and restart preserves unknown usage without replay or rewriting history', async () => {
  const f = await fixture();
  try {
    const old = f.broker.get('operation')!;
    f.broker.beginModel(old, 'before-steer');
    f.broker.modelText('operation', 'before-steer', 'Original version output');
    f.broker.revise({ ...f.input, runId: 'run-two', requirementsRevision: 2, updates: [{ revision: 2, content: 'New requirement' }] });
    assert.throws(() => f.broker.beginModel(old, 'stale-request'), /要求或授权已变化/);
    f.broker.modelText('operation', 'before-steer', 'Late original version output');
    assert.equal(f.broker.receivedModelText('operation', 2), '');
    assert.equal(f.broker.receivedModelText('operation', 1), 'Late original version output');
    assert.throws(() => f.broker.recoverModelCalls(), /派发执行前/);
    f.record({ kind: 'finished', state: 'failed', output: 'Process is no longer running' }); await f.pending;
    f.broker.recoverModelCalls();
    const calls = f.broker.export().modelCalls;
    assert.equal(calls.length, 1); assert.equal(calls[0].requirementsRevision, 1); assert.equal(calls[0].runId, 'run-one');
    assert.equal(calls[0].state, 'unknown'); assert.equal(calls[0].usage.usageStatus, 'unknown');
    assert.equal(calls[0].publicText, 'Late original version output');
    assert.equal(f.broker.get('operation')!.modelCalls, 1);
    f.broker.recoverModelCalls(); assert.deepEqual(f.broker.export().modelCalls, calls);
  } finally { f.close(); }
});

test('normal and late completion both wait for pending inputs and accepted provider responses', async () => {
  const f = await fixture();
  try {
    const wait = f.consent.waitForInput(f.task.id, { key: 'missing-rule', summary: 'Need owner rule', questions: [{ key: 'rule', question: 'Which rule?', blocks: 'Finish' }] });
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'projectCheck', label: 'Actual verification', state: 'succeeded', exitCode: 0 } });
    const ready = delivery(f.input.contract!.version === 2 ? f.input.contract!.requirements : []);
    f.record({ kind: 'delivery', delivery: ready });
    f.broker.beginModel(f.broker.get('operation')!, 'accepted-model');
    f.record({ kind: 'environment', state: 'closed', terminals: [] });
    f.record({ kind: 'finished', state: 'completed', output: 'Device finished' }); await f.pending;
    assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /依赖/);
    const source = f.inbox.ingestProcessed({ sourceId: 'owner-task-action', externalId: 'answer', caseId: 'case', kind: 'owner.task_answer', actor: 'owner', operation: 'create',
      occurredAt: new Date().toISOString(), payload: { taskId: f.task.id, dependencyId: wait.id, revision: wait.revision, answers: { rule: 'Use the reviewed rule' } } });
    f.consent.answerDependency(wait.id, wait.revision, [{ questionKey: 'rule', content: 'Use the reviewed rule', actor: 'owner', evidenceEventIds: [source.id], at: source.occurredAt }]);
    assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /模型请求/);
    const current = f.consent.get(f.task.id)!;
    f.consent.finish(current.id, current.revision, 'failed', 'Waiting for accepted request');
    assert.equal(f.consent.resolveProjectReceipt(f.task.id, 1), undefined);
    f.broker.settleModel('operation', 'accepted-model', { usageStatus: 'unknown' }, 'transport_interrupted');
    assert.equal(f.consent.projectCompletionProblem(f.task.id, 1), undefined);
    assert.equal(f.consent.resolveProjectReceipt(f.task.id, 1)?.state, 'completed');
    assert.equal(f.consent.get(f.task.id)?.projectResolution?.previousState, 'failed');
  } finally { f.close(); }
});

test('an approved first stage cannot finalize a two-stage task and an answer cannot substitute another recorded decision', async () => {
  const f = await fixture('owner');
  try {
    const stage = { stageId: 'input-review', index: 1, count: 2, title: 'Review inputs',
      files: [{ path: 'D:/fixture/stage-one.json', size: 17, sha256: 'a'.repeat(64), format: 'json' }] };
    const fingerprint = createHash('sha256').update(projectStageReviewContent(stage)).digest('hex');
    const waiting = f.consent.waitForInput(f.task.id, { key: 'first-stage', summary: 'Review inputs',
      stageReview: { ...stage, fingerprint }, questions: [{ key: 'stage-decision', question: 'Approve this stage?', blocks: 'Next stage' }] });
    const event = f.inbox.ingestProcessed({ sourceId: 'owner-task-action', externalId: 'approve-first', caseId: 'case', kind: 'owner.task_answer',
      actor: 'owner', operation: 'create', occurredAt: new Date().toISOString(), payload: { taskId: f.task.id, dependencyId: waiting.id,
        revision: waiting.revision, answers: { 'stage-decision': projectStageApproved } } });
    const answer = { questionKey: 'stage-decision', content: projectStageApproved, actor: 'owner' as const, evidenceEventIds: [event.id], at: event.occurredAt };
    assert.throws(() => f.consent.answerDependency(waiting.id, waiting.revision, [{ ...answer, content: projectStageRejected }]), /实际提交内容/);
    f.consent.answerDependency(waiting.id, waiting.revision, [answer]);
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'projectCheck', label: 'Actual verification', state: 'succeeded', exitCode: 0 } });
    f.record({ kind: 'delivery', delivery: delivery(f.input.contract!.version === 2 ? f.input.contract!.requirements : []) });
    f.record({ kind: 'environment', state: 'closed', terminals: [] });
    f.record({ kind: 'finished', state: 'completed', output: 'Device claims complete' }); await f.pending;
    assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /逐阶段人工审核/);
    const task = f.consent.get(f.task.id)!;
    f.consent.finish(task.id, task.revision, 'failed', 'Missing stage approval');
    assert.equal(f.consent.resolveProjectReceipt(task.id, 1), undefined);
    assert.equal(f.consent.get(task.id)?.state, 'failed');
  } finally { f.close(); }
});

test('v2 needs a real environment outcome and an allowed preview cannot hide an unfinished check or revoked task', async () => {
  const f = await fixture(undefined, true);
  try {
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'projectCheck', label: 'Actual verification', state: 'succeeded', exitCode: 0 } });
    f.record({ kind: 'delivery', delivery: delivery(f.input.contract!.version === 2 ? f.input.contract!.requirements : []) });
    f.record({ kind: 'tool', item: { id: 'pending-check', type: 'projectCheck', label: 'Still checking', state: 'running' } });
    f.record({ kind: 'finished', state: 'completed', output: 'Native turn ended' }); await f.pending;
    assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /执行环境收尾/);
    f.record({ kind: 'environment', state: 'active', terminals: [{ threadId: 'preview', processId: '123', command: 'node preview.js', cwd: f.input.spec.root }] });
    assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /工具或检查/);
    f.record({ kind: 'tool', item: { id: 'pending-check', type: 'projectCheck', label: 'Check drained', state: 'interrupted' } });
    assert.equal(f.consent.projectCompletionProblem(f.task.id, 1), undefined);
    const current = f.consent.get(f.task.id)!;
    f.consent.revoke(current.id, current.revision);
    assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /许可已撤回/);
    assert.equal(f.consent.resolveProjectReceipt(f.task.id, 1), undefined);
  } finally { f.close(); }
});

test('only the exact retained preview process can exempt a running native command from completion drain', async () => {
  const f = await fixture(undefined, true);
  try {
    f.record({ kind: 'tool', item: { id: 'check-run', type: 'projectCheck', label: 'Actual verification', state: 'succeeded', exitCode: 0 } });
    f.record({ kind: 'delivery', delivery: delivery(f.input.contract!.version === 2 ? f.input.contract!.requirements : []) });
    const preview = { id: 'preview-command', type: 'commandExecution', label: 'node preview.js', command: 'node preview.js',
      threadId: 'preview-thread', processId: '123', state: 'running' as const };
    f.record({ kind: 'tool', item: preview });
    f.record({ kind: 'environment', state: 'active', terminals: [{ threadId: 'preview-thread', processId: '123', command: 'node preview.js', cwd: f.input.spec.root }] });
    f.record({ kind: 'finished', state: 'completed', output: 'Preview remains available' }); await f.pending;
    assert.equal(f.consent.projectCompletionProblem(f.task.id, 1), undefined);
    for (const candidate of [
      { ...preview, id: 'another-process', processId: '456' },
      { ...preview, id: 'another-thread', threadId: 'unrelated-thread' },
      { ...preview, id: 'missing-identity', processId: undefined, threadId: undefined },
      { ...preview, id: 'unfinished-check', type: 'projectCheck' },
    ]) {
      f.record({ kind: 'tool', item: candidate });
      assert.match(f.consent.projectCompletionProblem(f.task.id, 1)!, /工具或检查/);
      f.record({ kind: 'tool', item: { ...candidate, state: 'interrupted' } });
      assert.equal(f.consent.projectCompletionProblem(f.task.id, 1), undefined);
    }
  } finally { f.close(); }
});
