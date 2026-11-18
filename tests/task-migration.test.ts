import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { MediaBackend, StoredMediaJob } from '../server/media/jobs.js';
import { mediaContentPath } from '../shared/media.js';
import { MockLanguageModelV4 } from './support/model.js';

const mp4 = Buffer.from('000000186674797069736F6D0000020069736F6D69736F32', 'hex');
async function until(check: () => boolean, message: string) {
  const deadline = performance.now() + 10_000;
  while (!check()) { assert.ok(performance.now() < deadline, message); await delay(10); }
}

async function legacyMediaFixture(completed: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-task-media-migration-'));
  const data = join(directory, 'data'); const native = join(directory, 'native');
  let modelCalls = 0; let posts = 0; let reads = 0; let ready = completed;
  const model = new MockLanguageModelV4({ doGenerate: async () => { modelCalls++; throw new Error('Migration cannot call a model.'); } });
  const provider: MediaBackend = {
    catalog: async () => ({ enabled: true, models: [{ id: 'legacy-video', name: 'Legacy video fixture', tags: ['text-to-video'] }] }),
    generateImage: async () => { posts++; throw new Error('No new media generation is authorized.'); },
    openImage: async () => { throw new Error('No image exists in this fixture.'); },
    submitVideo: async () => { posts++; throw new Error('The original video must never be submitted again.'); },
    videoStatus: async id => { reads++; assert.equal(id, 'saved-upstream-id'); return { id, status: ready ? 'completed' : 'queued' }; },
    downloadVideo: async id => {
      assert.equal(id, 'saved-upstream-id');
      return { body: new ReadableStream({ start(controller) { controller.enqueue(mp4); controller.close(); } }), mediaType: 'video/mp4' };
    },
    cancelVideo: async () => { throw new Error('An upgrade must not cancel an accepted legacy job.'); },
  };
  let store = new Store(data); store.getApiKey = () => undefined;
  let runtime = await V2Coordinator.create(store, { dataDir: native, model, mediaClient: provider });
  const scene = await runtime.createCase({ title: 'Legacy media', objective: 'Preserve the original owner request', domain: 'media' });
  const approved = runtime.consent.request({ caseId: scene.id, title: 'Original approved video', objective: 'One original video',
    expectedOutput: 'The original privately saved video', capabilities: ['media'],
    media: { kind: 'video', model: 'legacy-video', prompt: 'One original video' } }, 'legacy-owner-request');
  const task = runtime.consent.begin(approved.id, approved.approvalRevision!);
  const [execution] = runtime.inbox.claim(1, 60_000, [task.executionEventId!]);
  assert.ok(execution?.leaseToken); runtime.inbox.ack(execution.id, execution.leaseToken);
  const id = createHash('sha256').update(`media:${task.id}`).digest('hex');
  const timestamp = new Date().toISOString();
  const job: StoredMediaJob = { id, taskId: task.id, caseId: scene.id, kind: 'video', model: 'legacy-video', prompt: 'One original video',
    upstreamId: 'saved-upstream-id', state: completed ? 'completed' : 'queued', createdAt: timestamp, updatedAt: timestamp, nextPollAt: 0, files: [] };
  if (completed) {
    const mediaDirectory = join(native, 'media'); await mkdir(mediaDirectory, { recursive: true });
    job.localPath = join(mediaDirectory, `${id}.bin`); await writeFile(job.localPath, mp4);
    job.files = [{ id, name: 'original.mp4', mediaType: 'video/mp4', size: mp4.length, url: mediaContentPath(id) }];
  }
  store.insert('mediaJobs', job);
  assert.equal(store.list('runs').some(run => run.taskId === task.id), false, 'The old media path did not create a model Run.');
  assert.equal(runtime.inbox.get(task.executionEventId!)?.status, 'processed');
  await runtime.close(); store.close();
  store = new Store(data); store.getApiKey = () => undefined;
  runtime = await V2Coordinator.create(store, { dataDir: native, model, mediaClient: provider });
  return { get store() { return store; }, get runtime() { return runtime; }, task, job,
    completeOriginal() { ready = true; const current = store.get('mediaJobs', id)!; store.put('mediaJobs', { ...current, nextPollAt: 0 }); },
    modelCalls: () => modelCalls, posts: () => posts, reads: () => reads,
    async reopen() {
      await runtime.close(); store.close(); store = new Store(data); store.getApiKey = () => undefined;
      runtime = await V2Coordinator.create(store, { dataDir: native, model, mediaClient: provider });
    },
    async close() { await runtime.close(); store.close(); } };
}

test('a paused upgrade adopts an accepted legacy video with no Run and delivers only the original receipt', { timeout: 25_000 }, async () => {
  const f = await legacyMediaFixture(false);
  try {
    assert.equal(f.store.getSettings().enabled, false);
    assert.equal(f.runtime.consent.get(f.task.id)?.state, 'running');
    f.completeOriginal();
    await until(() => f.runtime.consent.get(f.task.id)?.state === 'completed', 'The original accepted video was not reconciled after upgrade.');
    assert.equal(f.posts(), 0); assert.equal(f.modelCalls(), 0); assert.ok(f.reads() > 0);
    const job = f.store.get('mediaJobs', f.job.id)!;
    assert.equal(job.upstreamId, 'saved-upstream-id'); assert.equal(job.state, 'completed'); assert.equal(job.files.length, 1);
    assert.equal(f.runtime.inbox.get(f.task.executionEventId!)?.status, 'processed');
    const delivered = f.store.list('messages').filter(message => message.role === 'assistant' && message.caseId === f.task.spec.caseId);
    assert.equal(delivered.length, 1);
    await f.reopen();
    assert.equal(f.runtime.consent.get(f.task.id)?.state, 'completed');
    assert.deepEqual(f.store.list('messages').filter(message => message.role === 'assistant' && message.caseId === f.task.spec.caseId), delivered);
    assert.equal(f.posts(), 0); assert.equal(f.modelCalls(), 0);
  } finally { await f.close(); }
});

test('a paused upgrade completes the legacy task whose private media file was saved before task-state commit', { timeout: 25_000 }, async () => {
  const f = await legacyMediaFixture(true);
  try {
    assert.equal(f.store.getSettings().enabled, false);
    await until(() => f.runtime.consent.get(f.task.id)?.state === 'completed', 'A saved legacy result did not complete its original task.');
    assert.equal(f.posts(), 0); assert.equal(f.modelCalls(), 0); assert.equal(f.reads(), 0);
    assert.equal(f.store.get('mediaJobs', f.job.id)?.localPath, f.job.localPath);
    const runs = f.store.list('runs').filter(run => run.taskId === f.task.id);
    assert.equal(runs.length, 1); assert.equal(runs[0].status, 'completed'); assert.equal(runs[0].usageStatus, 'not_used');
  } finally { await f.close(); }
});
