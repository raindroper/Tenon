import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTencentDocsProvider } from '../server/connectors/tencent-docs.js';
import { ConnectorProviderError } from '../server/connectors/types.js';

const signal = new AbortController().signal;

test('Tencent Docs sends only the authorized sheet to fixed read tools and preserves repeated revisions', async t => {
  const provider = createTencentDocsProvider({});
  const authorizedId = 'DShareLinkSheet17';
  const sheetUrl = `https://docs.qq.com/sheet/${authorizedId}`;
  const scope = provider.validateScope(`${sheetUrl}?ignored=1`);
  assert.throws(() => provider.validateScope(`https://docs.qq.com.example/sheet/${authorizedId}`));
  assert.equal(provider.tokenGrantUrl, 'https://docs.qq.com/open/auth/mcp.html');
  const token = { accessToken: 'owner-token' };
  const requests: string[] = [];
  let content = 'initial';
  let returnedUrl = `${sheetUrl}?ignored=1`;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://docs.qq.com/openapi/mcp');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'owner-token');
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const request = JSON.parse(String(init.body));
    requests.push(request.method === 'tools/call' ? request.params.name : request.method);
    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2025-06-18' } }, { headers: { 'Mcp-Session-Id': 'session' } });
    assert.equal(headers.get('Mcp-Session-Id'), 'session');
    assert.equal(headers.get('MCP-Protocol-Version'), '2025-06-18');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') return respond({ tools: [
      { name: 'manage.query_file_info' }, { name: 'get_content' }, { name: 'delete_space_node' },
    ] });
    assert.deepEqual(request.params.arguments, { file_id: authorizedId });
    if (request.params.name === 'manage.query_file_info') return respond({ structuredContent: {
      file_id: 'Canonical123', title: 'Workbook', url: returnedUrl, type: 'sheet',
    } });
    assert.equal(request.params.name, 'get_content');
    const result = { content: [{ type: 'text', text: JSON.stringify({ content, error: '' }) }] };
    return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const expectedDocument = { title: 'Workbook', type: 'sheet', url: sheetUrl };
  assert.deepEqual(await provider.previewDocument!({ token, scope, signal }), expectedDocument);
  assert.deepEqual(requests.splice(0), ['initialize', 'notifications/initialized', 'tools/list', 'manage.query_file_info']);

  content = `${'x'.repeat(4000)}\nThis row is beyond the observation excerpt.`;
  assert.deepEqual(await provider.readDocument!({ token, scope: `${sheetUrl}?ignored=1`, signal }), { content, document: expectedDocument });
  assert.deepEqual(requests.splice(0), ['initialize', 'notifications/initialized', 'tools/list', 'manage.query_file_info', 'get_content']);

  content = 'initial';
  const scan = (cursor?: string) => provider.scan({ token, scope, signal, cursor });
  const baseline = await scan();
  assert.deepEqual(baseline.document, expectedDocument);
  assert.deepEqual(baseline.changes, []);
  assert.deepEqual((await scan(baseline.cursor)).changes, []);
  content = 'x'.repeat(4000);
  const first = await scan(baseline.cursor);
  assert.equal(first.changes[0].title, 'Workbook');
  assert.equal(first.changes[0].content.length, 4000);
  assert.equal(first.changes[0].totalCharacters, 4000);
  assert.equal(first.changes[0].truncated, false);
  assert.equal(first.changes[0].id, authorizedId);
  assert.equal(first.changes[0].url, sheetUrl);
  content = 'initial';
  const reverted = await scan(first.cursor);
  content = 'x'.repeat(4000);
  const second = await scan(reverted.cursor);
  assert.notEqual(first.changes[0].revision, second.changes[0].revision);
  assert.deepEqual(requests.slice(0, 5), ['initialize', 'notifications/initialized', 'tools/list', 'manage.query_file_info', 'get_content']);

  returnedUrl = 'https://docs.qq.com/sheet/DUnrelatedSheet';
  const requestStart = requests.length;
  await assert.rejects(scan(), /读取文件信息/);
  assert.deepEqual(requests.slice(requestStart), ['initialize', 'notifications/initialized', 'tools/list', 'manage.query_file_info']);
});

test('Tencent Docs distinguishes oversized document streams from access errors', async t => {
  const provider = createTencentDocsProvider({});
  const scope = provider.validateScope('https://docs.qq.com/sheet/OneSheet');
  const token = { accessToken: 'owner-token' };
  const cases = [
    {
      name: 'oversized SSE body', status: 502, message: /^腾讯文档响应超出读取上限（读取正文）。$/,
      response(id: number) {
        const text = JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) });
        const result = { content: [{ type: 'text', text }] };
        return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
    },
    {
      name: 'file permission denied', status: 403, message: /^腾讯文档拒绝访问，请检查授权账号能否打开该文件。$/,
      response(id: number) {
        return Response.json({ jsonrpc: '2.0', id, error: { code: 400005, message: 'provider-only detail' } });
      },
    },
    {
      name: 'expired authorization', status: 401, message: /^腾讯文档授权已失效，请重新获取 Token。$/,
      response(id: number) {
        const text = JSON.stringify({ error: '400012 provider-only detail' });
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async subtest => {
      subtest.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
        if (request.method === 'initialize') return respond({ protocolVersion: '2025-06-18' });
        if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (request.method === 'tools/list') return respond({ tools: [{ name: 'get_content' }] });
        assert.equal(request.method, 'tools/call');
        assert.deepEqual(request.params, { name: 'get_content', arguments: { file_id: 'OneSheet' } });
        return fixture.response(request.id);
      });

      await assert.rejects(provider.readDocument!({ token, scope, signal }), (error: unknown) =>
        error instanceof ConnectorProviderError && error.status === fixture.status && fixture.message.test(error.message));
    });
  }
});
