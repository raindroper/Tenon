import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allowPagePermission, captureGrant, commandLine, localPath, quoteWindowsArg, secureBaseUrl, specHash, validateExecution, within } from '../desktop/security.js';
import { OperationJournal } from '../desktop/journal.js';
import { parseOperation, consumeEvents } from '../desktop/transport.js';
import type { DeviceExecuteMessage } from '../shared/local-device.js';

test('shared page copy grants only sanitized text writes to its own top-level origin', () => {
  assert.equal(allowPagePermission('clipboard-sanitized-write', 'https://rae.example.com', 'https://rae.example.com/settings', true), true);
  for (const permission of ['clipboard-read', 'media', 'geolocation', 'display-capture', 'fileSystem'])
    assert.equal(allowPagePermission(permission, 'https://rae.example.com', 'https://rae.example.com', true), false);
  assert.equal(allowPagePermission('clipboard-sanitized-write', 'https://rae.example.com', 'https://hostile.example', true), false);
  assert.equal(allowPagePermission('clipboard-sanitized-write', 'https://rae.example.com', 'https://rae.example.com', false), false);
});

test('desktop command uses direct Windows argv quoting and HTTPS origin only', () => {
  assert.equal(quoteWindowsArg('a"b\\'), '"a\\"b\\\\"');
  assert.equal(commandLine('C:\\Program Files\\tool.exe', ['x & y', '', '%PATH%']), '"C:\\Program Files\\tool.exe" "x & y" "" %PATH%');
  assert.throws(() => commandLine('C:\\tool.cmd', [])); assert.throws(() => localPath('C:\\file.txt:secret'));
  assert.throws(() => localPath('\\\\server\\share')); assert.throws(() => quoteWindowsArg('hello\nworld'));
  assert.equal(within('C:\\work', 'C:\\work\\sub'), true); assert.equal(within('C:\\work', 'C:\\workspace'), false);
  assert.equal(secureBaseUrl('https://rae.example.com/'), 'https://rae.example.com');
  for (const value of ['http://localhost', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?token=foo']) assert.throws(() => secureBaseUrl(value));
});
test('desktop rechecks executable identity, grant revision, deadline and junction target', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rae-desktop-'));
  try {
    const work = path.join(dir, 'work'); const outside = path.join(dir, 'outside'); const executable = path.join(dir, 'tool.exe');
    await mkdir(work); await mkdir(outside); await writeFile(executable, 'fixture executable');
    const grant = await captureGrant({ id: 'grant', revision: 2, root: work, executable, readOnly: true });
    const spec = { deviceId: 'device', grantId: 'grant', grantRevision: 2, executable: grant.executable, args: ['a'], cwd: grant.root, timeoutMs: 1000 };
    const message: DeviceExecuteMessage = { kind: 'execute', operationId: 'op', taskId: 'task', taskRevision: 1, runId: 'run', spec, specHash: specHash(spec), issuedAt: new Date().toISOString(), deadline: Date.now() + 10000 };
    await validateExecution(message, 'device', grant);
    await assert.rejects(validateExecution({ ...message, deadline: Date.now() - 1 }, 'device', grant));
    await assert.rejects(validateExecution({ ...message, specHash: '0'.repeat(64) }, 'device', grant));
    await assert.rejects(validateExecution(message, 'device', { ...grant, revision: 3 }));
    const link = path.join(work, 'linked'); await symlink(outside, link, 'junction');
    const escaped = { ...spec, cwd: link }; await assert.rejects(validateExecution({ ...message, spec: escaped, specHash: specHash(escaped) }, 'device', grant));
    await writeFile(executable, 'replaced executable'); await assert.rejects(validateExecution(message, 'device', grant));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('desktop journal turns interrupted calls unknown and never loses terminal receipts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rae-journal-'));
  try {
    const journal = new OperationJournal(dir);
    const message = { operationId: '../host-path', specHash: 'hash' } as DeviceExecuteMessage;
    await journal.save({ message, receipt: { operationId: message.operationId, state: 'running' } });
    assert.equal((await journal.recover())[0].receipt.state, 'unknown');
    await journal.save({ message, receipt: { operationId: message.operationId, state: 'completed', stdout: 'saved' } });
    assert.equal((await journal.recover())[0].receipt.stdout, 'saved');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('desktop event framing is bounded and parses only the shared command contract', async () => {
  const data = { kind: 'cancel', operationId: 'op', reason: 'owner' };
  assert.deepEqual(parseOperation(JSON.stringify(data)), data);
  assert.throws(() => parseOperation(JSON.stringify({ ...data, command: 'malicious' })));
  assert.throws(() => parseOperation(' '.repeat(128 * 1024 + 1)));
  const messages: unknown[] = [];
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(': heartbeat\n\nevent: operation\ndata: ' + JSON.stringify(data) + '\n\n')); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await consumeEvents(response, message => messages.push(message), new AbortController().signal);
  assert.deepEqual(messages, [data]);
  const splitMessages: unknown[] = [];
  const split = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('event: operation\r')); controller.enqueue(encoder.encode('\ndata: ' + JSON.stringify(data) + '\r')); controller.enqueue(encoder.encode('\n\r')); controller.enqueue(encoder.encode('\n')); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await consumeEvents(split, message => splitMessages.push(message), new AbortController().signal);
  assert.deepEqual(splitMessages, [data]);
});
