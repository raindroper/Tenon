import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import { githubCanonicalJson, githubTaskSpecCanonicalJson, githubTaskRequestSchema, githubTaskSpecSchema, GITHUB_OPERATIONS_PREFIX, type GitHubOperation } from '../shared/github.js';
import type { TaskRecord } from '../shared/task-consent.js';
import { Store } from '../server/store.js';
import { assertGitHubToolScope, GitHubOperations, GitHubOutcomeUnknownError, type GitHubOperationSelection, type GitHubOperationsOptions } from '../server/connectors/github-operations.js';
import { GitHubMCPError, type GitHubMCPTools } from '../server/connectors/github-mcp.js';
import { EventInbox } from '../server/v2/events.js';
import { TaskConsent, taskSpecSchema } from '../server/v2/consent.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const sha = 'a'.repeat(40);
const invoke = (tools: ToolsInput, input: unknown, name = 'github_push_files') => (tools[name] as ReturnType<typeof createTool>).execute!(input, {});
const commit = { owner: 'owner', repo: 'repo', branch: 'rae/change', files: [{ path: 'src/app.ts', content: 'export const answer = 42;' }], message: 'Requested change' };
const scope = () => githubTaskSpecSchema.parse({ connectionId: 'github-one', repository: 'owner/repo', repositoryId: 7,
  credentialRevision: 1, operations: ['commit'], branch: 'rae/change', baseBranch: 'main', files: ['src/app.ts'] });
const task = (): TaskRecord => ({ id: 'github-task', revision: 2, state: 'running', approvalRevision: 1, requirementsRevision: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), spec: { caseId: 'scene', title: 'Requested code change',
    objective: 'Make the requested change and submit it', expectedOutput: 'Real GitHub commit receipt', capabilities: ['github'], github: scope() } });
async function fixture(execute: (input: Record<string, unknown>) => Promise<unknown> = async () => ({ object: { sha } }), read: () => Promise<unknown> = async () => ({ content: 'read' })) {
  const directory = await mkdtemp(join(tmpdir(), 'rae-github-task-')); const store = new Store(directory);
  let calls = 0; let reads = 0; let inspected = 0; let actualId = 7; let allowed = true; let revision = 1; let connected = true;
  const selected: GitHubOperationSelection = { connectionId: 'github-one', caseId: 'scene', repository: 'owner/repo', repositoryId: 7,
    credentialRevision: 1, access: 'write', token: { accessToken: 'FIXTURE_SECRET_NOT_A_REAL_TOKEN' } };
  const tools = { push_files: createTool({ id: 'push_files', description: 'Official push fixture', inputSchema: z.record(z.string(), z.unknown()),
    execute: async input => { calls++; return execute(input); } }),
    issue_write: createTool({ id: 'issue_write', description: 'Official issue fixture', inputSchema: z.record(z.string(), z.unknown()), execute: async input => { calls++; return execute(input); } }),
    create_pull_request: createTool({ id: 'create_pull_request', description: 'Official PR fixture', inputSchema: z.record(z.string(), z.unknown()), execute: async input => { calls++; return execute(input); } }),
    get_file_contents: createTool({ id: 'get_file_contents', description: 'Official read fixture', inputSchema: z.record(z.string(), z.unknown()), execute: async () => { reads++; return read(); } }) } as GitHubMCPTools;
  const options = { store,
    select: (id: string, caseId?: string) => { if (!connected) throw new Error('Fixture connection removed'); assert.equal(id, selected.connectionId); assert(!caseId || caseId === selected.caseId); return { ...selected, credentialRevision: revision }; },
    run: <T>(_case: string, _connection: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
    assertOwner: (_case: string, eventId: string) => assert.equal(eventId, 'owner-event'), assertActive: () => undefined,
    assertReadSource: (_case: string, eventId: string) => assert.equal(eventId, 'owner-event'),
    withTools: async <T>(_token: unknown, _signal: AbortSignal, _access: 'read' | 'write', work: (tools: GitHubMCPTools) => Promise<T>) => work(tools),
    inspect: async () => { inspected++; return { id: actualId, fullName: 'owner/repo', defaultBranch: 'main' }; },
  };
  const operations = new GitHubOperations(options);
  return { directory, store, operations, options, tools, task: task(), calls: () => calls, reads: () => reads, inspected: () => inspected,
    guard: () => { if (!allowed) throw new Error('Owner permission revoked'); },
    revoke: () => { allowed = false; }, rotate: () => { revision++; }, replaceRepo: () => { actualId++; }, disconnect: () => { connected = false; },
    async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const executeCommit = (f: Awaited<ReturnType<typeof fixture>>, value = commit) => f.operations.withTaskTools(f.task,
  { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, value));

test('GitHub research uses the read source guard while task scope preparation still requires the owner', async () => {
  const f = await fixture();
  try {
    let allowed = true;
    const operations = new GitHubOperations({ ...f.options, assertReadSource: (_case, eventId) => {
      assert.equal(eventId, 'research-event'); if (!allowed) throw new Error('Research source revoked');
    } });
    await operations.read('scene', 'research-event', { connectionId: 'github-one', tool: 'get_file_contents',
      input: { owner: 'owner', repo: 'repo', path: 'README.md' } }, new AbortController().signal, f.guard);
    assert.equal(f.reads(), 1); assert.equal(f.calls(), 0);
    await assert.rejects(operations.prepareScope('scene', scope(), 'research-event'));
    allowed = false;
    await assert.rejects(operations.read('scene', 'research-event', { connectionId: 'github-one', tool: 'get_file_contents',
      input: { owner: 'owner', repo: 'repo', path: 'README.md' } }, new AbortController().signal, f.guard), /revoked/);
  } finally { await f.close(); }
});
function accountOperations(f: Awaited<ReturnType<typeof fixture>>) {
  let accountId = 42; let revision = 1;
  const options: GitHubOperationsOptions = { ...f.options,
    select: (id, caseId) => { assert.equal(id, 'github-one'); return { kind: 'account', connectionId: id, caseId: caseId ?? 'scene', accountId,
      login: 'owner', credentialRevision: revision, token: { accessToken: 'FIXTURE_SECRET_NOT_A_REAL_TOKEN' } }; },
    inspect: async (_token, repository) => ({ id: repository === 'owner/repo' ? 7 : 11, fullName: repository, defaultBranch: 'main' }) };
  return { operations: new GitHubOperations(options), rotate: () => { revision++; }, replaceAccount: () => { accountId++; } };
}

test('GitHub task permission requires immutable identity and precise targets, preserving its single consent contract', async () => {
  assert.equal(githubTaskRequestSchema.safeParse({ connectionId: 'one', repository: 'owner/repo', operations: ['commit'], files: ['src/app.ts'] }).success, false);
  assert.equal(githubTaskSpecSchema.safeParse({ ...scope(), files: ['../escape.ts'] }).success, false);
  assert.equal(githubTaskSpecSchema.safeParse({ ...scope(), branch: 'refs/heads/main' }).success, false);
  assert.equal(githubTaskSpecSchema.safeParse({ ...scope(), repositoryId: undefined }).success, false);
  const f = await fixture(); const inbox = new EventInbox(join(f.directory, 'events.sqlite'));
  const consent = new TaskConsent({ file: inbox.file, inbox });
  try {
    const requested = consent.request(f.task.spec, 'owner-github-request');
    assert.deepEqual(requested.spec.github, scope()); assert.equal(requested.state, 'approved');
    assert.throws(() => taskSpecSchema.parse({ ...f.task.spec, capabilities: ['artifact'] }));
    assert.throws(() => taskSpecSchema.parse({ ...f.task.spec, capabilities: ['github', 'local-command'] }));
  } finally { consent.close(); inbox.close(); await f.close(); }
});

test('official GitHub write arguments are fenced by actual repository, branch, file and target fields', () => {
  assert.deepEqual(assertGitHubToolScope('push_files', commit, scope()).paths, ['src/app.ts']);
  for (const changed of [{ ...commit, repo: 'other' }, { ...commit, branch: 'main' }, { ...commit, force: true },
    { ...commit, files: [{ path: '.git/config', content: 'bad' }] }, { ...commit, files: [{ path: 'src/other.ts', content: 'bad' }] }]) {
    assert.throws(() => assertGitHubToolScope('push_files', changed, scope()));
  }
  const issue = githubTaskSpecSchema.parse({ ...scope(), operations: ['issue-update'], issueNumbers: [12], issueFields: ['body'] });
  assert.throws(() => assertGitHubToolScope('issue_write', { owner: 'owner', repo: 'repo', method: 'update', issue_number: 13, body: 'x' }, issue));
  assert.throws(() => assertGitHubToolScope('issue_write', { owner: 'owner', repo: 'repo', method: 'update', issue_number: 12, state: 'closed' }, issue));
  assert.equal(assertGitHubToolScope('issue_write', { owner: 'owner', repo: 'repo', method: 'update', issue_number: 12, body: 'requested text' }, issue).targetNumber, 12);
  const pr = githubTaskSpecSchema.parse({ ...scope(), operations: ['pull-request-create'] });
  assert.throws(() => assertGitHubToolScope('create_pull_request', { owner: 'owner', repo: 'repo', head: 'rae/change', base: 'main', draft: false }, pr));
});

test('parallel identical submissions share one durable successful remote action and real commit receipt', async () => {
  const entered = gate(); const release = gate();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return { object: { sha } }; });
  try {
    const pending = f.operations.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, async tools => {
      const first = invoke(tools, commit); const second = invoke(tools, commit);
      await entered.promise; assert.equal(f.calls(), 1); release.resolve(); return Promise.all([first, second]);
    });
    await pending; assert.equal(f.calls(), 1); assert.equal(f.inspected(), 1);
    const receipt = f.operations.receipts(f.task.id); assert.equal(receipt.length, 1); assert.equal(receipt[0].state, 'submitted'); assert.equal(receipt[0].sha, sha);
    assert.doesNotMatch(JSON.stringify(receipt), /FIXTURE_SECRET/); f.operations.verifyDelivery(f.task);
  } finally { release.resolve(); await f.close(); }
});

test('a same-name replacement repository is rechecked before writing and never receives the submission', async () => {
  const f = await fixture();
  try { f.replaceRepo(); await assert.rejects(executeCommit(f), /实际仓库已改变/); assert.equal(f.calls(), 0); assert.equal(f.operations.receipts(f.task.id).length, 0); }
  finally { await f.close(); }
});

test('a disconnected submission remains unknown and neither different input nor process recovery resubmits', async () => {
  const f = await fixture(async () => { throw new Error('Disconnected after remote acceptance'); });
  try {
    await assert.rejects(executeCommit(f), /结果未知/); assert.equal(f.calls(), 1);
    await assert.rejects(executeCommit(f, { ...commit, message: 'try another title' }), /结果未知/); assert.equal(f.calls(), 1);
    const reopened = new GitHubOperations(f.options);
    await assert.rejects(reopened.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, commit)), /结果未知/);
    assert.equal(f.calls(), 1); assert.throws(() => reopened.verifyDelivery(f.task), GitHubOutcomeUnknownError);
    assert.equal(reopened.receipts(f.task.id)[0].state, 'unknown');
  } finally { await f.close(); }
});

test('cancellation and credential rotation after dispatch preserve accepted facts and drain before returning', async () => {
  const entered = gate(); const release = gate(); const f = await fixture(async () => { entered.resolve(); await release.promise; return { object: { sha } }; });
  let ended = false;
  try {
    const pending = executeCommit(f).then(() => { ended = true; }, error => { ended = true; throw error; });
    const rejected = assert.rejects(pending, /revoked/);
    await entered.promise; f.revoke(); f.rotate(); assert.equal(ended, false);
    release.resolve(); await rejected;
    assert.equal(f.operations.receipts(f.task.id)[0].state, 'submitted'); assert.equal(f.operations.receipts(f.task.id)[0].sha, sha);
    assert.equal(f.calls(), 1);
  } finally { release.resolve(); await f.close(); }
});

test('an abandoned model callback still waits for the actual submitted tool before disconnecting', async () => {
  const entered = gate(); const release = gate(); const f = await fixture(async () => { entered.resolve(); await release.promise; return { object: { sha } }; });
  let returned = false;
  try {
    const pending = f.operations.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, async tools => {
      void invoke(tools, commit); return 'model callback ended';
    }).then(result => { returned = true; return result; });
    await entered.promise; assert.equal(returned, false); release.resolve(); await pending;
    assert.equal(f.operations.receipts(f.task.id)[0].state, 'submitted'); assert.equal(returned, true);
  } finally { release.resolve(); await f.close(); }
});

test('saved submitting journals recover to visible unknown and model prose alone cannot complete a GitHub task', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.operations.verifyDelivery(f.task), /真实成功回执/);
    await executeCommit(f);
    const saved = f.store.getMeta<GitHubOperation[]>(GITHUB_OPERATIONS_PREFIX + f.task.id, []);
    f.store.setMeta(GITHUB_OPERATIONS_PREFIX + f.task.id, saved.map(value => ({ ...value, state: 'submitting', receipt: undefined })));
    const reopened = new GitHubOperations(f.options);
    assert.equal(reopened.receipts(f.task.id)[0].state, 'unknown'); assert.throws(() => reopened.verifyDelivery(f.task), GitHubOutcomeUnknownError);
  } finally { await f.close(); }
});

test('owner read access never permits remote write tools or a different repository', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.operations.read('scene', 'owner-event', { connectionId: 'github-one', tool: 'push_files', input: commit }, new AbortController().signal, f.guard), /只读/);
    await assert.rejects(f.operations.read('scene', 'owner-event', { connectionId: 'github-one', tool: 'get_file_contents', input: { owner: 'other', repo: 'repo', path: 'README.md' } }, new AbortController().signal, f.guard), /批准仓库/);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test('a same-name replacement is rejected for owner and task reads before fetching file content', async () => {
  const f = await fixture();
  try {
    f.replaceRepo();
    await assert.rejects(f.operations.read('scene', 'owner-event', { connectionId: 'github-one', tool: 'get_file_contents', input: { owner: 'owner', repo: 'repo', path: 'README.md' } }, new AbortController().signal, f.guard), /实际仓库已改变/);
    await assert.rejects(f.operations.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, tools =>
      (tools.github_get_file_contents as ReturnType<typeof createTool>).execute!({ owner: 'owner', repo: 'repo', path: 'src/app.ts' }, {})), /实际仓库已改变/);
    assert.equal(f.reads(), 0);
  } finally { await f.close(); }
});

test('read results are discarded when credentials rotate, connection is removed, or identity changes during a request', async () => {
  for (const mutation of ['rotate', 'disconnect', 'replaceRepo'] as const) {
    const entered = gate(); const release = gate();
    const f = await fixture(undefined, async () => { entered.resolve(); await release.promise; return { content: 'STALE_EXTERNAL_CONTENT' }; });
    try {
      const pending = f.operations.read('scene', 'owner-event', { connectionId: 'github-one', tool: 'get_file_contents', input: { owner: 'owner', repo: 'repo', path: 'README.md' } }, new AbortController().signal, f.guard);
      const rejected = assert.rejects(pending, /变化|removed/); await entered.promise; f[mutation](); release.resolve(); await rejected;
      assert.equal(f.reads(), 1);
    } finally { release.resolve(); await f.close(); }
  }
});

test('a real AbortSignal never lets cancellation return before an already accepted write settles', async () => {
  const entered = gate(); const release = gate(); const controller = new AbortController();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return { object: { sha } }; }); let returned = false;
  try {
    const pending = f.operations.withTaskTools(f.task, { signal: controller.signal, guard: f.guard }, tools => invoke(tools, commit))
      .then(result => { returned = true; return result; }, error => { returned = true; throw error; });
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    await entered.promise; controller.abort(); await Promise.resolve(); assert.equal(returned, false);
    release.resolve(); await rejected; assert.equal(f.operations.receipts(f.task.id)[0].state, 'submitted'); assert.equal(f.calls(), 1);
  } finally { release.resolve(); await f.close(); }
});

test('object key ordering cannot turn an identical submission into a second commit', async () => {
  const f = await fixture();
  try {
    await executeCommit(f);
    const reordered = { message: commit.message, files: [{ content: commit.files[0].content, path: commit.files[0].path }], branch: commit.branch, repo: commit.repo, owner: commit.owner };
    await executeCommit(f, reordered); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('one creation permission cannot create more Issues or PRs by varying the title', async () => {
  for (const operation of ['issue-create', 'pull-request-create'] as const) {
    const f = await fixture(async () => ({ html_url: `https://github.com/owner/repo/${operation === 'issue-create' ? 'issues' : 'pull'}/12`, number: 12 }));
    try {
      f.task.spec.github = githubTaskSpecSchema.parse({ ...scope(), operations: [operation] });
      const tool = operation === 'issue-create' ? 'github_issue_write' : 'github_create_pull_request';
      const value = operation === 'issue-create' ? { owner: 'owner', repo: 'repo', method: 'create', title: 'One requested issue', body: 'Requested content' }
        : { owner: 'owner', repo: 'repo', head: 'rae/change', base: 'main', draft: true, title: 'One requested PR', body: 'Requested content' };
      const run = (input: unknown) => f.operations.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, input, tool));
      await run(value); await run(value); assert.equal(f.calls(), 1);
      await assert.rejects(run({ ...value, title: 'Different second title' }), /不能.*重复创建/); assert.equal(f.calls(), 1);
    } finally { await f.close(); }
  }
});

test('explicit upstream refusals remain failed while genuinely ambiguous errors stay unknown', async () => {
  for (const status of [401, 403, 422]) {
    const f = await fixture(async () => { throw new GitHubMCPError('Definite upstream rejection', status, false); });
    try { await assert.rejects(executeCommit(f), /明确拒绝/); assert.equal(f.operations.receipts(f.task.id)[0].state, 'failed'); assert.equal(f.calls(), 1); }
    finally { await f.close(); }
  }
});

test('a receipt for earlier requirements cannot certify a later version or cause automatic replay', async () => {
  const f = await fixture();
  try {
    await executeCommit(f); f.task.requirementsRevision = 2;
    assert.throws(() => f.operations.verifyDelivery(f.task), /真实成功回执/);
    await assert.rejects(executeCommit(f), /旧要求.*新.*任务/); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('one account can prepare and execute tasks for different accessible repositories and owner scenes', async () => {
  const f = await fixture(); const account = accountOperations(f);
  try {
    for (const [repository, expectedId, caseId] of [['owner/repo', 7, 'scene'], ['another/project', 11, 'other-scene']] as const) {
      const prepared = await account.operations.prepareScope(caseId, { ...scope(), repository }, 'owner-event');
      assert.equal(prepared.repository, repository); assert.equal(prepared.repositoryId, expectedId); assert.equal(prepared.accountId, 42);
      const selected = task(); selected.id += '-' + expectedId; selected.spec.caseId = caseId; selected.spec.github = prepared;
      const [owner, repo] = repository.split('/');
      await account.operations.withTaskTools(selected, { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, { ...commit, owner, repo }));
      account.operations.verifyDelivery(selected);
    }
    assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});

test('account search and profile use official tools without requiring or adding a repository filter', async () => {
  const f = await fixture(); const account = accountOperations(f); const queries: unknown[] = [];
  for (const name of ['get_me', 'search_repositories', 'search_code', 'search_issues', 'search_pull_requests']) {
    f.tools[name] = createTool({ id: name, description: 'Official account read fixture', inputSchema: z.record(z.string(), z.unknown()),
      execute: async input => { queries.push(input); return { accepted: input, tool: name }; } });
  }
  try {
    for (const tool of ['get_me', 'search_repositories', 'search_code', 'search_issues', 'search_pull_requests']) {
      const input = tool === 'get_me' ? {} : { query: 'state:open language:TypeScript', page: 2 };
      const result = await account.operations.read('any-owner-scene', 'owner-event', { connectionId: 'github-one', tool, input }, new AbortController().signal, f.guard);
      assert.equal(result.repositoryId, undefined); assert.deepEqual((result.result as { accepted: unknown }).accepted, input);
    }
    assert.equal(queries.length, 5); assert.equal(f.inspected(), 0);
    await assert.rejects(f.operations.read('scene', 'owner-event', { connectionId: 'github-one', tool: 'search_repositories', input: { query: 'anything' } }, new AbortController().signal, f.guard), /只读工具/);
  } finally { await f.close(); }
});

test('account reads a concrete repository by its current identity instead of a connection-wide repository pin', async () => {
  const f = await fixture(); const account = accountOperations(f);
  try {
    const result = await account.operations.read('other-owner-scene', 'owner-event', { connectionId: 'github-one', tool: 'get_file_contents',
      input: { owner: 'another', repo: 'project', path: 'README.md' } }, new AbortController().signal, f.guard);
    assert.equal(result.repositoryId, 11); assert.equal(f.reads(), 1);
    await assert.rejects(f.operations.prepareScope('scene', { ...scope(), repository: 'another/project' }, 'owner-event'), /旧仓库连接/);
  } finally { await f.close(); }
});

test('account task admission pins the authenticated account and upstream permissions decide actual write availability', async () => {
  const f = await fixture(async () => { throw new GitHubMCPError('Upstream token cannot write', 403, false); }); const account = accountOperations(f);
  try {
    f.task.spec.github = await account.operations.prepareScope('scene', scope(), 'owner-event');
    await assert.rejects(account.operations.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, commit)), /明确拒绝/);
    assert.equal(f.calls(), 1); assert.equal(account.operations.receipts(f.task.id)[0].state, 'failed');
    account.replaceAccount(); assert.throws(() => account.operations.assertTaskScope(f.task), /账号.*版本已变化/);
  } finally { await f.close(); }
});

test('account tasks support explicit multi-create counts, standard PRs and large target lists without small connector caps', async () => {
  let created = 0; const f = await fixture(async () => ({ html_url: `https://github.com/owner/repo/issues/${++created}`, number: created })); const account = accountOperations(f);
  try {
    const many = githubTaskSpecSchema.parse({ ...scope(), operations: ['issue-update'], issueNumbers: Array.from({ length: 100 }, (_, index) => index + 1),
      issueFields: ['body'], files: Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`) });
    assert.equal(many.issueNumbers.length, 100); assert.equal(many.files.length, 80);
    const regularPR = githubTaskSpecSchema.parse({ ...scope(), accountId: 42, operations: ['pull-request-create'] });
    assert.equal(assertGitHubToolScope('create_pull_request', { owner: 'owner', repo: 'repo', head: 'rae/change', base: 'main', draft: false }, regularPR).operation, 'pull-request-create');
    assert.throws(() => assertGitHubToolScope('create_pull_request', { owner: 'owner', repo: 'repo', head: 'rae/change', base: 'main', draft: false }, { ...regularPR, draft: true }));
    f.task.spec.github = await account.operations.prepareScope('scene', { ...scope(), operations: ['issue-create'], createIssueCount: 2 }, 'owner-event');
    for (const title of ['First owner requested issue', 'Second owner requested issue']) await account.operations.withTaskTools(f.task,
      { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, { owner: 'owner', repo: 'repo', method: 'create', title, body: 'Requested content' }, 'github_issue_write'));
    account.operations.verifyDelivery(f.task); assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});

test('legacy submitted receipts keep their old canonical scope hash and immutable raw authorization despite new defaults', async () => {
  const f = await fixture(); const inbox = new EventInbox(join(f.directory, 'legacy-events.sqlite'));
  const consent = new TaskConsent({ file: inbox.file, inbox }); const db = new DatabaseSync(inbox.file);
  try {
    const legacyScope = { connectionId: 'github-one', operations: ['commit' as const], branch: 'rae/change', baseBranch: 'main', files: ['src/app.ts'],
      issueNumbers: [], pullRequestNumbers: [], issueFields: [], pullRequestFields: [], repository: 'owner/repo', repositoryId: 7, credentialRevision: 1 };
    const legacySpec = { ...f.task.spec, github: legacyScope };
    const admitted = consent.request(legacySpec, 'legacy-github-owner-request'); const begun = consent.begin(admitted.id, admitted.approvalRevision!);
    const rawSpec = JSON.stringify(legacySpec);
    db.prepare('UPDATE task_consents SET spec_json=?,json=? WHERE id=?').run(rawSpec, JSON.stringify({ ...begun, spec: legacySpec }), begun.id);
    const oldHash = createHash('sha256').update(githubCanonicalJson(legacyScope)).digest('hex');
    const oldOperation: GitHubOperation = { id: 'legacy-submission', taskId: begun.id, caseId: begun.spec.caseId, approvalRevision: begun.approvalRevision!,
      requirementsRevision: 1, specHash: oldHash, inputHash: 'legacy-input-hash', tool: 'push_files', operation: 'commit', connectionId: 'github-one', credentialRevision: 1,
      state: 'submitted', createdAt: begun.createdAt, updatedAt: begun.updatedAt, paths: ['src/app.ts'], receipt: { sha, result: { object: { sha } } } };
    f.store.setMeta(GITHUB_OPERATIONS_PREFIX + begun.id, [oldOperation]);
    const decode = consent.get.bind(consent);
    // Simulate a newer normalizer exposing absent default fields, without touching the old spec_json.
    consent.get = id => { const value = decode(id); return value?.spec.github ? { ...value, spec: { ...value.spec,
      github: githubTaskSpecSchema.parse({ ...value.spec.github, createIssueCount: 1, createPullRequestCount: 1 }) } } : value; };
    const normalized = consent.get(begun.id)!;
    assert.equal(createHash('sha256').update(githubTaskSpecCanonicalJson(normalized.spec.github!)).digest('hex'), oldHash);
    f.operations.verifyDelivery(normalized);
    const projected = consent.projectGitHubReceipts(begun.id, f.store)!;
    assert.equal(projected.githubReceipts?.[0].state, 'submitted'); assert.equal(projected.githubReceipts?.[0].sha, sha);
    assert.equal(projected.state, 'running'); assert.equal(f.calls(), 0);
    assert.equal((db.prepare('SELECT spec_json FROM task_consents WHERE id=?').get(begun.id) as { spec_json: string }).spec_json, rawSpec);
    assert.equal(f.store.getMeta<GitHubOperation[]>(GITHUB_OPERATIONS_PREFIX + begun.id, [])[0].specHash, oldHash);
  } finally { db.close(); consent.close(); inbox.close(); await f.close(); }
});

test('account commit scope permits ordinary files within the selected repository branch while explicit and legacy files stay bounded', async () => {
  const f = await fixture(); const account = accountOperations(f);
  try {
    const request = githubTaskRequestSchema.parse({ connectionId: 'github-one', repository: 'owner/repo', operations: ['commit'], branch: 'rae/change' });
    assert.deepEqual(request.files, []);
    const prepared = await account.operations.prepareScope('scene', request, 'owner-event'); f.task.spec.github = prepared;
    const ordinary = { ...commit, files: [{ path: 'src/new-helper.ts', content: 'export const helper = 1;' }, { path: 'tests/new-helper.test.ts', content: 'test helper' }] };
    assert.deepEqual(assertGitHubToolScope('push_files', ordinary, prepared).paths, ['src/new-helper.ts', 'tests/new-helper.test.ts']);
    assert.throws(() => account.operations.verifyDelivery(f.task), /真实成功回执/);
    await account.operations.withTaskTools(f.task, { signal: new AbortController().signal, guard: f.guard }, tools => invoke(tools, ordinary));
    account.operations.verifyDelivery(f.task); assert.equal(f.calls(), 1);
    assert.throws(() => assertGitHubToolScope('push_files', { ...ordinary, branch: 'main' }, prepared));
    assert.throws(() => assertGitHubToolScope('push_files', { ...ordinary, repo: 'another' }, prepared));
    assert.throws(() => assertGitHubToolScope('push_files', ordinary, { ...prepared, files: ['src/app.ts'] }), /精确文件许可/);
    assert.equal(githubTaskSpecSchema.safeParse({ ...scope(), files: [] }).success, false);
    await assert.rejects(f.operations.prepareScope('scene', request, 'owner-event'), /旧仓库任务.*文件范围/);
    assert.throws(() => assertGitHubToolScope('push_files', ordinary, { ...scope(), files: [] }), /精确文件许可/);
  } finally { await f.close(); }
});
