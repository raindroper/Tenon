import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { exchangeWithEwsWorker, EwsNativeOperationError, type EwsNativeRequest } from '../server/connectors/ews.js';

const request: EwsNativeRequest = { operation: 'baseline', credentials: {
  endpoint: 'https://mail.example.test/EWS/Exchange.asmx', username: 'fixture', password: 'offline-only-worker-secret',
} };
function fixture() {
  let killed = false; let input = '';
  const native = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { killed = true; return true; } });
  native.stdin.on('data', chunk => { input += chunk.toString(); });
  return { native: native as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough },
    input: () => input, killed: () => killed, close: (code = 0) => native.emit('close', code) };
}
test('EWS worker stdin is the only credential channel; fragmented Unicode and stderr remain separated', async () => {
  const child = fixture();
  const operation = exchangeWithEwsWorker(request, new AbortController().signal, () => child.native);
  assert.deepEqual(JSON.parse(child.input()), request);
  child.native.stderr.write('private diagnostics ' + request.credentials.password);
  for (const byte of Buffer.from(JSON.stringify({ ok: true, result: { displayName: '收件箱' } }))) child.native.stdout.write(Buffer.from([byte]));
  child.close(); assert.deepEqual(await operation, { displayName: '收件箱' });
  const failed = fixture(); const failing = exchangeWithEwsWorker(request, new AbortController().signal, () => failed.native);
  failed.native.stderr.write(request.credentials.password); failed.native.emit('error', new Error(request.credentials.password)); failed.close(1);
  await assert.rejects(failing, error => error instanceof Error && !error.message.includes(request.credentials.password));
});
test('native abort and response bounds wait for the actual worker close before settling', async () => {
  for (const oversized of [false, true]) {
    const child = fixture(); const controller = new AbortController(); let settled = false;
    const work = exchangeWithEwsWorker(request, controller.signal, () => child.native);
    const checked = assert.rejects(work).then(() => { settled = true; });
    if (oversized) child.native.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1)); else controller.abort();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(child.killed(), true); assert.equal(settled, false);
    child.close(); await checked;
  }
});

test('a full 5 MiB attachment fits the bounded worker output', async () => {
  const child = fixture(); const work = exchangeWithEwsWorker({ ...request, operation: 'read-attachment',
    attachment: { folderId: 'inbox', messageId: 'mail', revision: 'version', reference: 'fixture' } }, new AbortController().signal, () => child.native);
  const result = { base64: Buffer.alloc(5 * 1024 * 1024).toString('base64') };
  child.native.stdout.write(JSON.stringify({ ok: true, result })); child.close();
  assert.deepEqual(await work, result); assert.equal(child.killed(), false);
});

test('lost mutation reply is unknown, safe rejection preserves native dispatch facts', async () => {
  const mutation: EwsNativeRequest = { ...request, operation: 'submit-draft', submit: {
    operationId: 'operation', draftId: 'draft', revision: 'version', snapshotHash: 'a'.repeat(64),
  } };
  const lost = fixture(); const work = exchangeWithEwsWorker(mutation, new AbortController().signal, () => lost.native);
  lost.close(1);
  await assert.rejects(work, error => error instanceof EwsNativeOperationError && error.dispatched && error.outcomeUnknown);
  const known = fixture(); const denied = exchangeWithEwsWorker(mutation, new AbortController().signal, () => known.native);
  known.native.stdout.write(JSON.stringify({ ok: false, error: 'ews', ewsCode: 'ErrorAccessDenied', dispatched: true, outcomeUnknown: false, draftId: 'draft' }));
  known.close();
  await assert.rejects(denied, error => error instanceof EwsNativeOperationError && error.dispatched && !error.outcomeUnknown && error.draftId === 'draft');
  const preflight = fixture(); const unauthorized = exchangeWithEwsWorker(mutation, new AbortController().signal, () => preflight.native);
  preflight.native.stdout.write(JSON.stringify({ ok: false, error: 'authentication', dispatched: false, outcomeUnknown: false, draftId: null })); preflight.close();
  await assert.rejects(unauthorized, error => error instanceof EwsNativeOperationError && !error.dispatched && !error.outcomeUnknown && error.status === 401 && error.message.includes('登录'));
});
test('an admission revoked while launching the worker sends no credentials', async () => {
  const child = fixture(); const controller = new AbortController();
  const work = exchangeWithEwsWorker(request, controller.signal, () => { controller.abort(); return child.native; });
  const rejected = assert.rejects(work); assert.equal(child.input(), ''); assert.equal(child.killed(), true);
  child.close(); await rejected;
});
