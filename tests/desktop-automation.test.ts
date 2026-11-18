import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopAutomation, desktopAutomationResources, verifyDesktopAutomationResources } from '../desktop/desktop-automation.js';

const harness = (workspace: string, applications: Array<'notepad' | 'clash-verge'>, guard: () => Promise<void>) =>
  new DesktopAutomation({ resources: desktopAutomationResources(workspace), directory: workspace, workspace, applications, guard });

test('Windows actions outside the task scope and path-shaped names never reach the device guard', async () => {
  let checks = 0;
  const desktop = harness(tmpdir(), ['clash-verge'], async () => { checks++; });
  try {
    await assert.rejects(desktop.call({ action: 'open_notepad_sample' }), /不允许操作/);
    await assert.rejects(desktop.call({ action: 'clash_navigate', page: 'settings' }));
    await assert.rejects(desktop.call({ action: 'clash_navigate', page: 'logs', delivery_mode: 'foreground' }));
    await assert.rejects(desktop.call({ action: 'screenshot', app: 'clash-verge', hwnd: 100 }));
    await assert.rejects(desktop.call({ action: 'notepad_save_as', filename: 'C:\\Users\\owner\\file.txt' }));
    await assert.rejects(desktop.call({ action: 'notepad_save_as', filename: '../outside.txt' }));
    await assert.rejects(desktop.call({ action: 'notepad_save_as', filename: 'COM1.txt' }));
    assert.equal(checks, 0);
  } finally { await desktop.drain(); }
});

test('Windows task refuses revoked work and stops accepting calls as it drains', async () => {
  let checks = 0;
  const desktop = harness(tmpdir(), ['clash-verge'], async () => { checks++; throw new Error('revoked'); });
  await assert.rejects(desktop.call({ action: 'clash_navigate', page: 'logs' }), /revoked/);
  await desktop.drain();
  await assert.rejects(desktop.call({ action: 'clash_navigate', page: 'logs' }), /停止接收/);
  assert.equal(checks, 1);
});

test('device capability refuses a Cua Driver executable with mismatched digest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-desktop-resources-'));
  const driver = path.join(directory, 'cua-driver.exe');
  const guard = path.join(directory, 'window-guard.exe');
  await Promise.all([writeFile(driver, 'not the release'), writeFile(guard, '')]);
  await assert.rejects(verifyDesktopAutomationResources({ driver, guard }), /校验失败/);
});
