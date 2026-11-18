import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { receiveProjectInputs } from '../desktop/project-inputs.js';
import { completedDeliveryProblem, planHash, verifyProjectDelivery } from '../desktop/project-delivery.js';
import { projectContractCapability, projectDeliveryProblem, projectPlanProblem, type ProjectPlan, type ProjectDelivery } from '../shared/project-contract.js';
import { ProjectBroker, projectSpecHash, projectInputForDevice } from '../server/devices/projects.js';
import { localProjectSpecSchema, localProjectCapability, type ProjectExecutionInput, type ProjectEvent } from '../shared/local-project.js';

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const plan: ProjectPlan = { objective: 'Produce a verified report', basis: [{ kind: 'owner', reference: 'original message', detail: 'Read original input' }],
  method: 'Use the project validator', environment: [], outputs: [{ path: '报告.txt', format: 'txt', description: 'Owner deliverable' }],
  checks: [{ id: 'readback', criterion: 'content verified', required: true, method: 'Read and compare output', basis: 'owner' },
    { id: 'editorial', criterion: 'Editorial review', required: false, method: 'Optional review', basis: 'assumption' }] };
const checks = [{ id: 'readback', status: 'passed' as const, toolIds: ['check'], detail: 'Output was read back', validator: 'project validator' },
  { id: 'editorial', status: 'unverified' as const, toolIds: [], detail: 'Subjective editorial review is available for the owner', validator: 'not run' }];

test('only an actual owner revision can supersede a previously mandatory criterion', () => {
  assert.match(projectPlanProblem(plan, ['original criterion'], [])!, /保留/);
  const updated = { ...plan, criteriaOverrides: [{ criterion: 'original criterion', revision: 2, quote: '改为内容回读', reason: 'Owner updated the goal' }] };
  assert.match(projectPlanProblem(updated, ['original criterion'], [])!, /本人/);
  assert.equal(projectPlanProblem(updated, ['original criterion'], [{ revision: 2, content: '请改为内容回读。' }]), undefined);
});

test('original attachment bytes survive fragmentation, identical names and retries, and rejected transfers never publish a partial input', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-contract-inputs-'));
  const bodies = [Buffer.alloc(300_001, 71), Buffer.from('另一份原件')];
  const files = bodies.map((data, i) => ({ id: 'file-' + i, messageId: 'message', name: '原始输入.xlsx', size: data.length, sha256: sha(data) }));
  let requests = 0;
  const fetch = async (raw: Record<string, unknown>) => {
    requests++; const i = files.findIndex(file => file.id === raw.id); const offset = Number(raw.offset);
    return { ...files[i], offset, data: bodies[i].subarray(offset, offset + 256 * 1024).toString('base64') };
  };
  const received = await receiveProjectInputs(root, files, fetch, async () => {});
  assert.notEqual(received[0].path, received[1].path);
  for (let i = 0; i < files.length; i++) assert.deepEqual(await readFile(received[i].path), bodies[i]);
  assert.equal(requests, 3);
  await receiveProjectInputs(root, files, fetch, async () => {});
  assert.equal(requests, 3, 'recovery reuses only a matching immutable input');
  await assert.rejects(receiveProjectInputs(root, [{ ...files[0], name: '../outside.txt' }], fetch, async () => {}), /文件名/);
  const bad = { ...files[0], id: 'corrupt' };
  await assert.rejects(receiveProjectInputs(root, [bad], async raw => ({ ...bad, offset: raw.offset, data: Buffer.alloc(256 * 1024).toString('base64') }), async () => {}), /校验|不匹配/);
  const folder = path.join(root, 'inputs', sha(Buffer.from(bad.id + ':' + bad.sha256)));
  assert.deepEqual(await readdir(folder), []);
  let active = true;
  await assert.rejects(receiveProjectInputs(root, [{ ...files[1], id: 'cancelled' }], async raw => {
    active = false; return { ...files[1], offset: raw.offset, data: bodies[1].toString('base64') };
  }, async () => { if (!active) throw new Error('revoked'); }), /revoked/);
  const cancelled = path.join(root, 'inputs', sha(Buffer.from('cancelled:' + files[1].sha256)));
  assert.deepEqual(await readdir(cancelled), []);
});

test('delivery checks bind to real files and successful operations, preserve nonblocking unknowns, and detect subsequent edits or hard links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-contract-output-'));
  const workspace = path.join(root, 'workspace');
  for (const folder of [workspace, path.join(root, 'temporary'), path.join(root, 'outputs')]) await mkdir(folder);
  await writeFile(path.join(workspace, '报告.txt'), 'verified contents');
  const delivery: ProjectDelivery = { plan, planHash: planHash(plan), requirementsRevision: 2 };
  const tools = new Map([['check', { id: 'check', label: 'read report', type: 'commandExecution', state: 'succeeded' as const, exitCode: 0 }]]);
  delivery.verification = await verifyProjectDelivery(delivery, { checks }, tools, workspace, root);
  assert.equal(projectDeliveryProblem(delivery, 2), undefined);
  assert.match(projectDeliveryProblem(delivery, 2, [{ size: 1, sha256: '0'.repeat(64) }])!, /已保存成果/);
  assert.equal(projectDeliveryProblem(delivery, 2, delivery.verification.files), undefined);
  assert.match(projectDeliveryProblem(delivery, 3)!, /版本/);
  assert.equal(await completedDeliveryProblem(delivery, 2, workspace, root), undefined);
  await assert.rejects(verifyProjectDelivery(delivery, { checks: [{ ...checks[0], toolIds: ['invented'] }] }, tools, workspace, root), /未知/);
  const blocked = structuredClone(delivery); blocked.verification!.checks[0].status = 'unverified';
  assert.match(projectDeliveryProblem(blocked, 2)!, /必需检查/);
  await writeFile(path.join(workspace, '报告.txt'), 'changed after validation');
  assert.match((await completedDeliveryProblem(delivery, 2, workspace, root))!, /变化/);
  await link(path.join(workspace, '报告.txt'), path.join(root, 'linked.txt'));
  await assert.rejects(verifyProjectDelivery(delivery, { checks }, tools, workspace, root), /普通文件/);
});

test('native completion, late receipts, requirements and the full tool count use the same durable contract', async () => {
  const db = new DatabaseSync(':memory:');
  const device = { id: 'device', name: 'device', platform: 'win32' as const, online: true, grants: [],
    capabilities: [localProjectCapability, projectContractCapability], createdAt: new Date().toISOString() };
  const broker = new ProjectBroker(db, { device: () => device, send() {}, changed() {}, result() {}, assertActive() {} });
  const spec = localProjectSpecSchema.parse({ deviceId: device.id, root: 'D:\\test' });
  const input: ProjectExecutionInput = { operationId: 'operation', taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'report', objective: 'report', expectedOutput: 'report', ownerRequest: 'report', updates: [],
    model: { model: 'offline', reasoningEffort: 'default', maxOutputTokens: null }, stepLimit: null, deadline: null,
    issuedAt: new Date().toISOString(), contract: { version: 1, criteria: ['content verified'] } };
  assert.throws(() => projectInputForDevice(input, { ...device, capabilities: [localProjectCapability] }), /更新/);
  assert.equal(projectInputForDevice({ ...input, contract: undefined }, { ...device, capabilities: [localProjectCapability] }).contract, undefined);
  const pending = broker.run(input, { signal: new AbortController().signal, guard() {}, onEvent() {}, async model() {}, async context() {} });
  let seq = 0;
  const record = (event: ProjectEvent['event']) => { broker.record(device.id, { operationId: input.operationId, sequence: seq + 1, requirementsRevision: 1, at: new Date().toISOString(), event }); seq++; };
  try {
    assert.throws(() => record({ kind: 'finished', state: 'completed', output: 'Claimed complete' }), /执行方案/);
    for (let i = 0; i < 110; i++) record({ kind: 'tool', item: { id: 'tool-' + i, label: 'fixture', type: 'commandExecution', state: 'succeeded', exitCode: 0 } });
    assert.equal(broker.get(input.operationId)!.tools.length, 100);
    assert.equal(broker.get(input.operationId)!.toolCounts!.total, 110);
    const actual = { ...plan, outputs: [] }; const hash = planHash(actual);
    record({ kind: 'plan', plan: actual, planHash: hash });
    assert.throws(() => record({ kind: 'verification', verification: { planHash: hash, requirementsRevision: 1, files: [], checkedAt: new Date().toISOString(), checks } }), /未知/);
    record({ kind: 'verification', verification: { planHash: hash, requirementsRevision: 1, files: [], checkedAt: new Date().toISOString(),
      checks: [{ ...checks[0], toolIds: ['tool-0'] }, checks[1]] } });
    record({ kind: 'finished', state: 'completed', output: 'Verified fixture result' });
    assert.equal((await pending).state, 'completed');
  } finally { db.close(); }
});
