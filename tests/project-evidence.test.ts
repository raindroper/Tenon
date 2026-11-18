import { projectFilesCapability, projectFinalFilesCapability } from '../shared/project-files.js';
import { projectContractCapability, projectContractV2Capability } from '../shared/project-contract.js';
import { fixtureDelivery } from './support/project-delivery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { runResponseId } from '../server/v2/run-response.js';
import { hashWebPassword, WebAuth } from '../server/web-auth.js';
import { MockLanguageModelV4 } from './support/model.js';
import { localProjectCapability, type ProjectExecutionInput } from '../shared/local-project.js';
import type { ImageAttachment } from '../shared/chat-images.js';
import type { RuntimeView } from '../shared/runtime-view.js';

async function waitFor(runtime: V2Coordinator, predicate: () => boolean) {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => { if (predicate()) resolve(); };
      unsubscribe = runtime.subscribe(check);
      timer = setTimeout(() => reject(new Error('Project screenshot fixture did not settle')), 10000);
      check();
    });
  } finally { unsubscribe(); clearTimeout(timer); }
}

test('project screenshot uploads honor the device and revision, then appear with the report in the original conversation', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-project-screenshots-'));
  const store = new Store(directory);
  store.getApiKey = () => undefined;
  const runtime = await V2Coordinator.create(store, { dataDir: directory, model: new MockLanguageModelV4({
    doGenerate: async () => { throw new Error('The screenshot fixture must not call a model.'); },
  }) });
  const password = 'project-screenshot-test-fixture';
  const auth = new WebAuth({ username: 'owner', password: await hashWebPassword(password) }, join(directory, 'auth.sqlite'));
  const app = createApp({ store, runtime, auth });
  let detach: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (app.address() as { port: number }).port;
    const login = await fetch(origin + '/api/auth/login', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }),
    });
    assert.equal(login.status, 200);
    await login.body?.cancel();
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const scene = await runtime.createCase({ title: 'Original conversation', objective: 'Verify evidence delivery', domain: 'test' });
    const { device, credential } = runtime.devices.enroll({
      name: 'Screenshot fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token,
    });
    const other = runtime.devices.enroll({
      name: 'Unrelated fixture', platform: 'win32', pairingToken: runtime.devices.createPairing().token,
    });
    runtime.devices.updateDevice(device.id, { grants: [], capabilities: [localProjectCapability, projectContractCapability, projectContractV2Capability, projectFilesCapability, projectFinalFilesCapability] });
    let input: ProjectExecutionInput | undefined;
    detach = runtime.devices.attach(device.id, message => {
      if (message.kind === 'project-execute') input = message.input;
      if (message.kind === 'project-cancel' && input) {
        const operation = runtime.devices.projects.get(input.operationId)!;
        runtime.devices.projects.record(device.id, {
          operationId: input.operationId, sequence: operation.sequence + 1, requirementsRevision: input.requirementsRevision,
          at: new Date().toISOString(), event: { kind: 'finished', state: 'cancelled', output: 'Fixture stopped.' },
        });
      }
    });
    await store.updateSettings({ enabled: true });
    runtime.start();
    const task = await runtime.requestTask({ requestId: 'screenshot-fixture', spec: {
      caseId: scene.id, title: 'Verify the page', objective: 'Read the visible page', expectedOutput: 'Report and screenshot', capabilities: ['project'],
      project: { deviceId: device.id, root: 'D:\\fixture', access: 'read-only', readAccess: 'project', network: true, create: false, returnScreenshots: true },
    } });
    await waitFor(runtime, () => Boolean(input));
    const { operationId, specHash, requirementsRevision, runId } = input!;
    const authorization = { operationId, specHash, requirementsRevision };
    const source = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#334455' } }).png().toBuffer();
    const image = { name: 'actual.png', data: source.toString('base64') };
    const upload = (body: unknown, token = credential) => fetch(origin + '/api/device/projectevidence', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const rejectUpload = async (status: number, body: unknown, token?: string) => {
      const response = await upload(body, token);
      assert.equal(response.status, status);
      await response.body?.cancel();
    };
    await rejectUpload(403, { authorization, image }, other.credential);
    await rejectUpload(409, { authorization: { ...authorization, requirementsRevision: requirementsRevision + 1 }, image });
    await rejectUpload(400, { authorization, image: { ...image, data: 'AAAA' } });
    const response = await upload({ authorization, image });
    assert.equal(response.status, 200);
    const attachment = await response.json() as ImageAttachment;
    assert.deepEqual([attachment.name, attachment.mediaType, attachment.width, attachment.height], ['actual.png', 'image/png', 24, 16]);
    const repeated = await upload({ authorization, image });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), attachment);
    assert.equal(runtime.devices.projects.evidence(operationId, requirementsRevision).length, 1);
    assert.equal(runtime.devices.projects.evidence(operationId, requirementsRevision + 1).length, 0);

    const read = (headers?: HeadersInit) => fetch(origin + '/api/images/' + attachment.id, { headers });
    for (const headers of [undefined, { authorization: 'Bearer ' + credential }]) {
      const denied = await read(headers);
      assert.equal(denied.status, 401);
      await denied.body?.cancel();
    }
    const provisional = 'Verified the actual result.';
    store.put('messages', { id: runResponseId(runId), role: 'assistant', content: provisional, caseId: scene.id,
      runId, createdAt: new Date().toISOString(), outputState: 'streaming' });
    const finalReport = provisional + '\n\nA second requested screenshot could not be returned.';
    fixtureDelivery(requirementsRevision, undefined, input!.contract).forEach((event, i) => runtime.devices.projects.record(device.id, {
      operationId, sequence: i + 1, requirementsRevision, at: new Date().toISOString(), event,
    }));
    runtime.devices.projects.record(device.id, {
      operationId, sequence: 4, requirementsRevision, at: new Date().toISOString(),
      event: { kind: 'environment', state: 'closed', terminals: [] },
    });
    runtime.devices.projects.record(device.id, {
      operationId, sequence: 5, requirementsRevision, at: new Date().toISOString(),
      event: { kind: 'finished', state: 'completed', output: finalReport },
    });
    await waitFor(runtime, () => runtime.consent.get(task.id)?.state === 'completed');
    const reply = store.list('messages').find(message => message.runId === runId);
    assert.equal(reply?.caseId, scene.id);
    assert.equal(reply?.content, finalReport);
    assert.deepEqual(reply?.attachments, [attachment]);
    const state = await fetch(origin + '/api/state?caseId=' + scene.id, { headers: { cookie } });
    assert.equal(state.status, 200);
    const snapshot = await state.json() as RuntimeView;
    assert.deepEqual(snapshot.messages.find(message => message.id === reply?.id)?.attachments, [attachment]);
    const saved = await read({ cookie });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), runtime.devices.projects.readEvidenceImage(attachment.id)?.data);
    const exported = await fetch(origin + '/api/export', { headers: { cookie } });
    assert.equal(exported.status, 200);
    const exportData = await exported.json() as { imageFiles: Array<{ id: string; caseId: string; messageId: string; data: string }> };
    const file = exportData.imageFiles.find(value => value.id === attachment.id);
    assert.equal(file?.caseId, scene.id);
    assert.equal(file?.messageId, reply?.id);
    assert.equal(file?.data, runtime.devices.projects.readEvidenceImage(attachment.id)?.data.toString('base64'));
    await rejectUpload(409, { authorization, image });

    input = undefined;
    const { returnScreenshots: _screenshots, ...project } = task.spec.project!;
    await runtime.requestTask({ requestId: 'project-without-screenshot-consent', spec: { ...task.spec, project } });
    await waitFor(runtime, () => Boolean(input));
    const { operationId: otherOperationId, specHash: otherHash, requirementsRevision: otherRevision } = input!;
    await rejectUpload(403, { authorization: { operationId: otherOperationId, specHash: otherHash, requirementsRevision: otherRevision }, image });
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>(resolve => app.close(() => resolve()));
    try { await runtime.close(); } finally { detach?.(); await auth.close(); store.close(); }
  }
});
