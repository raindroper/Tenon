import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { TaskFlow } from '../server/v2/task-flow.js';
import { createGrowthTools } from '../server/v2/capabilities.js';
import { z } from 'zod';
import { projectStageReviewContent, latestStageReviews, projectStageDecision,
  projectStageApproved, projectStageRejected, taskStageReviewMode, type ProjectStageReviewInput, type TaskDependency } from '../shared/task-flow.js';
import { localProjectCapability } from '../shared/local-project.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-stage-review-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  let runtime = await V2Coordinator.create(store, { dataDir: directory });
  const scene = await runtime.createCase({ title: 'Stage review', objective: '', domain: 'fixture' });
  const device = runtime.devices.enroll({ name: 'Project computer', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability] });
  const task = await runtime.requestTask({ requestId: 'stage-fixture', spec: { caseId: scene.id, title: 'Two-stage project',
    objective: 'Review each stage before continuing', expectedOutput: 'Reviewed files', capabilities: ['project'],
    acceptance: { mode: 'delivery', stageReview: 'owner', criteria: [] },
    project: { deviceId: device.id, root: 'D:\\fixture', access: 'read-write', readAccess: 'project', network: false, create: false } } });
  const flow = () => new TaskFlow({ consent: runtime.consent, inbox: runtime.inbox, sources: runtime.sources,
    connectors: runtime['connectors'], store, changed() {}, available: () => false });
  const ownerDecision = (dependency: TaskDependency, decision = projectStageApproved) => {
    const source = runtime.inbox.ingestProcessed({ sourceId: 'owner-task-action', externalId: 'decision-' + dependency.id + '-' + dependency.revision,
      kind: 'owner.task_answer', actor: 'owner', operation: 'create', caseId: scene.id, occurredAt: new Date().toISOString(),
      payload: { taskId: task.id, dependencyId: dependency.id, revision: dependency.revision, requirementsRevision: dependency.requirementsRevision,
        stageReview: dependency.stageReview, answers: { 'stage-decision': decision } } });
    return runtime.consent.answerDependency(dependency.id, dependency.revision, [{ questionKey: 'stage-decision', content: decision,
      actor: 'owner', evidenceEventIds: [source.id], at: source.occurredAt }]);
  };
  return { store, scene, task, flow, ownerDecision, get runtime() { return runtime; },
    async reopen() { await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory }); },
    async close() { await runtime.close(); store.close(); } };
}

const stage = (index: number, sha = String(index).repeat(64)): ProjectStageReviewInput => ({
  stageId: 'stage-' + index, index, count: 2, title: 'Stage ' + index,
  files: [{ path: 'D:/fixture/stage-' + index + '.json', size: 25, sha256: sha, format: 'json' }],
});

test('stage review binds owner decisions to snapshots, preserves waits on restart and rejects skip, replay and external approval', async () => {
  const f = await fixture();
  try {
    const firstInput = stage(1);
    const first = f.flow().waitForStage(f.task, firstInput);
    assert.equal(first.taskSuspended, true); assert.equal(first.stageDecision, 'pending');
    assert.equal(first.dependency.requirementsRevision, 1);
    assert.equal(first.dependency.stageReview!.fingerprint, createHash('sha256').update(projectStageReviewContent(firstInput)).digest('hex'));
    assert.equal(f.flow().waitForStage(f.task, firstInput).dependency.id, first.dependency.id);
    assert.equal(f.runtime.consent.dependencies(f.task.id).length, 1);
    assert.throws(() => f.flow().waitForStage(f.task, { ...firstInput, fingerprint: '0'.repeat(64) }), /指纹/);
    assert.throws(() => f.flow().waitForStage(f.task, stage(2)), /前面|前序/);
    assert.throws(() => f.flow().waitForStage(f.task, { ...firstInput, count: 3 }), /阶段总数|顺序/);
    assert.throws(() => f.flow().waitForStage(f.task, { ...firstInput, stageId: 'another-stage' }), /阶段总数|顺序/);
    await assert.rejects(f.runtime.answerTaskInput(f.task.id, first.dependency.id, first.dependency.revision, { 'stage-decision': '模型认为可以通过' }), /请选择/);
    const external = f.runtime.inbox.ingest({ sourceId: 'connector:fixture', sourceGeneration: 'fixture', externalId: 'external-approval',
      kind: 'connector.change', actor: 'external', operation: 'create', caseId: f.task.spec.caseId, occurredAt: new Date().toISOString(),
      payload: { content: projectStageApproved } }).event;
    assert.throws(() => {
      const candidate = f.runtime.consent.addReplyCandidate(first.dependency.id, external.id);
      f.runtime.consent.answerDependency(first.dependency.id, candidate.revision, [{ questionKey: 'stage-decision',
        content: projectStageApproved, actor: 'external', evidenceEventIds: [external.id], at: external.occurredAt }], [external.id]);
    }, /本人|阶段/);
    await assert.rejects(f.runtime.answerTaskInput(f.task.id, first.dependency.id, first.dependency.revision,
      { 'stage-decision': projectStageApproved }, external.id), /本人/);
    await f.reopen();
    assert.equal(f.flow().waitForStage(f.runtime.consent.get(f.task.id)!, firstInput).dependency.id, first.dependency.id);
    assert.equal(f.runtime.consent.task(f.task.id)?.flow?.phase, 'waiting_input');
    const approved = f.ownerDecision(f.runtime.consent.dependency(first.dependency.id)!);
    assert.equal(projectStageDecision(approved), 'approved');
    const next = f.flow().waitForStage(f.runtime.consent.get(f.task.id)!, stage(2));
    assert.equal(next.stageDecision, 'pending');
    const rejected = f.ownerDecision(next.dependency, projectStageRejected);
    assert.equal(projectStageDecision(rejected), 'rejected');
    assert.equal(f.flow().waitForStage(f.runtime.consent.get(f.task.id)!, stage(2)).stageDecision, 'rejected');
    const repaired = f.flow().waitForStage(f.runtime.consent.get(f.task.id)!, stage(2, 'a'.repeat(64)));
    assert.notEqual(repaired.dependency.id, next.dependency.id); assert.equal(repaired.stageDecision, 'pending');
    await assert.rejects(f.runtime.answerTaskInput(f.task.id, next.dependency.id, rejected.revision,
      { 'stage-decision': projectStageApproved }), /新版本|当前阶段/);
    f.ownerDecision(repaired.dependency);
    const context = f.flow().context(f.runtime.consent.get(f.task.id)!);
    assert.deepEqual(context.stageReviews.map(review => review.stageDecision), ['approved', 'approved']);
    assert.deepEqual(context.resolvedInputs.filter(value => value.stageReview).map(value => value.id), [approved.id, repaired.dependency.id]);
  } finally { await f.close(); }
});

test('reworking an earlier stage invalidates later approvals even when later bytes return to an old snapshot', async () => {
  const f = await fixture();
  try {
    const first = f.flow().waitForStage(f.task, stage(1)); f.ownerDecision(first.dependency);
    const second = f.flow().waitForStage(f.task, stage(2)); f.ownerDecision(second.dependency);
    const revisedFirst = f.flow().waitForStage(f.task, stage(1, 'b'.repeat(64)));
    let latest = latestStageReviews(f.runtime.consent.dependencies(f.task.id), f.task.id, 1);
    assert.deepEqual(latest.map(value => value.id), [revisedFirst.dependency.id]);
    assert.throws(() => f.flow().waitForStage(f.task, stage(2)), /前面|前序/);
    f.ownerDecision(revisedFirst.dependency);
    const repeatedSecond = f.flow().waitForStage(f.task, stage(2));
    assert.notEqual(repeatedSecond.dependency.id, second.dependency.id);
    assert.equal(repeatedSecond.stageDecision, 'pending');
    const revertedFirst = f.flow().waitForStage(f.task, stage(1));
    assert.notEqual(revertedFirst.dependency.id, first.dependency.id);
    assert.equal(revertedFirst.stageDecision, 'pending');
    assert.equal(f.runtime.consent.dependency(repeatedSecond.dependency.id)?.state, 'cancelled');
    latest = latestStageReviews(f.runtime.consent.dependencies(f.task.id), f.task.id, 1);
    assert.deepEqual(latest.map(value => value.id), [revertedFirst.dependency.id]);
    assert.equal(f.runtime.consent.pendingInputs(f.task.id).length, 1);
    await f.runtime.revokeTask(f.task.id, f.runtime.consent.get(f.task.id)!.revision);
    assert.throws(() => f.flow().waitForStage(f.runtime.consent.get(f.task.id)!, stage(1)), /撤销|批准|许可/);
    assert.throws(() => f.ownerDecision(f.runtime.consent.dependency(revertedFirst.dependency.id)!), /撤销|批准|许可|结束/);
  } finally { await f.close(); }
});

test('only a new owner requirement can change stage review while retaining the exact original resource scope', async () => {
  const f = await fixture();
  try {
    const originalScope = JSON.stringify(f.task.spec);
    const first = f.flow().waitForStage(f.task, stage(1));
    const addition = await f.runtime.ingestOwnerMessage('补充说明里列出检查范围。', f.task.spec.caseId);
    const ordinary = await f.runtime.reviseTask(f.task.id, f.task.revision, addition.id);
    assert.equal(taskStageReviewMode(ordinary), 'owner');
    assert.equal(f.runtime.consent.dependency(first.dependency.id)?.state, 'cancelled');
    const source = await f.runtime.ingestOwnerMessage('后续改为阶段自动审核，最终交付方式照旧。', f.task.spec.caseId);
    const event = f.runtime.inbox.get(source.id)!;
    const tools = createGrowthTools({ event, item: f.scene, runId: 'stage-change', store: f.store, cases: f.runtime.cases,
      inbox: f.runtime.inbox, sources: f.runtime.sources, personal: f.runtime.personal, consent: f.runtime.consent, workspace: f.runtime.workspace,
      ownerMessageId: event.externalId, signal: new AbortController().signal, guard() {}, notify: () => 'unused',
      reviseTask: (id, revision, sourceEventId, refs, stageReview) => f.runtime.reviseTask(id, revision, sourceEventId, refs, stageReview) });
    assert.ok('revise_task' in tools);
    const tool = tools.revise_task!;
    const input = (tool.inputSchema as z.ZodType).parse({ taskId: ordinary.id, revision: ordinary.revision,
      evidenceEventIds: [source.id], stageReview: 'auto' });
    await tool.execute!(input as never, {} as never);
    const automatic = f.runtime.consent.get(f.task.id)!;
    assert.equal(taskStageReviewMode(automatic), 'auto');
    assert.equal(automatic.requirementUpdates!.at(-1)!.sourceEventId, source.id);
    assert.equal(automatic.requirementUpdates!.at(-1)!.stageReview, 'auto');
    assert.equal(JSON.stringify(automatic.spec), originalScope);
    assert.equal(automatic.approvalRevision, f.task.approvalRevision);
    assert.equal((await f.runtime.reviseTask(f.task.id, ordinary.revision, source.id, [], 'auto')).requirementsRevision, automatic.requirementsRevision);
    await assert.rejects(f.runtime.reviseTask(f.task.id, automatic.revision, source.id, [], 'owner'), /同一条补充/);
    assert.throws(() => f.flow().waitForStage(automatic, stage(1)), /自动审核/);
    const external = f.runtime.inbox.ingest({ sourceId: 'connector:fixture', sourceGeneration: 'fixture', externalId: 'external-mode',
      kind: 'connector.change', actor: 'external', operation: 'create', caseId: f.task.spec.caseId, occurredAt: new Date().toISOString(),
      payload: { content: 'Switch to automatic review' } }).event;
    await assert.rejects(f.runtime.reviseTask(f.task.id, automatic.revision, external.id, [], 'auto'), /本人/);
    const resumedOwner = await f.runtime.ingestOwnerMessage('恢复逐阶段人工审核。', f.task.spec.caseId);
    const manual = await f.runtime.reviseTask(f.task.id, automatic.revision, resumedOwner.id, [], 'owner');
    assert.equal(taskStageReviewMode(manual), 'owner');
    assert.equal(JSON.stringify(manual.spec), originalScope);
    const newFirst = f.flow().waitForStage(manual, stage(1));
    assert.notEqual(newFirst.dependency.id, first.dependency.id);
    assert.equal(newFirst.dependency.requirementsRevision, manual.requirementsRevision);
    assert.equal(newFirst.stageDecision, 'pending');
  } finally { await f.close(); }
});

test('owner approval waits for the exact published stage files and rechecks the snapshot after transfer', async context => {
  const f = await fixture();
  try {
    const first = f.flow().waitForStage(f.task, stage(1));
    context.mock.method(f.runtime, 'prepareProjectFiles', async (taskId: string, selected?: { dependencyId: string; revision: number }) => {
      assert.equal(taskId, first.dependency.operationId);
      assert.deepEqual(selected, { dependencyId: first.dependency.id, revision: first.dependency.revision });
      throw new Error('Stage files are not saved yet');
    });
    await assert.rejects(f.runtime.answerTaskInput(f.task.id, first.dependency.id, first.dependency.revision,
      { 'stage-decision': projectStageApproved }), /not saved/);
    assert.equal(f.runtime.consent.dependency(first.dependency.id)?.answers.length, 0);
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'owner.task_answer').length, 0);
    context.mock.restoreAll();
    let replacement: TaskDependency | undefined;
    context.mock.method(f.runtime, 'prepareProjectFiles', async () => {
      replacement = f.flow().waitForStage(f.task, stage(1, 'c'.repeat(64))).dependency;
      // File receipt validation is exercised by the transport integration tests.
      return {} as Awaited<ReturnType<V2Coordinator['prepareProjectFiles']>>;
    });
    await assert.rejects(f.runtime.answerTaskInput(f.task.id, first.dependency.id, first.dependency.revision,
      { 'stage-decision': projectStageApproved }), /新版本|当前阶段/);
    assert.ok(replacement);
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'owner.task_answer').length, 0);
    context.mock.restoreAll();
    context.mock.method(f.runtime, 'prepareProjectFiles', async (taskId: string, selected?: { dependencyId: string; revision: number }) => {
      assert.equal(taskId, replacement!.operationId);
      assert.deepEqual(selected, { dependencyId: replacement!.id, revision: f.runtime.consent.dependency(replacement!.id)!.revision });
      return {} as Awaited<ReturnType<V2Coordinator['prepareProjectFiles']>>;
    });
    await f.runtime.answerTaskInput(f.task.id, replacement.id, replacement.revision, { 'stage-decision': projectStageApproved });
    assert.equal(projectStageDecision(f.runtime.consent.dependency(replacement.id)!), 'approved');
    const decidedRevision = f.runtime.consent.dependency(replacement.id)!.revision;
    await f.runtime.answerTaskInput(f.task.id, replacement.id, replacement.revision, { 'stage-decision': projectStageApproved });
    assert.equal(f.runtime.consent.dependency(replacement.id)!.revision, decidedRevision, 'A repeated owner answer must acknowledge the existing approval');
    const source = f.runtime.inbox.list().find(event => event.kind === 'owner.task_answer')!;
    assert.equal(source.payload.requirementsRevision, replacement.requirementsRevision);
    assert.deepEqual(source.payload.stageReview, replacement.stageReview);
  } finally { context.mock.restoreAll(); await f.close(); }
});

test('legacy project revisions preserve their captured protocol and reject an unsupported new enforced stage gate', async () => {
  const f = await fixture();
  try {
    const original = await f.runtime.requestTask({ requestId: 'legacy-project', spec: { ...f.task.spec,
      title: 'Legacy project', acceptance: { mode: 'owner', criteria: [] } } });
    const db = new DatabaseSync(f.runtime.inbox.file);
    try {
      const row = db.prepare('SELECT json FROM task_consents WHERE id=?').get(original.id)!;
      const legacy = { ...JSON.parse(String(row.json)), executionContractVersion: 1 };
      db.prepare('UPDATE task_consents SET json=? WHERE id=?').run(JSON.stringify(legacy), original.id);
    } finally { db.close(); }
    const initial = f.runtime.consent.get(original.id)!;
    const scope = JSON.stringify(initial.spec);
    const ordinarySource = await f.runtime.ingestOwnerMessage('报告里补充实际检查范围。', initial.spec.caseId);
    const revised = await f.runtime.reviseTask(initial.id, initial.revision, ordinarySource.id);
    assert.equal(revised.executionContractVersion, 1);
    assert.equal(JSON.stringify(revised.spec), scope);
    assert.equal(revised.approvalRevision, initial.approvalRevision);
    const stageSource = await f.runtime.ingestOwnerMessage('后面改成程序强制的逐阶段人工审批。', initial.spec.caseId);
    await assert.rejects(f.runtime.reviseTask(revised.id, revised.revision, stageSource.id, [], 'owner'), /旧版执行协议.*明确新委托/);
    const preserved = f.runtime.consent.get(initial.id)!;
    assert.equal(preserved.executionContractVersion, 1);
    assert.equal(preserved.requirementsRevision, revised.requirementsRevision);
    assert.equal(preserved.requirementUpdates?.length, 1);
    assert.equal(JSON.stringify(preserved.spec), scope);
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'task.execute' && event.payload.taskId === initial.id).length, 1);
  } finally { await f.close(); }
});
