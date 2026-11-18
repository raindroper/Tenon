import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import childProcess, { type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ProjectRunner } from '../desktop/project-runner.js';
import { ProjectHand } from '../desktop/project-hand.js';
import { projectFilesCapability } from '../shared/project-files.js';
import { projectContractV2Capability } from '../shared/project-contract.js';
import { ProjectWorkspaces } from '../desktop/project-workspaces.js';
import { ProjectJournal, type LocalProjectEntry } from '../desktop/project-journal.js';
import { localProjectSpecSchema, windowsDesktopCapability, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectSpecHash } from '../server/devices/projects.js';
import { DeviceHttpError } from '../desktop/transport.js';
import { normalizeSiwcResponses, restoreSiwcToolIdentity } from '../server/models/provider.js';
import { ProjectModelStream, projectModelFailureFrame } from '../shared/project-model-stream.js';
import type { CodexRpc } from '../desktop/codex-rpc.js';
import { projectStageReviewContent, projectStageApproved, type TaskDependency } from '../shared/task-flow.js';

const packaged = path.resolve('.local/desktop-artifacts/win-unpacked/resources');
const packagedReady = existsSync(path.join(packaged, 'vendor/node/node_modules/npm/bin/npm-cli.js'));
const output = packagedReady ? path.join(packaged, 'app') : path.resolve('.local/desktop-build');
const vendor = packagedReady ? path.join(packaged, 'vendor') : path.join(output, 'vendor');
const resources = { engine: path.join(vendor, 'codex/bin/codex-app-server.exe'), node: path.join(vendor, 'node/node.exe'),
  hook: path.join(output, 'desktop/project-hook.js'), browser: path.join(output, 'node_modules/@playwright/mcp/cli.js') };
const available = process.platform === 'win32' && Object.values(resources).every(file => existsSync(file));

test('the actual Windows hand advertises file delivery alongside the v2 contract', { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-native-capabilities-'));
  const hand = new ProjectHand({ deviceId: 'fixture', baseUrl: 'http://127.0.0.1:1', credential: 'offline', resources,
    journal: new ProjectJournal(directory), async post() { throw new Error('Capability discovery must not publish or execute'); }, status() {} });
  const capabilities = await hand.capabilities();
  assert.ok(capabilities.includes(projectContractV2Capability));
  assert.ok(capabilities.includes(projectFilesCapability));
  assert.ok(capabilities.includes(windowsDesktopCapability), 'Moving Codex into its complete distribution preserves desktop automation');
});

for (const scenario of ['complete', 'cutoff', 'missing-report', 'wrong-output', 'lost-check-response', 'cancel-check', 'retained-preview']) test(`native v2 delivery ${scenario} uses actual checks and durable outcome`, { skip: !available, timeout: 60000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-delivery-v2-'));
  const project = path.join(root, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'generate.cjs'), `require('node:fs').writeFileSync('result.json',JSON.stringify({total:${scenario === 'wrong-output' ? 17 : 42}}));`);
  if (scenario === 'retained-preview') await writeFile(path.join(project, 'generate.cjs'), "const fs=require('node:fs');fs.writeFileSync('result.json','{\"total\":42}');fs.writeFileSync('preview.pid',String(process.pid));const s=require('node:http').createServer((q,r)=>r.end('fixture'));s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));");
  await writeFile(path.join(project, 'verify.cjs'), "const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(process.env.RAE_PROJECT_TOKEN,undefined);assert.equal(process.env.RAE_PROJECT_GATE,undefined);assert.equal(JSON.parse(fs.readFileSync('result.json')).total,42);console.log('ACTUAL_CHECK_PASSED');");
  if (scenario === 'cancel-check') await writeFile(path.join(project, 'verify.cjs'), "require('node:fs').writeFileSync('check.pid',String(process.pid));setInterval(()=>{},1000);");
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: project, network: scenario === 'retained-preview', readAccess: 'device' });
  const input: ProjectExecutionInput = { operationId: 'delivery-operation', taskId: 'delivery-task', runId: 'delivery-run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Actual delivery', objective: 'Compute 42', expectedOutput: 'Actual JSON and checks', ownerRequest: 'Compute 42',
    updates: [], model: { model: 'offline-v2', reasoningEffort: 'default', maxOutputTokens: null }, stepLimit: null, deadline: null,
    issuedAt: new Date().toISOString(), contract: { version: 2, requirements: [{ id: 'total', text: 'The total equals 42', revision: 1, sourceEventId: 'owner' }] } };
  const journal = new ProjectJournal(path.join(root, 'private'));
  const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  let calls = 0, questions = 0, failure: unknown;
  let checkedProcess: number | undefined;
  let cancellation: Promise<void> | undefined;
  let injected = false;
  const server = createServer(async (request, response) => {
    try {
      let data = ''; for await (const chunk of request) data += chunk;
      const body = JSON.parse(data); response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/device/projectguard') { response.end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') {
        if (body.input.action === 'call' && body.input.name === 'ask_rae_owner') {
          questions++; response.end(JSON.stringify({ taskSuspended: true, dependency: { id: 'resume', state: 'waiting' } }));
        } else response.end(JSON.stringify({ inputFiles: [], taskFlow: { stageReviews: [] }, tools: [] }));
        return;
      }
      assert.equal(request.url, '/api/device/projectmodel'); calls++; assert.ok(calls <= 4);
      const native = body.request;
      let item: Record<string, unknown>;
      if (calls === 1) item = { type: 'function_call', id: 'generate', call_id: 'generate', name: 'exec_command', arguments: JSON.stringify({
        cmd: 'node generate.cjs', shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) };
      else if (calls === 2) {
        if (['lost-check-response', 'cancel-check'].includes(scenario) && !injected) {
          injected = true;
          const rpc = (runner as unknown as { rpc: CodexRpc }).rpc;
          const original = rpc.request.bind(rpc);
          rpc.request = (async (method: string, params: Record<string, unknown>, timeout?: number) => {
            const result = original(method, params, timeout);
            if (method === 'command/exec') {
              if (scenario === 'lost-check-response') { await result; throw new Error('Injected lost check control receipt'); }
              cancellation = (async () => {
                const deadline = Date.now() + 5000;
                while (!existsSync(path.join(project, 'check.pid')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
                checkedProcess = Number(await readFile(path.join(project, 'check.pid'), 'utf8'));
                await runner.stop('Owner cancelled during the accepted check', 'cancel');
              })();
              void cancellation.catch(error => { failure = error; });
            }
            return result;
          }) as typeof rpc.request;
        }
        item = { type: 'function_call', id: 'deliver', call_id: 'deliver', name: 'submit_project_delivery', arguments: JSON.stringify({
        summary: 'Check the actual total', outputs: [{ path: 'result.json', format: 'json', description: 'Actual total' },
          ...(scenario === 'missing-report' ? [{ path: 'report.md', format: 'md', description: 'Required report' }] : [])],
        checks: [{ id: 'actual-total', requirementIds: ['total'], criterion: 'The total equals 42', files: ['result.json'],
          command: { argv: [resources.node, 'verify.cjs'] }, assertions: [{ kind: 'json', path: 'result.json', key: ['total'], equals: 42 }] }],
      }) };
      }
      else if (!['complete', 'retained-preview'].includes(scenario)) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(projectModelFailureFrame('request_timeout', 'Offline injected final-response failure')); return;
      } else item = nativeMessage('done', 'The actual total passed verification.');
      sendNativeResponse(response, input.model.model, calls, item, 1, native);
    } catch (error) { failure = error; response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const restore = guardNativeGit(context);
  const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    credential: 'offline', resources, journal, entry, workspaces: new ProjectWorkspaces(), changed() {},
    request: async (base, route, _credential, init) => fetch(base + route, init) });
  try {
    await runner.run(); await cancellation; if (failure) throw failure;
    assert.equal(calls, ['cancel-check', 'lost-check-response'].includes(scenario) ? 2 : 3); assert.equal(entry.environment, scenario === 'retained-preview' ? 'active' : 'closed');
    assert.equal(entry.state, scenario === 'cancel-check' ? 'cancelled' : ['complete', 'retained-preview'].includes(scenario) ? 'completed' : 'paused', entry.error ?? '');
    assert.equal(questions, ['cutoff', 'missing-report', 'wrong-output', 'lost-check-response'].includes(scenario) ? 1 : 0);
    assert.equal(entry.delivery?.version, 2);
    if (['cancel-check', 'lost-check-response'].includes(scenario)) assert.notEqual(entry.delivery?.verification?.checks[0].status, 'passed');
    else assert.equal(entry.delivery?.verification?.checks[0].status, scenario === 'wrong-output' ? 'failed' : 'passed');
    const events = await journal.pending(entry);
    assert.ok(events.some(event => event.event.kind === 'tool' && event.event.item.type === 'projectCheck' && event.event.item.endedAt));
    assert.ok(events.some(event => event.event.kind === 'delivery'));
    if (scenario === 'missing-report') assert.match(entry.delivery!.missing!.join('\n'), /report\.md/);
    if (scenario === 'lost-check-response') assert.ok(entry.checkpoint, 'An uncertain check retains a resumable, observed workspace');
    if (checkedProcess) assert.throws(() => process.kill(checkedProcess!, 0), 'Accepted check process must have exited before cancellation resolves');
    if (scenario === 'retained-preview') {
      const pid = Number(await readFile(path.join(project, 'preview.pid'), 'utf8'));
      assert.doesNotThrow(() => process.kill(pid, 0));
      const latest = new Map(events.flatMap(event => event.event.kind === 'tool' ? [[event.event.item.id, event.event.item] as const] : []));
      const environment = events.find(event => event.event.kind === 'environment' && event.event.state === 'active')?.event;
      assert.ok(environment?.kind === 'environment');
      const running = [...latest.values()].filter(tool => tool.state === 'running');
      assert.equal(running.length, 1);
      assert.ok(environment.terminals.some(terminal => terminal.threadId === running[0].threadId && terminal.processId === running[0].processId));
      await runner.stop('Owner stops the retained preview');
      assert.throws(() => process.kill(pid, 0));
    }
  } finally { await runner.stop('Fixture cleanup'); restore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const workbook of [false, true]) test(`native contract receives the original read-only ${workbook ? '11-column workbook' : 'text input'}, executes its real validator and delivers a hash-bound result`, { skip: !available, timeout: 60000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-contract-'));
  const project = path.join(root, 'project'); await mkdir(project);
  const journal = new ProjectJournal(path.join(root, 'private'));
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  zip.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="book" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
  zip.addFile('xl/workbook.xml', Buffer.from('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Plan" sheetId="1" r:id="sheet"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' + Array.from({ length: 11 }, (_, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>字段${i + 1}</t></is></c>`).join('') + '</row></sheetData></worksheet>'));
  const original = workbook ? zip.toBuffer() : Buffer.from('original owner attachment');
  const sha256 = createHash('sha256').update(original).digest('hex');
  const format = workbook ? 'xlsx' : 'txt';
  const source = { id: 'original-file', messageId: 'owner-message', name: 'source.' + format, size: original.length, sha256 };
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: project, network: false, readAccess: 'device' });
  const input: ProjectExecutionInput = { operationId: 'contract-operation', taskId: 'contract-task', runId: 'contract-run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Validate original input', objective: 'Create a report from original input', expectedOutput: 'result.txt', ownerRequest: 'Use my input and verify the result',
    updates: [], model: { model: 'offline-contract', reasoningEffort: 'default', maxOutputTokens: null }, stepLimit: null, deadline: null,
    issuedAt: new Date().toISOString(), contract: { version: 1, criteria: ['Output equals input'] } };
  const inputPath = path.join(journal.directory(input.operationId), 'inputs', createHash('sha256').update(source.id + ':' + sha256).digest('hex'), source.name);
  await writeFile(path.join(project, 'check.cjs'), [
    "const fs=require('node:fs'), assert=require('node:assert/strict');",
    'const source=' + JSON.stringify(inputPath) + ';',
    workbook ? 'const Zip=require(' + JSON.stringify(path.resolve('node_modules/adm-zip')) + ');assert.equal(new Zip(source).readAsText("xl/worksheets/sheet1.xml").match(/<c /g).length,11);'
      : "assert.equal(fs.readFileSync(source,'utf8'),'original owner attachment');",
    "assert.throws(()=>fs.writeFileSync(source,'changed'));",
    `fs.writeFileSync('result.${format}',fs.readFileSync(source));`,
    `assert.deepEqual(fs.readFileSync('result.${format}'),fs.readFileSync(source));console.log('CONTRACT_PASSED');`,
  ].join('\n'));
  const plan = { objective: input.objective, basis: [{ kind: 'owner', reference: 'original-file', detail: input.ownerRequest }], method: 'Existing validator', environment: [],
    outputs: [{ path: 'result.' + format, format, description: 'Validated output' }],
    checks: [{ id: 'readback', criterion: 'Output equals input', required: true, method: 'check.cjs', basis: 'owner' }] };
  const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  let calls = 0, step = 0, fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes); response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/device/projectguard') { response.end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') {
        response.end(JSON.stringify(body.input.action === 'input_file'
          ? { ...source, offset: body.input.offset, data: original.subarray(body.input.offset).toString('base64') }
          : { inputFiles: [source], relatedResults: [{ taskId: 'previous-task', content: 'Use original input' }], tools: [] })); return;
      }
      assert.equal(request.url, '/api/device/projectmodel'); calls++; assert.ok(calls <= 12);
      const native = body.request;
      let item: Record<string, unknown>;
      if (step === 0) { step++; item = { type: 'function_call', id: 'plan', call_id: 'plan', name: 'record_project_plan', arguments: JSON.stringify(plan) }; }
      else if (step === 1) { step++; item = { type: 'function_call', id: 'generate', call_id: 'generate', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'node check.cjs', shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 2000 }) }; }
      else if (step === 2) {
        const events = await journal.pending(entry);
        const actual = events.map(value => value.event).find(event => event.kind === 'tool' && event.item.type === 'commandExecution' && event.item.state === 'succeeded');
        assert.ok(actual?.kind === 'tool', 'Actual validator must have completed'); assert.match(actual.item.output ?? '', /CONTRACT_PASSED/); step++;
        item = { type: 'function_call', id: 'verify', call_id: 'verify', name: 'verify_project_delivery', arguments: JSON.stringify({ checks: [
          { id: 'readback', status: 'passed', toolIds: [actual.item.id], detail: 'Output matches original', validator: 'check.cjs' },
        ] }) };
      } else { assert.ok(entry.delivery?.verification, JSON.stringify(native.input).slice(-3000)); item = nativeMessage('done', 'Verified actual output'); }
      sendNativeResponse(response, input.model.model, calls, item, 1, native);
    } catch (error) { fixtureError = error; response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const restore = guardNativeGit(context);
  const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    credential: 'offline', resources, journal, entry, workspaces: new ProjectWorkspaces(), changed() {},
    request: async (base, route, _credential, init) => fetch(base + route, init) });
  try {
    await runner.run(); if (fixtureError) throw fixtureError;
    assert.equal(entry.state, 'completed', entry.error ?? ''); assert.equal(calls, 4);
    assert.equal(entry.delivery?.verification?.files[0].sha256, sha256);
    assert.deepEqual(await readFile(inputPath), original);
    const events = (await journal.pending(entry)).map(value => value.event);
    assert.ok(events.some(event => event.kind === 'verification'));
    assert.ok(events.some(event => event.kind === 'model_transport' && event.state === 'received' && event.bytes > 0));
    assert.equal(entry.environment, 'closed');
  } finally { try { await runner.stop('fixture complete'); } finally { restore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
});

test('native v2 waits at each owner-reviewed stage and resumes the same thread to final delivery', { skip: !available, timeout: 60000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-stages-'));
  const project = path.join(root, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'generate.cjs'), "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({total:42}));");
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: project, network: false, readAccess: 'device' });
  const input: ProjectExecutionInput = { operationId: 'stage-operation', taskId: 'stage-task', runId: 'stage-run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Two stage review', objective: 'Produce two reviewed results', expectedOutput: 'Two results', ownerRequest: 'Review every stage before continuing',
    updates: [], model: { model: 'offline-stage', reasoningEffort: 'default', maxOutputTokens: null }, stepLimit: 9, deadline: Date.now() + 90000,
    issuedAt: new Date().toISOString(), contract: { version: 2, reviewMode: 'owner', requirements: [{ id: 'result', text: 'Two correct reviewed results', revision: 1, sourceEventId: 'owner' }] } };
  const journal = new ProjectJournal(path.join(root, 'private'));
  let entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  const stages: TaskDependency[] = []; let calls = 0, failure: unknown;
  const output = (index: number) => ({ path: 'stage-' + index + '.json', format: 'json', description: 'Stage ' + index });
  const check = (index: number) => ({ id: 'check-' + index, requirementIds: ['result'], criterion: 'The total equals 42', files: ['stage-' + index + '.json'],
    assertions: [{ kind: 'json', path: 'stage-' + index + '.json', key: ['total'], equals: 42 }] });
  const server = createServer(async (request, response) => {
    try {
      let data = ''; for await (const chunk of request) data += chunk;
      const body = JSON.parse(data); response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/device/projectguard') { response.end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') {
        if (body.input.action === 'stage_review') {
          const value = body.input.arguments;
          assert.equal(value.index, stages.length + 1);
          assert.ok(stages.every(stage => stage.state === 'resolved'));
          const now = new Date().toISOString();
          const dependency: TaskDependency = { id: 'stage-' + value.index, taskId: input.taskId, operationId: input.taskId, key: 'stage-' + value.index,
            requirementsRevision: 1, revision: 1, summary: value.title, questions: [{ key: 'stage-decision', question: 'Approve this stage?', blocks: 'Next stage' }],
            stageReview: { ...value, fingerprint: createHash('sha256').update(projectStageReviewContent(value)).digest('hex') },
            state: 'waiting', answers: [], candidateEventIds: [], reviewedEventIds: [], mailOperationIds: [], createdAt: now, updatedAt: now };
          stages.push(dependency); response.end(JSON.stringify({ taskSuspended: true, dependency, stageDecision: 'pending' }));
        } else response.end(JSON.stringify({ inputFiles: [], stageReviews: stages, taskFlow: { stageReviews: stages, resolvedInputs: stages.filter(stage => stage.state === 'resolved') }, tools: [] }));
        return;
      }
      assert.equal(request.url, '/api/device/projectmodel');
      if (stages.some(stage => stage.state === 'waiting')) { response.writeHead(409).end('Waiting for owner'); return; }
      calls++; assert.ok(calls <= 6, 'Final delivery returns to its primary session once');
      const index = calls <= 2 ? 1 : 2;
      const item = calls === 6 ? nativeMessage('final', 'Both stages are complete and verified.') : calls === 1 || calls === 3 ? { type: 'function_call', id: 'generate-' + index, call_id: 'generate-' + index, name: 'exec_command', arguments: JSON.stringify({
        cmd: 'node generate.cjs stage-' + index + '.json', shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) }
        : { type: 'function_call', id: 'deliver-' + calls, call_id: 'deliver-' + calls, name: 'submit_project_delivery', arguments: JSON.stringify({ summary: 'Review actual stage files',
          outputs: calls === 5 ? [output(1), output(2)] : [output(index)], checks: calls === 5 ? [check(1), check(2)] : [check(index)],
          ...(calls === 5 ? {} : { stage: { id: 'stage-' + index, index, count: 2, title: 'Stage ' + index } }) }) };
      sendNativeResponse(response, input.model.model, calls, item, 1, body.request);
    } catch (error) { failure = error; response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const restore = guardNativeGit(context); let runner: ProjectRunner | undefined;
  const run = async () => {
    runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port, credential: 'offline', resources,
      journal, entry, workspaces: new ProjectWorkspaces(), changed() {}, request: async (base, route, _credential, init) => {
        const response = await fetch(base + route, init); if (!response.ok) throw new DeviceHttpError(response.status); return response;
      } });
    await runner.run(); if (failure) throw failure;
  };
  try {
    await run(); assert.equal(entry.state, 'paused', entry.error ?? ''); assert.equal(calls, 2); assert.equal(stages.length, 1);
    assert.equal(existsSync(path.join(project, 'stage-2.json')), false);
    const thread = entry.threadId; const firstHash = createHash('sha256').update(await readFile(path.join(project, 'stage-1.json'))).digest('hex');
    stages[0].state = 'resolved'; stages[0].answers = [{ questionKey: 'stage-decision', content: projectStageApproved, actor: 'owner', evidenceEventIds: ['owner-stage-1'], at: new Date().toISOString() }];
    entry = (await journal.list())[0]; await run(); assert.equal(entry.state, 'paused', entry.error ?? ''); assert.equal(calls, 4); assert.equal(stages.length, 2);
    assert.equal(entry.threadId, thread);
    stages[1].state = 'resolved'; stages[1].answers = [{ questionKey: 'stage-decision', content: projectStageApproved, actor: 'owner', evidenceEventIds: ['owner-stage-2'], at: new Date().toISOString() }];
    entry = (await journal.list())[0]; await run(); assert.equal(entry.state, 'completed', entry.error ?? ''); assert.equal(calls, 6);
    assert.equal(entry.threadId, thread); assert.equal(entry.environment, 'closed');
    assert.equal(entry.input.stepLimit, 9); assert.equal(entry.input.deadline, input.deadline);
    assert.equal(createHash('sha256').update(await readFile(path.join(project, 'stage-1.json'))).digest('hex'), firstHash);
  } finally { await runner?.stop('Fixture cleanup'); restore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

function guardNativeGit(context: TestContext): () => void {
  // The Node socket guard cannot intercept Git spawned by the native engine.
  // Local Git inspection still works, but every remote Git protocol is denied.
  const spawn = childProcess.spawn;
  const guarded = context.mock.method(childProcess, 'spawn', ((command: string, args: readonly string[], options: SpawnOptions) =>
    spawn(command, args, path.resolve(command) === path.resolve(resources.engine)
      ? { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' } } : options)) as typeof spawn);
  syncBuiltinESMExports();
  return () => { guarded.mock.restore(); syncBuiltinESMExports(); };
}

function nativeMessage(id: string, text: string) {
  return { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}

type FixtureTool = { type: string; name: string; tools?: FixtureTool[] };
function nativeFixtureTools(request: Record<string, unknown>): FixtureTool[] {
  const input = request.input as Array<{ type: string; tools?: FixtureTool[] }>;
  const initial = request.tools as FixtureTool[] | undefined;
  return [...(initial ?? []), ...input.flatMap(item => item.type === 'additional_tools' ? item.tools ?? [] : [])];
}

function fixtureToolOutput(input: Array<Record<string, unknown>>, callId: string): string | undefined {
  const receipt = [...input].reverse().find(value => ['function_call_output', 'custom_tool_call_output'].includes(String(value.type)) && value.call_id === callId);
  return typeof receipt?.output === 'string' ? receipt.output : JSON.stringify(receipt?.output);
}

function sendNativeResponse(response: ServerResponse, model: string, call: number, item: Record<string, unknown>, inputTokens = 1,
  originalRequest?: Record<string, unknown>, inspectNestedTools = false) {
  const relay = originalRequest ? new ProjectModelStream(restoreSiwcToolIdentity(originalRequest)) : undefined;
  if (originalRequest && ['function_call', 'custom_tool_call'].includes(String(item.type))) {
    const normalized = normalizeSiwcResponses(originalRequest);
    const tools = nativeFixtureTools(normalized);
    const group = tools.find(tool => tool.type === 'namespace' && (!item.namespace || item.namespace === tool.name)
      && tool.tools?.some(child => child.name === item.name));
    if (group) item = { ...item, namespace: group.name };
    else if (!tools.some(tool => !item.namespace && tool.name === item.name)) {
      // Native code mode exposes shell, patch, dynamic and MCP tools inside the isolate.
      assert.ok(tools.find(tool => tool.name === 'functions')?.tools?.some(tool => tool.name === 'exec' && tool.type === 'custom'));
      const name = [item.namespace, item.name].filter(Boolean).join('__');
      const args = item.type === 'custom_tool_call' ? item.input : JSON.parse(String(item.arguments));
      const discovery = inspectNestedTools ? 'text(ALL_TOOLS.map(({name}) => name));\n' : '';
      item = { type: 'custom_tool_call', id: item.id, call_id: item.call_id, namespace: 'functions', name: 'exec',
        input: discovery + 'text(await tools[' + JSON.stringify(name) + '](' + JSON.stringify(args) + '));' };
    }
  }
  const result = { id: 'response_' + call, object: 'response', created_at: Math.floor(Date.now() / 1000), model,
    status: 'completed', output: [item], usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 } };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (type: string, data: Record<string, unknown>) => {
    const frame = 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
    response.write(relay ? relay.push(new TextEncoder().encode(frame)) : frame);
  };
  emit('response.created', { response: { ...result, status: 'in_progress', output: [] } });
  emit('response.output_item.added', { output_index: 0, item });
  const text = (item.content as Array<{ text: string }> | undefined)?.[0]?.text;
  if (item.type === 'message' && text) emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: result });
  response.end();
}

test('native collaboration denies child delivery and lets the primary verify and finish', { skip: !available, timeout: 60000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-child-delivery-'));
  const project = path.join(root, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'result.json'), '{"total":42}');
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: project, network: false });
  const input: ProjectExecutionInput = { operationId: 'child-delivery', taskId: 'child-delivery-task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Primary delivery fixture', objective: 'Delegate a review, then verify and deliver the result.',
    expectedOutput: 'Verified JSON', ownerRequest: 'Use a subagent to review and return the verified JSON result.', updates: [],
    model: { model: 'gpt-6.1-sol', reasoningEffort: 'low', maxOutputTokens: null }, stepLimit: null, deadline: null, issuedAt: new Date().toISOString(),
    contract: { version: 2, requirements: [{ id: 'total', text: 'Total equals 42', revision: 1 }], finalFiles: [{ description: 'Final result', format: 'json' }] } };
  const journal = new ProjectJournal(path.join(root, 'private'));
  const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  const submission = (id: string) => ({ type: 'function_call', id, call_id: id, name: 'submit_project_delivery', arguments: JSON.stringify({
    summary: id, outputs: [{ path: 'result.json', format: 'json', description: 'Final result' }], checks: [{ id: 'total', requirementIds: ['total'],
      criterion: 'Total equals 42', assertions: [{ kind: 'json', path: 'result.json', key: ['total'], equals: 42 }] }],
  }) });
  let resolveChildDenial!: () => void;
  const childDenied = new Promise<void>(resolve => { resolveChildDenial = resolve; });
  let primaryCalls = 0, childCalls = 0, call = 0, fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      if (request.url === '/api/device/projectguard') { response.end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') { response.end(JSON.stringify({ tools: [], inputFiles: [] })); return; }
      assert.equal(request.url, '/api/device/projectmodel');
      const wire = JSON.parse(bytes).request;
      const thread = wire.client_metadata.thread_id;
      assert.ok(thread);
      let item: Record<string, unknown>;
      if (thread === entry.threadId) {
        primaryCalls++; assert.ok(primaryCalls <= 4);
        if (primaryCalls === 1) item = { type: 'function_call', id: 'spawn', call_id: 'spawn', namespace: 'collaboration', name: 'spawn_agent',
          arguments: JSON.stringify({ task_name: 'reviewer', fork_turns: 'all', message: 'Review result.json and return its findings.' }) };
        else if (primaryCalls === 2) {
          const spawned = fixtureToolOutput(wire.input, 'spawn');
          assert.ok(spawned?.includes('reviewer'), spawned ?? 'The native spawn must return its child identity');
          response.once('close', resolveChildDenial);
          await childDenied;
          if (response.destroyed) return;
          assert.equal(entry.delivery, undefined, 'A child submission cannot record delivery');
          item = submission('primary-delivery');
        } else item = nativeMessage('primary-final', 'Primary verification completed.');
      } else {
        childCalls++; assert.ok(childCalls <= 2);
        if (childCalls === 1) item = submission('child-attempt');
        else {
          assert.match(fixtureToolOutput(wire.input, 'child-attempt') ?? '', /主会话/);
          item = nativeMessage('child-final', 'Review complete.');
          resolveChildDenial();
        }
      }
      sendNativeResponse(response, input.model.model, ++call, item, 1, wire);
    } catch (error) { fixtureError = error; resolveChildDenial(); response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const restore = guardNativeGit(context);
  const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    credential: 'offline', resources, journal, entry, workspaces: new ProjectWorkspaces(), changed() {},
    request: async (base, route, _credential, init) => fetch(base + route, init) });
  try {
    await runner.run(); if (fixtureError) throw fixtureError;
    assert.equal(entry.state, 'completed', entry.error ?? '');
    assert.equal(childCalls, 2);
    assert.equal(entry.delivery?.request?.summary, 'primary-delivery');
    assert.equal(entry.delivery?.verification?.checks[0].status, 'passed');
    const events = (await journal.pending(entry)).map(value => value.event);
    assert.ok(events.some(event => event.kind === 'tool' && event.item.type === 'subAgentActivity'));
    assert.ok(events.some(event => event.kind === 'finished' && event.state === 'completed' && event.output.includes('Primary verification completed')));
  } finally {
    resolveChildDenial();
    try { await runner.stop('child delivery fixture finished'); }
    finally { restore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('a real local project uses its installed Node while Rae retains its pinned guard runtime', { skip: !available, timeout: 60000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-toolchain-'));
  const project = path.join(root, 'existing-project'); await mkdir(project);
  const host = JSON.parse(childProcess.execFileSync('node', ['-p', 'JSON.stringify({version:process.version,path:process.execPath})'], { encoding: 'utf8', windowsHide: true }));
  const bundled = childProcess.execFileSync(resources.node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  await writeFile(path.join(project, '.node-version'), host.version.slice(1) + '\n');
  await writeFile(path.join(project, 'owner.txt'), 'UNCOMMITTED_OWNER_WORK\n');
  await writeFile(path.join(project, 'sum.cjs'), 'module.exports = (a,b) => a-b;\n');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ engines: { node: host.version }, scripts: { test: 'node check.cjs' } }));
  await writeFile(path.join(project, 'check.cjs'), [
    "const assert=require('node:assert/strict'), fs=require('node:fs');",
    "assert.equal(process.version,'v'+fs.readFileSync('.node-version','utf8').trim());",
    "assert.equal(require('./sum.cjs')(2,3),5);",
    "assert.equal(fs.readFileSync('owner.txt','utf8'),'UNCOMMITTED_OWNER_WORK\\n');",
    "fs.writeFileSync('check-result.json',JSON.stringify({version:process.version,path:process.execPath,cwd:process.cwd(),passed:true}));",
    "console.log('LOCAL_PROJECT_CHECK_PASSED');",
  ].join('\n'));
  const spec = localProjectSpecSchema.parse({ deviceId: 'local-client', root: project, network: false, readAccess: 'device' });
  const input: ProjectExecutionInput = { operationId: 'toolchain-operation', taskId: 'toolchain-task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Existing project repair', objective: 'Fix sum in this repository, preserve owner edits and test with its installed runtime.',
    expectedOutput: 'Verified local repair', ownerRequest: 'Fix this local repository.', updates: [], model: { model: 'gpt-6.1-sol', reasoningEffort: 'auto', maxOutputTokens: null },
    stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };
  let calls = 0, lastCall = 'test', fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/device/projectguard') { response.writeHead(200).end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') { response.writeHead(200).end(JSON.stringify({ tools: [] })); return; }
      if (request.url !== '/api/device/projectmodel') { response.writeHead(404).end(); return; }
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const wire = JSON.parse(bytes).request; calls++; assert.ok(calls <= 12);
      let item: Record<string, unknown>;
      if (calls === 1) item = { type: 'custom_tool_call', id: 'fix', call_id: 'fix', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: '
        + path.join(project, 'sum.cjs').replaceAll('\\', '/') + '\n@@\n-module.exports = (a,b) => a-b;\n+module.exports = (a,b) => a+b;\n*** End Patch' };
      else if (calls === 2) item = { type: 'function_call', id: lastCall, call_id: lastCall, name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'npm test', shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 2000 }) };
      else {
        const output = fixtureToolOutput(wire.input, lastCall);
        assert.ok(output, 'The real command must produce a receipt');
        const session = output.match(/(?:session ID\s+|session_id["'\\]*\s*[:=]\s*)(\d+)/i);
        if (session) { lastCall = 'wait-' + calls; item = { type: 'function_call', id: lastCall, call_id: lastCall, name: 'write_stdin',
          arguments: JSON.stringify({ session_id: Number(session[1]), chars: '', yield_time_ms: 1000, max_output_tokens: 2000 }) }; }
        else { assert.match(output, /(?:Process exited with code\s*0|exit_code["'\\]*\s*[:=]\s*0)/i);
          item = nativeMessage('done', 'The existing local project is repaired and its test passed.'); }
      }
      sendNativeResponse(response, input.model.model, calls, item, 1, wire);
    } catch (error) { fixtureError = error; response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const journal = new ProjectJournal(path.join(root, 'private'));
  const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  const restoreSpawn = guardNativeGit(context);
  const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    credential: 'offline-test', resources, journal, entry, workspaces: new ProjectWorkspaces(), changed() {}, request: async (base, route, _credential, init) => {
      const response = await fetch(base + route, init); if (!response.ok) { await response.body?.cancel(); throw new DeviceHttpError(response.status); } return response;
    } });
  try {
    await runner.run(); if (fixtureError) throw fixtureError;
    assert.equal(entry.state, 'completed', entry.error ?? '');
    const result = JSON.parse(await readFile(path.join(project, 'check-result.json'), 'utf8'));
    assert.equal(result.version, host.version); assert.equal(result.path.toLowerCase(), host.path.toLowerCase());
    assert.equal(result.cwd.toLowerCase(), project.toLowerCase()); assert.equal(result.passed, true);
    assert.equal(await readFile(path.join(project, 'owner.txt'), 'utf8'), 'UNCOMMITTED_OWNER_WORK\n');
    const events = (await journal.pending(entry)).map(value => value.event);
    assert.ok(events.some(event => event.kind === 'tool' && event.item.exitCode === 0 && event.item.output?.includes('LOCAL_PROJECT_CHECK_PASSED')));
    context.diagnostic(`Project Node ${result.version}; Rae guard Node ${bundled}; existing owner file preserved.`);
  } finally { try { await runner.stop('toolchain fixture finished'); } finally { restoreSpawn(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
});

test('native task waits durably, closes its process, detects intervening file changes and resumes the saved thread', { skip: !available, timeout: 90000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-durable-input-'));
  const project = path.join(root, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'owner.txt'), 'original');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  await writeFile(path.join(project, 'check.cjs'), 'require("node:assert/strict").equal(require("./sum.cjs")(2,3),5); console.log("DURABLE_CHECK_PASSED");');
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: project, access: 'read-write', readAccess: 'device', network: false, create: false });
  const input: ProjectExecutionInput = { operationId: 'a'.repeat(64), taskId: 'durable-task', runId: 'durable-run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Durable input fixture', objective: 'Ask for the rule, then implement and test sum.', expectedOutput: 'Actual command result',
    ownerRequest: 'Ask for the rule, then implement and test sum.', updates: [], model: { model: 'gpt-6.1-sol', reasoningEffort: 'low', maxOutputTokens: null },
    stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };
  let modelCalls = 0, ruleAnswered = false, conflictAnswered = false, lastCheckCall = 'check', fixtureError: unknown;
  let questionCount = 0;
  const resolved = () => [
    ...(ruleAnswered ? [{ id: 'rule-input', state: 'resolved', answers: [{ actor: 'owner', content: 'Return the sum of both numbers.' }] }] : []),
    ...(conflictAnswered ? [{ id: 'workspace-input', state: 'resolved', answers: [{ actor: 'owner', content: 'Keep owner.txt and continue from current files.' }] }] : []),
  ];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/device/projectguard') { response.end(JSON.stringify({ input, sequence: 0 })); return; }
      if (request.url === '/api/device/projectcontext') {
        if (body.input.action === 'catalog') response.end(JSON.stringify({ taskFlow: { resolvedInputs: resolved() }, tools: [{ name: 'ask_rae_owner',
          description: 'Persist the missing input and suspend this task.', inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object' } } }, required: ['questions'] } }] }));
        else {
          questionCount++;
          const conflict = String(body.input.arguments.questions[0].id).startsWith('workspace-');
          response.end(JSON.stringify({ taskSuspended: true, dependency: { id: conflict ? 'workspace-input' : 'rule-input', state: 'waiting' } }));
        }
        return;
      }
      if (request.url !== '/api/device/projectmodel') { response.writeHead(404).end(); return; }
      modelCalls++;
      assert.ok(modelCalls <= 12);
      if (modelCalls > 1) assert.ok(ruleAnswered && conflictAnswered, 'A pending question or workspace conflict cannot start another model call');
      const items = [
        { type: 'function_call', id: 'ask', call_id: 'ask', name: 'ask_rae_owner', arguments: JSON.stringify({ questions: [{ id: 'rule', header: 'Rule', question: 'Which rule should sum implement?' }] }) },
        { type: 'custom_tool_call', id: 'patch', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: ' + path.join(project, 'sum.cjs').replaceAll('\\', '/') + '\n+module.exports=(a,b)=>a+b;\n*** End Patch' },
        { type: 'function_call', id: 'check', call_id: 'check', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) },
        nativeMessage('result', 'Finished from the saved owner answer.'),
      ];
      let item = items[Math.min(modelCalls - 1, 3)];
      if (modelCalls >= 4) {
        const output = fixtureToolOutput(body.request.input, lastCheckCall);
        assert.ok(output, 'The native check must return an actual command receipt');
        const session = output.match(/(?:session ID\s+|session_id["'\\]*\s*[:=]\s*)(\d+)/i);
        if (session) {
          lastCheckCall = 'wait-check-' + modelCalls;
          item = { type: 'function_call', id: lastCheckCall, call_id: lastCheckCall, name: 'write_stdin', arguments: JSON.stringify({
            session_id: Number(session[1]), chars: '', yield_time_ms: 1000, max_output_tokens: 2000,
          }) };
        } else assert.match(output, /(?:Process exited with code\s*0|exit_code["'\\]*\s*[:=]\s*0)/i, 'A running or failed check must not become a final success');
      }
      sendNativeResponse(response, input.model.model, modelCalls, item, 1, body.request);
    } catch (error) { fixtureError = error; response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const journal = new ProjectJournal(path.join(root, 'private'));
  let entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  const restoreSpawn = guardNativeGit(context);
  let runner: ProjectRunner | undefined;
  const run = async () => {
    runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port, credential: 'offline', resources,
      journal, entry, workspaces: new ProjectWorkspaces(), changed() {}, request: async (base, route, _credential, init) => {
        const response = await fetch(base + route, init); if (!response.ok) throw new DeviceHttpError(response.status); return response;
      } });
    await runner.run(); if (fixtureError) throw fixtureError;
  };
  try {
    await run();
    assert.equal(entry.state, 'paused', entry.error ?? ''); assert.equal(entry.environment, 'closed');
    assert.ok(entry.checkpoint); const thread = entry.threadId; assert.ok(thread);
    assert.equal(modelCalls, 1); assert.equal(questionCount, 1);
    await writeFile(path.join(project, 'owner.txt'), 'owner change while waiting');
    ruleAnswered = true;
    entry = (await journal.list())[0]; await run();
    assert.equal(entry.state, 'paused', entry.error ?? ''); assert.equal(modelCalls, 1); assert.equal(questionCount, 2);
    assert.equal(entry.checkpointConflict?.dependencyId, 'workspace-input');
    conflictAnswered = true;
    entry = (await journal.list())[0]; await run();
    assert.equal(entry.state, 'completed', entry.error ?? ''); assert.equal(entry.threadId, thread);
    assert.equal(await readFile(path.join(project, 'owner.txt'), 'utf8'), 'owner change while waiting');
    assert.ok(modelCalls >= 4 && modelCalls <= 12);
    const recorded = await journal.pending(entry);
    assert.ok(recorded.some(event => event.event.kind === 'tool' && event.event.item.output?.includes('DURABLE_CHECK_PASSED')),
      JSON.stringify(recorded.filter(event => event.event.kind === 'tool')));
  } finally { await runner?.stop('fixture cleanup'); await new Promise<void>(done => server.close(() => done())); restoreSpawn(); }
});

/** Deterministic provider responses test the real native protocol; this is NOT a model-quality benchmark. */
test('bundled Codex restores SIWC tool identities, edits files, reads scoped sources, uses Playwright and drains without external inference', { skip: !available, timeout: 90000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-codex-native-'));
  const project = path.join(root, '项目 with spaces'); await mkdir(project);
  await writeFile(path.join(project, 'owner-note.txt'), 'Keep owner changes.');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node check.cjs' } }));
  await writeFile(path.join(project, 'check.cjs'), [
    "const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');",
    "assert.equal(require('./sum.cjs')(2,3),5);",
    "assert.equal(fs.realpathSync(process.env.npm_execpath),fs.realpathSync(path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')));",
    "assert.equal(process.env.RAE_PROJECT_TOKEN, undefined);",
    "assert.equal(process.env.RAE_PROJECT_GATE, undefined);",
    "assert.throws(()=>fs.writeFileSync('../outside.txt','not allowed'), { code: /^(EPERM|EACCES)$/ });",
    "console.log('REAL_CHECK_PASSED');",
  ].join('\n'));
  await writeFile(path.join(project, 'preview.cjs'), [
    "const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/redirect'){res.writeHead(307,{Location:url.searchParams.get('to')}).end();return;}res.end('<!doctype html><title>Fixture preview</title><button onclick=\"this.textContent=\\'Clicked\\'\">Click me</button>');});",
    "server.on('upgrade',(req,socket)=>{const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');const payload=Buffer.from('HMR_READY');socket.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]));});",
    "server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync('preview.json',JSON.stringify({port,pid:process.pid,childPid:child.pid}));console.log('http://127.0.0.1:'+port);});",
  ].join('\n'));
  const spec = localProjectSpecSchema.parse({ deviceId: 'device', root: project, network: true, returnScreenshots: true });
  const input: ProjectExecutionInput = { operationId: 'native-operation', taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Fixture', objective: 'Edit code, verify and read a scoped source',
    expectedOutput: 'Real file and command results', ownerRequest: 'Complete this fixture project.', updates: [],
    model: { model: 'gpt-6.1-sol', reasoningEffort: 'auto', maxOutputTokens: null }, stepLimit: 12, deadline: null, issuedAt: new Date().toISOString() };
  let calls = 0; let guards = 0; let sourceCalls = 0; let foreignHits = 0; const requests: unknown[] = [];
  let fixtureError: unknown;
  const evidence: Buffer[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/outside-preview') { foreignHits++; response.end('unrelated host service'); return; }
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes || '{}');
      if (request.url === '/api/device/projectguard') {
        guards++; response.setHeader('Content-Type', 'application/json');
        if (guards === 1) { response.writeHead(502).end(JSON.stringify({ error: 'Injected proxy EOF before any engine work' })); return; }
        response.end(JSON.stringify({ input, sequence: 0 })); return;
      }
      if (request.url === '/api/device/projectcontext') {
        response.setHeader('Content-Type', 'application/json');
        if (body.input.action === 'catalog') response.end(JSON.stringify({ tools: [{ name: 'rae_fixture_source', description: 'Read the current task source.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
          { name: 'ask_rae_owner', description: 'Read the previously saved owner answer.', inputSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object' } } }, required: ['questions'] } }] }));
        else if (body.input.name === 'ask_rae_owner') {
          answered = true; response.end(JSON.stringify({ taskSuspended: false, answers: { layout: { answers: ['Double'] } } }));
        } else { sourceCalls++; response.end(JSON.stringify({ evidence: 'SOURCE_RECEIPT' })); }
        return;
      }
      if (request.url === '/api/device/projectevidence') {
        assert.deepEqual(body.authorization, { operationId: input.operationId, specHash: input.specHash, requirementsRevision: input.requirementsRevision });
        assert.equal(body.image.name, 'preview.png');
        const image = Buffer.from(body.image.data, 'base64');
        assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        evidence.push(image);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'fixture-png', mediaType: 'image/png', size: image.length })); return;
      }
      if (request.url !== '/api/device/projectmodel') { response.writeHead(404).end(); return; }
      requests.push(body.request);
      calls++;
      if (calls === 2) {
        const catalog = fixtureToolOutput(body.request.input, 'escalate');
        assert.ok(catalog && !/browser_run_code_unsafe|browser_file_upload|browser_install/.test(catalog));
        assert.match(catalog, /browser_take_screenshot/);
      }
      assert.ok(calls <= 11, 'Native loop unexpectedly repeated a deterministic response');
      const preview = calls >= 6 ? JSON.parse(await readFile(path.join(project, 'preview.json'), 'utf8')) as { port: number } : undefined;
      const foreign = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/outside-preview';
      const finalText = 'Fixture complete. This unrelated address must not become a preview: ' + foreign;
      const items: Record<string, unknown>[] = [
        { type: 'function_call', id: 'escalate', call_id: 'escalate', name: 'exec_command', arguments: JSON.stringify({
          cmd: 'echo UNSANDBOXED>..\\escalated.txt', shell: 'C:/Windows/System32/cmd.exe', login: false,
          sandbox_permissions: 'require_escalated', justification: 'Write outside this fixture project.' }) },
        { type: 'custom_tool_call', id: 'patch', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: ' + path.join(project, 'sum.cjs').replaceAll('\\', '/') + '\n+module.exports=(a,b)=>a+b;\n*** End Patch' },
        { type: 'function_call', id: 'check', call_id: 'check', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test',
          shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) },
        { type: 'function_call', id: 'source', call_id: 'source', name: 'rae_fixture_source', arguments: '{}' },
        { type: 'function_call', id: 'server', call_id: 'server', name: 'exec_command', arguments: JSON.stringify({
          cmd: 'node preview.cjs', shell: 'C:/Windows/System32/cmd.exe', login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) },
        { type: 'function_call', id: 'navigate', call_id: 'navigate', namespace: 'mcp__playwright', name: 'browser_navigate',
          arguments: JSON.stringify({ url: 'http://127.0.0.1:' + preview?.port }) },
        { type: 'function_call', id: 'click', call_id: 'click', namespace: 'mcp__playwright', name: 'browser_evaluate',
          arguments: JSON.stringify({ function: `async () => {
            const foreign = ${JSON.stringify(foreign)};
            await fetch(foreign, {method:'POST',mode:'no-cors'}).catch(() => {});
            await new Promise(resolve => {
              const unrelated = new WebSocket(foreign.replace('http:', 'ws:'));
              const timeout = setTimeout(() => { unrelated.close(); resolve(); }, 3000);
              unrelated.onerror = () => { clearTimeout(timeout); resolve(); };
              unrelated.onopen = () => { clearTimeout(timeout); unrelated.close(); resolve(); };
            });
            const redirect = await fetch('/redirect?to=' + encodeURIComponent(foreign), {method:'POST'});
            if (redirect.status !== 403) throw new Error('Foreign redirect was not blocked: ' + redirect.status);
            const button=document.querySelector('button'); button.click();
            if(button.textContent!=='Clicked') throw new Error('Click failed');
            const socket = new WebSocket(location.origin.replace('http:','ws:') + '/hot');
            const update = await new Promise((resolve,reject) => {
              const timeout = setTimeout(() => reject(new Error('Preview websocket timed out')), 8000);
              socket.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
              socket.onerror = () => { clearTimeout(timeout); reject(new Error('Preview websocket failed')); };
            });
            socket.close();
            if (update !== 'HMR_READY') throw new Error('Preview websocket returned wrong data');
            return 'REAL_BROWSER_PASSED';
          }` }) },
        { type: 'function_call', id: 'screenshot', call_id: 'screenshot', namespace: 'mcp__playwright', name: 'browser_take_screenshot',
          arguments: JSON.stringify({ type: 'png', filename: 'preview.png', fullPage: true }) },
        { type: 'function_call', id: 'escape', call_id: 'escape', namespace: 'mcp__playwright', name: 'browser_snapshot',
          arguments: JSON.stringify({ filename: path.join(project, 'browser-escaped.md') }) },
        { type: 'function_call', id: 'question', call_id: 'question', name: 'ask_rae_owner', arguments: JSON.stringify({
          questions: [{ id: 'layout', header: 'Layout', question: 'Choose fixture layout', options: [
            { label: 'Single', description: 'One column' }, { label: 'Double', description: 'Two columns' }] }] }) },
        nativeMessage('result', finalText),
      ];
      const item = items[Math.min(calls - 1, items.length - 1)];
      sendNativeResponse(response, input.model.model, calls, item, 1, body.request, calls === 1);
    } catch (error) { fixtureError = error; response.writeHead(500).end(String(error)); }
  });
  server.on('upgrade', (_request, socket) => { foreignHits++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const journal = new ProjectJournal(path.join(root, 'private'));
  const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  const restoreSpawn = guardNativeGit(context);
  let answered = false;
  const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    credential: 'offline-test', resources, journal, entry, workspaces: new ProjectWorkspaces(), changed() {},
    request: async (base, route, _credential, init) => {
      const response = await fetch(base + route, init);
      if (!response.ok) { await response.body?.cancel(); throw new DeviceHttpError(response.status); }
      return response;
    } });
  let primaryFailure: unknown;
  try {
    await runner.run();
    if (fixtureError) throw fixtureError;
    const events = await journal.pending(entry);
    assert.equal(entry.state, 'completed', entry.error + '\n' + JSON.stringify(events));
    assert.equal(await readFile(path.join(project, 'sum.cjs'), 'utf8'), 'module.exports=(a,b)=>a+b;\n');
    assert.equal(await readFile(path.join(project, 'owner-note.txt'), 'utf8'), 'Keep owner changes.');
    assert.ok(events.some(value => value.event.kind === 'tool' && value.event.item.output?.includes('REAL_CHECK_PASSED')),
      JSON.stringify(requests.flatMap(value => ((value as { input?: Array<Record<string, unknown>> }).input ?? []).filter(item => String(item.type).includes('output')))));
    assert.equal(sourceCalls, 1); assert.ok(guards >= 4); assert.equal(calls, 11);
    assert.equal(existsSync(path.join(root, 'escalated.txt')), false);
    assert.ok(!events.some(value => value.event.kind === 'interaction' && value.event.type === 'approval'));
    const modelInputs = requests.flatMap(value => (value as { input?: Array<Record<string, unknown>> }).input ?? []);
    assert.equal(answered, true, fixtureToolOutput(modelInputs, 'question') ?? 'Missing owner answer receipt');
    assert.ok(events.some(value => value.event.kind === 'tool' && value.event.item.output?.includes('REAL_BROWSER_PASSED')),
      JSON.stringify(events.filter(value => value.event.kind === 'tool' && value.event.item.type === 'mcpToolCall')) + '\n'
      + JSON.stringify(['navigate', 'click', 'screenshot'].map(id => fixtureToolOutput(modelInputs, id))));
    assert.equal(foreignHits, 0);
    assert.equal(existsSync(path.join(project, 'browser-escaped.md')), false);
    assert.equal(existsSync(path.join(project, 'preview.png')), false);
    const screenshotFile = path.join(journal.directory(input.operationId), 'browser-output', 'preview.png');
    assert.ok((await stat(screenshotFile)).size > 100);
    const finished = events.find(value => value.event.kind === 'finished');
    assert.ok(finished?.event.kind === 'finished');
    assert.deepEqual(evidence, [await readFile(screenshotFile)], finished.event.output);
    assert.equal(entry.environment, 'active');
    const rpc = (runner as unknown as { rpc: CodexRpc }).rpc;
    const features = await rpc.request<{ data: Array<{ name: string; enabled: boolean }> }>('experimentalFeature/list', { limit: 200 });
    for (const name of ['plugins', 'recommended_plugins']) assert.equal(features.data.find(feature => feature.name === name)?.enabled, false,
      'A task must not start native plugin discovery or catalog synchronization');
    const processes = JSON.parse(await readFile(path.join(project, 'preview.json'), 'utf8')) as { pid: number; childPid: number; port: number };
    const previews = events.flatMap(value => value.event.kind === 'preview' ? [value.event.url] : []);
    assert.ok(previews.length > 0);
    assert.ok(previews.every(url => new URL(url).port === String(processes.port)));
    await runner.stop('owner stopped preview');
    assert.equal(entry.environment, 'closed');
    for (const pid of [processes.pid, processes.childPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } catch (error) {
    primaryFailure = error;
    context.diagnostic(JSON.stringify({ primaryError: error instanceof Error ? { name: error.name, message: error.message } : error,
      state: entry.state, environment: entry.environment, error: entry.error, calls, guards,
      events: await journal.pending(entry) }));
    throw error;
  } finally {
    try {
      try { await runner.stop('fixture finished'); }
      catch (error) { if (primaryFailure) throw new AggregateError([primaryFailure, error], 'Native fixture and cleanup both failed'); throw error; }
    }
    finally {
      restoreSpawn();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test('bundled Codex compacts a project context and continues the same turn without publishing the summary', { skip: !available, timeout: 45000 }, async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-codex-compaction-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'check.cjs'), [
    "const assert = require('node:assert/strict');",
    "const { readFileSync } = require('node:fs');",
    "assert.equal(readFileSync('result.txt', 'utf8'), '42\\n');",
    "console.log('VERIFIED_AFTER_COMPACTION');",
  ].join('\n'));
  const spec = localProjectSpecSchema.parse({ deviceId: 'device', root: project, network: false });
  const model = { model: 'gpt-6.1-sol', reasoningEffort: 'auto', maxOutputTokens: null, contextWindow: 20_000 } satisfies ProjectExecutionInput['model'];
  const ownerRequest = 'Write a result with value 42, then run check.cjs to verify it.';
  const input: ProjectExecutionInput = { operationId: 'compaction-operation', taskId: 'task', runId: 'run', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'Compaction fixture', objective: ownerRequest, expectedOutput: 'The verified result file',
    ownerRequest, updates: [], model, stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };
  const summary = 'INTERNAL_FIXTURE_SUMMARY: the owner still wants value 42 and a real check.';
  const finalText = 'The result is 42 and the check passed.';
  const shell = 'C:/Windows/System32/cmd.exe';
  const command = (id: string, cmd: string) => ({ type: 'function_call', id, call_id: id, name: 'exec_command',
    arguments: JSON.stringify({ cmd, shell, login: false, max_output_tokens: 1000 }) });
  const patch = { type: 'custom_tool_call', id: 'patch', call_id: 'patch', name: 'apply_patch',
    input: '*** Begin Patch\n*** Add File: ' + path.join(project, 'result.txt').replaceAll('\\', '/') + '\n+42\n*** End Patch' };
  const stages = [command('before-compact', 'echo BEFORE_COMPACTION'), nativeMessage('summary', summary), patch,
    command('verify', 'node check.cjs'), nativeMessage('result', finalText)];
  const kinds: string[] = [];
  let fixtureError: unknown;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/device/projectguard') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input, sequence: 0 })); return;
      }
      if (request.url === '/api/device/projectcontext') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tools: [] })); return;
      }
      if (request.url !== '/api/device/projectmodel') { response.writeHead(404).end(); return; }
      let bytes = ''; for await (const chunk of request) bytes += chunk;
      const wire = JSON.parse(bytes).request;
      const metadata = JSON.parse(wire.client_metadata['x-codex-turn-metadata']);
      kinds.push(metadata.request_kind);
      const item = stages[kinds.length - 1];
      assert.ok(item, 'Native loop unexpectedly repeated a deterministic response');
      if (kinds.length === 2) {
        assert.equal(metadata.request_kind, 'compaction');
        assert.deepEqual(metadata.compaction, { trigger: 'auto', reason: 'context_limit', implementation: 'responses', phase: 'mid_turn', strategy: 'memento' });
        assert.match(JSON.stringify(wire.input), /BEFORE_COMPACTION/);
      } else assert.equal(metadata.request_kind, 'turn');
      if (kinds.length === 3) {
        const nextContext = JSON.stringify(wire.input);
        assert.ok(nextContext.includes(summary), 'The next generation must receive the actual summary');
        assert.ok(nextContext.includes(ownerRequest), 'The original task must survive compaction');
      }
      if (kinds.length === 5) assert.match(JSON.stringify(wire.input), /VERIFIED_AFTER_COMPACTION/);
      sendNativeResponse(response, model.model, kinds.length, item, kinds.length === 1 ? 30_000 : 10, wire);
    } catch (error) { fixtureError = error; response.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const journal = new ProjectJournal(path.join(root, 'private'));
  const entry: LocalProjectEntry = { input, state: 'queued', sequence: 0, acknowledged: 0, appliedRevision: 0, output: '' };
  const restoreSpawn = guardNativeGit(context);
  const runner = new ProjectRunner({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    credential: 'offline-test', resources, journal, entry, workspaces: new ProjectWorkspaces(), changed() {},
    request: async (base, route, _credential, init) => {
      const response = await fetch(base + route, init);
      if (!response.ok) { await response.body?.cancel(); throw new DeviceHttpError(response.status); }
      return response;
    } });
  try {
    await runner.run();
    if (fixtureError) throw fixtureError;
    const events = (await journal.pending(entry)).map(value => value.event);
    assert.equal(entry.state, 'completed', entry.error + '\n' + JSON.stringify(events));
    assert.deepEqual(kinds, ['turn', 'compaction', 'turn', 'turn', 'turn']);
    assert.equal(events.filter(event => event.kind === 'turn').length, 1);
    assert.equal(await readFile(path.join(project, 'result.txt'), 'utf8'), '42\n');
    assert.ok(events.some(event => event.kind === 'tool' && event.item.exitCode === 0
      && event.item.output?.includes('VERIFIED_AFTER_COMPACTION')));
    assert.ok(!JSON.stringify(events.filter(event => event.kind === 'text' || event.kind === 'finished')).includes(summary));
    assert.equal(entry.output, finalText);
    assert.ok(events.some(event => event.kind === 'finished' && event.state === 'completed' && event.output === finalText));
  } finally {
    try { await runner.stop('compaction fixture finished'); }
    finally {
      restoreSpawn();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
