import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, KERNEL_SCHEMA_VERSION } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { CaseMemory } from '../server/v2/memory.js';
import { DatabaseSync } from 'node:sqlite';
import { localProjectCapability, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectContractCapability } from '../shared/project-contract.js';
import { projectSpecHash } from '../server/devices/projects.js';
import { MockLanguageModelV4 } from './support/model.js';

test('a newer kernel data version is rejected before this writer migrates the records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-kernel-version-'));
  const store = new Store(directory);
  store.setMeta('kernel.schemaVersion', KERNEL_SCHEMA_VERSION + 1); store.close();
  assert.throws(() => new Store(directory), /不支持此内核数据版本/);
});

test('an interrupted kernel migration retains its journal and original data and completes once on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-kernel-migration-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const message = { id: 'existing-owner-message', role: 'user' as const, content: '保留这条原始消息。', createdAt: '2026-11-01T00:00:00.000Z' };
  store.insert('messages', message);
  const original = CaseMemory.prototype.init;
  CaseMemory.prototype.init = async () => { throw new Error('INJECTED_MIGRATION_BOUNDARY'); };
  try { await assert.rejects(V2Coordinator.create(store, { dataDir: directory }), /INJECTED_MIGRATION_BOUNDARY/); }
  finally { CaseMemory.prototype.init = original; }
  assert.equal(store.getMeta('kernel.schemaVersion', 1), 1);
  const begun = store.getMeta<{ state: string; startedAt: string }>('kernel.migration', { state: '', startedAt: '' });
  assert.equal(begun.state, 'preparing');
  let runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    assert.equal(store.getMeta('kernel.schemaVersion', 1), KERNEL_SCHEMA_VERSION);
    assert.equal(store.getMeta<{ state: string }>('kernel.migration', { state: '' }).state, 'complete');
    assert.equal(store.getMeta<{ startedAt: string }>('kernel.migration', { startedAt: '' }).startedAt, begun.startedAt);
    assert.equal(store.get('messages', message.id)?.content, message.content);
    assert.equal(store.getSettings().enabled, false);
    const completed = store.getMeta('kernel.migration', null);
    await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory });
    assert.deepEqual(store.getMeta('kernel.migration', null), completed);
    assert.equal(store.list('runs').length, 0);
  } finally { await runtime.close(); store.close(); }
});

test('upgrading the first-round kernel preserves its completed migration and records the new source-aware schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-kernel-following-migration-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const previous = { from: 1, to: 2, state: 'complete', startedAt: '2026-11-07T00:00:00.000Z', completedAt: '2026-11-07T00:00:01.000Z' };
  store.setMeta('kernel.schemaVersion', 2); store.setMeta('kernel.migration', previous);
  let runtime = await V2Coordinator.create(store, { dataDir: directory });
  try {
    const current = store.getMeta<{ from: number; to: number; state: string }>('kernel.migration', { from: 0, to: 0, state: '' });
    assert.equal(current.from, 2); assert.equal(current.to, KERNEL_SCHEMA_VERSION); assert.equal(current.state, 'complete');
    assert.deepEqual(store.getMeta('kernel.migrationHistory', []), [previous]);
    await runtime.close(); runtime = await V2Coordinator.create(store, { dataDir: directory });
    assert.deepEqual(store.getMeta('kernel.migration', null), current);
    assert.deepEqual(store.getMeta('kernel.migrationHistory', []), [previous]);
    assert.equal(store.getSettings().enabled, false);
    assert.equal(store.list('runs').length, 0);
  } finally { await runtime.close(); store.close(); }
});

test('schema 8 upgrades to the v2-aware writer without changing legacy task consent, native receipts or owner attachment bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-kernel-v9-'));
  let store = new Store(directory); store.getApiKey = () => undefined;
  let modelCalls = 0, dispatches = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('Migration cannot run a model'); } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const scene = await runtime.createCase({ title: 'Historical project', objective: '', domain: 'fixture' });
  const device = runtime.devices.enroll({ name: 'Historical client', platform: 'win32', pairingToken: runtime.devices.createPairing().token }).device;
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability] });
  const bytes = Buffer.from('Original attachment\r\n原始内容\n');
  const source = await runtime.ingestOwnerMessage('按本次原件整理结果。', scene.id, undefined, undefined, undefined, device.id, undefined,
    [{ name: 'original.txt', mediaType: 'text/plain', data: bytes.toString('base64') }]);
  const message = store.get('messages', source.externalId)!;
  const attachmentId = message.files![0].id;
  const task = await runtime.requestTask({ requestId: 'historical-project', spec: { caseId: scene.id, title: 'Historical work',
    objective: 'Preserve the original task', expectedOutput: 'A report', capabilities: ['project'],
    project: { deviceId: device.id, root: 'D:\\historical', access: 'read-write', readAccess: 'project', network: false, create: false } } });
  runtime.consent.begin(task.id, task.approvalRevision!);
  const input: ProjectExecutionInput = { operationId: 'historical-operation', taskId: task.id, runId: 'historical-run',
    approvalRevision: task.approvalRevision!, requirementsRevision: 1, spec: task.spec.project!, specHash: projectSpecHash(task.spec.project!),
    title: task.spec.title, objective: task.spec.objective, expectedOutput: task.spec.expectedOutput, ownerRequest: 'Original approved request',
    updates: [], model: { model: 'historical-model', reasoningEffort: 'default', maxOutputTokens: null },
    stepLimit: 7, deadline: Date.parse('2026-11-01T00:00:00.000Z'), issuedAt: '2026-10-31T00:00:00.000Z', contract: { version: 1, criteria: ['Legacy check'] } };
  const pending = runtime.devices.projects.run(input, { signal: new AbortController().signal, guard() {}, onEvent() {}, async model() {}, async context() {} });
  runtime.devices.projects.record(device.id, { operationId: input.operationId, sequence: 1, requirementsRevision: 1, at: '2026-10-31T00:01:00.000Z',
    event: { kind: 'tool', item: { id: 'old-operation', type: 'commandExecution', label: 'Original check', state: 'failed', exitCode: 1, output: 'Preserved diagnostic' } } });
  runtime.devices.projects.record(device.id, { operationId: input.operationId, sequence: 2, requirementsRevision: 1, at: '2026-10-31T00:02:00.000Z',
    event: { kind: 'finished', state: 'failed', output: 'Preserved partial result', error: 'Historical failure' } });
  await pending;
  const running = runtime.consent.get(task.id)!;
  runtime.consent.finish(task.id, running.revision, 'failed', 'Historical failure');
  await runtime.close();
  const priorJournal = { from: 7, to: 8, state: 'complete', startedAt: '2026-11-16T00:00:00.000Z', completedAt: '2026-11-16T00:00:01.000Z' };
  store.setMeta('kernel.schemaVersion', 8); store.setMeta('kernel.migration', priorJournal); store.close();
  const file = join(directory, 'v2-events.sqlite');
  const original = new DatabaseSync(file);
  const oldRow = original.prepare('SELECT json FROM task_consents WHERE id=?').get(task.id)!;
  const legacy = { ...JSON.parse(String(oldRow.json)), executionContractVersion: 1 };
  original.prepare('UPDATE task_consents SET json=? WHERE id=?').run(JSON.stringify(legacy), task.id);
  const snapshot = () => ({
    task: original.prepare('SELECT json,spec_json FROM task_consents WHERE id=?').get(task.id),
    operation: original.prepare('SELECT json FROM local_project_operations WHERE id=?').get(input.operationId),
    events: original.prepare('SELECT sequence,hash,json FROM local_project_events WHERE operation_id=? ORDER BY sequence').all(input.operationId),
    outbox: original.prepare('SELECT event_json,delivered_at FROM task_execution_outbox WHERE task_id=?').get(task.id),
  });
  const before = snapshot(); original.close();
  store = new Store(directory); store.getApiKey = () => undefined;
  runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const detach = runtime.devices.attach(device.id, message => { if (message.kind === 'project-execute') dispatches++; });
  try {
    assert.equal(store.getMeta('kernel.schemaVersion', 0), 9);
    assert.equal(KERNEL_SCHEMA_VERSION, 9);
    const journal = store.getMeta<{ from: number; to: number; state: string }>('kernel.migration', { from: 0, to: 0, state: '' });
    assert.deepEqual([journal.from, journal.to, journal.state], [8, 9, 'complete']);
    assert.ok(store.getMeta<unknown[]>('kernel.migrationHistory', []).some(value => JSON.stringify(value) === JSON.stringify(priorJournal)));
    const after = new DatabaseSync(file);
    try {
      assert.deepEqual(after.prepare('SELECT json,spec_json FROM task_consents WHERE id=?').get(task.id), before.task);
      assert.deepEqual(after.prepare('SELECT json FROM local_project_operations WHERE id=?').get(input.operationId), before.operation);
      assert.deepEqual(after.prepare('SELECT sequence,hash,json FROM local_project_events WHERE operation_id=? ORDER BY sequence').all(input.operationId), before.events);
      assert.deepEqual(after.prepare('SELECT event_json,delivered_at FROM task_execution_outbox WHERE task_id=?').get(task.id), before.outbox);
    } finally { after.close(); }
    assert.equal(runtime.consent.get(task.id)?.executionContractVersion, 1);
    assert.equal(runtime.devices.projects.forTask(task.id)?.input.stepLimit, 7);
    assert.equal(runtime.devices.projects.forTask(task.id)?.input.deadline, input.deadline);
    assert.deepEqual(store.readChatFile(attachmentId, message.id)!.data, bytes);
    assert.deepEqual(store.get('messages', message.id), message);
    assert.equal(store.getSettings().enabled, false);
    assert.equal(store.list('runs').length, 0); assert.equal(modelCalls, 0); assert.equal(dispatches, 0);
  } finally { detach(); await runtime.close(); store.close(); }
});
