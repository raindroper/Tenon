import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/store.js';
import { createApp } from '../server/index.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import type { RuntimeView } from '../shared/runtime-view.js';
import { MockLanguageModelV4 } from './support/model.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const start = performance.now();
  while (!check()) { assert(performance.now() - start < 20000, 'Progress HTTP fixture did not settle'); await delay(5); }
}
async function openViews(app: Server) {
  const views: RuntimeView[] = [];
  const stream = await new Promise<{ close(): void }>((accept, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port: (app.address() as { port: number }).port,
      path: '/api/state/stream?caseId=personal-growth' }, response => {
      let buffer = ''; response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const end = buffer.indexOf('\n\n'); const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!/^event: state$/m.test(frame)) continue;
          const data = frame.match(/^data: (.+)$/m)?.[1]; if (data) views.push(JSON.parse(data));
        }
      });
      accept({ close() { response.destroy(); outgoing.destroy(); } });
    }); outgoing.on('error', reject); outgoing.end();
  });
  return { views, close: () => stream.close() };
}

test('real owner tool progress reaches HTTP/SSE, survives disconnect and reload, and restores from the same saved run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-progress-http-'));
  const storeDirectory = join(directory, 'store'); const nativeDirectory = join(directory, 'native');
  let store = new Store(storeDirectory); store.getApiKey = () => undefined;
  const entered = gate(); const release = gate(); let eventId = ''; let actorCalls = 0;
  const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
  const answer = { content: [{ type: 'text' as const, text: 'The original record was checked.' }], usage, warnings: [], finishReason: { unified: 'stop' as const, raw: 'stop' } };
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    if (!options.tools?.some(tool => tool.name === 'read_event')) return answer;
    actorCalls++;
    if (actorCalls === 1) return { content: [{ type: 'tool-call', toolCallId: 'progress-real-read', toolName: 'read_event',
      input: JSON.stringify({ eventId }) }], usage, warnings: [], finishReason: { unified: 'tool-calls', raw: 'tool-calls' } };
    entered.resolve(); await release.promise; return answer;
  } });
  let runtime = await V2Coordinator.create(store, { dataDir: nativeDirectory, model });
  const app = createApp({ store, runtime }); let stream: Awaited<ReturnType<typeof openViews>> | undefined;
  try {
    await new Promise<void>(done => app.listen(0, '127.0.0.1', done));
    stream = await openViews(app); await until(() => stream!.views.length > 0);
    const owner = await runtime.ingestOwnerMessage('Read this original record. PRIVATE_SOURCE_BODY_FIXTURE'); eventId = owner.id;
    await store.updateSettings({ enabled: true, maxStepsPerRun: 8 }); runtime.start(); await entered.promise;
    await until(() => stream!.views.some(view => view.runs.some(run => run.eventId === owner.id && run.progress?.operations.some(operation => operation.status === 'succeeded'))));
    const active = stream.views.flatMap(view => view.runs).reverse().find(run => run.eventId === owner.id && run.progress?.operations.length)!;
    assert.equal(active.status, 'running'); assert.equal(active.progress!.operations.length, 1);
    assert.equal(active.progress!.operations[0].status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(active.progress), /PRIVATE_SOURCE_BODY_FIXTURE|eventId|progress-real-read.*input|arguments|reasoning/);
    const activeOther = { ...active, id: 'old-other-active', eventId: 'other-owner-event', caseId: 'other-scene',
      startedAt: new Date(Date.parse(active.startedAt) - 1000).toISOString() };
    store.insert('runs', activeOther);
    for (let index = 0; index < 45; index++) store.insert('runs', {
      id: `other-newer-${index}`, caseId: 'other-scene', trigger: 'source', mode: 'growth', status: 'completed',
      startedAt: new Date(Date.parse(active.startedAt) + index + 1).toISOString(), steps: 0, inputTokens: 0, outputTokens: 0,
    });
    const crowded = await runtime.snapshot({ caseId: 'personal-growth' });
    assert(!crowded.history.runs.items.some(run => run.id === active.id), 'Fixture moves the quiet owner request beyond recent history');
    assert(crowded.runs.some(run => run.id === active.id), 'Active owner progress stays attached without an assistant message');
    assert(!crowded.runs.some(run => run.id === activeOther.id), 'Old activity from another scene is not attached to this conversation');
    stream.close(); stream = undefined;
    assert.equal(store.get('runs', active.id)?.status, 'running', 'Viewing disconnect must not cancel work');
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const reloaded = await fetch(origin + '/api/state?caseId=personal-growth').then(response => response.json()) as RuntimeView;
    assert.equal(reloaded.runs.find(run => run.id === active.id)?.progress?.operations[0].status, 'succeeded');
    stream = await openViews(app); release.resolve();
    await until(() => store.get('runs', active.id)?.status === 'completed');
    await until(() => stream!.views.some(view => view.runs.some(run => run.id === active.id && run.status === 'completed')));
    const saved = structuredClone(store.get('runs', active.id)!.progress);
    assert(saved?.operations[0].endedAt); assert.equal(actorCalls, 2);
    stream.close(); stream = undefined;
    app.closeAllConnections(); await new Promise<void>(done => app.close(() => done()));
    await runtime.close(); store.close();
    store = new Store(storeDirectory); store.getApiKey = () => undefined;
    runtime = await V2Coordinator.create(store, { dataDir: nativeDirectory, model });
    const restored = (await runtime.snapshot({ caseId: 'personal-growth' })).runs.find(run => run.id === active.id);
    assert.deepEqual(restored?.progress, saved); assert.equal(restored?.status, 'completed'); assert.equal(actorCalls, 2);
  } finally {
    release.resolve(); stream?.close();
    if (app.listening) { app.closeAllConnections(); await new Promise<void>(done => app.close(() => done())); }
    await runtime.close(); store.close();
  }
});
