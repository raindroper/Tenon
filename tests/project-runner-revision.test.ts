import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRunner } from '../desktop/project-runner.js';
import { ProjectJournal, type LocalProjectEntry } from '../desktop/project-journal.js';
import { ProjectWorkspaces } from '../desktop/project-workspaces.js';
import type { CodexMessage } from '../desktop/codex-rpc.js';
import { localProjectSpecSchema, type ProjectExecutionInput } from '../shared/local-project.js';
import { projectSpecHash } from '../server/devices/projects.js';

interface NotificationProbe {
  notification(message: CodexMessage): void;
  request(message: CodexMessage): Promise<unknown>;
  nativeRequestRevision(params: Record<string, unknown>, primaryOnly: boolean): number;
  waitForOwnedWork(): Promise<boolean>;
  canRetainPreview(): boolean;
  turnRevisions: Map<string, number>;
  ownedWorkChanged?: () => void;
  stopping?: { mode: 'cancel'; reason: string };
  flushText(): void;
  revisionAtTurn: number;
  turnText: string;
  serial: Promise<void>;
  activeTurns: Map<string, string>;
  fatal?: Error;
  turnWaiter?: { resolve(turn: { id: string }): void; reject(error: Error): void };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rae-turn-revision-'));
  const spec = localProjectSpecSchema.parse({ deviceId: 'fixture', root: directory, network: false });
  const input: ProjectExecutionInput = { operationId: 'revision-operation', taskId: 'task', runId: 'run', approvalRevision: 1,
    requirementsRevision: 1, spec, specHash: projectSpecHash(spec), title: 'Revision fixture', objective: 'Verify current data',
    ownerRequest: 'Verify the first data', expectedOutput: 'Verified data', updates: [],
    model: { model: 'offline', reasoningEffort: 'default', maxOutputTokens: null }, stepLimit: null, deadline: null,
    issuedAt: new Date().toISOString(), contract: { version: 2, requirements: [{ id: 'owner', text: 'Verify current data', revision: 1 }] } };
  const entry: LocalProjectEntry = { input, state: 'running', sequence: 0, acknowledged: 0, appliedRevision: 1, output: '', threadId: 'root' };
  const journal = new ProjectJournal(join(directory, 'journal'));
  const runner = new ProjectRunner({ entry, journal, workspaces: new ProjectWorkspaces(), baseUrl: 'http://127.0.0.1', credential: 'offline',
    resources: { engine: 'unused', node: process.execPath, hook: 'unused', browser: 'unused' }, changed() {},
    request: async () => { throw new Error('Notification tests cannot dispatch any request'); } });
  const probe = runner as unknown as NotificationProbe;
  const notify = (method: string, params: Record<string, unknown>) => probe.notification({ method, params });
  notify('turn/started', { threadId: 'root', turn: { id: 'old-root', status: 'inProgress' } });
  notify('turn/started', { threadId: 'child', turn: { id: 'old-child', status: 'inProgress' } });
  entry.input = { ...entry.input, requirementsRevision: 2, runId: 'run-2' };
  entry.appliedRevision = 2; probe.revisionAtTurn = 2; probe.turnText = '';
  notify('turn/started', { threadId: 'root', turn: { id: 'new-root', status: 'inProgress' } });
  return { entry, journal, probe, notify, async drain() { probe.flushText(); await probe.serial; return journal.pending(entry); } };
}

test('an old child turn retains its captured revision when its tool starts and ends after a new root turn', async () => {
  const f = await fixture();
  const old = { id: 'old-check', type: 'commandExecution', command: 'check old data' };
  const current = { id: 'new-check', type: 'commandExecution', command: 'check new data' };
  f.notify('item/started', { threadId: 'child', turnId: 'old-child', item: old });
  f.notify('item/started', { threadId: 'root', turnId: 'new-root', item: current });
  f.notify('item/completed', { threadId: 'child', turnId: 'old-child', item: { ...old, status: 'completed', exitCode: 0 } });
  f.notify('item/completed', { threadId: 'root', turnId: 'new-root', item: { ...current, status: 'completed', exitCode: 0 } });
  const events = await f.drain();
  const oldEvents = events.filter(event => event.event.kind === 'tool' && event.event.item.id === old.id);
  const newEvents = events.filter(event => event.event.kind === 'tool' && event.event.item.id === current.id);
  assert.equal(oldEvents.length, 2); assert.equal(newEvents.length, 2);
  assert.ok(oldEvents.every(event => event.requirementsRevision === 1));
  assert.ok(newEvents.every(event => event.requirementsRevision === 2));
});

test('late old text and diff remain in old-version history and cannot enter the current final response', async () => {
  const f = await fixture();
  f.notify('item/agentMessage/delta', { threadId: 'root', turnId: 'old-root', itemId: 'old-text', delta: 'OLD_CONTENT' });
  f.notify('item/agentMessage/delta', { threadId: 'root', turnId: 'new-root', itemId: 'new-text', delta: 'CURRENT_CONTENT' });
  f.notify('turn/diff/updated', { threadId: 'root', turnId: 'old-root', diff: 'OLD_DIFF' });
  f.notify('turn/diff/updated', { threadId: 'root', turnId: 'new-root', diff: 'CURRENT_DIFF' });
  const events = await f.drain();
  assert.equal(f.probe.turnText, 'CURRENT_CONTENT');
  assert.ok(events.some(event => event.requirementsRevision === 1 && event.event.kind === 'text' && event.event.text === 'OLD_CONTENT'));
  assert.ok(events.some(event => event.requirementsRevision === 2 && event.event.kind === 'text' && event.event.text === 'CURRENT_CONTENT'));
  assert.ok(events.some(event => event.requirementsRevision === 1 && event.event.kind === 'diff' && event.event.diff === 'OLD_DIFF'));
  assert.ok(events.some(event => event.requirementsRevision === 2 && event.event.kind === 'diff' && event.event.diff === 'CURRENT_DIFF'));
});

test('late completion of the previous root turn cannot close or settle the current root turn', async () => {
  const f = await fixture();
  const settled: string[] = [];
  f.probe.turnWaiter = { resolve(turn) { settled.push(turn.id); }, reject(error) { throw error; } };
  f.notify('turn/completed', { threadId: 'root', turn: { id: 'old-root', status: 'completed' } });
  assert.deepEqual(settled, []);
  assert.equal(f.probe.activeTurns.get('root'), 'new-root');
  f.notify('turn/completed', { threadId: 'root', turn: { id: 'new-root', status: 'completed' } });
  assert.deepEqual(settled, ['new-root']);
  assert.equal(f.probe.activeTurns.has('root'), false);
  await f.drain();
});

test('an uncaptured explicit turn cannot supply new-version tool evidence while known tool identities remain stable', async () => {
  const f = await fixture();
  const tool = { id: 'known-check', type: 'commandExecution', command: 'check current data' };
  f.notify('item/started', { threadId: 'root', item: tool });
  f.notify('item/completed', { item: { ...tool, status: 'completed', exitCode: 0 } });
  f.notify('item/completed', { threadId: 'root', turnId: 'never-captured',
    item: { id: 'unknown-check', type: 'commandExecution', command: 'unknown command', status: 'completed', exitCode: 0 } });
  const events = await f.drain();
  assert.match(f.probe.fatal?.message ?? '', /要求版本无法核对/);
  assert.equal(events.filter(event => event.event.kind === 'tool' && event.event.item.id === 'unknown-check').length, 0);
  const known = events.filter(event => event.event.kind === 'tool' && event.event.item.id === tool.id);
  assert.equal(known.length, 2); assert.ok(known.every(event => event.requirementsRevision === 2));
});

test('task control rejects child and stale root calls before any external request', async () => {
  const f = await fixture();
  for (const tool of ['submit_project_delivery', 'record_project_plan', 'verify_project_delivery', 'ask_rae_owner']) {
    const result = await f.probe.request({ method: 'item/tool/call', params: { tool, arguments: {}, threadId: 'child', turnId: 'old-child' } }) as { success: boolean; contentItems: Array<{ text: string }> };
    assert.equal(result.success, false);
    assert.match(result.contentItems[0].text, /主会话/);
  }
  assert.throws(() => f.probe.nativeRequestRevision({ threadId: 'root', turnId: 'old-root' }, true), /活动会话/);
  assert.equal(f.probe.nativeRequestRevision({ threadId: 'root', turnId: 'new-root' }, true), 2);
  assert.throws(() => f.probe.nativeRequestRevision({ threadId: 'child', turnId: 'old-child' }, false), /版本/);
  await f.drain();
});

test('a late child turn inherits its actual root turn revision after owner changes', async () => {
  const f = await fixture();
  f.notify('turn/started', { threadId: 'late-child', turn: { id: 'late-turn', rootTurnId: 'old-root', status: 'inProgress' } });
  assert.equal(f.probe.turnRevisions.get('late-child:late-turn'), 1);
  assert.throws(() => f.probe.nativeRequestRevision({ threadId: 'late-child', turnId: 'late-turn' }, false), /版本/);
  await f.drain();
});

test('primary completion waits for the child and revision change wakes that wait', async () => {
  const f = await fixture(); f.probe.canRetainPreview = () => false;
  f.notify('turn/completed', { threadId: 'root', turn: { id: 'new-root', status: 'completed' } });
  let completed = false;
  const waiting = f.probe.waitForOwnedWork().then(value => { completed = true; return value; });
  await Promise.resolve(); assert.equal(completed, false);
  f.notify('turn/completed', { threadId: 'child', turn: { id: 'old-child', status: 'completed' } });
  assert.equal(await waiting, true);
  f.notify('turn/started', { threadId: 'child', turn: { id: 'more-work', rootTurnId: 'new-root', status: 'inProgress' } });
  const revised = f.probe.waitForOwnedWork();
  f.entry.input = { ...f.entry.input, requirementsRevision: 3 };
  f.probe.ownedWorkChanged?.();
  assert.equal(await revised, true);
  await f.drain();
});

test('legacy root controls follow successfully applied same-turn steering', async () => {
  const f = await fixture();
  f.entry.input.contract = { version: 1, criteria: ['Verify current data'] };
  assert.equal(f.probe.nativeRequestRevision({ threadId: 'root', turnId: 'new-root' }, true), 2);
  f.entry.appliedRevision = 1;
  assert.throws(() => f.probe.nativeRequestRevision({ threadId: 'root', turnId: 'new-root' }, true), /版本/);
  await f.drain();
});
