import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPClient } from '@mastra/mcp';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { noopLogger } from '@mastra/core/logger';
import { z } from 'zod';
import { describeGitHubTools, assertGitHubToolResult, GitHubToolContractError } from '../server/connectors/github-tool-contract.js';
import type { GitHubMCPTools } from '../server/connectors/github-mcp.js';
import { EventInbox } from '../server/v2/events.js';
import { MockLanguageModelV4 } from './support/model.js';

const officialSearchSchema = { type: 'object', properties: { query: { type: 'string' }, perPage: { type: 'integer', minimum: 1, maximum: 100 },
  page: { type: 'integer', minimum: 1 }, sort: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] } }, required: ['query'], additionalProperties: false };
const officialWriteSchema = { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' },
  message: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  required: ['owner', 'repo', 'branch', 'message', 'files'], additionalProperties: false };
async function fixture() {
  let reads = 0; let writes = 0;
  const client = new MCPClient({ id: 'github-tool-contract-' + crypto.randomUUID(), registerProcessHooks: false,
    servers: { github: { url: new URL('https://github-mcp.fixture.invalid/mcp'), protocolVersion: 'legacy', forwardInstructions: false, onToolError: 'return',
      fetch: async (_url, init) => {
        const request = init?.body ? JSON.parse(String(init.body)) : undefined;
        const result = (value: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: value }), { headers: { 'Content-Type': 'application/json' } });
        if (request?.method === 'initialize') return result({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'github', version: 'offline' } });
        if (request?.method === 'notifications/initialized' || init?.method === 'DELETE') return new Response(null, { status: 202 });
        if (request?.method === 'tools/list') return result({ tools: [
          { name: 'search_repositories', description: 'Official search fixture', inputSchema: officialSearchSchema },
          { name: 'push_files', description: 'Official write fixture', inputSchema: officialWriteSchema },
        ] });
        if (request?.method === 'tools/call') {
          if (request.params.name === 'push_files') writes++; else reads++;
          return result({ structuredContent: { total_count: 1, items: [{ full_name: 'owner/private-recipe', description: 'PRIVATE_CORRECT_SEARCH_RESULT' }] }, content: [] });
        }
        return new Response(null, { status: 405 });
      },
    } } });
  client.__setLogger(noopLogger);
  const discovered = await client.listToolsWithErrors(); assert.deepEqual(discovered.errors, {});
  const tools: GitHubMCPTools = { search_repositories: discovered.tools.github_search_repositories, push_files: discovered.tools.github_push_files };
  return { client, tools, reads: () => reads, writes: () => writes };
}

test('GitHub tool descriptions expose the real discovered SDK input schema without REST aliases', async () => {
  const f = await fixture();
  try {
    const descriptions = await describeGitHubTools(f.tools, new Set(['search_repositories']));
    assert.equal(descriptions.length, 1); assert.equal(descriptions[0].name, 'search_repositories');
    assert.equal(descriptions[0].description, 'Official search fixture');
    const schema = descriptions[0].inputSchema as typeof officialSearchSchema;
    assert.deepEqual(schema.properties, officialSearchSchema.properties); assert.deepEqual(schema.required, ['query']);
    assert.equal(schema.additionalProperties, false); assert.equal('q' in schema.properties, false); assert.equal('per_page' in schema.properties, false);
    assert.equal(f.reads(), 0); assert.equal(f.writes(), 0);
  } finally { await f.client.disconnect(); }
});

test('SDK input validation is a safe correctable error, never a persisted GitHub success receipt', async () => {
  const f = await fixture(); const inbox = new EventInbox(':memory:');
  const invoke = async (input: unknown, name = 'search_repositories') => {
    const result = await f.tools[name].execute!(input, {}); assertGitHubToolResult(result);
    inbox.ingestProcessed({ sourceId: 'connector:fixture', sourceGeneration: 'fixture', externalId: crypto.randomUUID(), kind: 'connector.github_read',
      actor: 'external', operation: 'create', caseId: 'fixture-scene', occurredAt: new Date().toISOString(), payload: { provider: 'github', result } });
    return result;
  };
  try {
    await assert.rejects(invoke({ q: 'PRIVATE_ARGUMENT_NOT_FOR_ERRORS', sort: 'updated', order: 'desc', per_page: 10 }), error => {
      assert.ok(error instanceof GitHubToolContractError); assert.equal(error.phase, 'input'); assert.equal(error.outcomeUnknown, false);
      assert.match(error.message, /list_tools|inputSchema/); assert.doesNotMatch(error.message, /PRIVATE_ARGUMENT|Provided arguments/); return true;
    });
    assert.equal(f.reads(), 0); assert.equal(inbox.list().length, 0);
    const schema = (await describeGitHubTools(f.tools, ['search_repositories']))[0].inputSchema as typeof officialSearchSchema;
    assert.ok('query' in schema.properties && 'perPage' in schema.properties);
    await invoke({ query: 'recipe', sort: 'updated', order: 'desc', perPage: 10 });
    assert.equal(f.reads(), 1); assert.equal(inbox.list().length, 1);
    for (let n = 0; n < 2; n++) await assert.rejects(invoke({ owner: 'owner', repo: 'repo', branch: 'change', per_page: 10 }, 'push_files'), GitHubToolContractError);
    assert.equal(f.writes(), 0, 'invalid write arguments never dispatch, including retries');
    assert.equal(inbox.list().length, 1);
  } finally { inbox.close(); await f.client.disconnect(); }
});

test('nested repository error data is content, while root SDK output-validation failures retain unknown outcome', () => {
  for (const value of [
    { body: { error: true, message: 'ordinary repository data', validationErrors: { errors: [], fields: {} } } },
    { error: 'ordinary service field', message: 'content' },
    { error: true, body: 'repository content' },
  ]) assert.doesNotThrow(() => assertGitHubToolResult(value));
  assert.throws(() => assertGitHubToolResult({ error: true, message: 'Tool output validation failed for fixture. PRIVATE_RAW_RESPONSE',
    validationErrors: { errors: ['PRIVATE_RAW_RESPONSE'], fields: {} } }), error => {
    assert.ok(error instanceof GitHubToolContractError); assert.equal(error.phase, 'output'); assert.equal(error.outcomeUnknown, true);
    assert.doesNotMatch(error.message, /PRIVATE_RAW_RESPONSE/); return true;
  });
});

test('a real Mastra model turn can read official schema and correct q/per_page without creating false external evidence', async () => {
  const f = await fixture(); const inbox = new EventInbox(':memory:'); let calls = 0;
  const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
  const toolCall = (name: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: `contract-step-${calls}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [] });
  const model = new MockLanguageModelV4({ doGenerate: async input => {
    calls++; const prompt = JSON.stringify(input.prompt);
    if (calls === 1) return toolCall('read_github_repository', { input: { q: 'recipe', per_page: 10 } });
    if (calls === 2) { assert.match(prompt, /inputSchema/); assert.equal(inbox.list().length, 0); assert.equal(f.reads(), 0); return toolCall('list_tools', {}); }
    if (calls === 3) { assert.match(prompt, /query/); assert.match(prompt, /perPage/); return toolCall('read_github_repository', { input: { query: 'recipe', perPage: 10 } }); }
    assert.match(prompt, /PRIVATE_CORRECT_SEARCH_RESULT/); assert.equal(inbox.list().length, 1);
    return { content: [{ type: 'text' as const, text: 'The corrected official call returned the repository.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] };
  } });
  const tools = {
    list_tools: createTool({ id: 'list_tools', description: 'Read official tool schemas', inputSchema: z.object({}).strict(),
      execute: async () => ({ tools: await describeGitHubTools(f.tools, ['search_repositories']) }) }),
    read_github_repository: createTool({ id: 'read_github_repository', description: 'Trusted thin application dispatcher', inputSchema: z.object({ input: z.record(z.string(), z.unknown()) }),
      execute: async ({ input }) => { const result = await f.tools.search_repositories.execute!(input, {}); assertGitHubToolResult(result);
        inbox.ingestProcessed({ sourceId: 'connector:fixture', sourceGeneration: 'fixture', externalId: 'corrected-search', kind: 'connector.github_read', actor: 'external',
          operation: 'create', caseId: 'fixture-scene', occurredAt: new Date().toISOString(), payload: { provider: 'github', result } }); return result; } }),
  };
  try {
    await new Agent({ id: 'github-contract-correction', name: 'Offline contract fixture', instructions: 'Offline schema correction fixture.', model, tools, maxRetries: 0 }).generate('Search my GitHub repositories', { maxSteps: 4 });
    assert.equal(calls, 4); assert.equal(f.reads(), 1); assert.equal(f.writes(), 0);
  } finally { inbox.close(); await f.client.disconnect(); }
});
