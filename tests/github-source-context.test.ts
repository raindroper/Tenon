import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CaseMemory } from '../server/v2/memory.js';
import { caseSourceContext, toolEvidenceIds, type ConnectorEvidenceFilter } from '../server/v2/source-context.js';
import { MockLanguageModelV4 } from './support/model.js';

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const call = (name: string, id = 'github-fixture-call') => ({ content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: '{}' }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' }, usage, warnings: [] });
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const ownerSource = (caseId: string) => ({ version: 1, caseId, connectionId: 'github-one', repositoryId: 7, credentialRevision: 2 });
const ownerResult = (caseId: string) => ({ githubSource: ownerSource(caseId), evidenceId: 'github-read-receipt', result: { body: 'PRIVATE_GITHUB_SOURCE' } });
const toolMessage = (value: unknown, name = 'read_github_repository') => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'github-fixture-call',
  toolName: name, output: { type: 'json', value } }] });

test('owner GitHub provenance checks scene, repository identity, credential revision and durable receipt before a model request', () => {
  let connected = true; let revision = 2; let actualCase = 'case-one';
  const allowed: ConnectorEvidenceFilter = (caseId, id, source) => connected && caseId === actualCase && id === 'github-one'
    && source?.repositoryId === 7 && source.credentialRevision === revision;
  const processor = () => caseSourceContext('case-one', (_case, id) => id === 'github-read-receipt', allowed);
  const prompt = [user('Read the connected code'), toolMessage(ownerResult('case-one'))];
  assert.equal(processor().processLLMRequest({ prompt } as never), undefined);
  assert.deepEqual(toolEvidenceIds('read_github_repository', ownerResult('case-one')), ['github-read-receipt']);
  for (const change of [() => { connected = false; }, () => { connected = true; revision = 3; }, () => { revision = 2; actualCase = 'case-two'; }]) {
    change(); assert.throws(() => processor().processLLMRequest({ prompt } as never), /来源已停用/);
  }
  connected = true; revision = 2; actualCase = 'case-one';
  const forgedInsideRawBody = { result: ownerResult('case-one') };
  assert.throws(() => processor().processLLMRequest({ prompt: [user('Read'), toolMessage(forgedInsideRawBody)] } as never), /来源已停用/);
  assert.throws(() => processor().processLLMRequest({ prompt: [user('Read'), toolMessage({ ...ownerResult('case-one'), evidenceId: undefined })] } as never), /来源已停用/);
});

test('GitHub connection catalogs require matched trusted snapshots and disappear after revocation', () => {
  const source = ownerSource('case-one');
  const value = { githubSources: [source], connections: [{ connectionId: source.connectionId,
    repository: 'owner/private', repositoryId: source.repositoryId, credentialRevision: source.credentialRevision }] };
  const prompt = [user('List my connected repository'), toolMessage(value, 'list_github_connections'),
    { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_REPOSITORY_SUMMARY' }] }, user('New question')];
  const filtered = caseSourceContext('case-one', () => true, () => false).processLLMRequest({ prompt } as never) as { prompt: unknown[] };
  assert.doesNotMatch(JSON.stringify(filtered.prompt), /owner\/private|PRIVATE_REPOSITORY_SUMMARY/);
  assert.match(JSON.stringify(filtered.prompt), /New question/);
  const mismatched = { ...value, connections: [{ ...value.connections[0], repositoryId: 8 }] };
  assert.throws(() => caseSourceContext('case-one', () => true, () => true).processLLMRequest({ prompt: [user('List'), toolMessage(mismatched, 'list_github_connections')] } as never), /来源已停用/);
});

test('real CaseMemory prompts stop replaying GitHub private results and derived text after disconnect, rotation or scene mismatch', async t => {
  for (const reason of ['disconnect', 'rotation', 'scene'] as const) await t.test(reason, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rae-github-source-memory-'));
    const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'github-source-owner');
    let connected = true; let revision = 2; let sourceCase: string;
    const prompts: string[] = [];
    memory.setSourceEvidenceFilter((_case, id) => id === 'github-read-receipt');
    memory.setConnectorEvidenceFilter((caseId, id, source) => connected && caseId === sourceCase && id === 'github-one'
      && source?.repositoryId === 7 && source.credentialRevision === revision);
    const model = new MockLanguageModelV4({ doGenerate: async input => {
      const text = JSON.stringify(input.prompt); prompts.push(text);
      if (prompts.length === 1) return call('read_github_repository');
      if (prompts.length === 2) { assert.match(text, /PRIVATE_GITHUB_SOURCE/); return answer('PRIVATE_DERIVED_ANSWER'); }
      assert.doesNotMatch(text, /PRIVATE_GITHUB_SOURCE|PRIVATE_DERIVED_ANSWER|FIRST_PRIVATE_QUESTION/);
      assert.match(text, /NEXT_OWNER_QUESTION/); return answer('Only currently allowed information is used.');
    } });
    try {
      const scene = await memory.createCase({ title: 'Private source', objective: '', domain: 'fixture' }); sourceCase = scene.id;
      const read = createTool({ id: 'read_github_repository', description: 'Trusted application adapter fixture', inputSchema: z.object({}), execute: async () => ownerResult(scene.id) });
      await memory.runCase({ caseId: scene.id, message: 'FIRST_PRIVATE_QUESTION', model, instructions: 'Offline fixture.',
        tools: { read_github_repository: read }, maxSteps: 2, observeOwnerConversation: false });
      if (reason === 'disconnect') connected = false;
      if (reason === 'rotation') revision++;
      if (reason === 'scene') sourceCase = 'different-case';
      await memory.runCase({ caseId: scene.id, message: 'NEXT_OWNER_QUESTION', model, instructions: 'Offline fixture.', maxSteps: 1, observeOwnerConversation: false });
      assert.equal(prompts.length, 3);
      assert.match(JSON.stringify(await memory.historyForObservation(scene.id)), /PRIVATE_GITHUB_SOURCE|PRIVATE_DERIVED_ANSWER/,
        'Stored native history remains available for owner viewing/export');
    } finally { await memory.close(); }
  });
});

test('real task memory keeps current official schemas/results but drops old raw GitHub read and write turns', async () => {
  for (const toolName of ['github_get_file_contents', 'github_update_pull_request', 'github_search_repositories', 'github_search_code', 'github_search_issues', 'github_search_pull_requests']) {
    const directory = await mkdtemp(join(tmpdir(), 'rae-github-task-source-'));
    const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'github-task-owner');
    memory.setSourceEvidenceFilter(() => true);
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async input => {
      calls++; const text = JSON.stringify(input.prompt);
      if (calls === 1) return call(toolName);
      if (calls === 2) { assert.match(text, /PRIVATE_OFFICIAL_RESULT/); return answer('PRIVATE_DERIVED_TASK_ANSWER'); }
      assert.doesNotMatch(text, /PRIVATE_OFFICIAL_RESULT|PRIVATE_DERIVED_TASK_ANSWER|ORIGINAL_TASK_REQUEST/);
      return answer('The next turn must recheck its live connection.');
    } });
    try {
      const scene = await memory.createCase({ title: 'Task source', objective: '', domain: 'fixture' });
      const execution = { taskId: 'github-fixture-task', requirementsRevision: 1 };
      const official = createTool({ id: toolName, description: 'Official schema fixture', inputSchema: z.object({}),
        outputSchema: z.object({ body: z.string() }).strict(), execute: async () => ({ body: 'PRIVATE_OFFICIAL_RESULT' }) });
      await memory.runCase({ caseId: scene.id, execution, message: 'ORIGINAL_TASK_REQUEST', model,
        tools: { [toolName]: official }, instructions: 'Offline task fixture.', maxSteps: 2 });
      await memory.runCase({ caseId: scene.id, execution, message: 'NEXT_TASK_TURN', model, instructions: 'Offline task fixture.', maxSteps: 1 });
      assert.equal(calls, 3);
      assert.match(JSON.stringify(await memory.taskHistories(scene.id)), /PRIVATE_OFFICIAL_RESULT|PRIVATE_DERIVED_TASK_ANSWER/);
    } finally { await memory.close(); }
  }
});

const accountSource = (caseId: string) => ({ version: 2, caseId, connectionId: 'github-account', accountId: 42, credentialRevision: 3 });
const accountSearch = (caseId: string, tag: string) => ({ githubSource: accountSource(caseId), evidenceId: `account-search-${caseId}`,
  result: { total_count: 3, items: [
    { id: 7, full_name: 'owner/private-one', private: true, description: `PRIVATE_ACCOUNT_SEARCH_ONE_${tag}` },
    { id: 8, full_name: 'organization/private-two', private: true, description: `PRIVATE_ACCOUNT_SEARCH_TWO_${tag}` },
    { id: 9, full_name: 'community/public-project', private: false, description: 'Public search result' },
  ] } });

test('account repository search admits multiple native-permission results now and removes prior private context after disconnect or rotation', async t => {
  for (const reason of ['disconnect', 'rotation'] as const) await t.test(reason, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rae-github-account-search-'));
    const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'github-account-owner');
    let active = true; let revision = 3; let calls = 0;
    memory.setSourceEvidenceFilter(() => active);
    memory.setConnectorEvidenceFilter((_case, id, source) => active && id === 'github-account' && source?.credentialRevision === revision
      && 'accountId' in source && source.accountId === 42);
    const model = new MockLanguageModelV4({ doGenerate: async input => {
      calls++; const prompt = JSON.stringify(input.prompt);
      if (calls === 1) return call('read_github_repository');
      if (calls === 2) {
        assert.match(prompt, /PRIVATE_ACCOUNT_SEARCH_ONE_current|PRIVATE_ACCOUNT_SEARCH_TWO_current/);
        assert.match(prompt, /owner\/private-one/); assert.match(prompt, /organization\/private-two/);
        return answer('PRIVATE_ACCOUNT_DERIVED_SUMMARY');
      }
      assert.doesNotMatch(prompt, /PRIVATE_ACCOUNT_SEARCH|PRIVATE_ACCOUNT_DERIVED_SUMMARY|FIND_ACCESSIBLE_REPOSITORIES/);
      assert.match(prompt, /NEXT_ACCOUNT_QUESTION/); return answer('Current allowed context only.');
    } });
    try {
      const scene = await memory.createCase({ title: 'Account search', objective: '', domain: 'fixture' });
      const search = createTool({ id: 'read_github_repository', description: 'Account-native official search fixture', inputSchema: z.object({}),
        execute: async () => accountSearch(scene.id, 'current') });
      await memory.runCase({ caseId: scene.id, message: 'FIND_ACCESSIBLE_REPOSITORIES', model, tools: { read_github_repository: search },
        instructions: 'Offline account fixture.', maxSteps: 2, observeOwnerConversation: false });
      if (reason === 'disconnect') active = false; else revision++;
      await memory.runCase({ caseId: scene.id, message: 'NEXT_ACCOUNT_QUESTION', model, instructions: 'Offline account fixture.', maxSteps: 1, observeOwnerConversation: false });
      assert.equal(calls, 3);
      assert.match(JSON.stringify(await memory.historyForObservation(scene.id)), /PRIVATE_ACCOUNT_SEARCH_ONE_current|PRIVATE_ACCOUNT_DERIVED_SUMMARY/);
    } finally { await memory.close(); }
  });
});

test('one account supports fresh owner searches in different scenes while an old-scene provenance marker cannot be moved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rae-github-account-scenes-'));
  const memory = new CaseMemory(`file:${join(directory, 'memory.sqlite').replaceAll('\\', '/')}`, 'github-global-account-owner');
  memory.setSourceEvidenceFilter(() => true);
  memory.setConnectorEvidenceFilter((_case, id, source) => id === 'github-account' && source?.credentialRevision === 3
    && 'accountId' in source && source.accountId === 42);
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async input => {
    calls++; const prompt = JSON.stringify(input.prompt);
    if (calls === 1 || calls === 3) return call('read_github_repository');
    if (calls === 2) { assert.match(prompt, /PRIVATE_ACCOUNT_SEARCH_ONE_first/); return answer('FIRST_SCENE_PRIVATE_SUMMARY'); }
    assert.doesNotMatch(prompt, /PRIVATE_ACCOUNT_SEARCH_ONE_first|FIRST_SCENE_PRIVATE_SUMMARY/);
    assert.match(prompt, /PRIVATE_ACCOUNT_SEARCH_ONE_second/); return answer('SECOND_SCENE_OWNER_REPLY');
  } });
  try {
    const first = await memory.createCase({ title: 'First account scene', objective: '', domain: 'fixture' });
    const second = await memory.createCase({ title: 'Second account scene', objective: '', domain: 'fixture' });
    for (const [scene, tag] of [[first, 'first'], [second, 'second']] as const) {
      const search = createTool({ id: 'read_github_repository', description: 'Same-account fresh scene read', inputSchema: z.object({}),
        execute: async () => accountSearch(scene.id, tag) });
      await memory.runCase({ caseId: scene.id, message: `Fresh owner search in ${tag}`, model, tools: { read_github_repository: search },
        instructions: 'Offline account fixture.', maxSteps: 2, observeOwnerConversation: false });
    }
    assert.equal(calls, 4);
    let invalidCalls = 0;
    const invalid = new MockLanguageModelV4({ doGenerate: async () => { invalidCalls++; return call('read_github_repository', 'github-borrowed-call'); } });
    const borrowed = createTool({ id: 'read_github_repository', description: 'Fixture stale-scene marker', inputSchema: z.object({}),
      execute: async () => accountSearch(first.id, 'BORROWED_FROM_FIRST') });
    await assert.rejects(memory.runCase({ caseId: second.id, message: 'Do not reuse another private scene', model: invalid,
      tools: { read_github_repository: borrowed }, instructions: 'Offline account fixture.', maxSteps: 2, observeOwnerConversation: false }), /来源已停用/);
    assert.equal(invalidCalls, 1, 'the borrowed marker is rejected before a second model request');
  } finally { await memory.close(); }
});

test('account catalog markers bind immutable account identity and require a real account snapshot', () => {
  const marker = accountSource('case-one');
  const catalog = { githubSources: [marker], connections: [{ connectionId: marker.connectionId,
    kind: 'account', accountId: marker.accountId, credentialRevision: marker.credentialRevision, login: 'owner' }] };
  const processor = () => caseSourceContext('case-one', () => true, () => true);
  assert.equal(processor().processLLMRequest({ prompt: [user('List my account'), toolMessage(catalog, 'list_github_connections')] } as never), undefined);
  assert.throws(() => processor().processLLMRequest({ prompt: [user('List my account'), toolMessage({ ...catalog,
    connections: [{ ...catalog.connections[0], accountId: 99 }] }, 'list_github_connections')] } as never), /来源已停用/);
  assert.throws(() => processor().processLLMRequest({ prompt: [user('List my account'), toolMessage({ ...catalog,
    githubSources: [{ ...marker, accountId: undefined }] }, 'list_github_connections')] } as never), /来源已停用/);
});
