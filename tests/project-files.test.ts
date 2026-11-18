import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import { ProjectFiles, projectFileSnapshot } from '../server/devices/project-files.js';
import { captureProjectFinalFiles, sendProjectFiles } from '../desktop/project-files.js';
import { captureProject } from '../desktop/project-configuration.js';
import { archiveProject, pruneProjectArchives } from '../desktop/project-archive.js';
import { projectCheckpoint, projectExecutionCheckpoint } from '../desktop/project-checkpoint.js';
import type { LocalProjectEntry } from '../desktop/project-journal.js';
import { projectSpecHash } from '../server/devices/projects.js';
import { localProjectSpecSchema, serverProjectResources, type ProjectOperation } from '../shared/local-project.js';
import { projectFilesCapability, projectFinalFilesCapability, projectFilesRequestSchema, projectFilesUploadSchema,
  type ProjectFilesRequest, type ProjectFilesUpload, type ProjectFileSelection } from '../shared/project-files.js';
import { projectContractV2Capability, projectDeliveryRequestSchema } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';

async function fixture(extra?: (work: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-file-delivery-')), work = path.join(root, 'work'), privateDirectory = path.join(root, 'private');
  await mkdir(path.join(work, 'workspace'), { recursive: true }); await mkdir(path.join(work, 'temporary', 'report'), { recursive: true });
  await mkdir(path.join(work, 'codex')); await mkdir(path.join(work, 'workspace', '.codex'));
  await writeFile(path.join(work, 'codex', 'auth.json'), 'private engine credential');
  await writeFile(path.join(work, 'workspace', '.codex', 'config'), 'private project configuration');
  await mkdir(path.join(work, 'temporary', 'codex-bwrap-synthetic-mount-targets-20002'));
  await writeFile(path.join(work, 'temporary', 'codex-bwrap-synthetic-mount-targets-20002', 'lock'), '');
  const text = Buffer.from('中文报告\n' + 'data'.repeat(90000));
  await writeFile(path.join(work, 'temporary', 'report', '结果.md'), text);
  await writeFile(path.join(work, 'workspace', 'empty.txt'), '');
  await writeFile(path.join(work, 'workspace', 'data.bin'), Buffer.from([0, 1, 254, 255]));
  await extra?.(work);
  const spec = localProjectSpecSchema.parse({ deviceId: 'linux', root: 'task-temporary', serverResources: serverProjectResources(false) });
  const entry: LocalProjectEntry = { input: { operationId: 'a'.repeat(64), taskId: 'task', runId: 'run', approvalRevision: 2, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Report', objective: 'Prepare report', expectedOutput: 'Files', ownerRequest: 'Prepare report', updates: [],
    retainWorkspace: true, deliverFiles: true, model: { model: 'offline', reasoningEffort: 'auto', maxOutputTokens: null },
    stepLimit: null, deadline: null, issuedAt: new Date().toISOString() }, state: 'completed', environment: 'closed',
    sequence: 0, acknowledged: 0, appliedRevision: 1, output: '', identity: 'fixture-identity' };
  entry.workspaceArchive = await archiveProject(work, privateDirectory, entry);
  const operation: ProjectOperation = { input: entry.input, state: 'completed', sequence: 0, modelCalls: 0, output: '', tools: [], previews: [], interactions: [],
    updatedAt: new Date().toISOString(), checkpoint: { hash: entry.workspaceArchive.hash, identity: entry.identity! },
    environment: { state: 'closed', retainedWorkspace: true, terminals: [] } };
  const db = new DatabaseSync(path.join(root, 'files.sqlite'));
  let allowed = true, revoked = false, request: ProjectFilesRequest | undefined;
  const options = { operation: () => operation, device: () => ({ id: 'linux', name: 'Linux', platform: 'linux' as const,
    createdAt: new Date().toISOString(), online: true, grants: [], capabilities: [projectFilesCapability], ...(revoked ? { revokedAt: 'now' } : {}) }),
    send: (_deviceId: string, value: ProjectFilesRequest) => { request = value; }, changed() {}, assertActive() {} };
  const files = new ProjectFiles(db, options);
  const guard = () => { if (!allowed) throw new Error('owner consent revoked'); };
  const start = () => { const result = files.prepare(operation, guard); void result.catch(() => {}); return result; };
  return { root, work, privateDirectory, text, entry, operation, db, files, options, guard, start,
    request: () => { assert.ok(request); return request; }, revoke: () => { allowed = false; }, revokeDevice: () => { revoked = true; },
    post: async (input: ProjectFilesUpload) => files.receive('linux', input), close: () => { files.close(); db.close(); } };
}

test('real archived files transfer in chunks, exclude native private files, persist across restart and survive workspace release', async () => {
  const f = await fixture();
  try {
    const result = f.start();
    await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const delivery = await result;
    assert.deepEqual(delivery.files.map(file => file.path).sort(), ['temporary/report/结果.md', 'workspace/data.bin', 'workspace/empty.txt']);
    assert.deepEqual(f.files.read(delivery, 'temporary/report/结果.md'), f.text);
    assert.equal(f.files.read(delivery, 'workspace/empty.txt').length, 0);
    const zip = new AdmZip(await f.files.bundle(delivery));
    assert.deepEqual(zip.getEntries().map(entry => entry.entryName).sort(), delivery.files.map(file => file.path).sort());
    assert.deepEqual(zip.readFile('temporary/report/结果.md'), f.text);
    await pruneProjectArchives(f.privateDirectory);
    f.operation.environment = { state: 'closed', terminals: [] };
    f.files.close();
    const reopened = new ProjectFiles(f.db, f.options);
    assert.deepEqual(await reopened.prepare(f.operation, f.guard), delivery, 'already delivered data never need another worker execution or archive');
    assert.deepEqual(reopened.read(delivery, 'workspace/data.bin'), Buffer.from([0, 1, 254, 255]));
    reopened.close();
  } finally { f.close(); }
});

test('archived delivery excludes exact private verification files while keeping other archived files', async () => {
  const f = await fixture();
  try {
    const receipt = fixtureDelivery(1, 'fixture-dependency', { version: 2, requirements: [] }).at(-1)!;
    assert.ok(receipt.kind === 'delivery');
    const privatePath = 'temporary/report/结果.md';
    const helper = { path: '/fixture/' + privatePath, publishedPath: privatePath, format: 'file',
      sha256: createHash('sha256').update(f.text).digest('hex'), size: f.text.length };
    receipt.delivery.verification!.dependencies = [helper];
    f.entry.delivery = f.operation.delivery = receipt.delivery;
    const refused = f.start();
    await assert.rejects(f.post({ action: 'begin', requestId: f.request().requestId,
      manifest: { snapshot: f.request().snapshot, files: [{ path: privatePath, size: helper.size, sha256: helper.sha256 }], omittedLinks: 0 } }), /辅助验证文件/);
    await assert.rejects(refused, /辅助验证文件/);
    const result = f.start();
    await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const saved = await result;
    assert.deepEqual(saved.files.map(file => file.path), ['workspace/data.bin', 'workspace/empty.txt']);
    const zip = new AdmZip(await f.files.bundle(saved));
    assert.equal(zip.getEntry(privatePath), null);
  } finally { f.close(); }
});

test('a paused Linux stage publishes only its exact review files and remains distinct from final delivery', async () => {
  const f = await fixture();
  try {
    f.entry.input.contract = { version: 2, requirements: [], reviewMode: 'owner' };
    f.entry.state = 'paused'; f.entry.realPath = path.join(f.work, 'workspace'); f.operation.state = 'waiting';
    const device = f.options.device();
    f.options.device = () => ({ ...device, capabilities: [...device.capabilities, projectContractV2Capability] });
    const sourcePath = path.join(f.work, 'temporary', 'report', '结果.md');
    const selection: ProjectFileSelection = { fingerprint: '1'.repeat(64), files: [{ path: sourcePath, size: f.text.length,
      sha256: createHash('sha256').update(f.text).digest('hex') }] };
    const pending = f.files.prepare(f.operation, f.guard, undefined, selection);
    await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const delivery = await pending;
    assert.equal(delivery.snapshot.stageFingerprint, selection.fingerprint);
    assert.deepEqual(delivery.files.map(file => [file.path, file.sourcePath]), [['temporary/report/结果.md', sourcePath]]);
    assert.equal(f.files.forOperation(f.operation), undefined, 'Stage files cannot satisfy final-delivery obligations');
    assert.deepEqual(f.files.forStage(f.operation, selection), delivery);
    await pruneProjectArchives(f.privateDirectory); f.operation.environment = { state: 'closed', terminals: [] };
    f.operation.checkpoint = { hash: '2'.repeat(64), identity: 'later-stage' };
    f.options.device = () => ({ ...device, online: false });
    assert.deepEqual(await f.files.prepare(f.operation, f.guard, undefined, selection), delivery, 'An immutable review copy remains readable offline');
  } finally { f.close(); }
});

test('equal bytes in two stage paths still require two distinct published files', async () => {
  const f = await fixture(async work => {
    await writeFile(path.join(work, 'workspace', 'copy.md'), await readFile(path.join(work, 'temporary', 'report', '结果.md')));
  });
  try {
    f.entry.input.contract = { version: 2, requirements: [], reviewMode: 'owner' };
    f.entry.state = 'paused'; f.entry.realPath = path.join(f.work, 'workspace'); f.operation.state = 'waiting';
    const device = f.options.device();
    f.options.device = () => ({ ...device, capabilities: [...device.capabilities, projectContractV2Capability] });
    const sha256 = createHash('sha256').update(f.text).digest('hex');
    const selection: ProjectFileSelection = { fingerprint: '5'.repeat(64), files: [
      { path: path.join(f.work, 'temporary', 'report', '结果.md'), size: f.text.length, sha256 },
      { path: path.join(f.work, 'workspace', 'copy.md'), size: f.text.length, sha256 },
    ] };
    const pending = f.files.prepare(f.operation, f.guard, undefined, selection); void pending.catch(() => {});
    assert.throws(() => f.files.receive('linux', { action: 'begin', requestId: f.request().requestId, manifest: {
      snapshot: f.request().snapshot, omittedLinks: 0,
      files: [{ path: 'workspace/copy.md', sourcePath: selection.files[0].path, size: f.text.length, sha256 }],
    } }), /待审核/);
    await assert.rejects(pending, /待审核/);
    assert.equal(f.files.forStage(f.operation, selection), undefined);
    const retry = f.files.prepare(f.operation, f.guard, undefined, selection);
    await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    assert.equal((await retry).files.length, 2);
  } finally { f.close(); }
});

test('Windows stage files use the paused checkpoint and preserve content without copying unrelated workspace files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-windows-stage-files-'));
  const workspace = path.join(root, 'project'), privateDirectory = path.join(root, 'private');
  for (const directory of [workspace, path.join(privateDirectory, 'temporary'), path.join(privateDirectory, 'outputs')]) await mkdir(directory, { recursive: true });
  const sourcePath = path.join(workspace, 'stage.md'), text = Buffer.from('Only this stage is submitted for review.');
  await writeFile(sourcePath, text); await writeFile(path.join(workspace, 'unrelated.txt'), 'Keep local');
  const spec = localProjectSpecSchema.parse({ deviceId: 'windows', root: workspace });
  const entry: LocalProjectEntry = { input: { operationId: 'w'.repeat(64), taskId: 'windows-task', runId: 'run', approvalRevision: 1,
    requirementsRevision: 1, spec, specHash: projectSpecHash(spec), title: 'Stage', objective: 'Review one stage', expectedOutput: 'Stage file',
    ownerRequest: 'Review each stage', updates: [], model: { model: 'offline', reasoningEffort: 'default', maxOutputTokens: null },
    stepLimit: null, deadline: null, issuedAt: new Date().toISOString(), contract: { version: 2, requirements: [], reviewMode: 'owner' } },
    state: 'paused', environment: 'closed', realPath: workspace, identity: 'fixture', sequence: 0, acknowledged: 0, appliedRevision: 1, output: '' };
  entry.checkpoint = await projectExecutionCheckpoint(workspace, privateDirectory);
  const operation: ProjectOperation = { input: entry.input, state: 'waiting', sequence: 0, modelCalls: 0, output: '', tools: [], previews: [], interactions: [],
    updatedAt: new Date().toISOString(), checkpoint: { hash: entry.checkpoint, identity: entry.identity! }, environment: { state: 'closed', terminals: [] } };
  const selection: ProjectFileSelection = { fingerprint: '3'.repeat(64), files: [{ path: sourcePath, size: text.length, sha256: createHash('sha256').update(text).digest('hex') }] };
  const db = new DatabaseSync(':memory:'); let request: ProjectFilesRequest | undefined;
  const files = new ProjectFiles(db, { operation: () => operation,
    device: () => ({ id: 'windows', name: 'Windows', platform: 'win32', online: true, createdAt: new Date().toISOString(),
      grants: [], capabilities: [projectFilesCapability, projectContractV2Capability] }),
    assertActive() {}, changed() {}, send(_id, value) { request = value; } });
  try {
    const pending = files.prepare(operation, () => {}, undefined, selection); assert.ok(request);
    const post = async (input: ProjectFilesUpload) => files.receive('windows', input);
    await sendProjectFiles(entry, privateDirectory, request, post);
    const delivery = await pending;
    assert.deepEqual(delivery.files.map(file => file.path), ['workspace/stage.md']);
    assert.deepEqual(files.read(delivery, 'workspace/stage.md'), text);
    assert.equal(files.forOperation(operation), undefined);
    await writeFile(sourcePath, 'Changed after snapshot');
    await assert.rejects(sendProjectFiles(entry, privateDirectory, request, post), /现场已变化/);
    assert.deepEqual(files.read(delivery, 'workspace/stage.md'), text, 'The reviewed copy is immutable');
    entry.state = 'running'; operation.state = 'running';
    await assert.rejects(sendProjectFiles(entry, privateDirectory, request, post), /尚未暂停/);
    await assert.rejects(files.prepare(operation, () => {}, undefined, { ...selection, fingerprint: '4'.repeat(64) }), /状态|变化/);
  } finally { files.close(); db.close(); }
});

async function windowsFinalFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-windows-final-files-'));
  const workspace = path.join(root, 'project'), privateDirectory = path.join(root, 'private');
  const sourcePath = path.join(workspace, 'answer.md');
  await mkdir(workspace); await mkdir(privateDirectory);
  const bytes = Buffer.from('Final verified file.\n'.repeat(32000));
  await writeFile(sourcePath, bytes);
  await writeFile(path.join(workspace, 'unrelated.txt'), 'Keep local');
  const spec = localProjectSpecSchema.parse({ deviceId: 'windows', root: workspace });
  const contract = { version: 2 as const, requirements: [] };
  const input: LocalProjectEntry['input'] = { operationId: 'w'.repeat(64), taskId: 'windows-final-task', runId: 'run',
    approvalRevision: 1, requirementsRevision: 1, spec, specHash: projectSpecHash(spec), title: 'Final', objective: 'Produce final output',
    expectedOutput: 'One Markdown file', ownerRequest: 'Write the final answer', updates: [], contract, deliverFiles: true,
    model: { model: 'offline', reasoningEffort: 'default', maxOutputTokens: null }, stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };
  const proofEvent = fixtureDelivery(1, 'fixture-validation', contract).at(-1)!;
  assert.equal(proofEvent.kind, 'delivery');
  const delivery = proofEvent.delivery;
  delivery.plan.outputs = [{ path: sourcePath, format: 'markdown', description: 'Final answer' }];
  delivery.request = projectDeliveryRequestSchema.parse({ ...delivery.request, outputs: delivery.plan.outputs });
  delivery.planHash = createHash('sha256').update(JSON.stringify(delivery.plan)).digest('hex');
  delivery.verification!.planHash = delivery.planHash;
  delivery.verification!.files = [{ path: sourcePath, publishedPath: 'workspace/answer.md', format: 'markdown', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }];
  const entry: LocalProjectEntry = { input, ...await captureProject(input), state: 'completed', environment: 'active',
    sequence: 0, acknowledged: 0, appliedRevision: 1, output: '', delivery };
  const operation: ProjectOperation = { input, state: 'completed', sequence: 0, modelCalls: 0, output: '', tools: [], previews: [], interactions: [],
    updatedAt: new Date().toISOString(), delivery, environment: { state: 'active', terminals: [{ threadId: 'preview', processId: 'test',
      command: 'preview', cwd: workspace }] } };
  const db = new DatabaseSync(':memory:'); let request: ProjectFilesRequest | undefined, online = true, allowed = true;
  const guard = () => { if (!allowed) throw new Error('owner consent revoked'); };
  const files = new ProjectFiles(db, { operation: () => operation,
    device: () => ({ id: 'windows', name: 'Windows', platform: 'win32', online, createdAt: new Date().toISOString(),
      grants: [], capabilities: [projectFilesCapability, projectFinalFilesCapability, projectContractV2Capability] }),
    assertActive() {}, changed() {}, send(_id, value) { request = projectFilesRequestSchema.parse(value); } });
  return { sourcePath, bytes, privateDirectory, entry, operation, files, db, guard,
    offline() { online = false; }, revoke() { allowed = false; }, freeze: async () => { entry.finalFilesSnapshot = await captureProjectFinalFiles(entry, privateDirectory, guard); },
    start() { const result = files.prepare(operation, guard); void result.catch(() => {}); return result; },
    request() { assert.ok(request); return request; }, post: async (part: ProjectFilesUpload) => files.receive('windows', part),
    close() { files.close(); db.close(); } };
}

test('Windows final delivery freezes exact verified files while a preview runs, then resumes an interrupted transfer', async () => {
  const f = await windowsFinalFixture();
  try {
    await f.freeze();
    await writeFile(f.sourcePath, 'New workspace edits after completion.');
    const first = f.start();
    assert.ok(f.request().snapshot.finalFingerprint);
    assert.equal(f.request().snapshot.stageFingerprint, undefined);
    assert.equal(f.request().selection, undefined);
    await assert.rejects(sendProjectFiles(f.entry, f.privateDirectory, f.request(), async part => {
      const receipt = await f.post(part);
      if (part.action === 'chunk') { f.files.disconnect('windows'); throw new Error('lost acknowledgement'); }
      return receipt;
    }), /lost acknowledgement/);
    await assert.rejects(first, /连接中断/);
    assert.equal(f.files.forOperation(f.operation), undefined);
    const retry = f.start();
    await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const delivery = await retry;
    assert.deepEqual(delivery.files.map(file => file.path), ['workspace/answer.md']);
    assert.equal(delivery.files[0].sourcePath, undefined);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_file_deliveries').get()!.n, 1);
    assert.deepEqual(f.files.read(delivery, 'workspace/answer.md'), f.bytes);
    assert.deepEqual(new AdmZip(await f.files.bundle(delivery)).readFile('workspace/answer.md'), f.bytes);
    f.offline();
    assert.deepEqual(await f.start(), delivery);
  } finally { f.close(); }
});

test('Windows final delivery rejects source hardlinks and fences revoked consent before commit', async () => {
  const f = await windowsFinalFixture();
  try {
    const alias = path.join(f.privateDirectory, 'alias.md');
    await link(f.sourcePath, alias);
    await assert.rejects(f.freeze(), /普通文件/);
    await unlink(alias);
    await f.freeze();
    const pending = f.start();
    await assert.rejects(sendProjectFiles(f.entry, f.privateDirectory, f.request(), async part => {
      if (part.action === 'commit') f.revoke();
      return f.post(part);
    }), /owner consent revoked/);
    await assert.rejects(pending, /owner consent revoked/);
    assert.equal(f.files.forOperation(f.operation), undefined);
  } finally { f.close(); }
});

test('an altered frozen file cannot add unverified bytes to a Windows final transfer', async () => {
  const f = await windowsFinalFixture();
  try {
    await f.freeze();
    const initial = f.start();
    const frozen = path.join(f.privateDirectory, 'final-files', f.entry.finalFilesSnapshot!.fingerprint, 'workspace', 'answer.md');
    let chunks = 0;
    await assert.rejects(sendProjectFiles(f.entry, f.privateDirectory, f.request(), async part => {
      const response = await f.post(part);
      if (part.action === 'begin') await writeFile(frozen, Buffer.alloc(f.bytes.length, 1));
      if (part.action === 'chunk') chunks++;
      return response;
    }), /传输中已变化/);
    assert.equal(chunks, 0);
    f.files.disconnect('windows');
    await assert.rejects(initial, /连接中断/);
    assert.equal(f.files.forOperation(f.operation), undefined);
    await writeFile(frozen, f.bytes);
    const retry = f.start();
    await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    assert.deepEqual(f.files.read(await retry, 'workspace/answer.md'), f.bytes);
  } finally { f.close(); }
});

test('interrupted uploads are unpublished and retries reuse the exact manifest and existing chunks', async () => {
  const f = await fixture();
  try {
    const first = f.start(); let interrupted = false;
    await assert.rejects(sendProjectFiles(f.entry, f.privateDirectory, f.request(), async input => {
      const result = await f.post(input);
      if (input.action === 'chunk' && !interrupted) { interrupted = true; f.files.disconnect('linux'); throw new Error('lost acknowledgement'); }
      return result;
    }), /lost acknowledgement/);
    await assert.rejects(first, /连接中断/);
    assert.equal(f.files.forOperation(f.operation), undefined);
    const next = f.start(); await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const delivery = await next;
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_file_deliveries').get()!.n, 1);
    assert.deepEqual(f.files.read(delivery, 'temporary/report/结果.md'), f.text);
  } finally { f.close(); }
});

for (const change of ['consent', 'device', 'revision', 'checkpoint'] as const) test(`a ${change} change fences an accepted transfer before publication`, async () => {
  const f = await fixture();
  try {
    const result = f.start(); let changed = false;
    await assert.rejects(sendProjectFiles(f.entry, f.privateDirectory, f.request(), async input => {
      if (input.action === 'commit' && !changed) {
        changed = true;
        if (change === 'consent') f.revoke();
        else if (change === 'device') f.revokeDevice();
        else if (change === 'revision') f.operation.input = { ...f.operation.input, requirementsRevision: 2 };
        else f.operation.checkpoint = { hash: 'f'.repeat(64), identity: 'new' };
      }
      return f.post(input);
    }));
    await assert.rejects(result);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_file_deliveries WHERE ready=1').get()!.n, 0);
  } finally { f.close(); }
});

test('archive tampering, foreign devices, path traversal and conflicting chunks cannot publish a file', async () => {
  const f = await fixture();
  try {
    const result = f.start();
    assert.throws(() => f.files.receive('foreign', { action: 'error', requestId: f.request().requestId, error: 'forged' }), /不属于/);
    assert.throws(() => projectFilesUploadSchema.parse({ action: 'chunk', requestId: f.request().requestId, deliveryId: 'a'.repeat(64), path: 'workspace/../codex/auth.json', offset: 0, data: 'YQ==' }));
    assert.throws(() => projectFilesUploadSchema.parse({ action: 'chunk', requestId: f.request().requestId, deliveryId: 'a'.repeat(64), path: 'temporary/codex-bwrap-synthetic-mount-targets-20002/lock', offset: 0, data: '' }));
    const input = { snapshot: projectFileSnapshot(f.operation), files: [{ path: 'workspace/test.txt', size: 1, sha256: createHash('sha256').update('a').digest('hex') }], omittedLinks: 0 };
    const { deliveryId } = f.files.receive('linux', { action: 'begin', requestId: f.request().requestId, manifest: input });
    f.files.receive('linux', { action: 'chunk', requestId: f.request().requestId, deliveryId: deliveryId!, path: 'workspace/test.txt', offset: 0, data: 'YQ==' });
    assert.throws(() => f.files.receive('linux', { action: 'chunk', requestId: f.request().requestId, deliveryId: deliveryId!, path: 'workspace/test.txt', offset: 0, data: 'Yg==' }), /不能改写/);
    await assert.rejects(result);
    const archiveFile = path.join(f.privateDirectory, 'workspace-snapshots', f.entry.workspaceArchive!.id, 'content', 'workspace', 'data.bin');
    await writeFile(archiveFile, 'tampered');
    await assert.rejects(sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post), /归档已变更/);
    assert.equal(f.files.forOperation(f.operation), undefined);
  } finally { f.close(); }
});

test('public-directory links never expose another directory or engine credentials', async () => {
  const f = await fixture();
  try {
    // fs.cp cannot recreate junctions without Windows symlink privilege; construct this archived fixture directly.
    const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'not an artifact');
    const directory = path.join(f.privateDirectory, 'workspace-snapshots', f.entry.workspaceArchive!.id), content = path.join(directory, 'content');
    await symlink(outside, path.join(content, 'workspace', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const digest = await projectCheckpoint(content, true);
    f.entry.workspaceArchive!.hash = digest; f.operation.checkpoint!.hash = digest;
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, hash: digest }));
    const result = f.start(); await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const delivery = await result;
    assert.equal(delivery.omittedLinks, 1);
    assert.ok(delivery.files.every(file => !/private|auth|config|outside-link/.test(file.path)));
    assert.equal(await readFile(path.join(f.root, 'outside', 'private.txt'), 'utf8'), 'not an artifact');
  } finally { f.close(); }
});

test('historical runtime metadata is hidden from file reads without rewriting delivered bytes or receipts', async () => {
  const f = await fixture();
  try {
    const pending = f.start(); await sendProjectFiles(f.entry, f.privateDirectory, f.request(), f.post);
    const delivery = await pending;
    const old = { ...delivery, files: [...delivery.files, { path: 'temporary/codex-bwrap-synthetic-mount-targets-20002/lock', size: 0,
      sha256: createHash('sha256').update('').digest('hex') }] };
    const original = JSON.stringify(old);
    f.db.prepare('UPDATE project_file_deliveries SET json=? WHERE id=?').run(original, delivery.id);
    const visible = f.files.get(delivery.id)!;
    assert.equal(visible.files.length, 3);
    assert.throws(() => f.files.read(visible, old.files.at(-1)!.path), /没有该文件/);
    assert.equal(new AdmZip(await f.files.bundle(visible)).getEntries().length, 3);
    assert.equal(f.db.prepare('SELECT json FROM project_file_deliveries WHERE id=?').get(delivery.id)!.json, original);
    assert.deepEqual(f.files.read(visible, 'temporary/report/结果.md'), f.text);
  } finally { f.close(); }
});
