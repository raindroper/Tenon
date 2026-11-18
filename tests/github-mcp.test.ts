import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { MCPClient } from '@mastra/mcp';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { createGitHubProvider } from '../server/connectors/github.js';
import { GitHubMCPError, gitHubToolResult, inspectGitHubAccount, inspectGitHubRepository, withGitHubTools,
  type GitHubMCPOptions, type GitHubMCPTools } from '../server/connectors/github-mcp.js';

const token = { accessToken: 'github_pat_private_fixture' };
const signal = new AbortController().signal;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve };
};
function fakeOptions(tools: GitHubMCPTools, closed: () => void = () => {}): GitHubMCPOptions {
  return { clientFactory: configuration => {
    assert.equal(configuration.registerProcessHooks, false);
    const definition = configuration.servers.github;
    assert.equal(definition.forwardInstructions, false);
    assert.deepEqual(definition.capabilities, {});
    assert.equal(definition.tasks, false);
    assert.equal(definition.enableServerLogs, false);
    assert.equal(definition.url?.href, 'https://api.githubcopilot.com/mcp/');
    return { async listToolsWithErrors() { return { tools, errors: {}, errorDetails: {} }; }, async disconnect() { closed(); } };
  } };
}
const requestObjectClient: NonNullable<GitHubMCPOptions['clientFactory']> = configuration => {
  const definition = configuration.servers.github;
  if (!definition.url || !definition.fetch) throw new Error('Expected HTTP transport');
  const originalFetch = definition.fetch;
  const requestFetch: typeof originalFetch = (input, init) => {
    const request = new Request(input, init); request.headers.set('X-Fixture-Transport', 'preserve');
    // Runtime fetch adapters can normalize (URL, init) to a Request instance.
    return (originalFetch as unknown as typeof fetch)(request);
  };
  const client = new MCPClient({ ...configuration, servers: { github: { ...definition, fetch: requestFetch } } });
  client.__setLogger(noopLogger); return client;
};
function fixtureTools(read: (name: string, input: Record<string, unknown>) => unknown | Promise<unknown>): GitHubMCPTools {
  return Object.fromEntries(['get_me', 'search_repositories', 'search_code', 'search_issues', 'search_pull_requests'].map(name => [`github_${name}`,
    createTool({ id: name, description: 'official fixture', inputSchema: z.record(z.string(), z.unknown()),
      execute: input => Promise.resolve(read(name, input)) })]));
}
const repository = { id: 57, full_name: 'owner/repo', default_branch: 'main' };

test('GitHub uses official tool schemas, excludes unrequested tools, and closes every connection', async () => {
  let closed = false; const inputSchema = z.object({ owner: z.string(), repo: z.string() }).strict();
  const official = createTool({ id: 'get_file_contents', description: 'official description', inputSchema,
    execute: async input => ({ body: input.owner }) });
  const options = fakeOptions({ github_get_file_contents: official,
    github_push_files: createTool({ id: 'push_files', description: 'write', inputSchema, execute: async () => ({}) }),
    github_delete_repository: official }, () => { closed = true; });
  await withGitHubTools(token, signal, 'read', async tools => {
    assert.deepEqual(Object.keys(tools), ['get_file_contents']);
    assert.equal(tools.get_file_contents.inputSchema, official.inputSchema);
    assert.equal(tools.get_file_contents.description, official.description);
    assert.deepEqual(await tools.get_file_contents.execute!({ owner: 'owner', repo: 'repo' }, {}), { body: 'owner' });
  }, options);
  assert.equal(closed, true);
});

test('repository inspection searches only the exact repository and checks its immutable identity', async () => {
  const calls: unknown[] = []; let current = repository;
  const options = fakeOptions(fixtureTools((name, input) => {
    calls.push({ name, input }); return { items: [current], incomplete_results: false };
  }));
  assert.deepEqual(await inspectGitHubRepository(token, 'Owner/Repo', signal, options), { id: 57, fullName: 'owner/repo', defaultBranch: 'main' });
  assert.deepEqual(calls, [{ name: 'search_repositories', input: { query: 'repo:owner/repo', perPage: 10, page: 1, minimal_output: false } }]);
  current = { ...repository, full_name: 'other/repo' };
  await assert.rejects(inspectGitHubRepository(token, 'owner/repo', signal, options), /指定仓库/);
});

test('old GitHub App credentials never become token access and errors never expose secrets', async () => {
  let connects = 0; let closes = 0;
  const options: GitHubMCPOptions = { clientFactory: () => { connects++; return {
    async listToolsWithErrors() { throw new Error('HTTP 401 ' + token.accessToken); }, async disconnect() { closes++; },
  }; } };
  await assert.rejects(inspectGitHubRepository({ accessToken: 'ghu_old' }, 'owner/repo', signal, options), /旧应用授权/);
  assert.equal(connects, 0);
  await assert.rejects(inspectGitHubRepository(token, 'owner/repo', signal, options), error => {
    assert.ok(error instanceof GitHubMCPError); assert.equal(error.status, 401);
    assert.doesNotMatch(String(error), new RegExp(token.accessToken)); return true;
  });
  assert.equal(closes, 1);
  assert.throws(() => gitHubToolResult({ isError: true, content: [{ type: 'text', text: token.accessToken }] }), /官方连接/);
});

test('read cancellation and an accepted write drain before disconnect', async () => {
  const readStarted = deferred(); const readAbort = new AbortController(); let readClosed = false;
  const read = createTool({ id: 'issue_read', description: 'fixture', inputSchema: z.object({}), execute: async (_input, context) => {
    readStarted.resolve(); await new Promise<void>((_resolve, reject) => context?.abortSignal?.addEventListener('abort', () => reject(context.abortSignal?.reason), { once: true }));
  } });
  const reading = withGitHubTools(token, readAbort.signal, 'read', async tools => tools.issue_read.execute!({}, {}),
    fakeOptions({ github_issue_read: read }, () => { readClosed = true; }));
  await readStarted.promise; readAbort.abort(); await assert.rejects(reading, { name: 'AbortError' }); assert.equal(readClosed, true);
  const writeStarted = deferred(); const finish = deferred(); const writeAbort = new AbortController(); let writeClosed = false;
  const write = createTool({ id: 'issue_write', description: 'fixture', inputSchema: z.object({}), execute: async (_input, context) => {
    assert.equal(context?.abortSignal, undefined); writeStarted.resolve(); await finish.promise; return { number: 1 };
  } });
  const writing = withGitHubTools(token, writeAbort.signal, 'write', async tools => tools.issue_write.execute!({}, {}),
    fakeOptions({ github_issue_write: write }, () => { writeClosed = true; }));
  await writeStarted.promise; writeAbort.abort(); assert.equal(writeClosed, false); finish.resolve();
  assert.deepEqual(await writing, { number: 1 }); assert.equal(writeClosed, true);
});

test('real MCP SDK never resubmits a write after transport failure or HTTP 401', async t => {
  for (const requestObject of [false, true]) for (const fault of ['disconnect', 'unauthorized'] as const) await t.test(`${fault}: ${requestObject ? 'Request' : 'URL/init'}`, async () => {
    let accepted = 0; let toolCalls = 0; let initializes = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const wire = new Request(input, init);
      const text = wire.method === 'POST' ? await wire.text() : '';
      const request = text ? JSON.parse(text) : undefined;
      const respond = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
      if (request?.method === 'initialize') { initializes++; return respond({ protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'github', version: 'fixture' } }); }
      if (request?.method === 'notifications/initialized' || wire.method === 'DELETE') return new Response(null, { status: 202 });
      if (request?.method === 'tools/list') return respond({ tools: [{ name: 'issue_write', description: 'official fixture', inputSchema: { type: 'object', properties: {} } }] });
      if (request?.method === 'tools/call') {
        toolCalls++; assert.equal(request.params.name, 'issue_write');
        if (fault === 'unauthorized') return new Response(null, { status: 401 });
        accepted++; return new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection closed')); } }),
          { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 405 });
    };
    await assert.rejects(withGitHubTools(token, signal, 'write', async tools => tools.issue_write.execute!({}, {}),
      { fetch: mockFetch, ...(requestObject ? { clientFactory: requestObjectClient } : {}) }),
      error => { assert.ok(error instanceof GitHubMCPError); assert.equal(error.outcomeUnknown, fault === 'disconnect');
        assert.doesNotMatch(String(error), new RegExp(token.accessToken)); return true; });
    assert.equal(toolCalls, 1); assert.equal(accepted, fault === 'disconnect' ? 1 : 0);
    assert.equal(initializes, fault === 'disconnect' ? 2 : 1, 'the write gate also survives the actual SDK reconnect branch');
  });
});

test('GitHub account inspection uses official get_me and binds immutable identity without listing repositories', async () => {
  const calls: unknown[] = [];
  const options = fakeOptions(fixtureTools((name, input) => {
    calls.push({ name, input });
    assert.equal(name, 'get_me'); assert.deepEqual(input, {});
    return { id: 42, login: 'owner', details: { name: 'Owner Name', email: 'PRIVATE_EMAIL_NOT_RETURNED' } };
  }));
  assert.deepEqual(await inspectGitHubAccount(token, signal, options), { id: 42, login: 'owner', name: 'Owner Name' });
  assert.deepEqual(calls, [{ name: 'get_me', input: {} }]);
  const provider = createGitHubProvider({}, options);
  assert.equal(provider.validateScope('ACCOUNT'), 'account');
  const baseline = await provider.scan({ token, scope: 'account', signal });
  const saved = JSON.parse(baseline.cursor);
  assert.equal(saved.version, 3); assert.equal(saved.accountId, 42); assert.equal(saved.login, 'owner');
  assert.deepEqual(baseline.changes, []);
  assert.equal(calls.length, 2);
  assert.throws(() => provider.authorize({ scope: 'account', state: '', redirectUri: '', challenge: '' }), /连接表单/);
});

test('account search forwards native official repository/code/issue/PR schemas and queries without a hidden repository scope', async () => {
  const queries = [
    ['search_repositories', { query: 'topic:recipe is:private', page: 2, perPage: 30, minimal_output: false }],
    ['search_repositories', { query: 'language:typescript stars:>1000', page: 1, perPage: 10 }],
    ['search_code', { query: '"prepareMeal" language:typescript', page: 1, perPage: 20 }],
    ['search_issues', { query: 'is:open "recipe generation"', sort: 'updated', order: 'desc', page: 1, perPage: 20 }],
    ['search_pull_requests', { query: 'is:open review:required', page: 1, perPage: 20 }],
  ] as const;
  const received: unknown[] = [];
  const official = fixtureTools((name, input) => { received.push([name, input]); return { total_count: 0, items: [] }; });
  await withGitHubTools(token, signal, 'read', async tools => {
    assert.ok(tools.get_me);
    for (const [name, input] of queries) {
      assert.equal(tools[name].inputSchema, official[`github_${name}`].inputSchema);
      await tools[name].execute!(input, {});
    }
    assert.equal(tools.push_files, undefined, 'discovery does not grant account writes');
  }, fakeOptions(official));
  assert.deepEqual(received, queries);
});

test('account checks permit login changes for the same immutable user but reject account substitution', async () => {
  let account = { id: 42, login: 'old-login', name: 'Owner' };
  const provider = createGitHubProvider({}, fakeOptions(fixtureTools(name => {
    assert.equal(name, 'get_me'); return account;
  })));
  const baseline = await provider.scan({ token, scope: 'account', signal });
  account = { ...account, login: 'renamed-owner' };
  const updated = await provider.scan({ token, scope: 'account', cursor: baseline.cursor, signal });
  assert.equal(JSON.parse(updated.cursor).login, 'renamed-owner');
  assert.equal(JSON.parse(updated.cursor).at, JSON.parse(baseline.cursor).at);
  assert.deepEqual(updated.changes, []);
  account = { id: 43, login: 'another-user', name: 'Other' };
  await assert.rejects(provider.scan({ token, scope: 'account', cursor: updated.cursor, signal }), error => {
    assert.ok(error instanceof Error && 'needsAttention' in error && error.needsAttention === true);
    assert.match(error.message, /账号身份已变化/); return true;
  });
});

test('retired repository checkpoints stay exact read-only data without re-scanning or silently expanding access', async () => {
  const provider = createGitHubProvider({}, { clientFactory() { throw new Error('Retired checkpoint must not start MCP'); } });
  for (const cursor of [
    '{"repositoryId":57,"at":1794240000000,"numbers":null}',
    '{"version":2,"repositoryId":57,"defaultBranch":"main","at":1794240000000,"numbers":[1],"pagination":{"kind":"issues","page":2,"end":1794240001000,"previous":"old"}}',
  ]) {
    const retained = await provider.scan({ token, scope: 'owner/repo', cursor, signal });
    assert.equal(retained.cursor, cursor); assert.deepEqual(retained.changes, []); assert.match(retained.notice!, /历史资料/);
    await assert.rejects(provider.scan({ token, scope: 'account', cursor, signal }), /明确连接账号/);
  }
  await assert.rejects(provider.scan({ token, scope: 'owner/repo', signal }), /明确连接账号/);
});

function accountTransport(options: { protocolVersion?: string; failure?: 'unauthorized' | 'forbidden' | 'gateway' | 'offline' | 'catalog'; omitAccountTool?: boolean } = {}) {
  const methods: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.githubcopilot.com/mcp/');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${token.accessToken}`);
    assert.equal(headers.get('X-MCP-Readonly'), 'true');
    assert.ok(headers.get('X-MCP-Tools')?.split(',').includes('get_me'));
    if (options.failure === 'offline') throw new TypeError('fetch failed ' + token.accessToken);
    const request = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (request?.method) methods.push(request.method);
    const respond = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
    if (request?.method === 'initialize') {
      const status = options.failure === 'unauthorized' ? 401 : options.failure === 'forbidden' ? 403 : options.failure === 'gateway' ? 503 : undefined;
      if (status) return new Response('PRIVATE_UPSTREAM_BODY ' + token.accessToken, { status });
      return respond({ protocolVersion: options.protocolVersion ?? request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'github-mcp-server', version: 'offline-fixture' } });
    }
    if (request?.method === 'notifications/initialized' || init?.method === 'DELETE') return new Response(null, { status: 202 });
    if (request?.method === 'tools/list') {
      if (options.failure === 'catalog') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32603, message: 'PRIVATE_CATALOG_ERROR ' + token.accessToken } }), { headers: { 'Content-Type': 'application/json' } });
      return respond({ tools: options.omitAccountTool ? [] : [{ name: 'get_me', description: 'Get details of the authenticated GitHub user.',
        inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', required: ['id', 'login'],
          properties: { id: { type: 'integer' }, login: { type: 'string' }, details: { type: 'object' } } } }] });
    }
    if (request?.method === 'tools/call') {
      assert.equal(request.params.name, 'get_me'); assert.deepEqual(request.params.arguments, {});
      const account = { id: 42, login: 'owner', details: { name: 'Owner Name' } };
      return respond({ structuredContent: account, content: [{ type: 'text', text: JSON.stringify(account) }] });
    }
    return new Response(null, { status: 405 });
  };
  return { fetcher, methods };
}

test('actual Mastra MCP discovery exposes github_get_me and completes the owner account flow with supported legacy wire revisions', async t => {
  for (const protocolVersion of [undefined, '2025-03-26']) await t.test(protocolVersion ?? 'SDK default legacy revision', async () => {
    const transport = accountTransport({ protocolVersion });
    assert.deepEqual(await inspectGitHubAccount(token, signal, { fetch: transport.fetcher }), { id: 42, login: 'owner', name: 'Owner Name' });
    assert.ok(transport.methods.includes('initialize')); assert.ok(transport.methods.includes('tools/list'));
    assert.equal(transport.methods.filter(method => method === 'tools/call').length, 1);
  });
});

test('actual SDK discovery failures retain safe auth/transport diagnostics instead of masquerading as a missing get_me tool', async t => {
  for (const failure of ['unauthorized', 'forbidden', 'gateway', 'offline', 'catalog'] as const) await t.test(failure, async () => {
    const transport = accountTransport({ failure });
    await assert.rejects(inspectGitHubAccount(token, signal, { fetch: transport.fetcher }), error => {
      assert.ok(error instanceof GitHubMCPError);
      assert.equal(error.status, failure === 'unauthorized' ? 401 : failure === 'forbidden' ? 403 : 502);
      assert.doesNotMatch(String(error), /账号查询工具暂不可用|PRIVATE_UPSTREAM_BODY|PRIVATE_CATALOG_ERROR/);
      assert.doesNotMatch(String(error), new RegExp(token.accessToken)); return true;
    });
    assert.equal(transport.methods.filter(method => method === 'tools/call').length, 0);
  });
});

test('a successfully discovered empty GitHub catalog remains distinguishable from failed discovery', async () => {
  const transport = accountTransport({ omitAccountTool: true });
  await assert.rejects(inspectGitHubAccount(token, signal, { fetch: transport.fetcher }), error => {
    assert.ok(error instanceof GitHubMCPError); assert.equal(error.status, 409); return true;
  });
  assert.ok(transport.methods.includes('tools/list'));
});

test('actual MCP SDK Request objects preserve content, accept, session and custom transport headers during account discovery', async () => {
  let calls = 0;
  const options: GitHubMCPOptions = {
    clientFactory: requestObjectClient,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get('X-Fixture-Transport'), 'preserve');
      assert.equal(request.headers.get('Authorization'), `Bearer ${token.accessToken}`);
      if (request.method === 'DELETE') return new Response(null, { status: 202 });
      assert.match(request.headers.get('Content-Type') ?? '', /application\/json/);
      assert.match(request.headers.get('Accept') ?? '', /application\/json/);
      assert.match(request.headers.get('Accept') ?? '', /text\/event-stream/);
      const message = JSON.parse(await request.text());
      const response = (result: unknown, session = false) => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
        headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': 'fixture-session' } : {}) },
      });
      if (message.method === 'initialize') return response({ protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'github', version: 'request-fixture' } }, true);
      assert.equal(request.headers.get('Mcp-Session-Id'), 'fixture-session');
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return response({ tools: [{ name: 'get_me', description: 'Official account fixture', inputSchema: { type: 'object' } }] });
      assert.equal(message.method, 'tools/call'); assert.equal(message.params.name, 'get_me'); calls++;
      return response({ content: [{ type: 'text', text: JSON.stringify({ id: 42, login: 'owner' }) }] });
    },
  };
  assert.deepEqual(await inspectGitHubAccount(token, signal, options), { id: 42, login: 'owner' }); assert.equal(calls, 1);
});
