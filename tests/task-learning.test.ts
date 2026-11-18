import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { EventInbox, type InboxEvent } from '../server/v2/events.js';
import { TaskConsent } from '../server/v2/consent.js';
import { CaseMemory } from '../server/v2/memory.js';
import { CaseService } from '../server/v2/case-service.js';
import { PersonalMemory } from '../server/v2/personal-memory.js';
import { OwnerInputs } from '../server/v2/inputs.js';
import { TaskLearning } from '../server/v2/task-learning.js';
import { DeviceBroker } from '../server/devices/broker.js';
import type { Run } from '../shared/types.js';
import { deviceDirectoryLookupCapability } from '../shared/local-device.js';
import type { TaskSpec } from '../shared/task-consent.js';
import type { WorkspaceGrant } from '../server/v2/workspace.js';
import { MockLanguageModelV4 } from './support/model.js';
import { EWS_MAIL_OPERATION_PREFIX, type EwsMailOperation } from '../shared/mail.js';
import { mailOperationId, mailSpecHash } from '../server/v2/mail-results.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
async function fixture() {
  const prefix = join(tmpdir(), 'rae-task-learning-'); const directory = await mkdtemp(prefix);
  const store = new Store(directory); store.getApiKey = () => undefined;
  const inbox = new EventInbox(join(directory, 'events.sqlite'));
  const consent = new TaskConsent({ file: inbox.file, inbox });
  const devices = new DeviceBroker({ file: inbox.file });
  let memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'fixture-owner');
  let cases = new CaseService(memory); const revoked = new Set<string>();
  const sources = { isEventAllowed: (event: InboxEvent) => !revoked.has(event.id), resolveEventCase: (event: InboxEvent) => event.caseId };
  let grant: WorkspaceGrant | undefined;
  const learning = new TaskLearning({ store, consent, inbox, devices, sources, workspace: { getGrant: () => grant } });
  let personal = new PersonalMemory({ memory, inbox, sources, resolveTaskOutcome: event => learning.resolveEvidence(event) });
  let inputs = new OwnerInputs(store, inbox, cases, async () => { throw new Error('Explicit fixture scene is required'); },
    { feedbackOutcome: target => learning.feedbackOutcome(target) });
  return { store, inbox, consent, devices, sources, learning, revoked,
    get memory() { return memory; }, get cases() { return cases; }, get personal() { return personal; }, get inputs() { return inputs; },
    getGrant() { return grant; },
    setGrant(value: WorkspaceGrant) { grant = value; },
    createRun(spec: TaskSpec) {
      const approved = consent.request(spec, randomUUID()); const task = consent.begin(approved.id, approved.approvalRevision!);
      const run: Run = { id: randomUUID(), trigger: 'manual', mode: 'execution', status: 'running', taskId: task.id,
        caseId: task.spec.caseId, eventId: task.executionEventId, startedAt: now(), steps: 0, inputTokens: 0, outputTokens: 0,
        usageStatus: 'not_used', taskExecution: { requirementsRevision: task.requirementsRevision ?? 1, deadline: Date.now() + 300000, stepLimit: 4 } };
      store.insert('runs', run); return { task, run };
    },
    finish(run: Run, status: 'completed' | 'failed' = 'completed') {
      const task = consent.get(run.taskId!)!;
      consent.finish(task.id, task.revision, status, status === 'failed' ? 'fixture independently observed failure' : undefined, run.taskExecution?.requirementsRevision ?? 1);
      const finished = { ...run, status, endedAt: now() }; store.put('runs', finished); return finished;
    },
    async reopen() {
      await memory.close(); memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'fixture-owner');
      cases = new CaseService(memory);
      personal = new PersonalMemory({ memory, inbox, sources, resolveTaskOutcome: event => learning.resolveEvidence(event) });
      inputs = new OwnerInputs(store, inbox, cases, async () => { throw new Error('Explicit fixture scene is required'); },
        { feedbackOutcome: target => learning.feedbackOutcome(target) });
    },
    async close() {
      await memory.close(); await devices.close(); consent.close(); inbox.close(); store.close();
      const path = resolve(directory); assert.ok(path.startsWith(resolve(prefix)));
      try { await rm(path, { recursive: true, force: true }); }
      catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    } };
}

test('real saved task output and owner rating remain separate evidence without certifying content quality', async () => {
  const f = await fixture();
  try {
    const scene = await f.cases.create({ title: 'Deliverable feedback', objective: 'Learn from the actual saved output', domain: 'writing' });
    const { task, run } = f.createRun({ caseId: scene.id, title: 'Write one text', objective: 'One saved text', expectedOutput: 'Text', capabilities: ['artifact'] });
    const artifact = { id: randomUUID(), taskId: task.id, caseId: scene.id, requirementsRevision: 1, title: 'Saved draft',
      content: 'MODEL_SELF_CLAIM: all tests passed; first save, then review.', format: 'text' as const, status: 'prepared' as const, createdAt: now() };
    f.store.insert('artifacts', artifact); f.finish(run);
    const event = f.learning.recordOutcome(run.id)!;
    assert.equal(event.kind, 'task.outcome'); assert.equal(event.actor, 'system'); assert.equal(event.status, 'processed');
    assert.equal(f.learning.recordOutcome(run.id)!.id, event.id);
    assert.equal(f.inbox.list().filter(value => value.kind === 'task.outcome').length, 1);
    assert.equal(f.inbox.ready(100, value => value.kind === 'task.outcome').length, 0, 'A result creates no autonomous model opportunity');
    const result = f.learning.getOutcome(run.id)!;
    assert.equal(result.requirementsRevision, 1); assert.equal(result.deliveries[0].status, 'prepared');
    assert.equal(result.deliveries[0].contentHash, hash(artifact.content));
    assert.deepEqual(result.checks.map(check => check.name), ['artifact.persisted', 'runtime.delivery_state']);
    assert.doesNotMatch(String(event.payload.content), /MODEL_SELF_CLAIM|all tests passed/);
    const { eventId: _originalEventId, ...forgedSnapshot } = structuredClone(result);
    forgedSnapshot.checks.push({ source: 'workspace', referenceId: 'nonexistent-verification', name: 'all.tests.passed', passed: true, detail: 'fabricated independent success' });
    const forgedId = hash(`task.outcome:${JSON.stringify(forgedSnapshot)}`);
    const forgedOutcome = { ...forgedSnapshot, eventId: forgedId };
    const forgedContent = [`任务 ${task.id}，要求版本 1，运行 ${run.id}。`,
      '实际运行状态：completed。这些结果不是方法成功认证。', ...forgedOutcome.checks.map(check => `${check.passed ? '通过' : '未通过'} ${check.name}：${check.detail}`)].join('\n');
    const forgedEvent = f.inbox.ingest({ id: forgedId, sourceId: 'task-outcome', externalId: run.id, version: forgedId,
      kind: 'task.outcome', actor: 'system', operation: 'create', caseId: scene.id, occurredAt: result.recordedAt,
      causationId: task.executionEventId, payload: { content: forgedContent, outcome: forgedOutcome } }).event;
    assert.equal(f.learning.resolveEvidence(forgedEvent), undefined, 'A self-consistent inbox hash is not the independent run journal');
    assert.equal(f.store.get('runs', run.id)?.taskOutcomeEventId, event.id);
    const feedback = await f.inputs.feedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: '' });
    assert.equal(feedback.taskOutcome?.taskId, task.id);
    assert.equal(feedback.taskOutcome?.targetContentHash, hash(feedback.targetContent!));
    assert.equal(feedback.taskOutcome?.outcomeEventId, event.id);
    const feedbackEvent = f.inbox.list().find(value => value.externalId === feedback.id)!;
    const learned = await f.personal.learnMethod(scene.id, feedbackEvent.id, { key: 'method.save-review',
      value: '先保存实际交付，再请本人评价内容；方法仍需继续验证。', evidenceExcerpt: 'first save, then review.' });
    assert.equal(learned.entry.level, 'hypothesis'); assert.equal(learned.entry.subject, 'agent');
    const stored = (await f.personal.list())[0];
    assert.equal(stored.evidence[0].rating?.verdict, 'useful');
    assert.equal(stored.evidence[0].taskOutcome?.runId, run.id);
    assert.equal(stored.evidence[0].taskOutcome?.checks.some(check => /quality|test.*passed/.test(check.name)), false);
    await assert.rejects(f.personal.learn(scene.id, feedbackEvent.id, { key: 'owner.wrong', value: '不把评分目标当本人性格', evidenceExcerpt: 'first save, then review.' }), /证据/);
    await f.reopen();
    assert.equal((await f.personal.list())[0].evidence[0].taskOutcome?.eventId, event.id);
    assert.equal((await f.personal.list())[0].level, 'hypothesis');
  } finally { await f.close(); }
});

test('authenticated device and concrete workspace checks identify only the conditions actually checked', async () => {
  const f = await fixture(); let detach: (() => void) | undefined;
  try {
    const scene = await f.cases.create({ title: 'Native result evidence', objective: '', domain: 'work' });
    const device = f.devices.enroll({ name: 'Offline device fixture', platform: 'win32', pairingToken: f.devices.createPairing().token }).device;
    f.devices.updateDevice(device.id, { grants: [], capabilities: [deviceDirectoryLookupCapability] });
    detach = f.devices.attach(device.id, message => {
      if (message.kind !== 'execute') return;
      f.devices.admit(device.id, { operationId: message.operationId, specHash: message.specHash });
      f.devices.recordResult(device.id, { operationId: message.operationId, state: 'completed', exitCode: 0,
        stdout: JSON.stringify({ directory: 'D:/fixture', files: [], scanned: 0, truncated: false }) });
    });
    const { task, run } = f.createRun({ caseId: scene.id, title: 'List exact directory', objective: 'Only list', expectedOutput: 'Metadata',
      capabilities: ['local-command'], command: { kind: 'list_directory', deviceId: device.id, root: 'D:/fixture', timeoutMs: 1000, limit: 10 } });
    const operationId = hash(`local-command:${task.id}`);
    await f.devices.run(task.spec.command!, { taskId: task.id, taskRevision: task.approvalRevision! + 1, requirementsRevision: 1,
      runId: run.id, operationId, deadline: run.taskExecution!.deadline!, signal: new AbortController().signal, guard() {} });
    f.finish(run);
    const outcomeEvent = f.learning.recordOutcome(run.id)!; const outcome = f.learning.getOutcome(run.id)!;
    assert.equal(outcome.operations[0].id, operationId); assert.equal(outcome.checks[0].name, 'device.authenticated_receipt');
    assert.equal(outcome.checks[0].passed, true); assert.match(outcome.checks[0].detail, /不证明后续分析/);
    await f.personal.learnMethod(scene.id, outcomeEvent.id, { key: 'method.native-receipt', value: '使用原生回执核对查询，不能把零退出码当成分析正确。',
      evidenceExcerpt: 'device.authenticated_receipt' });
    assert.equal((await f.personal.list())[0].level, 'hypothesis');
    await assert.rejects(f.personal.learnMethod(scene.id, outcomeEvent.id, { key: 'method.native-receipt', value: '结果不是本人明确教学',
      evidenceExcerpt: 'device.authenticated_receipt', mode: 'correction' }), /明确方法纠正/);
    const readOperation = f.devices.getOperation.bind(f.devices);
    f.devices.getOperation = id => {
      const operation = readOperation(id);
      return operation ? { ...operation, receipt: { ...operation.receipt, state: 'failed', exitCode: 4 } } : undefined;
    };
    assert.equal(f.learning.getOutcome(run.id), undefined, 'The mutable original receipt is rechecked, not certified by its prior snapshot');
    f.devices.getOperation = readOperation;
    const workspace = f.createRun({ caseId: scene.id, title: 'JSON change', objective: 'Change only one JSON file', expectedOutput: 'A checked change',
      capabilities: ['workspace'], workspace: { revision: 4, files: ['settings.json'] } });
    f.setGrant({ caseId: scene.id, repoRoot: 'D:/fixture', worktreePath: 'D:/fixture-worktree', baselineCommit: 'fixture-commit',
      allowedFiles: ['settings.json'], jsonRules: [], createdAt: workspace.run.startedAt, sourceWasDirty: false, status: 'verified',
      revision: 4, progressRevision: 2, specFingerprint: 'fixture-spec', latestReceipt: { id: 'fixture-real-check-receipt', caseId: scene.id,
        worktreePath: 'D:/fixture-worktree', baselineCommit: 'fixture-commit', status: 'verified', changedFiles: ['settings.json'],
        fileHashes: { 'settings.json': hash('{"enabled":true}') }, checks: [{ name: 'json.required-value', passed: true, exitCode: 0,
          detail: 'The owner-selected field equals true.' }], diffStat: 'one file', patch: '+{"enabled":true}', createdAt: now(), authorizationRevision: 4 } });
    f.finish(workspace.run); f.learning.recordOutcome(workspace.run.id);
    const checked = f.learning.getOutcome(workspace.run.id)!;
    assert.deepEqual(checked.checks.filter(check => check.source === 'workspace').map(check => [check.name, check.passed]), [['json.required-value', true]]);
    assert.match(checked.checks[0].detail, /授权文件版本与该项条件/);
    f.setGrant({ ...f.getGrant()!, latestReceipt: undefined });
    assert.equal(f.learning.getOutcome(workspace.run.id)?.checks.find(check => check.source === 'workspace')?.referenceId, 'fixture-real-check-receipt',
      'The trusted run journal preserves what the old check verified even after a newer workspace inspection replaces its live receipt');
  } finally { detach?.(); await f.close(); }
});

test('native outcome hashes survive schema parsing and retain historical journal IDs without rewriting them', async () => {
  const f = await fixture();
  try {
    const scene = await f.cases.create({ title: 'Native hash compatibility', objective: '', domain: 'work' });
    const { task, run } = f.createRun({ caseId: scene.id, title: 'Exact mail', objective: 'Submit the authorized mail', expectedOutput: 'Submission receipt',
      capabilities: ['mail'], mail: { connectionId: 'mailbox-one', credentialRevision: 1, mode: 'send', to: ['recipient@example.test'], cc: [], bcc: [], attachments: [],
        subject: 'Approved subject', body: 'Approved body', protection: 'plaintext' } });
    const operation: EwsMailOperation = { id: mailOperationId(task.id), taskId: task.id, caseId: scene.id,
      approvalRevision: task.approvalRevision!, requirementsRevision: 1, specHash: mailSpecHash(task.spec.mail!), connectionId: 'mailbox-one',
      credentialRevision: 1, state: 'submitted', createdAt: now(), updatedAt: now() };
    f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation); f.finish(run);
    const recorded = f.learning.recordOutcome(run.id)!;
    const outcome = f.learning.getOutcome(run.id)!;
    assert.ok(outcome, 'A native receipt must pass the same schema/hash validation used on read');
    assert.equal(outcome.operations[0].kind, 'mail');
    const { eventId: _canonicalId, ...snapshot } = outcome;
    const reference = outcome.operations[0];
    const legacySnapshot = { ...snapshot, operations: [{ kind: reference.kind, id: reference.id,
      requirementsRevision: reference.requirementsRevision, state: reference.state, receiptHash: reference.receiptHash }] };
    const legacyId = hash(`task.outcome:${JSON.stringify(legacySnapshot)}`);
    assert.notEqual(legacyId, recorded.id);
    const legacy = f.inbox.ingestProcessed({ id: legacyId, sourceId: recorded.sourceId, externalId: run.id, version: legacyId,
      kind: recorded.kind, actor: recorded.actor, operation: recorded.operation, caseId: scene.id, occurredAt: recorded.occurredAt,
      causationId: recorded.causationId, payload: { ...recorded.payload, outcome: { ...outcome, eventId: legacyId } } });
    f.store.put('runs', { ...f.store.get('runs', run.id)!, taskOutcomeEventId: legacyId });
    assert.equal(f.learning.resolveEvidence(legacy)?.eventId, legacyId);
    let writes = 0; const detach = f.store.subscribe(() => { writes++; });
    try { assert.equal(f.learning.recordOutcome(run.id)?.id, legacyId); } finally { detach(); }
    assert.equal(writes, 0); assert.equal(f.store.get('runs', run.id)?.taskOutcomeEventId, legacyId);
    f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, { ...operation, state: 'unknown' });
    assert.equal(f.learning.getOutcome(run.id), undefined, 'Legacy ID compatibility still rechecks the actual native receipt');
  } finally { await f.close(); }
});

test('fabricated outcomes, another scene and a withdrawn original source cannot teach methods', async () => {
  const f = await fixture();
  try {
    const a = await f.cases.create({ title: 'Scope A', objective: '', domain: 'work' });
    const b = await f.cases.create({ title: 'Scope B', objective: '', domain: 'other' });
    const source = f.inbox.ingest({ sourceId: 'connector:approved-source', sourceGeneration: 'approved-source', externalId: 'original-file',
      kind: 'connector.change', actor: 'external', operation: 'create', caseId: a.id, occurredAt: now(), payload: { content: 'Task background' } }).event;
    const proposed = f.consent.propose({ caseId: a.id, title: 'Prepare output', objective: 'Use the authorized source', expectedOutput: 'Text', capabilities: ['artifact'] }, source.id);
    const approved = f.consent.approve(proposed.id, proposed.revision); const task = f.consent.begin(approved.id, approved.approvalRevision!);
    const run: Run = { id: randomUUID(), trigger: 'manual', mode: 'execution', status: 'running', startedAt: now(), taskId: task.id, caseId: a.id,
      eventId: task.executionEventId, steps: 0, inputTokens: 0, outputTokens: 0, taskExecution: { requirementsRevision: 1, deadline: Date.now() + 1000, stepLimit: 2 } };
    f.store.insert('runs', run);
    const artifact = { id: randomUUID(), taskId: task.id, caseId: a.id, requirementsRevision: 1, title: 'Partial source output',
      content: 'SOURCE_BOUND_RATING_TARGET', format: 'text' as const, status: 'prepared' as const, createdAt: now() };
    f.store.insert('artifacts', artifact); f.finish(run, 'failed');
    const event = f.learning.recordOutcome(run.id)!;
    const input = { key: 'method.partial-result', value: '部分结果不能冒充完整交付。', evidenceExcerpt: '保存部分结果不等于任务完成。' };
    await assert.rejects(f.personal.learnMethod(b.id, event.id, input), /不属于/);
    const forged = f.inbox.ingest({ sourceId: 'agent-output', externalId: 'fake-result', kind: 'task.outcome', actor: 'agent', operation: 'create',
      caseId: a.id, occurredAt: now(), payload: { content: '已验证能力增长。', outcome: event.payload.outcome } }).event;
    await assert.rejects(f.personal.learnMethod(a.id, forged.id, { ...input, evidenceExcerpt: '已验证能力增长。' }), /不构成独立验证证据/);
    await f.personal.learnMethod(a.id, event.id, input);
    f.revoked.add(source.id);
    assert.equal(f.learning.getOutcome(run.id), undefined);
    assert.equal((await f.personal.list())[0].effectiveStatus, 'evidence_unavailable');
    assert.deepEqual(await f.memory.sharedForCase(a.id), []);
    const late = await f.inputs.feedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: '' });
    assert.equal(late.taskOutcome?.outcomeEventId, event.id, 'A withdrawn result retains its original journal reference for the prompt fence');
    assert.equal(late.targetContent, artifact.content, 'The saved owner feedback snapshot is preserved for history');
    const lateEvent = f.inbox.list().find(value => value.externalId === late.id)!;
    assert.equal(f.learning.resolveEvidence(lateEvent), undefined);
    const savedRun = f.store.get('runs', run.id)!;
    const { taskOutcomeEventId: _missingJournal, ...withoutJournal } = savedRun; f.store.put('runs', withoutJournal);
    const unavailable = await f.inputs.feedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'off_target', comment: 'Do not resend the withdrawn target.' });
    assert.equal(unavailable.taskOutcome?.unavailable, true);
    assert.equal(f.inbox.get(unavailable.taskOutcome!.outcomeEventId), undefined, 'An unavailable association is a fence, not fabricated result evidence');
  } finally { await f.close(); }
});

test('actual same-scene tool dependencies are retained without admission references and cannot be replaced by an unrelated scene', async () => {
  const f = await fixture();
  try {
    const scene = await f.cases.create({ title: 'Read during execution', objective: '', domain: 'work' });
    const other = await f.cases.create({ title: 'Unrelated private scene', objective: '', domain: 'other' });
    const source = f.inbox.ingest({ sourceId: 'fixture-original-source', externalId: 'actual-read', kind: 'owner.source', actor: 'owner',
      operation: 'create', caseId: scene.id, occurredAt: now(), payload: { content: 'A source actually read by the task.' } }).event;
    const { task, run } = f.createRun({ caseId: scene.id, title: 'Read and answer', objective: 'Use the actual source', expectedOutput: 'Text', capabilities: ['artifact'] });
    run.evidenceEventIds = [source.id]; f.store.put('runs', run); f.finish(run, 'failed');
    assert.equal(task.evidenceRefs, undefined);
    const event = f.learning.recordOutcome(run.id)!;
    assert.deepEqual(f.learning.getOutcome(run.id)?.sourceEventIds, [source.id]);
    await f.personal.learnMethod(scene.id, event.id, { key: 'method.actual-source', value: 'Wait for real delivery, not partial source work.',
      evidenceExcerpt: '保存部分结果不等于任务完成。' });
    f.revoked.add(source.id);
    assert.equal(f.learning.getOutcome(run.id), undefined); assert.equal((await f.personal.list())[0].effectiveStatus, 'evidence_unavailable');
    const privateSource = f.inbox.ingest({ sourceId: 'fixture-private-source', externalId: 'unrelated-read', kind: 'owner.source', actor: 'owner',
      operation: 'create', caseId: other.id, occurredAt: now(), payload: { content: 'Not linked to the task.' } }).event;
    const saved = f.store.get('runs', run.id)!; f.store.put('runs', { ...saved, evidenceEventIds: [privateSource.id] });
    assert.equal(f.learning.recordOutcome(run.id), undefined, 'Recording actual evidence cannot expand the task into an unlinked scene');
  } finally { await f.close(); }
});

test('task-linked correction is versioned and reusable without repeating the owner explanation or inventing validated competence', async () => {
  const f = await fixture();
  try {
    const scene = await f.cases.create({ title: 'Feedback loop', objective: '', domain: 'writing' });
    const { task, run } = f.createRun({ caseId: scene.id, title: 'One answer', objective: 'Produce a concise answer', expectedOutput: 'Text', capabilities: ['artifact'] });
    const artifact = { id: randomUUID(), taskId: task.id, caseId: scene.id, requirementsRevision: 1, title: 'Verbose draft',
      content: 'OLD_METHOD_SENTINEL: explain every detail first.', format: 'text' as const, createdAt: now(), status: 'prepared' as const };
    f.store.insert('artifacts', artifact); f.finish(run); f.learning.recordOutcome(run.id);
    const first = await f.inputs.feedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: '' });
    const firstEvent = f.inbox.list().find(value => value.externalId === first.id)!;
    await f.personal.learnMethod(scene.id, firstEvent.id, { key: 'method.answer-order', value: 'OLD_METHOD_SENTINEL: explain every detail first.',
      evidenceExcerpt: 'explain every detail first.' });
    const correctionText = '新方法：先给结论，只展开影响决定的依据。';
    const correction = await f.inputs.feedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'off_target', comment: correctionText });
    const correctionEvent = f.inbox.list().find(value => value.externalId === correction.id)!;
    await f.personal.learnMethod(scene.id, correctionEvent.id, { key: 'method.answer-order', value: correctionText, evidenceExcerpt: correctionText });
    const memory = (await f.personal.list())[0];
    assert.equal(memory.revision, 2); assert.equal(memory.level, 'hypothesis'); assert.equal(memory.history[0].value, artifact.content);
    assert.equal(memory.evidence[0].taskOutcome?.taskId, task.id);
    await f.reopen();
    const later = await f.cases.create({ title: 'Later related scene', objective: '', domain: 'writing' });
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async options => {
      prompts.push(JSON.stringify(options.prompt));
      return { content: [{ type: 'text', text: 'A fixture response; not independent success evidence.' }], warnings: [],
        finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } } };
    } });
    await f.memory.runCase({ caseId: later.id, message: 'A new related question, without repeating my feedback.', model,
      instructions: 'Use only applicable memory.', maxSteps: 1 });
    assert.match(prompts[0], /先给结论/); assert.doesNotMatch(prompts[0], /OLD_METHOD_SENTINEL/);
    assert.equal(f.store.list('feedback').filter(value => value.comment === correctionText).length, 1);
    assert.equal((await f.personal.list())[0].revision, 2, 'The agent response cannot certify or promote its own method');
    assert.equal(f.store.list('runs').filter(value => value.taskId === task.id).length, 1, 'Learning created no new execution task or reflection run');
  } finally { await f.close(); }
});

test('feedback links the server target snapshot and cannot substitute another task outcome', async () => {
  const f = await fixture();
  try {
    const scene = await f.cases.create({ title: 'Feedback integrity', objective: '', domain: 'work' });
    const { task, run } = f.createRun({ caseId: scene.id, title: 'Saved result', objective: 'Write one result', expectedOutput: 'Text', capabilities: ['artifact'] });
    const artifact = { id: randomUUID(), taskId: task.id, caseId: scene.id, requirementsRevision: 1, title: 'Result', content: 'ACTUAL_TARGET_CONTENT',
      format: 'text' as const, status: 'prepared' as const, createdAt: now() };
    f.store.insert('artifacts', artifact); f.finish(run);
    assert.equal(f.learning.feedbackOutcome({ targetType: 'artifact', targetId: artifact.id, caseId: scene.id, targetContent: 'FORGED_TARGET' }), undefined);
    const feedback = await f.inputs.feedback({ targetType: 'artifact', targetId: artifact.id, verdict: 'useful', comment: '' });
    const original = f.inbox.list().find(value => value.externalId === feedback.id)!;
    assert.ok(f.learning.resolveEvidence(original));
    const forged = f.inbox.ingest({ sourceId: 'owner-feedback', externalId: 'not-a-saved-owner-feedback', kind: 'owner.feedback', actor: 'owner',
      operation: 'create', caseId: scene.id, occurredAt: now(), payload: { ...original.payload } }).event;
    await assert.rejects(f.personal.learnMethod(scene.id, forged.id, { key: 'method.fake-owner-rating', value: 'Cannot certify from fabricated feedback',
      evidenceExcerpt: artifact.content }), /任务结果依据无效/);
    await f.inputs.recover();
    assert.equal(f.inbox.list().filter(value => value.externalId === feedback.id).length, 1);
    assert.deepEqual(f.store.get('feedback', feedback.id)?.taskOutcome, feedback.taskOutcome);
    const plain = await f.inputs.feedback({ targetType: 'case', targetId: scene.id, verdict: 'useful', comment: '', taskOutcome: feedback.taskOutcome } as never);
    assert.equal(plain.taskOutcome, undefined, 'Only the server resolver may attach a task outcome to owner input');
  } finally { await f.close(); }
});

for (const interruption of ['journal', 'event'] as const) test(`task outcome ${interruption} interruption repairs locally without a model opportunity`, async () => {
  const f = await fixture();
  try {
    const scene = await f.cases.create({ title: 'Outcome crash', objective: '', domain: 'work' });
    const { run } = f.createRun({ caseId: scene.id, title: 'Partial work', objective: 'Observe a failed result', expectedOutput: 'Text', capabilities: ['artifact'] });
    f.finish(run, 'failed');
    const ingest = f.inbox.ingest.bind(f.inbox); const consume = f.inbox.consumeLocal.bind(f.inbox);
    if (interruption === 'journal') f.inbox.ingest = input => { if (input.kind === 'task.outcome') throw new Error('fixture journal-before-event crash'); return ingest(input); };
    else f.inbox.consumeLocal = (kinds, eligible) => { if (kinds.includes('task.outcome')) throw new Error('fixture event-before-ack crash'); return consume(kinds, eligible); };
    assert.throws(() => f.learning.recordOutcome(run.id), /fixture/);
    assert.match(f.store.get('runs', run.id)?.taskOutcomeEventId ?? '', /^[a-f0-9]{64}$/);
    f.inbox.ingest = ingest; f.inbox.consumeLocal = consume;
    const recovered = f.learning.recordOutcome(run.id)!;
    assert.equal(recovered.status, 'processed'); assert.equal(f.learning.recordOutcome(run.id)?.id, recovered.id);
    assert.equal(f.inbox.list().filter(event => event.kind === 'task.outcome').length, 1);
    assert.equal(f.inbox.ready(100, event => event.kind === 'task.outcome').length, 0);
    assert.equal(f.store.list('runs').length, 1);
  } finally { await f.close(); }
});
