import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { V2Coordinator } from '../server/v2/coordinator.js';
import { createApp } from '../server/index.js';

const listen = (server: Server): Promise<number> => new Promise(done => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)));
const close = (server: Server): Promise<void> => server.listening ? new Promise((done, fail) => server.close(error => error ? fail(error) : done())) : Promise.resolve();
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'scripted provider outcome did not persist'); await delay(15); }
}

test('Mastra -> real DeepSeek HTTP SDK -> scoped tools -> prepared artifact -> feedback with original target (local provider only)', async context => {
  const prefix = join(tmpdir(), 'rae-mastra-wire-'); const directory = await mkdtemp(prefix);
  const store = new Store(directory); store.getApiKey = () => 'fixture-key-not-a-real-credential';
  let step = 0; const requests: Record<string, unknown>[] = []; let providerFailure: unknown;
  const artifactBody = '# SDK fixture artifact\n\nThis exact target text must accompany feedback.';
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; requests.push(input);
      assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer fixture-key-not-a-real-credential');
      assert.equal(input.stream, true, 'the installed SDK must use its actual streaming transport');
      step++; assert.ok(step <= 4, 'fixture allows only the four expected local SDK requests');
      let name = ''; let args: Record<string, unknown> = {};
      if (step === 1) { name = 'publish_artifact'; args = { title: 'SDK成果草稿', content: artifactBody, format: 'markdown' }; }
      if (step === 3) { name = 'save_working_state'; args = { content: '已收到真实成果反馈：下次使用短句。', status: 'waiting' }; }
      const delta = name ? { role: 'assistant', content: null, reasoning_content: '', tool_calls: [{ index: 0, id: 'fixture_call_' + step, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: step === 2 ? '草稿已经保存，等待你的反馈。' : '已保留反馈并调整事项状态。', reasoning_content: '' };
      const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: 'fixture_completion_' + step, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'deepseek-flash', choices, ...(usage ? { usage } : {}) })}\n\n`;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(chunk([{ index: 0, delta, finish_reason: null }])
        + chunk([{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 }) + 'data: [DONE]\n\n');
    } catch (error) { providerFailure = error; response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Local scripted provider assertion failed' } })); }
  });
  const providerPort = await listen(provider);
  await store.updateSettings({ enabled: true, model: 'deepseek-flash', maxStepsPerRun: 3, apiBaseUrl: 'http://127.0.0.1:' + providerPort + '/v1' });
  let runtime = await V2Coordinator.create(store, { dataDir: directory }); const app = createApp({ store, runtime }); const appPort = await listen(app);
  const post = async (path: string, body: unknown) => {
    const response = await fetch('http://127.0.0.1:' + appPort + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, path + ': ' + response.status + ' ' + JSON.stringify(data)); return data;
  };
  try {
    const item = await post('/api/cases', { title: 'SDK链路事项', objective: '检验真实工具调用和反馈关联', domain: 'fixture' });
    const requested = await post('/api/tasks', { requestId: randomUUID(), spec: { caseId: item.id, title: '本人明确委托的SDK文本草稿',
      objective: '仅在本地合成链路中检验文本交付与真实工具调用', expectedOutput: '保存一份SDK成果草稿，供本人给出反馈', capabilities: ['artifact'] } });
    assert.equal(requested.state, 'approved'); assert.equal(requests.length, 0, 'owner consent persists before starting inference');
    runtime.start(); await waitFor(() => store.list('runs').filter(run => run.status === 'completed').length === 1);
    const artifact = store.list('artifacts')[0]; assert.ok(artifact); assert.equal(artifact.caseId, item.id); assert.equal(artifact.content, artifactBody); assert.equal(artifact.taskId, requested.id);
    assert.equal((await runtime.listTasks()).find(task => task.id === requested.id)?.state, 'completed');
    const executionRun = store.list('runs').find(run => run.taskId === requested.id); assert.equal(executionRun?.mode, 'execution');
    assert.equal(artifact.status, 'prepared'); assert.equal((await runtime.getCase(item.id))?.status, 'active', 'a text artifact is not a verified work outcome');
    assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1]), /"role":"tool"/);
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 1);
    const feedback = await post('/api/feedback', { targetType: 'artifact', targetId: artifact.id, verdict: 'off_target', comment: '这只是fixture：下次使用短句。' });
    assert.equal(feedback.caseId, item.id);
    assert.equal(feedback.targetContent, artifactBody); assert.equal(store.get('feedback', feedback.id)?.targetContent, artifactBody);
    const feedbackEvent = runtime.inbox.list().find(event => event.kind === 'owner.feedback')!; assert.equal(feedbackEvent.caseId, item.id); assert.equal(feedbackEvent.payload.targetContent, artifactBody);
    await waitFor(() => store.list('runs').filter(run => run.status === 'completed').length === 2);
    assert.match(JSON.stringify(requests[2]), /下次使用短句/); assert.ok(JSON.stringify(requests[2]).includes('This exact target text must accompany feedback.'));
    assert.match((await runtime.getCaseDetails(item.id)).working ?? '', /短句/); assert.equal((await runtime.getCase(item.id))?.status, 'waiting');
    assert.equal(store.list('messages').filter(message => message.role === 'assistant').length, 1, 'background final text does not duplicate a notification');
    assert.equal(requests.length, 4);
    assert.deepEqual(store.todayUsage(), { inputTokens: 400, outputTokens: 320, usageStatus: 'reported' });
    const tokenView = await runtime.snapshot();
    assert.deepEqual(tokenView.status.todayUsage, store.todayUsage());
    assert.equal(tokenView.runs.some(run => 'costCny' in run || 'reservedCostCny' in run), false);
    assert.equal(providerFailure, undefined);
    assert.equal(store.list('runs').find(run => run.eventId === feedbackEvent.id)?.mode, 'growth');
    await close(app); await runtime.close(); await store.updateSettings({ enabled: false });
    runtime = await V2Coordinator.create(store, { dataDir: directory });
    const reopened = await runtime.getCaseDetails(item.id); assert.match(reopened.working ?? '', /短句/); assert.ok(JSON.stringify(reopened.history).includes(artifactBody.split('\n')[0]));
    assert.equal((await runtime.listTasks()).find(task => task.id === requested.id)?.state, 'completed'); assert.equal((await runtime.snapshot()).artifacts[0].taskId, requested.id);
    assert.equal(requests.length, 4, 'reopening storage must not invoke the provider');
  } finally {
    await close(app); await runtime.close(); await close(provider); store.close();
    const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix)));
    try { await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 40 }); }
    catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) throw error; context.diagnostic('cleanupDeferred=' + target); }
  }
});
