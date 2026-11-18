import { projectContractCapability, projectContractV2Capability, projectDeliveryRequestSchema, projectDeliverySchema } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createApp } from '../server/index.js';
import { WebAuth, hashWebPassword } from '../server/web-auth.js';
import { MockLanguageModelV4 } from './support/model.js';
import { localProjectCapability, projectContextWindowCapability, serverProjectResources, type ProjectEvent, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectFilesCapability, projectFinalFilesCapability, type ProjectFilesUpload } from '../shared/project-files.js';
import type { LocalProjectEntry } from '../desktop/project-journal.js';
import { archiveProject, pruneProjectArchives } from '../desktop/project-archive.js';
import { captureProjectFinalFiles, sendProjectFiles } from '../desktop/project-files.js';
import { captureProject } from '../desktop/project-configuration.js';
import { executeProjectDelivery } from '../desktop/project-delivery.js';

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(runtime: V2Coordinator, predicate: () => boolean) {
  let detach = () => {}; let timer: ReturnType<typeof setTimeout> | undefined;
  try { await new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) resolve(); };
    detach = runtime.subscribe(check); timer = setTimeout(() => reject(new Error('File delivery did not settle')), 10000); check();
  }); } finally { detach(); clearTimeout(timer); }
}

for (const platform of ['linux', 'win32'] as const) for (const lostAck of [false, true]) test(`${platform} files publish before completion and survive release/restart (lost acknowledgement: ${lostAck})`, { timeout: 20000 }, async () => {
  const windows = platform === 'win32';
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-file-http-')), privateDirectory = path.join(directory, 'worker-private');
  const work = windows ? privateDirectory : path.join(directory, 'work'), workspace = path.join(work, 'workspace');
  let deviceId: string = randomUUID();
  let token = 'f'.repeat(43), modelCalls = 0;
  const worker = windows ? undefined : { id: deviceId, name: 'Fixture server', credentialHash: createHash('sha256').update(token).digest('hex') };
  const authConfig = { username: 'owner', password: await hashWebPassword('test-only-password') };
  let store = new Store(directory); store.getApiKey = () => undefined;
  const model = new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('Files must not cause a model call'); } });
  let runtime = await V2Coordinator.create(store, { dataDir: directory, model, serverWorker: worker });
  let auth = new WebAuth(authConfig, path.join(directory, 'auth.sqlite'));
  let app = createApp({ store, runtime, auth });
  const beforeCommit = gate<Error | undefined>(), commit = gate<void>(), released = gate<void>();
  let dispatched: ProjectExecutionInput | undefined;
  let entry: LocalProjectEntry | undefined, transfer: Promise<void> | undefined, transfers = 0, executions = 0, dropped = false, detach = () => {};
  let origin = '', cookie = '';
  const start = async () => {
    await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
    origin = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'test-only-password' }) });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie')!.split(';')[0]; await response.body?.cancel();
  };
  const close = async () => {
    await runtime.close(); detach(); app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); store.close(); auth.close();
  };
  try {
    await start();
    if (windows) {
      const enrollment = runtime.devices.enroll({ name: 'Fixture Windows', platform, pairingToken: runtime.devices.createPairing().token });
      deviceId = enrollment.device.id; token = enrollment.credential;
    }
    const post = async (input: ProjectFilesUpload) => {
      if (input.action === 'commit') { beforeCommit.resolve(undefined); await commit.promise; }
      const response = await fetch(origin + '/api/device/projectfiles', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(response.status, 200, await response.clone().text());
      if (lostAck && !dropped && input.action === 'chunk') { dropped = true; await response.body?.cancel(); throw new Error('lost acknowledgement'); }
      return response.json() as Promise<{ deliveryId?: string; ready?: boolean }>;
    };
    runtime.devices.updateDevice(deviceId, { grants: [], capabilities: [localProjectCapability, projectContextWindowCapability,
      projectFilesCapability, projectContractCapability, projectContractV2Capability, ...(windows ? [projectFinalFilesCapability] : [])] });
    detach = runtime.devices.attach(deviceId, message => {
      if (message.kind === 'project-execute') { executions++; dispatched = message.input; }
      if (message.kind === 'project-files') {
        transfers++; transfer = sendProjectFiles(entry!, privateDirectory, message, post).catch(async error => {
          beforeCommit.resolve(error);
          await post({ action: 'error', requestId: message.requestId, error: String(error) }).catch(() => {});
          throw error;
        }); void transfer.catch(() => {});
      }
      if (message.kind === 'project-cancel') void (async () => {
        if (!windows) await pruneProjectArchives(privateDirectory);
        const operation = runtime.devices.projects.get(message.operationId)!;
        runtime.devices.projects.record(deviceId, { operationId: message.operationId, sequence: operation.sequence + 1,
          requirementsRevision: operation.input.requirementsRevision, at: new Date().toISOString(), event: { kind: 'environment', state: 'closed', terminals: [] } });
        if (operation.state === 'running') runtime.devices.projects.record(deviceId, { operationId: message.operationId, sequence: operation.sequence + 2,
          requirementsRevision: operation.input.requirementsRevision, at: new Date().toISOString(), event: message.mode === 'pause'
            ? { kind: 'paused', reason: message.reason } : { kind: 'finished', state: 'cancelled', output: '' } });
        released.resolve();
      })();
    }, () => {});
    await store.updateSettings({ enabled: true }); runtime.start();
    const scene = await runtime.createCase({ title: 'File result fixture', objective: 'Deliver files', domain: 'test' });
    const task = await runtime.requestTask({ requestId: 'file-test', spec: { caseId: scene.id, title: 'Produce report', objective: 'Create report in the task workspace',
      expectedOutput: 'Report and data', capabilities: ['project'], project: { deviceId, root: 'task-temporary', access: 'read-write', readAccess: 'project', network: false, create: false },
      acceptance: { mode: 'owner', criteria: ['Files are downloadable'] } } });
    if (!windows) {
      assert.equal(task.state, 'proposed');
      await runtime.approveTask(task.id, task.revision, undefined, serverProjectResources(false));
    }
    await waitFor(runtime, () => Boolean(dispatched) || runtime.consent.get(task.id)?.state === 'failed');
    assert.ok(dispatched, runtime.consent.get(task.id)?.error ?? 'Project was not dispatched');
    const input = dispatched;
    assert.equal(input.deliverFiles, true); assert.equal(input.retainWorkspace, true);
    await mkdir(workspace, { recursive: true }); await mkdir(path.join(work, 'temporary'));
    const report = path.join(workspace, '报告.md'), reportText = '# 报告\n净额 5400 元\n';
    await writeFile(report, reportText);
    await writeFile(path.join(work, 'temporary', 'data.json'), '{"netFen":540000}\n');
    entry = { input, state: 'completed', sequence: 0, acknowledged: 0, appliedRevision: 1, output: 'Files generated', environment: 'closed',
      ...(windows ? await captureProject(input, undefined, workspace) : { realPath: '/work/workspace', identity: 'fixture' }) };
    let sequence = 0;
    const event = (value: ProjectEvent['event']) => runtime.devices.projects.record(deviceId,
      { operationId: input.operationId, sequence: ++sequence, requirementsRevision: input.requirementsRevision, at: new Date().toISOString(), event: value });
    const wireWorkspace = windows && process.platform !== 'win32' ? 'C:\\fixture\\workspace' : entry.realPath!;
    event({ kind: 'started', threadId: 'native-fixture', engineVersion: 'fixture', realPath: wireWorkspace, identity: entry.identity! });
    if (windows) {
      await mkdir(path.join(work, 'outputs'));
      await writeFile(path.join(workspace, 'helper.txt'), 'Local validation helper');
      assert.equal(input.contract?.version, 2);
      const requirements = input.contract.requirements;
      const guard = async () => { runtime.devices.projects.authorize(deviceId, { operationId: input.operationId,
        requirementsRevision: input.requirementsRevision, specHash: input.specHash }); };
      await executeProjectDelivery(projectDeliveryRequestSchema.parse({ summary: 'Verify final report',
        outputs: [{ path: report, format: 'md', description: 'Final report' }],
        checks: [{ id: 'report-content', criterion: 'Check the reported total', requirementIds: requirements.map(requirement => requirement.id),
          files: [report], assertions: [{ kind: 'text', path: report, equals: reportText }] }],
      }), { revision: input.requirementsRevision, requirements, objective: input.objective, workspace, directory: privateDirectory, guard,
        async command() { throw new Error('Only the real file assertion should run'); }, async desktop() { return false; },
        async recordTool(item) { event({ kind: 'tool', item }); },
        async save(delivery) { entry!.delivery = delivery; event({ kind: 'delivery', delivery: projectDeliverySchema.parse(delivery) }); },
      });
      entry.finalFilesSnapshot = await captureProjectFinalFiles(entry, privateDirectory, guard);
      assert.ok(entry.finalFilesSnapshot);
      await writeFile(report, 'Local edits after the verified snapshot');
      event({ kind: 'environment', state: 'closed', terminals: [] });
    } else {
      entry.workspaceArchive = await archiveProject(work, privateDirectory, entry);
      event({ kind: 'workspace_saved', hash: entry.workspaceArchive.hash, identity: entry.identity! });
      event({ kind: 'environment', state: 'closed', retainedWorkspace: true, terminals: [] });
      fixtureDelivery(input.requirementsRevision, 'validation', input.contract).forEach(event);
    }
    event({ kind: 'finished', state: 'completed', output: 'Report generated; verify delivered files.' });
    if (lostAck) {
      await waitFor(runtime, () => runtime.consent.get(task.id)?.state === 'failed');
      assert.equal(runtime.devices.projects.forTask(task.id)?.files, undefined);
      commit.resolve();
      const retry = await fetch(origin + `/api/tasks/${task.id}/files`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(retry.status, 200, await retry.clone().text()); await retry.body?.cancel();
    } else {
      const error = await beforeCommit.promise;
      if (error) throw error;
      assert.equal(runtime.consent.get(task.id)?.state, 'running');
      assert.equal(runtime.devices.projects.forTask(task.id)?.files, undefined, 'partial transmission is not a deliverable');
      commit.resolve(); await transfer;
    }
    await waitFor(runtime, () => runtime.consent.task(task.id)?.flow?.phase === 'awaiting_acceptance');
    const delivery = runtime.devices.projects.forTask(task.id)!.files!;
    assert.equal(delivery.files.length, windows ? 1 : 2); assert.equal(transfers, lostAck ? 2 : 1); assert.equal(executions, 1, 'file recovery never replays native execution');
    assert.equal(modelCalls, 0);
    if (windows) {
      assert.equal(delivery.snapshot.finalFingerprint, entry.finalFilesSnapshot!.fingerprint);
      assert.deepEqual(delivery.files.map(({ path, sourcePath }) => [path, sourcePath]), [['workspace/报告.md', undefined]]);
    }
    const base = `/api/tasks/${task.id}/files/content?delivery=${delivery.id}`;
    const unauthenticated = await fetch(origin + base); assert.equal(unauthenticated.status, 401); await unauthenticated.body?.cancel();
    const download = await fetch(origin + base + '&file=' + encodeURIComponent('workspace/报告.md'), { headers: { cookie } });
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /attachment;.*filename\*=UTF-8/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.equal(await download.text(), reportText);
    const escaped = await fetch(origin + base + '&file=' + encodeURIComponent('workspace/../codex/auth.json'), { headers: { cookie } });
    assert.equal(escaped.status, 400); await escaped.body?.cancel();
    const other = await fetch(origin + base.replace(task.id, 'unrelated-task'), { headers: { cookie } });
    assert.equal(other.status, 404); await other.body?.cancel();
    await runtime.acceptTaskDelivery(task.id, runtime.consent.task(task.id)!.revision);
    if (!windows) {
      await released.promise;
      assert.equal((await readdir(path.join(privateDirectory, 'workspace-snapshots'))).length, 0);
    }
    detach(); detach = () => {};
    const zipResponse = await fetch(origin + base, { headers: { cookie } }); assert.equal(zipResponse.status, 200);
    const zip = new AdmZip(Buffer.from(await zipResponse.arrayBuffer()));
    assert.equal(zip.readAsText('workspace/报告.md'), reportText);
    if (windows) assert.deepEqual(zip.getEntries().map(value => value.entryName), ['workspace/报告.md']);
    else assert.equal(zip.readAsText('temporary/data.json'), '{"netFen":540000}\n');
    const runCount = store.list('runs').length;
    await store.updateSettings({ enabled: false }); await close();
    store = new Store(directory); store.getApiKey = () => undefined;
    runtime = await V2Coordinator.create(store, { dataDir: directory, model, serverWorker: worker });
    auth = new WebAuth(authConfig, path.join(directory, 'auth.sqlite')); app = createApp({ store, runtime, auth }); detach = () => {};
    await start();
    const afterRestart = await fetch(origin + base, { headers: { cookie } }); assert.equal(afterRestart.status, 200);
    const reopened = new AdmZip(Buffer.from(await afterRestart.arrayBuffer())); assert.equal(reopened.readAsText('workspace/报告.md'), reportText);
    assert.equal(runtime.consent.task(task.id)?.flow?.phase, 'completed'); assert.equal(store.list('runs').length, runCount);
    assert.equal(store.getSettings().enabled, false, 'owner downloads do not enable inference');
  } finally { commit.resolve(); await transfer?.catch(() => {}); await close(); }
});
