import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectBridge } from '../desktop/project-bridge.js';
import { CodexRpc } from '../desktop/codex-rpc.js';
import { configureProject, inspectProjectShells, projectApprovalPolicy, trustProjectGuard } from '../desktop/project-configuration.js';
import { localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectSpecHash } from '../server/devices/projects.js';

const output = path.resolve('.local/desktop-build');
const vendor = path.join(output, 'vendor');
const engine = process.env.RAE_NATIVE_TEST_ENGINE ?? path.join(vendor, 'codex/bin/codex-app-server.exe');
const resources = { engine, node: path.join(vendor, 'node/node.exe'), hook: path.join(output, 'desktop/project-hook.js'), browser: path.join(output, 'node_modules/@playwright/mcp/cli.js') };
const available = process.platform === 'win32' && Object.values(resources).every(existsSync);

test('native Windows tools preserve quoted commands and enforce desktop patch boundary', { skip: !available, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rae-native-'));
  const project = path.join(root, '.local', 'space 中文'); await mkdir(project, { recursive: true });
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: project, readAccess: 'device', access: 'read-write', network: false });
  const input: ProjectExecutionInput = { operationId: 'native-fixture', taskId: 'fixture', runId: 'fixture', approvalRevision: 1, requirementsRevision: 1,
    spec, specHash: projectSpecHash(spec), title: 'fixture', objective: 'fixture', expectedOutput: 'fixture', ownerRequest: 'fixture', updates: [],
    model: { model: 'gpt-6.1-sol', reasoningEffort: 'auto', maxOutputTokens: null }, stepLimit: null, deadline: null, issuedAt: new Date().toISOString() };
  let desktop = false, revokeOnPatch = false, step = 0; const receipts: string[] = [];

  let python: string | undefined;
  try { python = execFileSync('py', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { /* Python is optional on a client. */ }
  const commands = [
    { cmd: `"${resources.node}" -e "console.log(JSON.stringify({cwd:process.cwd(),value:'quoted value'}))"`, shell: 'C:/Windows/System32/cmd.exe' },
    ...(python ? [{ cmd: `"${python}" -c "import os,json; print(json.dumps({'cwd':os.getcwd(),'value':'quoted value'}))"`, shell: 'C:/Windows/System32/cmd.exe' }] : []),
  ];
  const bridge = new ProjectBridge({ baseUrl: 'http://fixture', credential: 'fixture', signal: new AbortController().signal,
    input: () => desktop ? { ...input, spec: { ...input.spec, desktop: { applications: ['notepad'] } } } : input, async assertLocal() {},
    async request(_base, route, _credential, init) {
      if (route === '/api/device/projectguard') {
        if (revokeOnPatch && step > 0) throw new Error('Fixture task permission revoked');
        return Response.json({ input, sequence: 0 });
      }
      assert.equal(route, '/api/device/projectmodel');
      const wire = JSON.parse(String(init?.body)).request as { model: string; input: Array<{ type: string; output?: unknown; call_id?: string }> };
      if (step) { const receipt = [...wire.input].reverse().find(value => value.call_id === 'call-' + step && value.type.endsWith('_output'));
        receipts.push(typeof receipt?.output === 'string' ? receipt.output : JSON.stringify(receipt?.output ?? '')); }
      step++;
      let item: Record<string, unknown>;
      if (!desktop && !revokeOnPatch && step <= commands.length) item = { type: 'function_call', id: 'item-' + step, call_id: 'call-' + step, name: 'exec_command', arguments: JSON.stringify({ ...commands[step - 1], login: false, yield_time_ms: 10000, max_output_tokens: 3000 }) };
      else if (step === 1) item = { type: 'custom_tool_call', id: 'item-1', call_id: 'call-1', namespace: 'functions', name: 'exec',
        input: 'const result = await tools.apply_patch(' + JSON.stringify('*** Begin Patch\n*** Add File: denied.txt\n+not allowed\n*** End Patch') + '); text(result);' };
      else item = { type: 'message', id: 'done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
      const result = { id: 'response-' + step, object: 'response', created_at: 1, model: wire.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: result }];
      return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  const address = await bridge.start();
  async function run() {
    const config = await configureProject({ realPath: project, input: { spec: desktop ? { ...spec, desktop: { applications: ['notepad'] } } : spec, model: input.model } }, path.join(root, desktop ? 'desktop' : revokeOnPatch ? 'revoked' : 'private'), resources, address, bridge.token);
    let resolveCompleted!: () => void; let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
    const rpc = new CodexRpc({ executable: engine, args: config.args, cwd: project, env: config.environment,
      onNotification(value) { if (value.method === 'turn/completed') resolveCompleted(); }, onFailure: rejectCompleted, async onRequest() { throw new Error('Unexpected native request'); } });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'rae_native_test', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
      await trustProjectGuard(rpc, project, config.hookFile, config.hookCommand);
      if (!desktop && !revokeOnPatch) {
        const shells = await inspectProjectShells(rpc, project, config.permissions, () => bridge.guard());
        assert.ok(shells.some(shell => shell.available));
        for (const shell of shells.filter(shell => !shell.available)) assert.ok(shell.detail.length > 0);
      }
      const started = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd: project, model: input.model.model, modelProvider: 'rae', permissions: config.permissions, approvalPolicy: projectApprovalPolicy, ephemeral: true });
      await rpc.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Execute the offline fixture.' }], permissions: config.permissions, approvalPolicy: projectApprovalPolicy });
      await Promise.race([completed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Native fixture timed out')), 45000); timer.unref(); })]);
    } finally { await rpc.close(10000); }
  }
  try {
    await run();
    const commandReceipts = [...receipts];
    assert.equal(commandReceipts.length, commands.length);
    desktop = true; step = 0; receipts.length = 0;
    await run();
    assert.equal(existsSync(path.join(project, 'denied.txt')), false);
    assert.match(receipts[0], /未开放原生文件修改工具|block|denied|write.*project|outside|read.only|rejected/i);
    desktop = false; revokeOnPatch = true; step = 0; receipts.length = 0;
    await run();
    assert.equal(existsSync(path.join(project, 'denied.txt')), false);
    assert.match(receipts[0], /revoked|block/i);
    for (const receipt of commandReceipts) { assert.match(receipt, /quoted value/); assert.match(receipt, /Process exited with code\s*0/i); assert.ok(receipt.toLowerCase().includes('space')); }
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
