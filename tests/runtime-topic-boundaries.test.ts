import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { HubMediaClient } from '../server/media/hub-media.js';
import { V2Coordinator, type CoordinatorOptions } from '../server/v2/coordinator.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const answer = { content: [{ type: 'text' as const, text: 'Fixture complete' }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } };
function gate() {
  let open!: () => void;
  const wait = new Promise<void>(done => { open = done; });
  return { wait, open };
}
async function fixture(respond: MockLanguageModelV4['doGenerate'] = async () => answer, options: Partial<CoordinatorOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rae-topic-boundaries-'));
  const store = new Store(dataDir);
  const runtime = await V2Coordinator.create(store, { dataDir, model: new MockLanguageModelV4({ doGenerate: respond }), ...options });
  return { store, runtime, async close() { await runtime.close(); store.close(); } };
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 4000;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'Expected fixture state was not reached');
    await delay(10);
  }
}

test('stopped topic rejects stale sends and suppresses already released learning and reminder events', async () => {
  const f = await fixture();
  try {
    const topic = await f.runtime.createCase({ title: 'Fixture topic', objective: 'Exercise stop and restore', domain: 'fixture' });
    const at = new Date().toISOString();
    const learning = f.runtime.inbox.scheduleWake({ caseId: topic.id, at, reason: 'Learn later', originEventId: 'old' });
    const reminder = f.runtime.inbox.scheduleWake({ caseId: topic.id, at, reason: 'Remember later', message: 'Stale reminder', originEventId: 'old' });
    assert.equal(f.runtime.inbox.releaseDueWakes(), 2);
    await f.runtime.cancelCase(topic.id);
    await assert.rejects(f.runtime.ingestOwnerMessage('Old tab', topic.id), { status: 409 });
    assert.equal((await f.runtime.getCase(topic.id))?.status, 'cancelled');
    assert.deepEqual(f.store.list('messages'), []);
    await f.runtime.updateCase(topic.id, { status: 'active' });
    assert.deepEqual(f.runtime.inbox.ready().filter(event => [learning.id, reminder.id].includes(event.id)), []);
    assert.equal((await f.runtime.ingestOwnerMessage('Explicitly restored', topic.id)).status, 'pending');
  } finally { await f.close(); }
});

test('late media approval cannot survive a stop and subsequent restore', async () => {
  const entered = gate(); const catalog = gate();
  const mediaClient = new HubMediaClient({
    baseUrl: 'http://127.0.0.1:1/v1',
    connection: () => ({ apiBaseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }),
    fetch: async () => {
      entered.open(); await catalog.wait;
      return Response.json({ enabled: true, models: [{ id: 'fixture-image', name: 'Fixture image', tags: ['text-to-image'] }] });
    },
  });
  const f = await fixture(undefined, { mediaClient });
  let approval: Promise<unknown> | undefined;
  try {
    const topic = await f.runtime.createCase({ title: 'Fixture topic', objective: 'Exercise approval race', domain: 'fixture' });
    const event = await f.runtime.ingestOwnerMessage('Consider a mock image', topic.id);
    const task = f.runtime.consent.propose({ caseId: topic.id, title: 'Fixture image', objective: 'Render a test image',
      expectedOutput: 'One fixture image', capabilities: ['media'], media: { kind: 'image', model: 'fixture-image', prompt: 'Render a test image' } }, event.id);
    approval = assert.rejects(f.runtime.approveTask(task.id, task.revision), { status: 409 });
    await entered.wait;
    await f.runtime.cancelCase(topic.id);
    await f.runtime.updateCase(topic.id, { status: 'active' });
    catalog.open(); await approval;
    assert.equal(f.runtime.consent.get(task.id)?.state, 'proposed');
    assert.equal(f.runtime.inbox.list().some(item => item.kind === 'task.execute'), false);
  } finally { catalog.open(); await approval; await f.close(); }
});

test('a retry cooldown preserves the affected topic order while another topic can finish', async () => {
  let calls = 0;
  const f = await fixture(async () => { if (++calls === 1) throw new Error('Fixture transient failure'); return answer; });
  try {
    const topic = await f.runtime.createCase({ title: 'Affected', objective: 'Transient fixture', domain: 'fixture' });
    const other = await f.runtime.createCase({ title: 'Independent', objective: 'Unaffected fixture', domain: 'fixture' });
    const first = await f.runtime.ingestOwnerMessage('First', topic.id);
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.coolingDownCases().has(topic.id));
    const later = await f.runtime.ingestOwnerMessage('Later', topic.id);
    const independent = await f.runtime.ingestOwnerMessage('Independent', other.id);
    await until(() => f.runtime.inbox.get(independent.id)?.status === 'processed');
    assert.equal(f.runtime.inbox.get(first.id)?.attempts, 1);
    assert.equal(f.runtime.inbox.get(later.id)?.attempts, 0);
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test('a learning wake cannot schedule another model wake without new input', async () => {
  const at = new Date(Date.now() + 60_000).toISOString();
  const f = await fixture(async options => options.prompt.at(-1)?.role === 'tool' ? answer : {
    content: [
      { type: 'tool-call', toolCallId: 'chain', toolName: 'schedule_wake', input: JSON.stringify({ at, reason: 'Follow this follow-up' }) },
      { type: 'tool-call', toolCallId: 'reminder', toolName: 'schedule_wake', input: JSON.stringify({ at, reason: 'Local delivery', message: 'Saved reminder' }) },
    ], usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
  });
  try {
    const topic = await f.runtime.createCase({ title: 'Wake fixture', objective: 'Test follow-up limits', domain: 'fixture' });
    const wake = f.runtime.inbox.scheduleWake({ caseId: topic.id, at: new Date().toISOString(), reason: 'One follow-up', originEventId: 'fixture-origin' });
    f.runtime.inbox.releaseDueWakes();
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    await until(() => f.runtime.inbox.get(wake.id)?.status === 'processed');
    assert.deepEqual(f.runtime.inbox.scheduledWakes(topic.id).map(item => item.message), ['Saved reminder']);
  } finally { await f.close(); }
});

test('resume arriving during HTTP pause drain waits and applies the final owner intent', async () => {
  const f = await fixture();
  const stopping = gate(); const drained = gate(); const resumeReceived = gate();
  const app = createApp({ store: f.store, runtime: f.runtime });
  const stop = f.runtime.stop.bind(f.runtime);
  f.runtime.stop = async () => { await stop(); stopping.open(); await drained.wait; };
  app.on('request', request => {
    if (request.headers['x-fixture-resume']) request.once('end', () => setImmediate(resumeReceived.open));
  });
  await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
  const address = app.address();
  assert.ok(address && typeof address === 'object');
  const post = (action: 'pause' | 'resume') => fetch(`http://127.0.0.1:${address.port}/api/control`, {
    method: 'POST', body: JSON.stringify({ action }), headers: { 'content-type': 'application/json', ...(action === 'resume' ? { 'x-fixture-resume': '1' } : {}) },
  });
  try {
    await f.store.updateSettings({ enabled: true }); f.runtime.start();
    const paused = post('pause'); await stopping.wait;
    const resumed = post('resume'); await resumeReceived.wait;
    assert.equal(f.store.getSettings().enabled, false);
    drained.open();
    assert.equal((await paused).status, 200);
    const result = await resumed;
    assert.equal(result.status, 200); assert.equal((await result.json()).state, 'idle');
    assert.equal(f.store.getSettings().enabled, true);
    assert.deepEqual(f.runtime.inbox.list(), []);
  } finally { drained.open(); await new Promise<void>(done => app.close(() => done())); await f.close(); }
});
