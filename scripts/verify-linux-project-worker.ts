import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ProjectRunner } from '../desktop/project-runner.js';
import { ProjectJournal, type LocalProjectEntry } from '../desktop/project-journal.js';
import { ProjectWorkspaces } from '../desktop/project-workspaces.js';
import { localProjectSpecSchema, serverProjectResources, type ProjectExecutionInput } from '../shared/local-project.js';
import { linuxProjectResources } from '../worker/linux-project-sandbox.js';
import { DeviceHttpError } from '../desktop/transport.js';
import { projectModelFailureFrame } from '../shared/project-model-stream.js';

const fixtureModel = 'gpt-6.1-sol';
const finalText = 'Fixture completed.';

function nativeCall(id: string, tool: string, input: unknown) {
  return { type: 'custom_tool_call', id, call_id: id, name: 'exec', namespace: 'functions',
    input: `text(await tools[${JSON.stringify(tool)}](${JSON.stringify(input)}));` };
}

function finalResponse() {
  return { type: 'message', id: 'final', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: finalText, annotations: [] }] };
}

function sendResponse(response: ServerResponse, item: Record<string, unknown>, count: number): void {
  const result = { id: 'fixture_' + count, object: 'response', created_at: 0, model: fixtureModel,
    status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type: string, value: Record<string, unknown>) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
  emit('response.created', { response: { ...result, status: 'in_progress', output: [] } });
  emit('response.output_item.added', { output_index: 0, item });
  if (item.type === 'message') emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: finalText });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: result });
  response.end();
}

async function assertTaskProcessesDrained(directory: string): Promise<void> {
  for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value))) {
    try {
      const command = await readFile('/proc/' + pid + '/cmdline', 'utf8');
      assert.equal(command.includes(directory), false, 'A native task process remains after drain: ' + pid);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Run as the worker user in its private container with Docker init and production limits. This fixture uses no provider. */
async function verify(): Promise<void> {
  const resources = linuxProjectResources(process.env.RAE_WORKER_WORK_DIR ?? '/work',
    process.env.RAE_WORKER_CODEX ?? '/opt/rae-worker/codex/bin/codex-app-server', process.execPath,
    process.env.RAE_WORKER_HOOK ?? '/opt/rae-worker/project-hook.cjs');
  await resources.sandbox.verify();
  const journalRoot = await mkdtemp(path.join(process.env.RAE_WORKER_STATE_DIR ?? tmpdir(), 'fixture-'));
  const publicTarget = process.env.RAE_WORKER_FIXTURE_PUBLIC_URL ? new URL(process.env.RAE_WORKER_FIXTURE_PUBLIC_URL) : undefined;
  if (publicTarget && publicTarget.protocol !== 'https:') throw new Error('The public verification fixture requires HTTPS.');
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture-linux', readAccess: 'project', network: Boolean(publicTarget),
    serverResources: serverProjectResources(Boolean(publicTarget)) });
  const input: ProjectExecutionInput = {
    operationId: 'fixture-worker-project', taskId: 'fixture-worker-task', runId: 'fixture-worker-run',
    approvalRevision: 1, requirementsRevision: 1, spec, specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
    title: 'Fixture', objective: 'Create an implementation and execute a genuine test.',
    expectedOutput: 'Real file and test receipts', ownerRequest: 'Create sum.cjs and verify it.', updates: [],
    model: { model: fixtureModel, reasoningEffort: 'auto', maxOutputTokens: null }, stepLimit: 6, deadline: null, issuedAt: new Date().toISOString(),
    contract: { version: 2, requirements: [{ id: 'sum', text: 'Sum returns five using the original attachment', revision: 1, sourceEventId: 'fixture-owner' }] },
  };
  const dir = resources.sandbox.directory(input.operationId);
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  const original = Buffer.from('{"a":2,"b":3}\n');
  const source = { id: 'fixture-input', messageId: 'fixture-owner', name: 'input.json', size: original.length,
    sha256: createHash('sha256').update(original).digest('hex') };
  const inputPath = path.join(dir, 'inputs', createHash('sha256').update(source.id + ':' + source.sha256).digest('hex'), source.name);
  const checkCode = `const fs=require('node:fs'),assert=require('node:assert/strict');const file=${JSON.stringify(inputPath)};`
    + `const bytes=fs.readFileSync(file);assert.throws(()=>fs.writeFileSync(file,'changed'));`
    + `assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),${JSON.stringify(source.sha256)});`
    + `const values=JSON.parse(bytes);assert.equal(require('./sum.cjs')(values.a,values.b),5);console.log('SERVER_FIXTURE_CHECK_PASSED');`;
  const commands = [
    nativeCall('patch', 'apply_patch', '*** Begin Patch\n*** Add File: sum.cjs\n+module.exports=(a,b)=>a+b;\n*** End Patch'),
    ...(publicTarget ? [nativeCall('public', 'exec_command', {
      cmd: 'curl --silent --show-error --fail --max-time 6 --output /dev/null ' + "'" + publicTarget.href.replaceAll("'", "'\"'\"'") + "'"
        + ' && echo SERVER_FIXTURE_PUBLIC_HTTPS_PASSED',
      shell: '/bin/bash', login: false, yield_time_ms: 9000, max_output_tokens: 1000,
    })] : []),
    nativeCall('verify', 'submit_project_delivery', {
      summary: 'Read the original attachment and verify the actual implementation.',
      outputs: [{ path: 'sum.cjs', format: 'cjs', description: 'Implementation' }],
      checks: [{ id: 'sum', requirementIds: ['sum'], criterion: 'Sum returns five using the original read-only input', required: true,
        command: { argv: [process.execPath, '-e', checkCode], timeoutMs: 10000 },
        assertions: [{ kind: 'text', path: 'sum.cjs', equals: 'module.exports=(a,b)=>a+b;\n' }] }],
    }),
    finalResponse(),
  ];
  let calls = 0;
  let guards = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/api/device/projectguard') {
        guards++;
        response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ input, sequence: 0 }));
      } else if (request.url === '/api/device/projectcontext') {
        if (body.input.action === 'stage_reviews') { response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ stageReviews: [] })); return; }
        assert.ok(['catalog', 'input_file'].includes(body.input.action), 'Unexpected fixture context operation');
        response.setHeader('Content-Type', 'application/json').end(JSON.stringify(body.input.action === 'input_file'
          ? { ...source, offset: body.input.offset, data: original.subarray(body.input.offset).toString('base64') }
          : { tools: [], inputFiles: [source] }));
      } else if (request.url === '/api/device/projectmodel' && calls < commands.length) {
        const bridge = request.headers['x-fixture-project-bridge'];
        if (typeof bridge !== 'string') throw new Error('Fixture needs the operation-local model relay address.');
        const unauthorized = await fetch(new URL('/authorize', bridge), { method: 'POST', body: '{}' });
        assert.equal(unauthorized.status, 401);
        await unauthorized.body?.cancel();
        sendResponse(response, commands[calls], ++calls);
      } else response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const journal = new ProjectJournal(journalRoot);
    const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
    const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + address.port, credential: 'fixture-token',
      resources, journal, entry, workspaces: new ProjectWorkspaces(true), changed() {},
      request: async (base, route, _credential, init) => {
        const headers = new Headers(init?.headers);
        if (route === '/api/device/projectmodel') {
          const saved = await readFile(path.join(dir, 'codex/config.toml'), 'utf8');
          const match = saved.match(/^base_url = "(http:\/\/127\.0\.0\.1:\d+)\/v1"$/m);
          if (match) headers.set('X-Fixture-Project-Bridge', match[1]);
        }
        const response = await fetch(base + route, { ...init, headers });
        if (!response.ok) { await response.body?.cancel(); throw new DeviceHttpError(response.status); }
        return response;
      } });
    await runner.run();
    const events = await journal.pending(entry);
    assert.equal(entry.state, 'completed', JSON.stringify(events));
    assert.equal(calls, commands.length);
    assert.ok(guards >= 4);
    assert.ok(events.some(value => value.event.kind === 'tool' && value.event.item.type === 'fileChange' && value.event.item.state === 'succeeded'), JSON.stringify(events));
    assert.ok(events.some(value => value.event.kind === 'tool' && value.event.item.output?.includes('SERVER_FIXTURE_CHECK_PASSED')
      && value.event.item.exitCode === 0), JSON.stringify(events));
    if (publicTarget) assert.ok(events.some(value => value.event.kind === 'tool'
      && value.event.item.output?.includes('SERVER_FIXTURE_PUBLIC_HTTPS_PASSED') && value.event.item.exitCode === 0), JSON.stringify(events));
    assert.equal(entry.environment, 'closed');
    assert.equal(entry.delivery?.verification?.checks[0].status, 'passed');
    assert.ok(entry.delivery?.verification?.files[0].sha256);
    assert.equal(entry.delivery?.version, 2);
    await assert.rejects(lstat(dir), { code: 'ENOENT' });
    await assertTaskProcessesDrained(dir);
    process.stdout.write('LINUX_PROJECT_FIXTURE_OK\n');
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(journalRoot, { recursive: true, force: true });
  }
}

await verify();

async function verifyDurableInput(): Promise<void> {
  const resources = linuxProjectResources(process.env.RAE_WORKER_WORK_DIR ?? '/work',
    process.env.RAE_WORKER_CODEX ?? '/opt/rae-worker/codex/bin/codex-app-server', process.execPath,
    process.env.RAE_WORKER_HOOK ?? '/opt/rae-worker/project-hook.cjs');
  await resources.sandbox.verify();
  const journalRoot = await mkdtemp(path.join(process.env.RAE_WORKER_STATE_DIR ?? tmpdir(), 'durable-fixture-'));
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture-linux', readAccess: 'project', network: false, serverResources: serverProjectResources(false) });
  const input: ProjectExecutionInput = { operationId: 'fixture-durable-project', taskId: 'fixture-durable-task', runId: 'fixture-durable-run',
    approvalRevision: 1, requirementsRevision: 1, spec, specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
    title: 'Durable fixture', objective: 'Implement, test and deliver a report.', expectedOutput: 'Actual implementation, report and command receipts',
    ownerRequest: 'Implement, test and deliver a report.', updates: [], model: { model: fixtureModel, reasoningEffort: 'auto', maxOutputTokens: null },
    stepLimit: 6, deadline: Date.now() + 180000, issuedAt: new Date().toISOString(),
    contract: { version: 2, requirements: [{ id: 'report', text: 'Working sum and review report', revision: 1, sourceEventId: 'fixture-owner' }] } };
  const dir = resources.sandbox.directory(input.operationId);
  let calls = 0, answered = false, questions = 0;
  const submission = { summary: 'Verify the implementation and review report.',
    outputs: [{ path: 'sum.cjs', format: 'cjs', description: 'Implementation' }, { path: 'report.md', format: 'md', description: 'Required review report' }],
    checks: [{ id: 'sum', requirementIds: ['report'], criterion: 'Sum returns five', files: ['sum.cjs'], required: true,
      command: { argv: [process.execPath, '-e', "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5);console.log('DURABLE_LINUX_CHECK_PASSED');"], timeoutMs: 10000 },
      assertions: [{ kind: 'text', path: 'sum.cjs', equals: 'module.exports=(a,b)=>a+b;\n' }] },
    { id: 'report-file', requirementIds: ['report'], criterion: 'Review report exists', files: ['report.md'], required: true,
      assertions: [{ kind: 'text', path: 'report.md', equals: 'Checked sum equals 5.\n' }] }],
  };
  const commands = [
    nativeCall('patch', 'apply_patch', '*** Begin Patch\n*** Add File: sum.cjs\n+module.exports=(a,b)=>a+b;\n*** End Patch'),
    nativeCall('incomplete', 'submit_project_delivery', submission),
    undefined,
    nativeCall('report', 'apply_patch', '*** Begin Patch\n*** Add File: report.md\n+Checked sum equals 5.\n*** End Patch'),
    nativeCall('complete', 'submit_project_delivery', submission),
    finalResponse(),
  ];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/device/projectguard') { response.end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') {
        if (body.input.action === 'stage_reviews') { response.end(JSON.stringify({ stageReviews: [] })); return; }
        if (body.input.action !== 'catalog') {
          assert.equal(body.input.action, 'call'); assert.equal(body.input.name, 'ask_rae_owner'); questions++;
        }
        response.end(JSON.stringify(body.input.action === 'catalog' ? {
          taskFlow: { resolvedInputs: answered ? [{ id: 'resume-input', state: 'resolved', answers: [{ actor: 'owner', content: 'Continue the same task and add the missing report.' }] }] : [] },
          tools: [{ name: 'ask_rae_owner', description: 'Persist the pending input, then suspend.', inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object' } } }, required: ['questions'] } }],
        } : { taskSuspended: true, dependency: { id: 'resume-input', state: 'waiting' } })); return;
      }
      if (request.url === '/api/device/projectmodel' && calls < commands.length) {
        assert.ok(calls < 3 || answered, 'No inference is allowed during an unresolved wait');
        const item = commands[calls++];
        if (!item) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(projectModelFailureFrame('transport_interrupted', 'Offline cutoff after partial delivery')); return; }
        sendResponse(response, item, calls); return;
      }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  let runner: ProjectRunner | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const journal = new ProjectJournal(journalRoot);
    const createRunner = (entry: LocalProjectEntry) => new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + address.port, credential: 'offline-fixture',
      resources, journal, entry, workspaces: new ProjectWorkspaces(true), changed() {}, request: async (base, route, _credential, init) => {
        const response = await fetch(base + route, init); if (!response.ok) throw new DeviceHttpError(response.status); return response;
      } });
    let entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
    runner = createRunner(entry); await runner.run();
    assert.equal(entry.state, 'paused', entry.error ?? ''); assert.equal(calls, 3); assert.equal(questions, 1); assert.ok(entry.workspaceArchive);
    assert.equal(entry.environment, 'closed'); await assert.rejects(lstat(dir), { code: 'ENOENT' });
    await assertTaskProcessesDrained(dir);
    assert.ok(entry.delivery?.missing?.some(value => value.startsWith('report.md')));
    assert.equal(entry.delivery?.evidence?.find(value => value.id === 'sum')?.status, 'passed');
    const threadId = entry.threadId, originalDeadline = entry.input.deadline;
    const savedSum = await readFile(path.join(journal.directory(input.operationId), 'workspace-snapshots', entry.workspaceArchive!.id, 'content/workspace/sum.cjs'));
    answered = true; entry = (await new ProjectJournal(journalRoot).list())[0]; runner = createRunner(entry); await runner.run();
    assert.equal(entry.state, 'completed', JSON.stringify(await journal.pending(entry)));
    assert.equal(entry.threadId, threadId); assert.equal(calls, 6); assert.equal(entry.workspaceArchive, undefined);
    assert.equal(entry.input.deadline, originalDeadline); assert.equal(entry.input.stepLimit, 6);
    assert.equal(entry.delivery?.verification?.files.find(file => file.path === 'sum.cjs')?.sha256, createHash('sha256').update(savedSum).digest('hex'));
    assert.equal(entry.delivery?.missing?.length, 0);
    const events = await journal.pending(entry);
    assert.ok(events.some(event => event.event.kind === 'workspace_saved'));
    assert.ok(events.some(event => event.event.kind === 'workspace_restored'));
    assert.ok(events.some(event => event.event.kind === 'tool' && event.event.item.exitCode === 0 && event.event.item.output?.includes('DURABLE_LINUX_CHECK_PASSED')));
    assert.equal(events.filter(event => event.event.kind === 'tool' && event.event.item.type === 'fileChange' && event.event.item.state === 'succeeded').length, 2,
      'Recovery writes only the missing report and keeps the original implementation');
    await assert.rejects(lstat(dir), { code: 'ENOENT' });
    await assertTaskProcessesDrained(dir);
    process.stdout.write('LINUX_DURABLE_INPUT_FIXTURE_OK\n');
  } finally {
    await runner?.stop('fixture cleanup');
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await rm(journalRoot, { recursive: true, force: true });
  }
}

await verifyDurableInput();
