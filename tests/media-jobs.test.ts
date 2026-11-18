import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { EventInbox } from '../server/v2/events.js';
import { TaskConsent } from '../server/v2/consent.js';
import { MediaJobs, type MediaBackend } from '../server/media/jobs.js';
import type { MediaSpec } from '../shared/media.js';

function gate() { let release!: () => void; const reached = new Promise<void>(resolve => { release = resolve; }); return { reached, release }; }
async function fixture(overrides: Partial<MediaBackend> = {}, onNotify?: () => void) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-media-operation-')); const file = join(directory, 'events.sqlite');
  const store = new Store(directory); const inbox = new EventInbox(file); const consent = new TaskConsent({ file, inbox });
  let submissions = 0; let notifications = 0;
  const notificationStates: string[][] = [];
  const client: MediaBackend = {
    catalog: async () => ({ enabled: true, models: [{ id: 'image', name: 'Image fixture', tags: ['text-to-image'] },
      { id: 'video', name: 'Video fixture', tags: ['text-to-video'] }] }),
    generateImage: async () => { submissions++; return { model: 'image', source: { b64: 'fixture' } }; },
    openImage: async () => ({ body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])); controller.close(); } }), mediaType: 'image/png' }),
    submitVideo: async () => { submissions++; return { id: 'original-video', status: 'queued' }; },
    videoStatus: async () => ({ id: 'original-video', status: 'queued' }),
    downloadVideo: async () => { throw new Error('No video content requested in this fixture.'); },
    cancelVideo: async () => ({ id: 'original-video', status: 'failed', error: { code: 'cancelled', message: 'cancelled while queued (未提交到上游，未扣费)' } }),
    ...overrides,
  };
  const jobs = new MediaJobs({ store, consent, client, dataDir: directory, assertActive() {}, onResult() {
    notifications++;
    notificationStates.push(store.list('mediaJobs').map(job => job.state));
    onNotify?.();
  } });
  const task = (media: MediaSpec) => {
    const approved = consent.request({ caseId: 'media-scene', title: 'Media fixture', objective: media.prompt,
      expectedOutput: 'The authorized media artifact', capabilities: ['media'], media }, 'media-owner-request');
    return consent.begin(approved.id, approved.approvalRevision!);
  };
  return { store, inbox, consent, jobs, task, notificationStates, submissions: () => submissions, notifications: () => notifications,
    async close() { await jobs.close(); consent.close(); inbox.close(); store.close(); } };
}

test('media reports its persisted receipt while the task executor retains ownership of task completion', async () => {
  const f = await fixture();
  try {
    const task = f.task({ kind: 'image', model: 'image', prompt: 'Generate the approved fixture.' });
    const job = await f.jobs.submit(task, new AbortController().signal);
    assert.equal(job.state, 'completed'); assert.equal(f.notifications(), 1);
    assert.deepEqual(f.notificationStates, [['completed']], 'The callback must observe the committed result.');
    assert.equal(f.consent.get(task.id)?.state, 'running', 'MediaJobs must not finish the enclosing task.');
    assert.equal(f.jobs.operationForTask(task.id)?.taskRevision, task.revision);
    assert.equal(f.jobs.operationForTask(task.id)?.requirementsRevision, 1);
    const owner = f.inbox.ingest({ sourceId: 'owner-chat', externalId: 'update', caseId: task.spec.caseId, kind: 'owner.message', actor: 'owner',
      operation: 'create', occurredAt: new Date().toISOString(), payload: { messageId: 'update', content: '保留原图，在交付时补充说明。' } }).event;
    const revised = f.consent.reviseRequirements(task.id, task.revision, owner.id);
    assert.equal((await f.jobs.submit(revised, new AbortController().signal)).id, job.id);
    assert.equal(f.submissions(), 1); assert.equal(f.jobs.operationForTask(task.id)?.requirementsRevision, 1);
    assert.equal(f.consent.get(task.id)?.requirementsRevision, 2);
    await assert.rejects(f.jobs.submit({ ...revised, spec: { ...revised.spec, media: { ...revised.spec.media!, prompt: 'Different media.' } } },
      new AbortController().signal), /不能更换/);
    f.jobs.recover(); assert.equal(f.notifications(), 2);
    assert.equal(f.consent.get(task.id)?.state, 'running');
  } finally { await f.close(); }
});

test('a result wake-up failure cannot downgrade an already persisted media artifact', async () => {
  const f = await fixture({}, () => { throw new Error('Task scheduler temporarily unavailable.'); });
  try {
    const task = f.task({ kind: 'image', model: 'image', prompt: 'Preserve this completed artifact.' });
    const job = await f.jobs.submit(task, new AbortController().signal);
    assert.equal(job.state, 'completed'); assert.equal(job.files.length, 1); assert.equal(f.submissions(), 1);
    assert.equal(f.jobs.operationForTask(task.id)?.state, 'completed'); assert.equal(f.consent.get(task.id)?.state, 'running');
  } finally { await f.close(); }
});

test('an uncertain media submission remains the same unknown operation across recovery', async () => {
  let posts = 0;
  const f = await fixture({ generateImage: async () => { posts++; throw new TypeError('Response lost after upstream acceptance.'); } });
  try {
    const task = f.task({ kind: 'image', model: 'image', prompt: 'One image only.' });
    const job = await f.jobs.submit(task, new AbortController().signal);
    assert.equal(job.state, 'unknown'); assert.equal(f.notifications(), 1);
    f.jobs.recover(); await f.jobs.submit(task, new AbortController().signal);
    assert.equal(posts, 1); assert.equal(f.jobs.operationForTask(task.id)?.id, job.id);
    assert.equal(f.jobs.operationForTask(task.id)?.state, 'unknown'); assert.equal(f.consent.get(task.id)?.state, 'running');
  } finally { await f.close(); }
});

test('media cancellation reports its result only after an in-flight native poll has drained', async () => {
  const entered = gate(); const release = gate(); const cancelled = gate();
  const f = await fixture({ videoStatus: async () => { entered.release(); await release.reached; return { id: 'original-video', status: 'queued' }; } });
  let unsubscribe: (() => void) | undefined;
  try {
    const task = f.task({ kind: 'video', model: 'video', prompt: 'A queued video.' });
    const job = await f.jobs.submit(task, new AbortController().signal);
    const saved = f.jobs.operationForTask(task.id)!; f.store.put('mediaJobs', { ...saved, nextPollAt: 0 });
    const polling = f.jobs.tick(); await entered.reached;
    unsubscribe = f.store.subscribe(() => { if (f.jobs.operationForTask(task.id)?.state === 'cancelled') cancelled.release(); });
    const cancelling = f.jobs.cancel(job.id); await cancelled.reached;
    assert.equal(f.notifications(), 0, 'A persisted cancellation request is not proof that native work has drained.');
    release.release(); await polling; await cancelling;
    assert.equal(f.notifications(), 1); assert.equal(f.jobs.blocksVideo('next-task'), false);
    assert.equal(f.consent.get(task.id)?.state, 'running');
  } finally { release.release(); unsubscribe?.(); await f.close(); }
});
