import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureProject } from '../desktop/project-configuration.js';
import { linuxProjectResources } from '../worker/linux-project-sandbox.js';
import { LINUX_CODEX_RUNTIME } from '../shared/codex-runtime.js';

const resources = { engine: 'C:/vendor/codex/bin/codex-app-server.exe', node: 'C:/vendor/node/node.exe', hook: 'C:/app/project-hook.js', browser: 'C:/app/browser.js' };

test('project configuration retains native model metadata and quotes dotted project paths in TOML', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-config-'));
  try {
    const realPath = 'C:\\workspace\\.local\\project';
    const entry = { realPath, input: { spec: { access: 'read-only' as const, readAccess: 'project' as const, network: false, desktop: undefined, returnScreenshots: undefined }, model: { model: 'custom-provider-model', contextWindow: 32768 } } };
    const result = await configureProject(entry, directory, resources, 'http://127.0.0.1:1234', 'fixture');
    const config = await readFile(path.join(result.home, 'config.toml'), 'utf8');
    assert.match(config, /model = "custom-provider-model"/);
    assert.match(config, /model_context_window = 32768/);
    assert.match(config, /developer_instructions = /);
    assert.doesNotMatch(config, /model_catalog_json|shell_tool = false/);
    assert.ok(config.includes('[projects.' + JSON.stringify(realPath) + ']\ntrust_level = "untrusted"'));
    assert.deepEqual(result.args, ['--strict-config', '--listen', 'stdio://']);
    assert.match(config, /exclude = \["RAE_PROJECT_TOKEN", "RAE_PROJECT_GATE"\]/);
    const desktop = await configureProject({ ...entry, input: { ...entry.input, spec: { ...entry.input.spec, desktop: { applications: [] } } } }, path.join(directory, 'desktop'), resources, 'http://127.0.0.1:1234', 'fixture');
    const desktopConfig = await readFile(path.join(desktop.home, 'config.toml'), 'utf8');
    assert.match(desktopConfig, /shell_tool = false/);
    assert.ok(desktopConfig.includes(JSON.stringify(realPath) + ' = "read"'));
    assert.doesNotMatch(desktopConfig, / = "write"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux outer isolation includes every verified native runtime component without exposing the worker directory', () => {
  const runtime = path.resolve('runtime-root', 'codex');
  const resources = linuxProjectResources('/work', path.join(runtime, LINUX_CODEX_RUNTIME.executable), '/usr/local/bin/node', '/opt/worker/project-hook.cjs');
  const args = resources.sandbox.command('/work/task', []).args;
  const readonly = args.flatMap((value, index) => value === '--ro-bind' ? [args[index + 1]] : []);
  for (const relative of Object.keys(LINUX_CODEX_RUNTIME.requiredFiles)) assert.ok(readonly.includes(path.join(runtime, relative)), relative);
  assert.ok(!readonly.includes(runtime));
  assert.ok(!readonly.includes(path.dirname(runtime)));
});
