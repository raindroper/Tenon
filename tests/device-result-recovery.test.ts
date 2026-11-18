import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';
import { DatabaseSync } from 'node:sqlite';
import { runResponseId } from '../server/v2/run-response.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function gate() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function waitFor(runtime: V2Coordinator, predicate: () => boolean) {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try { await new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) resolve(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error('Audit fixture timeout')), 15000); check();
  }); } finally { detach(); clearTimeout(timer); }
}
async function fixture(onModel: (options: Parameters<MockLanguageModelV4['doGenerate']>[0]) => void = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-directory-boundary-audit-'));
  const store = new Store(directory); store.getApiKey = () => undefined;
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    onModel(options); return { content: [{ type: 'text', text: 'Offline audit reply' }], usage, warnings: [], finishReason: { unified: 'stop', raw: 'stop' } };
  } });
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model });
  const item = await runtime.createCase({ title: 'Boundary review', objective: 'Offline transport fixtures', domain: 'audit' });
  const { device } = runtime.devices.enroll({ name: 'Audit fixture PC', platform: 'win32', pairingToken: runtime.devices.createPairing().token });
  runtime.devices.updateDevice(device.id, { grants: [], capabilities: ['local_directory_lookup', 'local_directory_entries'] });
  const command = { kind: 'list_directory' as const, deviceId: device.id, root: 'D:\\approved-fixture', entryType: 'directory' as const, limit: 100, timeoutMs: 30000 };
  const spec = { caseId: item.id, title: 'Lookup', objective: 'Read fixture directory', expectedOutput: 'Folder metadata', capabilities: ['local-command' as const], command };
  const result = { directory: command.root, entryType: 'directory', files: [{ name: 'SavedFolder', size: 0, modifiedAt: '2026-01-01T00:00:00.000Z' }], scanned: 1, truncated: false };
  await store.updateSettings({ enabled: true });
  return { directory, store, runtime, device, spec, result, model, async close() { await this.runtime.close(); store.close(); } };
}

test('a newer failed query does not hide a previous successful result from follow-up tools', async () => {
  let observedTools: string[] = [];
  const f = await fixture(options => { observedTools = (options.tools ?? []).map((tool: any) => tool.name); });
  let sent = 0;
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    f.runtime.devices.admit(f.device.id, { operationId: message.operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, ++sent === 1
      ? { operationId: message.operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) }
      : { operationId: message.operationId, state: 'failed', error: 'offline fixture failure' });
  });
  try {
    const first = await f.runtime.requestTask({ requestId: 'success', spec: f.spec }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(first.id)?.state === 'completed');
    const second = await f.runtime.requestTask({ requestId: 'failure', spec: f.spec });
    await waitFor(f.runtime, () => f.runtime.consent.get(second.id)?.state === 'failed');
    const event = await f.runtime.ingestOwnerMessage('前一次成功查到的文件夹是什么？', f.spec.caseId, undefined, undefined, undefined, f.device.id);
    await waitFor(f.runtime, () => f.runtime.inbox.get(event.id)?.status === 'processed');
    assert.equal(f.runtime.devices.operationForTask(first.id)?.receipt.state, 'completed');
    assert.equal(observedTools.includes('read_local_file_result'), true);
    const failedRun = f.store.list('runs').find(run => run.taskId === second.id)!;
    const quoted = await f.runtime.ingestOwnerMessage('这次失败的查询返回了什么？', f.spec.caseId, runResponseId(failedRun.id), undefined, undefined, f.device.id);
    await waitFor(f.runtime, () => f.runtime.inbox.get(quoted.id)?.status === 'processed');
    assert.equal(observedTools.includes('read_local_file_result'), false, 'a failed quoted task cannot silently use another result');
    const other = f.runtime.devices.enroll({ name: 'Other device', platform: 'win32', pairingToken: f.runtime.devices.createPairing().token }).device;
    const different = await f.runtime.ingestOwnerMessage('这台电脑之前返回了什么？', f.spec.caseId, undefined, undefined, undefined, other.id);
    await waitFor(f.runtime, () => f.runtime.inbox.get(different.id)?.status === 'processed');
    assert.equal(observedTools.includes('read_local_file_result'), false, 'saved results cannot cross a selected device');
  } finally { detach(); await f.close(); }
});

test('current task lookup uses its exact operation while archived lookup only falls back to a matching legacy run', async () => {
  let tools: string[] = [];
  const f = await fixture(options => { tools = (options.tools ?? []).map(tool => tool.name); });
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    f.runtime.devices.admit(f.device.id, { operationId: message.operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId: message.operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'exact-operation-lookup', spec: f.spec });
    const db = new DatabaseSync(join(f.directory, 'v2-events.sqlite'));
    try {
      db.prepare('INSERT INTO local_device_operations(id,task_id,device_id,json) VALUES(?,?,?,?)').run('earlier-unrelated-operation', task.id, f.device.id,
        JSON.stringify({ operationId: 'earlier-unrelated-operation', taskId: task.id, taskRevision: 2, runId: 'unrelated-run',
          spec: { ...f.spec.command, root: 'D:\\unapproved' }, specHash: 'unrelated', issuedAt: new Date().toISOString(), deadline: Date.now(),
          receipt: { operationId: 'earlier-unrelated-operation', state: 'completed', exitCode: 0, stdout: JSON.stringify({ ...f.result, directory: 'D:\\unapproved' }) } }));
    } finally { db.close(); }
    f.runtime.start(); await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    const ask = async () => {
      const event = await f.runtime.ingestOwnerMessage('刚才查到的文件夹是什么？', f.spec.caseId, undefined, undefined, undefined, f.device.id);
      await waitFor(f.runtime, () => f.runtime.inbox.get(event.id)?.status === 'processed');
      return tools.includes('read_local_file_result');
    };
    assert.equal(await ask(), true, 'An earlier unrelated operation must not hide the exact saved result.');
    const run = f.store.list('runs').find(value => value.taskId === task.id)!;
    const actual = f.runtime.devices.listOperations(task.id).find(value => value.runId === run.id)!;
    const changed = new DatabaseSync(join(f.directory, 'v2-events.sqlite'));
    try {
      changed.prepare('UPDATE local_device_operations SET id=?,json=? WHERE id=?').run('legacy-operation-id',
        JSON.stringify({ ...actual, operationId: 'legacy-operation-id', receipt: { ...actual.receipt, operationId: 'legacy-operation-id' } }), actual.operationId);
    } finally { changed.close(); }
    assert.equal(await ask(), false, 'A new workflow cannot silently use a different operation ID.');
    const { taskExecution: _execution, ...legacyRun } = run; f.store.put('runs', legacyRun);
    assert.equal(await ask(), true, 'Archived records can resolve their own matching historical operation ID.');
  } finally { detach(); await f.close(); }
});

test('pause drains a native call before final receipt recovery completes and never repeats execution', async () => {
  const f = await fixture(() => assert.fail('no model during pause or receipt recovery'));
  const started = gate(); const cancelled = gate(); let operationId = ''; let sends = 0;
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind === 'cancel') { cancelled.resolve(); return; }
    if (message.kind !== 'execute') return;
    sends++; operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'running' }); started.resolve();
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'pause-during-query', spec: f.spec }); f.runtime.start(); await started.promise;
    let stopped = false; const stop = f.runtime.stop().then(() => { stopped = true; });
    await cancelled.promise; await Promise.resolve(); assert.equal(stopped, false);
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
    await stop;
    assert.equal(stopped, true); assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.equal(f.runtime.status().state, 'paused'); assert.equal(sends, 1);
    assert.equal(f.store.list('messages').filter(message => message.content.includes('SavedFolder')).length, 1);
  } finally { detach(); await f.close(); }
});

test('startup repairs a crash after terminal receipt but before task, run and event completion', async () => {
  const f = await fixture(() => assert.fail('startup must not invoke the model')); let operationId = '';
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'receipt-before-crash', spec: f.spec }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    const run = f.store.list('runs').find(value => value.taskId === task.id)!;
    detach(); await f.runtime.close();
    // Persistent checkpoint immediately before run/task/event completion. The
    // native terminal receipt is durable and the worker is gone.
    f.store.put('runs', { ...run, status: 'running', endedAt: undefined });
    const db = new DatabaseSync(join(f.directory, 'v2-events.sqlite'));
    try {
      db.prepare("UPDATE task_consents SET state='running',revision=2,json=json_set(json,'$.state','running','$.revision',2) WHERE id=?").run(task.id);
      db.prepare("UPDATE events SET status='leased',lease_token='dead-worker',lease_until=? WHERE id=?").run(Date.now() + 30000, task.executionEventId!);
    } finally { db.close(); }
    f.runtime = await V2Coordinator.create(f.store, { dataDir: f.directory, model: f.model });
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.equal(f.store.get('runs', run.id)?.status, 'completed');
    assert.equal(f.runtime.inbox.get(task.executionEventId!)?.status, 'processed');
    assert.equal(f.runtime.devices.operationForTask(task.id)?.operationId, operationId);
    assert.equal(f.runtime.devices.listOperations().length, 1);
  } finally { detach(); await f.close(); }
});

test('a late success reconciles the task, run and one durable supplement without replay', async () => {
  const f = await fixture(); let operationId = '';
  const listConsents = f.runtime.consent.list;
  const listOperations = f.runtime.devices.listOperations;
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'unknown', error: 'receipt delayed in offline fixture' });
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'late-receipt', spec: f.spec }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed');
    f.runtime.consent.list = () => assert.fail('late receipt must not scan consent history');
    f.runtime.devices.listOperations = () => assert.fail('late receipt must not scan operation history');
    try {
      f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
      await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'completed');
    } finally {
      f.runtime.consent.list = listConsents;
      f.runtime.devices.listOperations = listOperations;
    }
    const state = await f.runtime.snapshot({ caseId: f.spec.caseId });
    const run = state.runs.find(value => value.taskId === task.id)!;
    const reply = state.messages.find(value => value.runId === run.id)!;
    assert.equal(f.runtime.devices.operationForTask(task.id)?.receipt.state, 'completed');
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.equal(run.status, 'completed');
    assert.equal(run.deviceResolution?.previousStatus, 'failed');
    assert.equal(reply.outputState, 'incomplete', 'original interrupted reply stays visible');
    const supplements = state.messages.filter(value => value.runId === run.id && value.id !== reply.id);
    assert.equal(supplements.length, 1);
    assert.match(supplements[0].content, /SavedFolder/);
    const before = JSON.stringify(state.messages);
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
    assert.equal(JSON.stringify((await f.runtime.snapshot({ caseId: f.spec.caseId })).messages), before);
    assert.equal(reply.content.includes('SavedFolder'), false);
    assert.equal(f.store.getMeta('v2.lastError', null), null);
  } finally { detach(); await f.close(); }
});

for (const executionKind of ['legacy', 'workflow'] as const) for (const fault of ['before-task', 'after-task-before-message', 'after-message-before-run'] as const) test(`restart repairs ${executionKind} final receipt delivery ${fault} with original authority and no replay`, async () => {
  let modelCalls = 0; let sends = 0; const f = await fixture(() => { modelCalls++; }); let operationId = '';
  let detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    sends++; operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'unknown', error: 'interrupted fixture' });
  });
  const put = f.store.put.bind(f.store);
  try {
    const task = await f.runtime.requestTask({ requestId: fault, spec: f.spec }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed');
    const executionEventId = task.executionEventId;
    const oldRun = f.store.list('runs').find(run => run.taskId === task.id)!;
    const originalText = f.store.get('messages', runResponseId(oldRun.id))!.content;
    // The archive projection remains the result owner for pre-upgrade Runs.
    // New taskExecution Runs are covered by the native workflow cases above;
    // these faults deliberately target the retained legacy-only writer.
    if (executionKind === 'legacy') {
      const { taskExecution: _newExecution, ...legacyRun } = oldRun;
      f.store.put('runs', legacyRun);
    }
    await f.store.updateSettings({ enabled: false });
    let injected = false;
    if (fault === 'before-task') f.runtime.consent.resolveDeviceReceipt = () => { injected = true; throw new Error('injected task persistence fault'); };
    else f.store.put = ((collection: string, record: { deviceResolution?: unknown; id: string }) => {
      if (fault === 'after-task-before-message' && collection === 'messages' && record.id !== runResponseId(oldRun.id)
        || fault === 'after-message-before-run' && collection === 'runs' && record.deviceResolution) {
        injected = true; throw new Error('injected projection persistence fault');
      }
      return put(collection as never, record as never);
    }) as typeof f.store.put;
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
    await waitFor(f.runtime, () => injected);
    assert.equal(f.runtime.devices.operationForTask(task.id)?.receipt.state, 'completed');
    if (fault !== 'before-task') assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.equal(f.store.list('messages').filter(message => message.runId === oldRun.id).length, 1, 'partial store transaction is rolled back');
    detach(); detach = () => {};
    await f.runtime.close();
    f.store.put = put;
    f.runtime = await V2Coordinator.create(f.store, { dataDir: f.directory, model: f.model });
    assert.equal(f.runtime.consent.get(task.id)?.state, 'completed');
    assert.equal(f.runtime.consent.get(task.id)?.executionEventId, executionEventId);
    assert.equal(f.store.get('runs', oldRun.id)?.status, 'completed');
    assert.equal(f.store.get('messages', runResponseId(oldRun.id))?.content, originalText);
    assert.equal(f.store.list('messages').filter(message => message.runId === oldRun.id && message.content.includes('SavedFolder')).length, 1);
    assert.equal(f.runtime.inbox.list().filter(event => event.kind === 'task.execute').length, 1);
    assert.equal(f.store.getMeta('v2.lastError', null), null, 'repaired persistence must also clear its synchronization error');
    assert.equal(f.store.getSettings().enabled, false); assert.equal(sends, 1); assert.equal(modelCalls, 0);
    const saved = JSON.stringify(f.store.list('messages'));
    await f.runtime.close(); f.runtime = await V2Coordinator.create(f.store, { dataDir: f.directory, model: f.model });
    assert.equal(JSON.stringify(f.store.list('messages')), saved, 'second restart adds no duplicate delivery');
  } finally { f.store.put = put; detach(); await f.close(); }
});

for (const outcome of ['failed', 'cancelled'] as const) test(`late ${outcome} receipt is delivered once without running a new operation`, async () => {
  const f = await fixture(() => assert.fail('no model during device recovery')); let operationId = ''; let sends = 0;
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    sends++; operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'unknown', error: 'waiting for final device fact' });
  });
  try {
    const task = await f.runtime.requestTask({ requestId: outcome, spec: f.spec }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed');
    f.runtime.devices.recordResult(f.device.id, { operationId, state: outcome, error: 'confirmed terminal fixture' });
    await waitFor(f.runtime, () => /confirmed terminal fixture/.test(f.runtime.consent.get(task.id)?.error ?? ''));
    assert.equal(f.runtime.consent.get(task.id)?.state, 'failed');
    assert.match(f.runtime.consent.get(task.id)?.error ?? '', /confirmed terminal fixture/);
    assert.equal(f.store.list('messages').filter(message => message.content.includes('confirmed terminal fixture')).length, 1);
    assert.equal(sends, 1);
  } finally { detach(); await f.close(); }
});

test('late native success never certifies missing model analysis or resurrects revoked permission', async () => {
  const f = await fixture(() => assert.fail('late results must not invoke analysis')); let operationId = ''; let revoke = false;
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    if (revoke) { const task = f.runtime.consent.get(message.taskId)!; f.runtime.consent.revoke(task.id, task.revision); }
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'unknown', error: 'unknown fixture' });
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'analysis', spec: { ...f.spec, directoryAnalysis: true } }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed');
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
    await waitFor(f.runtime, () => /分析尚未完成/.test(f.runtime.consent.get(task.id)?.error ?? ''));
    assert.equal(f.runtime.consent.get(task.id)?.state, 'failed');
    assert.match(f.runtime.consent.get(task.id)?.error ?? '', /分析尚未完成/);
    assert.equal(f.store.list('messages').filter(message => message.content.includes('SavedFolder')).length, 1);
    revoke = true;
    const revoked = await f.runtime.requestTask({ requestId: 'revoked', spec: f.spec });
    await waitFor(f.runtime, () => f.store.list('runs').some(run => run.taskId === revoked.id && run.status !== 'running'));
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
    assert.equal(f.runtime.consent.get(revoked.id)?.state, 'revoked');
    assert.equal(f.store.list('messages').filter(message => message.content.includes('SavedFolder')).length, 1);
    assert.throws(() => f.runtime.consent.assertApproved(revoked.id, f.spec.caseId));
  } finally { detach(); await f.close(); }
});

test('recovery rejects mismatched persisted operation revisions and does not reveal their output', async () => {
  const f = await fixture(); let operationId = '';
  const detach = f.runtime.devices.attach(f.device.id, message => {
    if (message.kind !== 'execute') return;
    operationId = message.operationId;
    f.runtime.devices.admit(f.device.id, { operationId, specHash: message.specHash });
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'unknown', error: 'unknown fixture' });
  });
  try {
    const task = await f.runtime.requestTask({ requestId: 'mismatch', spec: f.spec }); f.runtime.start();
    await waitFor(f.runtime, () => f.runtime.consent.get(task.id)?.state === 'failed');
    const db = new DatabaseSync(join(f.directory, 'v2-events.sqlite'));
    try { db.prepare("UPDATE local_device_operations SET json=json_set(json,'$.taskRevision',999) WHERE id=?").run(operationId); } finally { db.close(); }
    f.runtime.devices.recordResult(f.device.id, { operationId, state: 'completed', exitCode: 0, stdout: JSON.stringify(f.result) });
    assert.equal(f.runtime.consent.get(task.id)?.state, 'failed');
    assert.equal(f.store.list('messages').some(message => message.content.includes('SavedFolder')), false);
  } finally { detach(); await f.close(); }
});
