import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveProject, pruneProjectArchives, restoreProjectArchive } from '../desktop/project-archive.js';
import { projectCheckpoint } from '../desktop/project-checkpoint.js';
import type { LocalProjectEntry } from '../desktop/project-journal.js';
import { serverProjectResources, localProjectSpecSchema, localProjectCapability, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { ProjectBroker, projectSpecHash } from '../server/devices/projects.js';
import { TaskConsent } from '../server/v2/consent.js';
import { EventInbox } from '../server/v2/events.js';

test('workspace checkpoint restores exact files and native history, rejects mismatched or tampered snapshots and never overwrites an existing target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-workspace-archive-'));
  const scratch = path.join(root, 'scratch'), privateDirectory = path.join(root, 'private'); await mkdir(scratch);
  const work = path.join(scratch, 'a'.repeat(64)); await mkdir(work); await mkdir(path.join(work, 'workspace')); await mkdir(path.join(work, 'codex'));
  await writeFile(path.join(work, 'workspace', 'requirements.txt'), 'P10 original source');
  await writeFile(path.join(work, 'codex', 'session.jsonl'), '{"thread":"native-test"}');
  const spec = localProjectSpecSchema.parse({ deviceId: 'linux', root: 'task-temporary', readAccess: 'project', network: false, serverResources: serverProjectResources(false) });
  const entry: LocalProjectEntry = { input: { operationId: 'a'.repeat(64), taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'P10', objective: 'Implement P10', expectedOutput: 'Files', ownerRequest: 'Implement P10', updates: [],
    model: { model: 'offline', reasoningEffort: 'auto', maxOutputTokens: null }, stepLimit: null, deadline: null, issuedAt: new Date().toISOString() },
    state: 'paused', sequence: 0, acknowledged: 0, appliedRevision: 1, output: '', identity: 'original-directory-identity' };
  const before = await projectCheckpoint(work, true);
  entry.workspaceArchive = await archiveProject(work, privateDirectory, entry);
  assert.equal(entry.workspaceArchive.hash, before);
  await assert.rejects(restoreProjectArchive(work, privateDirectory, entry), /已存在/);
  assert.equal(path.dirname(work), scratch); await rm(work, { recursive: true });
  await restoreProjectArchive(work, privateDirectory, entry);
  assert.equal(await projectCheckpoint(work, true), before);
  assert.equal(await readFile(path.join(work, 'codex', 'session.jsonl'), 'utf8'), '{"thread":"native-test"}');
  await rm(work, { recursive: true });
  const wrong = { ...entry, input: { ...entry.input, specHash: 'b'.repeat(64) } };
  await assert.rejects(restoreProjectArchive(work, privateDirectory, wrong), /不匹配/);
  await writeFile(path.join(privateDirectory, 'workspace-snapshots', entry.workspaceArchive.id, 'content', 'workspace', 'requirements.txt'), 'changed snapshot');
  await assert.rejects(restoreProjectArchive(work, privateDirectory, entry), /已变化/);
  const original = { ...entry, input: { ...entry.input, spec: { ...spec, serverResources: { ...spec.serverResources!, workspaceStorage: undefined } } } };
  await assert.rejects(restoreProjectArchive(work, privateDirectory, original), /缺少/);
  await pruneProjectArchives(privateDirectory);
});

test('task migration preserves old records and IDs, creates no execution and is idempotent; separate operation approval cannot outlive its parent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-flow-migration-')), file = path.join(root, 'events.sqlite');
  const inbox = new EventInbox(file);
  let consent = new TaskConsent({ file, inbox });
  const task = consent.request({ caseId: 'work', title: 'Code task', objective: 'Implement the approved feature', expectedOutput: 'Code', capabilities: ['artifact'] }, 'owner-request');
  consent.begin(task.id, task.approvalRevision!);
  const db = new DatabaseSync(file);
  const original = String(db.prepare('SELECT json FROM task_consents WHERE id=?').get(task.id)!.json);
  const executionId = task.executionEventId;
  consent.close();
  // Emulate the pre-operation schema, retaining the exact historical JSON/outbox.
  db.exec('DROP INDEX task_operations_goal; ALTER TABLE task_consents DROP COLUMN root_task_id; DROP TABLE task_goals; DROP TABLE task_dependencies; DROP TABLE task_mail_reply_cursors; DROP TABLE task_flow_migrations;');
  consent = new TaskConsent({ file, inbox });
  try {
    assert.equal(String(db.prepare('SELECT json FROM task_consents WHERE id=?').get(task.id)!.json), original);
    assert.equal(consent.get(task.id)?.executionEventId, executionId); assert.equal(consent.tasks().length, 1);
    const child = consent.proposeOperation(task.id, 'question-mail', { caseId: 'work', title: 'Clarification', objective: 'Send one question', expectedOutput: 'Receipt',
      capabilities: ['mail'], mail: { connectionId: 'fixture-mail', credentialRevision: 1, mode: 'send', to: ['pm@example.test'], cc: [], bcc: [], subject: 'Question',
        body: 'Exact approved body', attachments: [], protection: 'plaintext' } });
    assert.equal(consent.tasks().length, 1); assert.equal(inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    consent.approve(child.id, child.revision); assert.equal(consent.operations(task.id).length, 2);
    const rootTask = consent.get(task.id)!; consent.revoke(task.id, rootTask.revision);
    assert.equal(consent.get(child.id)?.state, 'revoked');
    assert.throws(() => consent.assertApproved(child.id, 'work', 'mail'), /原任务|失效/);
    assert.throws(() => consent.begin(child.id, consent.get(child.id)!.approvalRevision!), /原任务|失效/);
    const exported = consent.exportFlow(); assert.equal(exported.operations.length, 2);
    consent.close(); consent = new TaskConsent({ file, inbox });
    assert.equal(consent.tasks().length, 1); assert.equal(consent.get(task.id)?.state, 'revoked');
    assert.equal(consent.get(child.id)?.state, 'revoked');
  } finally { consent.close(); db.close(); inbox.close(); }
});

test('active legacy native questions migrate without changing native history, granting resources or replaying execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-native-question-migration-')), file = path.join(directory, 'events.sqlite');
  const inbox = new EventInbox(file), db = new DatabaseSync(file);
  let consent = new TaskConsent({ file, inbox });
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: 'D:\\fixture\\project', network: false });
  const task = consent.request({ caseId: 'work', title: 'Existing work', objective: 'Implement the already approved feature', expectedOutput: 'Verified code', capabilities: ['project'], project: spec }, 'original-owner-request');
  consent.begin(task.id, task.approvalRevision!);
  const broker = new ProjectBroker(db, { device: id => ({ id, name: 'fixture', platform: 'win32', online: true, grants: [], capabilities: [localProjectCapability], createdAt: task.createdAt }),
    assertActive() {}, changed() {}, result() {}, send() {} });
  const input: ProjectExecutionInput = { operationId: 'legacy-operation', taskId: task.id, runId: 'legacy-run', approvalRevision: task.approvalRevision!, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: task.spec.title, objective: task.spec.objective, expectedOutput: task.spec.expectedOutput,
    ownerRequest: task.spec.objective, updates: [], model: { model: 'fixture', reasoningEffort: 'auto', maxOutputTokens: null }, stepLimit: 7, deadline: 2000000000000, issuedAt: task.createdAt };
  const running = broker.run(input, { signal: new AbortController().signal, guard() {}, onEvent() {}, model: async () => {}, context: async () => ({}) });
  let sequence = 0;
  const record = (event: ProjectEvent['event']) => broker.record('fixture', { operationId: input.operationId, sequence: ++sequence, requirementsRevision: 1, at: new Date().toISOString(), event });
  record({ kind: 'started', threadId: 'original-thread', engineVersion: 'old', realPath: spec.root, identity: 'original-identity' });
  record({ kind: 'interaction', id: 'old-question', type: 'question', method: 'item/tool/call', title: '选择布局', detail: '请选择布局。',
    request: { questions: [{ id: 'layout', question: '选择哪个布局？' }] } });
  record({ kind: 'environment', state: 'closed', terminals: [] }); record({ kind: 'paused', reason: 'shutdown pause' }); await running;
  const nativeBefore = String(db.prepare('SELECT json FROM local_project_operations WHERE id=?').get(input.operationId)!.json);
  const consentBefore = String(db.prepare('SELECT json FROM task_consents WHERE id=?').get(task.id)!.json);
  try {
    consent.migrateNativeInputs();
    const dependency = consent.dependencies(task.id)[0];
    assert.equal(dependency.questions[0].key, 'layout'); assert.equal(dependency.state, 'waiting');
    assert.equal(consent.task(task.id)?.flow?.phase, 'waiting_input');
    assert.equal(String(db.prepare('SELECT json FROM local_project_operations WHERE id=?').get(input.operationId)!.json), nativeBefore);
    assert.equal(String(db.prepare('SELECT json FROM task_consents WHERE id=?').get(task.id)!.json), consentBefore);
    assert.equal(inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    consent.close(); consent = new TaskConsent({ file, inbox }); consent.migrateNativeInputs();
    assert.equal(consent.dependencies(task.id).length, 1); assert.equal(consent.dependencies(task.id)[0].id, dependency.id);
    assert.equal(broker.forTask(task.id)?.input.stepLimit, 7); assert.equal(broker.forTask(task.id)?.input.deadline, 2000000000000);
  } finally { consent.close(); db.close(); inbox.close(); }
});

test('mail-scoped cursors retire the global cursor without losing an earlier reply or mutating task/input evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-mail-cursor-migration-')), file = path.join(directory, 'events.sqlite');
  const inbox = new EventInbox(file), db = new DatabaseSync(file);
  let consent = new TaskConsent({ file, inbox });
  try {
    const parent = consent.request({ caseId: 'work', title: 'Fixture', objective: 'Clarify one rule', expectedOutput: 'Confirmed rule', capabilities: ['artifact'] }, 'owner');
    consent.begin(parent.id, parent.approvalRevision!);
    const pending = consent.proposeClarification(parent.id, { key: 'rule', summary: 'Confirm rule', questions: [{ key: 'rule', question: 'Which rule?', blocks: 'Implementation' }] }, [{
      key: 'mail', questionKeys: ['rule'], spec: { caseId: 'work', title: 'Ask rule', objective: 'Confirm rule', expectedOutput: 'Reply', capabilities: ['mail'],
        mail: { connectionId: 'mailbox', credentialRevision: 1, mode: 'send', to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Fixture', body: 'Which rule?', attachments: [], protection: 'plaintext' } },
    }]);
    const event = inbox.ingest({ sourceId: 'connector:mailbox', sourceGeneration: 'mailbox', externalId: 'early-reply', kind: 'connector.change',
      actor: 'external', operation: 'create', caseId: 'work', occurredAt: new Date().toISOString(), payload: { provider: 'ews', content: 'RULE' } }).event;
    const tasksBefore = db.prepare('SELECT id,json FROM task_consents ORDER BY id').all();
    const inputsBefore = db.prepare('SELECT id,json FROM task_dependencies ORDER BY id').all();
    consent.close();
    db.exec('DROP TABLE task_mail_reply_cursors; CREATE TABLE task_flow_cursor(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL); INSERT INTO task_flow_cursor VALUES(1,99999)');
    consent = new TaskConsent({ file, inbox });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='task_flow_cursor'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT id,json FROM task_consents ORDER BY id').all(), tasksBefore);
    assert.deepEqual(db.prepare('SELECT id,json FROM task_dependencies ORDER BY id').all(), inputsBefore);
    assert.equal(consent.exportFlow().migrations.find(value => value.kind === 'mail-scoped-reply-cursors')?.retiredGlobalCursor, 99999);
    const mail = pending.operations[0];
    const received = consent.replyEvents(pending.dependency.id, mail.id);
    assert.deepEqual(received.events.map(value => value.event.id), [event.id]);
    consent.acknowledgeReplyEvent(pending.dependency.id, mail.id, received.through);
    const exported = consent.exportFlow(); consent.close(); consent = new TaskConsent({ file, inbox });
    assert.deepEqual(consent.exportFlow(), exported);
    assert.equal(consent.replyEvents(pending.dependency.id, mail.id).events.length, 0);
    assert.equal(consent.dependency(pending.dependency.id)?.revision, pending.dependency.revision, 'Transport progress cannot invalidate an owner answer form');
  } finally { consent.close(); db.close(); inbox.close(); }
});

test('a reply arriving during review prevents early resolution; conflicting external answers reopen the question and cannot replace an owner answer', () => {
  const inbox = new EventInbox(':memory:'), consent = new TaskConsent({ file: ':memory:', inbox });
  try {
    const task = consent.request({ caseId: 'work', title: 'Clarify a rule', objective: 'Resolve the existing rule', expectedOutput: 'A confirmed rule', capabilities: ['artifact'] }, 'owner');
    consent.begin(task.id, task.approvalRevision!);
    const wait = consent.waitForInput(task.id, { key: 'rule', summary: '确认规则', questions: [{ key: 'rule', question: '采用哪个规则？', blocks: '实现' }] });
    const reply = (externalId: string) => inbox.ingest({ sourceId: 'connector:mail', sourceGeneration: 'mail', externalId, kind: 'connector.change', actor: 'external',
      caseId: 'work', operation: 'create', occurredAt: new Date().toISOString(), payload: { provider: 'ews', content: externalId } }).event;
    const first = reply('first'), second = reply('conflicting');
    consent.addReplyCandidate(wait.id, first.id); consent.addReplyCandidate(wait.id, second.id);
    let current = consent.dependency(wait.id)!;
    current = consent.answerDependency(wait.id, current.revision, [{ questionKey: 'rule', content: 'A', evidenceEventIds: [first.id], actor: 'external', at: first.occurredAt }], [first.id]);
    assert.equal(current.state, 'reviewing', 'A second unreviewed reply must keep the dependency open');
    current = consent.answerDependency(wait.id, current.revision, [], [second.id], [{ questionKey: 'rule', reason: '两封回复采用不同规则。' }]);
    assert.equal(current.state, 'waiting'); assert.equal(current.answers.length, 0); assert.ok(current.unresolved?.rule);
    const owner = inbox.ingestProcessed({ sourceId: 'owner-task-action', externalId: 'answer', kind: 'owner.task_answer', actor: 'owner',
      caseId: 'work', operation: 'create', occurredAt: new Date().toISOString(), payload: { taskId: task.id, dependencyId: wait.id, answers: { rule: 'Owner decision' } } });
    current = consent.answerDependency(wait.id, current.revision, [{ questionKey: 'rule', content: 'Owner decision', evidenceEventIds: [owner.id], actor: 'owner', at: owner.occurredAt }]);
    assert.equal(current.state, 'resolved'); assert.equal(current.answers[0].actor, 'owner');
    assert.throws(() => consent.answerDependency(wait.id, current.revision, [{ questionKey: 'rule', content: 'External override', evidenceEventIds: [first.id], actor: 'external', at: first.occurredAt }]), /已经结束/);
    assert.equal(consent.dependency(wait.id)?.answers[0].content, 'Owner decision');
  } finally { consent.close(); inbox.close(); }
});
