import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EWS_MAIL_OPERATION_PREFIX, mailTaskSpecSchema, type EwsMailOperation, type MailTaskSpec } from '../shared/mail.js';
import { taskOutcomeEvidenceSchema } from '../shared/personal-memory.js';
import type { TaskRecord, TaskSpec } from '../shared/task-consent.js';
import type { Run } from '../shared/types.js';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { mailOperationId, mailSpecHash, MailOutcomeUnknownError } from '../server/v2/mail-results.js';
import { MockLanguageModelV4 } from './support/model.js';
import type { ConnectorService } from '../server/connectors/service.js';
import type { StoredEvent } from '../server/v2/events.js';
import type { TaskExecutor } from '../server/v2/task-execution.js';
import { RunResponse } from '../server/v2/run-response.js';

const usage = { inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }],
  usage, warnings: [], finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Mail fixture did not reach its gate')), 10_000); })]); }
  finally { clearTimeout(timer); }
}
function until(runtime: V2Coordinator, check: () => boolean): Promise<void> { return bounded(new Promise<void>(done => {
  const run = () => { if (check()) { detach(); done(); } }; const detach = runtime.subscribe(run); run();
})); }
const mail = (body: string | undefined = 'Exact owner supplied body'): MailTaskSpec => mailTaskSpecSchema.parse({ connectionId: 'mailbox-one', credentialRevision: 1,
  mode: 'send', to: ['recipient@example.test'], subject: 'Exact approved subject', protection: 'plaintext', ...(body !== undefined ? { body } : {}) });
const spec = (caseId: string, body?: string): TaskSpec => ({ caseId, title: 'One exact mail', objective: 'Send the requested concise progress update to the approved address',
  expectedOutput: 'Exchange submission receipt', capabilities: ['mail'], mail: mail(body) });
function operation(task: TaskRecord, state: EwsMailOperation['state'], body?: string): EwsMailOperation { return {
  id: mailOperationId(task.id), taskId: task.id, caseId: task.spec.caseId, approvalRevision: task.approvalRevision!, requirementsRevision: task.requirementsRevision ?? 1,
  specHash: mailSpecHash(task.spec.mail!), connectionId: task.spec.mail!.connectionId, credentialRevision: task.spec.mail!.credentialRevision, state,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(body ? { body } : {}) }; }
async function fixture(respond: MockLanguageModelV4['doGenerate'], control?: { entered?: ReturnType<typeof gate>; release?: ReturnType<typeof gate>; aborted?: ReturnType<typeof gate>; state?: EwsMailOperation['state'] }) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-mail-executor-')); const store = new Store(directory); store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({ doGenerate: respond }) });
  const connectors = (runtime as unknown as { connectors: ConnectorService }).connectors;
  const scene = await runtime.createCase({ title: 'Mail task fixture', objective: 'One authorized mail task', domain: 'fixture' });
  await store.updateSettings({ enabled: true, maxStepsPerRun: 5 });
  let sends = 0; let allowed = true; const payloads: string[] = [];
  connectors.prepareMailTaskScope = (_case, value) => mailTaskSpecSchema.parse(value);
  connectors.assertEwsMailTaskScope = () => { if (!allowed) throw new Error('Fixture connection revoked'); };
  connectors.getEwsMailTaskContext = () => undefined;
  connectors.operationForMailTask = taskId => store.getMeta<EwsMailOperation | undefined>(EWS_MAIL_OPERATION_PREFIX + taskId, undefined);
  connectors.executeEwsMailTask = async (task, input) => {
    const existing = connectors.operationForMailTask(task.id);
    if (existing && ['submitted', 'unknown', 'failed'].includes(existing.state)) return existing;
    input.guard(); input.signal.throwIfAborted();
    const body = existing?.body ?? task.spec.mail!.body ?? input.body;
    assert.ok(body); payloads.push(body); sends++;
    const prepared = existing ?? operation(task, 'prepared', body);
    input.signal.addEventListener('abort', () => control?.aborted?.resolve(), { once: true });
    store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, { ...prepared, state: 'submitting', phase: 'dispatching' });
    control?.entered?.resolve(); if (control?.release) await control.release.promise;
    // Simulate a native POST that was already dispatched: its accepted outcome
    // remains a fact even if the owner revoked while that call was in flight.
    const settled = { ...prepared, state: control?.state ?? 'submitted', updatedAt: new Date().toISOString() };
    store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, settled); return settled;
  };
  return { directory, store, runtime, connectors, scene, sends: () => sends, payloads, revokeConnection: () => { allowed = false; },
    async close() { control?.release?.resolve(); await runtime.close(); store.close(); } };
}

test('exact owner body follows the single approved native executor without a model or duplicate submission', async () => {
  let models = 0; const f = await fixture(async () => { models++; throw new Error('Exact body needs no inference'); });
  try {
    const task = await f.runtime.requestTask({ requestId: 'exact-mail', spec: spec(f.scene.id, 'OWNER_EXACT_TEXT') });
    assert.equal(f.sends(), 0); f.runtime.start();
    await until(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    assert.equal(f.sends(), 1); assert.deepEqual(f.payloads, ['OWNER_EXACT_TEXT']); assert.equal(models, 0);
    assert.equal(f.runtime.consent.get(task.id)?.mailReceipt?.state, 'submitted');
    const event = f.runtime.inbox.get(task.executionEventId!)!;
    await (f.runtime as unknown as { taskExecutor: { accept(event: StoredEvent): Promise<void> } }).taskExecutor.accept(event);
    assert.equal(f.sends(), 1);
    assert.ok(f.store.list('messages').some(message => message.content.includes('Exchange 接受提交')));
    const run = f.store.list('runs').find(item => item.taskId === task.id)!;
    assert.equal(run.steps, 0);
    const outcome = taskOutcomeEvidenceSchema.parse(f.runtime.inbox.get(run.taskOutcomeEventId!)?.payload.outcome);
    assert.equal(outcome.operations[0]?.id, f.runtime.consent.get(task.id)?.mailReceipt?.operationId);
    assert.equal(outcome.checks.find(check => check.name === 'mail.submission')?.passed, true);
    assert.doesNotMatch(JSON.stringify(outcome), /OWNER_EXACT_TEXT|recipient@example.test/);
  } finally { await f.close(); }
});

test('body composition exists only inside approved execution and tool cannot modify recipients or scope', async () => {
  let models = 0; const f = await fixture(async options => {
    models++; const names = options.tools?.map(tool => tool.name) ?? [];
    assert.ok(names.includes('submit_mail_body')); assert.ok(!names.includes('request_task') && !names.includes('write_workspace') && !names.includes('publish_artifact'));
    assert.match(JSON.stringify(options.prompt), /recipient@example.test|Exact approved subject/);
    if (models === 1) return call('submit_mail_body', { body: 'APPROVED_EXECUTOR_COMPOSED_TEXT' });
    return answer('Exchange 已接受提交。');
  });
  try {
    const input = spec(f.scene.id); delete input.mail!.body;
    const task = await f.runtime.requestTask({ requestId: 'compose-mail', spec: input });
    assert.equal(models, 0); f.runtime.start(); await until(f.runtime, () => ['completed', 'failed'].includes(f.runtime.consent.get(task.id)?.state ?? ''));
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed', f.runtime.consent.get(task.id)?.error ?? 'Mail task did not complete');
    assert.equal(models, 2); assert.equal(f.sends(), 1); assert.deepEqual(f.payloads, ['APPROVED_EXECUTOR_COMPOSED_TEXT']);
    assert.equal(f.runtime.consent.get(task.id)?.spec.mail?.body, undefined);
    assert.equal(f.connectors.operationForMailTask(task.id)?.body, 'APPROVED_EXECUTOR_COMPOSED_TEXT');
  } finally { await f.close(); }
});

test('revoking a native mail task drains the in-flight mutation and keeps a late accepted receipt without restoring consent', async () => {
  const entered = gate(); const release = gate(); const aborted = gate(); const f = await fixture(async () => { throw new Error('No inference'); }, { entered, release, aborted });
  try {
    const task = await f.runtime.requestTask({ requestId: 'cancel-mail', spec: spec(f.scene.id, 'Exact body') }); f.runtime.start();
    await bounded(entered.promise); let stopped = false;
    const current = f.runtime.consent.get(task.id)!;
    const cancel = f.runtime.revokeTask(task.id, current.revision).then(() => { stopped = true; });
    await bounded(aborted.promise); assert.equal(stopped, false); assert.equal(f.runtime.consent.get(task.id)?.state, 'revoked');
    release.resolve(); await bounded(cancel);
    assert.equal(f.sends(), 1); assert.equal(f.runtime.consent.get(task.id)?.state, 'revoked');
    assert.equal(f.runtime.consent.get(task.id)?.mailReceipt?.state, 'submitted');
    assert.equal(f.connectors.operationForMailTask(task.id)?.state, 'submitted');
    assert.throws(() => f.runtime.consent.assertApproved(task.id, f.scene.id, 'mail'));
  } finally { release.resolve(); await f.close(); }
});

test('unknown mail outcome fails explicitly and recovery never blindly submits again or invokes a model', async () => {
  let models = 0; const f = await fixture(async () => { models++; throw new Error('No inference'); }, { state: 'unknown' });
  try {
    const task = await f.runtime.requestTask({ requestId: 'unknown-mail', spec: spec(f.scene.id, 'Exact body') }); f.runtime.start();
    await until(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed'
      && !(f.runtime as unknown as { taskExecutor: { hasTask(id: string): boolean } }).taskExecutor.hasTask(task.id));
    assert.equal(f.sends(), 1); assert.equal(models, 0); assert.match(f.runtime.consent.get(task.id)?.error ?? '', /未知.*不会自动重发/);
    await (f.runtime as unknown as { taskExecutor: { recover(): Promise<void> } }).taskExecutor.recover();
    assert.equal(f.sends(), 1); assert.equal(models, 0);
    assert.equal(f.runtime.consent.get(task.id)?.mailReceipt?.state, 'unknown');
  } finally { await f.close(); }
});

test('a durable submitted receipt settles an interrupted composing run with its original exhausted budget', async () => {
  let models = 0; const f = await fixture(async () => { models++; throw new Error('Do not replay interrupted composition'); });
  try {
    const input = spec(f.scene.id); delete input.mail!.body;
    const admitted = f.runtime.consent.request(input, 'interrupted-compose');
    const task = f.runtime.consent.begin(admitted.id, admitted.approvalRevision!);
    const run: Run = { id: 'interrupted-mail-run', taskId: task.id, caseId: f.scene.id, eventId: task.executionEventId!, trigger: 'manual', mode: 'execution', status: 'interrupted',
      startedAt: new Date().toISOString(), inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', steps: 5, toolCallsStarted: 1,
      taskExecution: { requirementsRevision: 1, deadline: Date.now() - 1000, stepLimit: 5, modelStarted: true } };
    f.store.insert('runs', run); f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation(task, 'submitted', 'DURABLE_ALREADY_SENT_BODY'));
    await (f.runtime as unknown as { taskExecutor: { recover(): Promise<void> } }).taskExecutor.recover();
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed'); assert.equal(f.sends(), 0); assert.equal(models, 0);
    const resolved = f.store.get('runs', run.id)!; assert.equal(resolved.status, 'completed'); assert.equal(resolved.steps, 5);
    assert.equal(resolved.taskExecution?.deadline, run.taskExecution?.deadline); assert.equal(resolved.taskExecution?.stepLimit, 5);
    assert.doesNotMatch(JSON.stringify(f.store.list('messages')), /DURABLE_ALREADY_SENT_BODY/);
  } finally { await f.close(); }
});

for (const fault of ['run_projection', 'event_acknowledgement', 'outcome_journal'] as const) {
  test(`mail receipt recovery repairs ${fault} without duplicate public text or another submission`, async () => {
    let models = 0; const f = await fixture(async () => { models++; throw new Error('Receipt recovery cannot infer'); });
    const executor = (f.runtime as unknown as { taskExecutor: TaskExecutor }).taskExecutor;
    const put = f.store.put.bind(f.store); const consume = f.runtime.inbox.consumeLocal.bind(f.runtime.inbox);
    try {
      const admitted = f.runtime.consent.request(spec(f.scene.id), `mail-fault-${fault}`);
      const task = f.runtime.consent.begin(admitted.id, admitted.approvalRevision!);
      const run: Run = { id: `mail-fault-${fault}`, taskId: task.id, caseId: f.scene.id, eventId: task.executionEventId!,
        trigger: 'manual', mode: 'execution', status: 'interrupted', startedAt: new Date().toISOString(),
        inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', steps: 2, toolCallsStarted: 1,
        taskExecution: { requirementsRevision: 1, deadline: Date.now() - 1000, stepLimit: 2, modelStarted: true } };
      f.store.insert('runs', run);
      f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation(task, 'submitted', 'ALREADY_SENT_BODY'));
      const original = new RunResponse(f.store, { runId: run.id, caseId: f.scene.id, replyTo: 'owner-anchor', automatic: true, assertOwned() {} });
      original.append('PRESERVED_PARTIAL_PUBLIC_TEXT'); original.finish('incomplete', 'Original interruption'); original.dispose();
      let injected = false;
      f.store.put = (kind, value) => {
        if (!injected && kind === 'runs' && value.id === run.id && (fault === 'run_projection' && Boolean((value as Run).taskExecution?.recoveryReceiptHash)
          || fault === 'outcome_journal' && Boolean((value as Run).taskOutcomeEventId))) {
          injected = true; throw new Error('Injected mail projection failure');
        }
        return put(kind, value);
      };
      f.runtime.inbox.consumeLocal = (...args) => {
        if (!injected && fault === 'event_acknowledgement' && args[0].includes('task.execute')) {
          injected = true; throw new Error('Injected mail acknowledgement failure');
        }
        return consume(...args);
      };
      if (fault === 'outcome_journal') await executor.recover();
      else await assert.rejects(executor.recover(), /Injected mail/);
      assert.equal(injected, true);
      f.store.put = put; f.runtime.inbox.consumeLocal = consume;
      await executor.recover();
      let repeatedWrites = 0; const detach = f.store.subscribe(() => { repeatedWrites++; });
      try { await executor.recover(); } finally { detach(); }
      assert.equal(repeatedWrites, 0, 'An already repaired receipt does not rewrite idle history');
      const message = f.store.get('messages', original.id)!;
      assert.equal(message.content, 'PRESERVED_PARTIAL_PUBLIC_TEXT\n\n邮件已由 Exchange 接受提交。此回执不表示对方已收到或已读。');
      assert.equal(message.replyTo, 'owner-anchor'); assert.equal(message.outputState, 'complete');
      const saved = f.store.get('runs', run.id)!;
      assert.equal(saved.status, 'completed'); assert.equal(saved.steps, 2); assert.equal(saved.taskExecution?.deadline, run.taskExecution!.deadline);
      assert.equal(f.runtime.inbox.get(task.executionEventId!)?.status, 'processed');
      assert.ok(saved.taskOutcomeEventId); assert.equal(f.runtime.inbox.get(saved.taskOutcomeEventId!)?.status, 'processed');
      assert.equal(f.sends(), 0); assert.equal(models, 0);
    } finally { f.store.put = put; f.runtime.inbox.consumeLocal = consume; await f.close(); }
  });
}

test('a safely prepared journal resumes its durable composed body without replaying composition or resetting limits', async () => {
  let models = 0; const f = await fixture(async () => { models++; throw new Error('Prepared body must not be recomposed'); });
  try {
    const input = spec(f.scene.id); delete input.mail!.body;
    const admitted = f.runtime.consent.request(input, 'prepared-compose'); const task = f.runtime.consent.begin(admitted.id, admitted.approvalRevision!);
    const run: Run = { id: 'prepared-mail-run', taskId: task.id, caseId: f.scene.id, eventId: task.executionEventId!, trigger: 'manual', mode: 'execution', status: 'interrupted',
      startedAt: new Date().toISOString(), inputTokens: 0, outputTokens: 0, usageStatus: 'not_used', steps: 2, toolCallsStarted: 1,
      taskExecution: { requirementsRevision: 1, deadline: Date.now() + 20_000, stepLimit: 5, modelStarted: true } };
    f.store.insert('runs', run); f.store.setMeta(EWS_MAIL_OPERATION_PREFIX + task.id, operation(task, 'prepared', 'PREPARED_DURABLE_COMPOSED_TEXT'));
    await (f.runtime as unknown as { taskExecutor: { recover(): Promise<void> } }).taskExecutor.recover(); f.runtime.start();
    await until(f.runtime, () => ['completed', 'failed'].includes(f.runtime.consent.get(task.id)?.state ?? '')
      && !(f.runtime as unknown as { taskExecutor: { hasTask(id: string): boolean } }).taskExecutor.hasTask(task.id));
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed', f.runtime.consent.get(task.id)?.error ?? 'Prepared mail failed');
    assert.equal(f.sends(), 1); assert.deepEqual(f.payloads, ['PREPARED_DURABLE_COMPOSED_TEXT']); assert.equal(models, 0);
    const saved = f.store.get('runs', run.id)!; assert.equal(saved.steps, 2); assert.equal(saved.taskExecution?.deadline, run.taskExecution?.deadline);
    assert.equal(saved.taskExecution?.stepLimit, 5);
  } finally { await f.close(); }
});

test('revoked connection identity blocks an admitted mail task before composing text or dispatching native work', async () => {
  let models = 0; const f = await fixture(async () => { models++; throw new Error('Revoked source must never enter composition'); });
  try {
    const input = spec(f.scene.id); delete input.mail!.body;
    const task = await f.runtime.requestTask({ requestId: 'revoke-before-model', spec: input }); f.revokeConnection(); f.runtime.start();
    await until(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed'
      && !(f.runtime as unknown as { taskExecutor: { hasTask(id: string): boolean } }).taskExecutor.hasTask(task.id));
    assert.equal(models, 0); assert.equal(f.sends(), 0); assert.equal(f.connectors.operationForMailTask(task.id), undefined);
  } finally { await f.close(); }
});

test('approval of a chat reply proposal validates its retained exact source without reinterpreting it as a UI selection', async () => {
  const f = await fixture(async () => { throw new Error('Approval is not inference'); });
  try {
    const source = await f.runtime.ingestOwnerMessage('Propose a reply to this selected email; do not send it yet.', f.scene.id);
    const input = spec(f.scene.id, 'Exact reply body'); input.mail = { ...input.mail!, mode: 'reply',
      source: { contextId: 'context-bound-to-owner-chat', messageId: 'original-message', revision: 'original-revision' } };
    const proposed = f.runtime.consent.propose(input, source.id);
    f.connectors.prepareMailTaskScope = () => { throw new Error('A retained chat selection must not be reinterpreted as a new UI selection'); };
    const approved = await f.runtime.approveTask(proposed.id, proposed.revision);
    assert.equal(approved.state, 'approved'); assert.deepEqual(approved.spec.mail, input.mail); assert.equal(f.sends(), 0);
    const proposed2 = f.runtime.consent.propose({ ...input, title: 'Another reply proposal' }, source.id);
    f.revokeConnection(); await assert.rejects(f.runtime.approveTask(proposed2.id, proposed2.revision), /revoked/);
    assert.equal(f.runtime.consent.get(proposed2.id)?.state, 'proposed'); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('cancellation waits for an uncertain native outcome and returns a concrete conflict with the durable unknown receipt', async () => {
  const entered = gate(); const release = gate(); const aborted = gate();
  const f = await fixture(async () => { throw new Error('No inference'); }, { entered, release, aborted, state: 'unknown' });
  try {
    const task = await f.runtime.requestTask({ requestId: 'cancel-unknown-mail', spec: spec(f.scene.id, 'Exact body') }); f.runtime.start();
    await bounded(entered.promise); const current = f.runtime.consent.get(task.id)!;
    const cancellation = f.runtime.revokeTask(task.id, current.revision);
    const rejected = assert.rejects(cancellation, error => error instanceof MailOutcomeUnknownError && error.status === 409 && /未知/.test(error.message));
    await bounded(aborted.promise); release.resolve(); await bounded(rejected);
    assert.equal(f.sends(), 1); assert.equal(f.runtime.consent.get(task.id)?.state, 'revoked');
    assert.equal(f.runtime.consent.get(task.id)?.mailReceipt?.state, 'unknown');
  } finally { release.resolve(); await f.close(); }
});
