import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { HubWebTools, type TrackWebRequest } from '../server/web/hub-webtools.js';

const connection = () => ({ apiBaseUrl: 'http://127.0.0.1:8788/v1', apiKey: 'test-hub-key', model: 'fixture-model' });
const signal = () => new AbortController().signal;
const encoder = new TextEncoder();
const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const searchItem = { id: 'web-item-varying-id', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'rewritten fixture query' } };
const annotation = { type: 'url_citation', title: '真实来源', url: 'https://example.com/source', start_index: 2, end_index: 9 };
function completed(options: { annotate?: boolean; includeSearch?: boolean; status?: string; text?: string } = {}) {
  return { id: 'final-response-different-from-start', object: 'response', status: options.status ?? 'completed',
    output: [...(options.includeSearch ? [searchItem] : []), { id: 'message-varying-id', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: options.text ?? '这是有来源的检索摘要。', annotations: options.annotate === false ? [] : [annotation] }] }],
    usage: { input_tokens: 999, output_tokens: 123, total_tokens: 1122 } };
}
function response(text: string) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    // Split both SSE framing and UTF-8 bytes: the installed parser owns reassembly.
    for (let start = 0; start < bytes.length; start += 13) controller.enqueue(bytes.slice(start, start + 13));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function fixture(fetcher: typeof fetch, timeoutMs?: number) {
  return new HubWebTools({ endpoint: 'http://127.0.0.1:8788/v1/responses', connection, fetch: fetcher, timeoutMs });
}

test('Hub search uses its existing Responses route with only web tools and accepts only final verified source annotations', async () => {
  let requests = 0; let tracking = 0;
  const web = fixture(async (url, init) => {
    requests++; assert.equal(url, 'http://127.0.0.1:8788/v1/responses');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-hub-key'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'fixture-model'); assert.equal(body.stream, true);
    assert.deepEqual(body.tools, [{ type: 'web_search' }, { type: 'web_fetch' }]); assert.equal(body.tool_choice, 'auto');
    assert.equal(body.max_output_tokens, undefined); assert.equal(body.reasoning, undefined);
    return response(event('response.output_item.done', { item: searchItem }) + event('response.completed', { response: completed() }));
  });
  const track: TrackWebRequest = async work => { tracking++; return work(); };
  try {
    const result = await web.run('web_search', { query: '中文搜索', num_results: 4 }, signal(), track);
    assert.equal(result.status, 'ok'); assert.equal(result.basis, 'gateway_summary'); assert.equal(result.truncated, false);
    assert.deepEqual(result.sources, [{ title: '真实来源', url: 'https://example.com/source' }]);
    assert.match(result.sourceNote ?? '', /不是网页原文/); assert.equal(requests, 1); assert.equal(tracking, 1);
    assert.equal('usage' in result, false); assert.equal('inputTokens' in result, false, 'Gateway last-round/estimated usage is not a complete count');
  } finally { await web.close(); }
});

test('completed tool cards or model-written links alone cannot certify a successful search', async () => {
  for (const [tool, annotate] of [[true, false], [false, true], [false, false]]) {
    const web = fixture(async () => response((tool ? event('response.output_item.done', { item: searchItem }) : '') +
      event('response.completed', { response: completed({ annotate, text: '看起来像来源 [页面](https://example.com/source)' }) })));
    try {
      const result = await web.run('web_search', { query: 'verify actual search' }, signal());
      assert.equal(result.status, 'unavailable'); assert.deepEqual(result.sources, []);
    } finally { await web.close(); }
  }
});

test('final nested output can carry search proof with arbitrary IDs and incomplete summaries retain their status', async () => {
  const web = fixture(async () => response(event('response.created', { response: { id: 'different-initial-response' } }) +
    event('response.incomplete', { response: completed({ includeSearch: true, status: 'incomplete' }) })));
  try {
    const result = await web.run('web_search', { query: 'research' }, signal());
    assert.equal(result.status, 'ok'); assert.equal(result.truncated, true); assert.equal(result.sources.length, 1);
  } finally { await web.close(); }
});

test('changing the model base URL disables Hub search instead of sending its key to another provider or path', async () => {
  let current = connection(); let requests = 0; let tracks = 0;
  const web = new HubWebTools({ endpoint: 'http://127.0.0.1:8788/v1/responses', connection: () => current,
    fetch: async () => { requests++; return response(event('response.completed', { response: completed({ includeSearch: true }) })); } });
  const track: TrackWebRequest = async work => { tracks++; return work(); };
  try {
    for (const apiBaseUrl of ['https://api.other-provider.example/v1', 'http://127.0.0.1:8788/other-prefix']) {
      current = { ...current, apiBaseUrl };
      assert.equal((await web.run('web_search', { query: 'query' }, signal(), track)).status, 'unavailable');
    }
    current = { ...connection(), apiKey: '' };
    assert.equal((await web.run('web_search', { query: 'query' }, signal(), track)).status, 'unavailable');
    await assert.rejects(web.run('web_search', { query: 'query', endpoint: 'https://evil.example' }, signal(), track));
    assert.equal((await web.run('web_fetch', { url: 'https://example.com' }, signal(), track)).status, 'unavailable');
    assert.equal(requests, 0); assert.equal(tracks, 0);
  } finally { await web.close(); }
});

test('an abort waits for transport cancellation before acknowledging; queued cancellation never starts another request', async () => {
  let cancelEntered!: () => void; const entered = new Promise<void>(done => { cancelEntered = done; });
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  let requests = 0; let cancelled = false;
  const web = fixture(async () => {
    requests++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(event('response.output_item.done', { item: searchItem }))); },
      async cancel() { cancelEntered(); await gate; cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const active = new AbortController(); const queued = new AbortController();
  try {
    let acknowledged = false;
    const running = web.run('web_search', { query: 'active query' }, active.signal).catch(error => { acknowledged = true; throw error; });
    const stopped = assert.rejects(running, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    await delay(10);
    const waiting = web.run('web_search', { query: 'queued query' }, queued.signal); queued.abort(); await assert.rejects(waiting);
    assert.equal(requests, 1); active.abort(); await entered; await delay(20); assert.equal(acknowledged, false);
    release(); await stopped; assert.equal(cancelled, true); await web.close(); assert.equal(requests, 1);
  } finally { release(); active.abort(); queued.abort(); await web.close(); }
});

test('deadline stops and drains a stalled search without automatic retries', async () => {
  let cancelled = false; let requests = 0;
  const web = fixture(async () => { requests++; return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'text/event-stream' } }); }, 20);
  try {
    const result = await web.run('web_search', { query: 'stalled query' }, signal());
    assert.equal(result.status, 'unavailable'); assert.match(result.content, /超时/); assert.equal(cancelled, true); assert.equal(requests, 1);
  } finally { await web.close(); }
});

test('HTTP and SSE errors never expose response diagnostics or credentials as search content', async () => {
  for (const failure of [
    () => new Response('TEST_SECRET_FROM_UPSTREAM', { status: 401 }),
    () => response(event('response.failed', { response: { error: { message: 'TEST_SECRET_FROM_UPSTREAM' } } })),
    () => new Response('{"secret":"TEST_SECRET_FROM_UPSTREAM"}', { headers: { 'content-type': 'application/json' } }),
    () => response('event: response.completed\ndata: not-json TEST_SECRET_FROM_UPSTREAM\n\n'),
    () => response(event('response.output_item.done', { item: searchItem }) + event('response.completed', { response: {
      status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'TEST_SECRET_REASONING', annotations: [annotation] }] }],
    } })),
  ]) {
    const web = fixture(async () => failure());
    try {
      const result = await web.run('web_search', { query: 'error query' }, signal());
      assert.equal(result.status, 'unavailable'); assert.deepEqual(result.sources, []); assert.doesNotMatch(JSON.stringify(result), /TEST_SECRET|test-hub-key/);
    } finally { await web.close(); }
  }
});

test('transport remains bounded and source cleanup completes when malformed or excessive data is returned', async () => {
  let cancelled = false;
  const web = fixture(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  try {
    assert.equal((await web.run('web_search', { query: 'oversized query' }, signal())).status, 'unavailable'); assert.equal(cancelled, true);
  } finally { await web.close(); }
});
