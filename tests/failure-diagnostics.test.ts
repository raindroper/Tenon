import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APICallError } from '@ai-sdk/provider';
import { summarizeFailure, modelConnectionFailureMessage } from '../server/v2/failure-diagnostics.js';
import { SourceContextError } from '../server/v2/source-context.js';

const privateText = 'PRIVATE_TOKEN_PROMPT_PROVIDER_BODY';
test('model transport failures have useful public explanations without raw provider content', () => {
  assert.match(modelConnectionFailureMessage({ category: 'transport', code: 'UND_ERR_CONNECT_TIMEOUT' })!, /连接模型服务超时/);
  assert.match(modelConnectionFailureMessage({ category: 'transport', code: 'ETIMEDOUT' })!, /与模型服务通信超时/);
  assert.match(modelConnectionFailureMessage({ category: 'model_api', httpStatus: 429 })!, /HTTP 429/);
  assert.equal(modelConnectionFailureMessage({ category: 'unknown' }), undefined);
});
const sourceFile = fileURLToPath(new URL('../server/v2/source-context.ts', import.meta.url));
const memoryFile = fileURLToPath(new URL('../server/v2/memory.ts', import.meta.url));

function apiError(statusCode?: number, cause?: unknown) {
  const error = new APICallError({ message: privateText, url: `https://private.example/${privateText}`,
    requestBodyValues: { prompt: privateText, token: privateText }, responseHeaders: { authorization: privateText },
    responseBody: privateText, data: { code: privateText }, statusCode, cause });
  error.stack = `AI_APICallError: ${privateText}\n    at ${privateText} (https://private.example/${privateText}:12:1)`;
  return error;
}

test('nested SDK API errors retain only safe HTTP metadata through causes and aggregate errors', () => {
  const error = new Error(privateText, { cause: new AggregateError([new Error(privateText),
    new Error(privateText, { cause: apiError(429) })], privateText) });
  const result = summarizeFailure(error);
  assert.equal(result.category, 'model_api'); assert.equal(result.httpStatus, 429);
  assert.equal(result.code, 'MODEL_API_HTTP_ERROR'); assert.equal(result.errorName, 'AI_APICallError');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText));
  assert.doesNotMatch(JSON.stringify(result), /https:|responseBody|requestBodyValues|authorization|message|stack/);
});

test('the exact local source-context code distinguishes a local guard failure from provider failures', () => {
  const local = new SourceContextError();
  local.stack = `SourceContextError: ${privateText}\n    at ${privateText} (${sourceFile}:177:65)\n    at wrapper (${memoryFile}:510:2)`;
  const result = summarizeFailure(new AggregateError([apiError(422), new Error(privateText, { cause: local })], privateText));
  assert.deepEqual(result, { category: 'source_unavailable', errorName: 'SourceContextError', code: 'SOURCE_CONTEXT_UNAVAILABLE',
    location: { file: 'server/v2/source-context.ts', line: 177 } });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText));
  assert.doesNotMatch(JSON.stringify(result), /AnotherRae|https:|[A-Z]:\\/);
});

test('transport diagnostics use exact native codes, while arbitrary SDK names and codes are omitted', () => {
  const network = Object.assign(new Error(privateText), { code: 'ECONNRESET' });
  const result = summarizeFailure(apiError(undefined, network));
  assert.equal(result.category, 'transport'); assert.equal(result.code, 'ECONNRESET'); assert.equal(result.errorName, 'Error');
  assert.equal(result.httpStatus, undefined);
  const unknown = Object.assign(new Error(privateText), { name: privateText, code: `ECONNRESET_${privateText}` });
  assert.deepEqual(summarizeFailure(unknown), { category: 'unknown', errorName: 'Error', code: 'UNCLASSIFIED_ERROR' });
  const timeout = Object.assign(new Error(privateText), { name: 'TimeoutError' });
  assert.equal(summarizeFailure(timeout).code, 'TIMEOUT');
});

test('stack locations skip messages and external or fabricated files and never expose full paths or frame names', () => {
  const error = new Error(privateText);
  error.stack = `at ${privateText} (${sourceFile}:999:1)\n    at ${privateText} (file:///private/server/v2/source-context.ts:2:1)`
    + `\n    at malicious (${pathToFileURL(sourceFile).href.replace('source-context.ts', `${privateText}.ts`)}:3:1)`
    + `\n    at ${privateText} (${pathToFileURL(memoryFile).href}:510:9)\n    at later (${sourceFile}:177:1)`;
  const result = summarizeFailure(error);
  assert.deepEqual(result.location, { file: 'server/v2/memory.ts', line: 510 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateText));
  assert.doesNotMatch(JSON.stringify(result), /file:|AnotherRae|private\/server/);
});

test('messages, model-provided labels and response objects cannot claim a source-context failure', () => {
  const messageOnly = new Error(`SourceContextError SOURCE_CONTEXT_UNAVAILABLE source unavailable ${privateText}`);
  assert.equal(summarizeFailure(messageOnly).category, 'unknown');
  const body = { name: 'SourceContextError', code: 'SOURCE_CONTEXT_UNAVAILABLE', message: privateText };
  assert.equal(summarizeFailure({ responseBody: body, data: body, risk: 'high' }).category, 'unknown');
  assert.equal(summarizeFailure({ cause: body }).category, 'unknown');
  assert.doesNotMatch(JSON.stringify(summarizeFailure({ cause: privateText, errors: [privateText] })), new RegExp(privateText));
});

test('cyclic causes, excessive nesting and throwing metadata accessors remain bounded and private', () => {
  const cyclic = new Error(privateText, { cause: undefined });
  cyclic.cause = cyclic;
  Object.defineProperty(cyclic, 'errors', { get() { throw new Error(privateText); } });
  Object.defineProperty(cyclic, 'stack', { get() { throw new Error(privateText); } });
  assert.equal(summarizeFailure(cyclic).category, 'unknown');
  let deep: unknown = apiError(500);
  for (let index = 0; index < 80; index++) deep = { cause: deep, message: privateText };
  assert.equal(summarizeFailure(deep).category, 'unknown');
  assert.doesNotMatch(JSON.stringify(summarizeFailure(cyclic)), new RegExp(privateText));
});
