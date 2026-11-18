import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { HttpError, readJsonBody, readRequestBytes } from '../server/http.js';

function request(contentType = 'application/json'): IncomingMessage {
  const value = new IncomingMessage(new Socket());
  value.headers['content-type'] = contentType;
  return value;
}
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected;

test('shared body reader handles fragmented UTF-8 and releases listeners', async () => {
  const input = request('Application/JSON; charset=utf-8');
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  const bytes = Buffer.from('{"text":"中文"}');
  const body = readJsonBody(input);
  for (const byte of bytes) input.push(Buffer.from([byte]));
  input.push(null);
  assert.deepEqual(await body, { text: '中文' });
  input.destroy();
  await closed;
  for (const event of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(input.listenerCount(event), 0);
});

test('shared body reader accepts JSON beyond the former transport limit', async () => {
  const input = request();
  const body = readJsonBody(input);
  input.push(Buffer.from(JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024 + 1) })));
  input.push(null);
  assert.equal((await body as { text: string }).text.length, 2 * 1024 * 1024 + 1);
  input.destroy();
});

test('shared body reader rejects a disconnected partial upload and observes its later error', async () => {
  const input = request();
  const failed = assert.rejects(readRequestBytes(input), status(400));
  input.push(Buffer.from('partial'));
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  input.destroy(new Error('fixture disconnect'));
  await failed;
  await closed;
  for (const event of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(input.listenerCount(event), 0);
});

test('shared body reader rejects already closed requests without waiting for missed events', async () => {
  const input = request();
  const closed = new Promise<void>(resolve => input.once('close', resolve));
  input.destroy();
  await closed;
  await assert.rejects(readRequestBytes(input), status(400));
});

test('body assembly failures reject the request without escaping the stream callback', async t => {
  const input = request();
  const failure = new RangeError('fixture allocation failure');
  t.mock.method(Buffer, 'concat', () => { throw failure; });
  const failed = assert.rejects(readRequestBytes(input), error => error === failure);
  input.push(Buffer.from('body'));
  input.push(null);
  await failed;
  input.destroy();
});

test('shared JSON boundary rejects unsupported content types and malformed JSON', async () => {
  const wrongType = request('text/plain');
  await assert.rejects(readJsonBody(wrongType), status(415));
  wrongType.destroy();
  const invalid = request();
  const failed = assert.rejects(readJsonBody(invalid), status(400));
  invalid.push(Buffer.from('{'));
  invalid.push(null);
  await failed;
  invalid.destroy();
});
