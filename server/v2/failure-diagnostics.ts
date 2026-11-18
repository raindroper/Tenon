import { APICallError } from '@ai-sdk/provider';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FailureDiagnostic } from '../../shared/types.js';

export type { FailureDiagnostic } from '../../shared/types.js';

export function modelConnectionFailureMessage(diagnostic: FailureDiagnostic): string | undefined {
  if (diagnostic.category === 'transport') {
    if (diagnostic.code === 'UND_ERR_CONNECT_TIMEOUT') return '连接模型服务超时，本轮未收到回复；原消息保留。';
    if (diagnostic.code === 'ETIMEDOUT' || diagnostic.code?.includes('TIMEOUT')) return '与模型服务通信超时，原消息和已收到的内容保留。';
    return '与模型服务的连接中断，原消息和已收到的内容保留。';
  }
  if (diagnostic.category === 'model_api' && diagnostic.httpStatus) {
    return '模型接口返回 HTTP ' + diagnostic.httpStatus + '，原消息和已收到的内容保留。';
  }
}

const serverRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const names = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'AbortError',
  'TimeoutError', 'SourceContextError', 'MastraError', 'AI_APICallError', 'APICallError', 'AI_RetryError',
  'AI_NoOutputGeneratedError', 'AI_NoContentGeneratedError', 'AI_InvalidResponseDataError', 'AI_JSONParseError']);
const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK', 'ERR_SOCKET_CLOSED', 'ABORT_ERR', 'ERR_ABORTED', 'ERR_CANCELED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function property(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}

function errorName(value: object): string {
  const name = property(value, 'name');
  return typeof name === 'string' && names.has(name) ? name : 'Error';
}

function apiError(value: object): value is APICallError {
  try { return APICallError.isInstance(value); } catch { return false; }
}

function location(value: object): FailureDiagnostic['location'] {
  const stack = property(value, 'stack');
  if (typeof stack !== 'string') return;
  // The first line is an arbitrary error message, even when it resembles a stack frame.
  for (const line of stack.slice(0, 32_768).split('\n').slice(1, 65)) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    const opening = frame.lastIndexOf('(');
    const target = opening >= 0 && frame.endsWith(')') ? frame.slice(opening + 1, -1) : frame.slice(3).replace(/^async /, '');
    const match = /^(.+\.ts):([1-9]\d{0,6})(?::\d+)?$/.exec(target);
    if (!match) continue;
    try {
      const path = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
      if (!isAbsolute(path)) continue;
      const file = relative(serverRoot, path).replaceAll('\\', '/');
      if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(file) || file.split('/').includes('..')) continue;
      const resolved = resolve(serverRoot, file);
      // Only real, packaged source files are printable. Injected filenames in SDK stacks are not diagnostics.
      const stat = lstatSync(resolved);
      if (!stat.isFile() || stat.isSymbolicLink() || relative(serverRoot, realpathSync(resolved)).replaceAll('\\', '/') !== file) continue;
      return { file: `server/${file}`, line: Number(match[2]) };
    } catch { /* External paths, missing files and malformed file URLs are omitted. */ }
  }
}

/** A bounded structural summary; no message, request URL, headers, body, prompt or arbitrary code is retained. */
export function summarizeFailure(error: unknown): FailureDiagnostic {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  let source: object | undefined;
  let http: { value: object; status: number } | undefined;
  let transport: { value: object; code: string } | undefined;
  let api: object | undefined;
  let first: object | undefined;
  let firstLocation: FailureDiagnostic['location'];
  for (let index = 0; index < queue.length && index < 64; index++) {
    const { value, depth } = queue[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); first ??= value;
    firstLocation ??= location(value);
    const code = property(value, 'code');
    if (value instanceof Error && property(value, 'name') === 'SourceContextError' && code === 'SOURCE_CONTEXT_UNAVAILABLE') source ??= value;
    if (apiError(value)) {
      api ??= value;
      const status = property(value, 'statusCode');
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) http ??= { value, status };
    }
    if (value instanceof Error) {
      if (typeof code === 'string' && transportCodes.has(code)) transport ??= { value, code };
      else if (property(value, 'name') === 'TimeoutError') transport ??= { value, code: 'TIMEOUT' };
      else if (property(value, 'name') === 'AbortError') transport ??= { value, code: 'ABORT_ERR' };
    }
    if (depth >= 12) continue;
    const cause = property(value, 'cause');
    if (cause && typeof cause === 'object') queue.push({ value: cause, depth: depth + 1 });
    const errors = Array.isArray(value) ? value : property(value, 'errors');
    if (Array.isArray(errors)) for (const child of errors.slice(0, 64)) queue.push({ value: child, depth: depth + 1 });
  }
  const selected = source ?? http?.value ?? transport?.value ?? api ?? first;
  const selectedLocation = selected ? location(selected) ?? firstLocation : firstLocation;
  const diagnostic: FailureDiagnostic = source
    ? { category: 'source_unavailable', errorName: 'SourceContextError', code: 'SOURCE_CONTEXT_UNAVAILABLE' }
    : http ? { category: 'model_api', errorName: errorName(http.value), code: 'MODEL_API_HTTP_ERROR', httpStatus: http.status }
    : transport ? { category: 'transport', errorName: errorName(transport.value), code: transport.code }
    : api ? { category: 'transport', errorName: errorName(api), code: 'MODEL_API_TRANSPORT_ERROR' }
    : { category: 'unknown', errorName: selected ? errorName(selected) : 'Error', code: 'UNCLASSIFIED_ERROR' };
  return { ...diagnostic, ...(selectedLocation ? { location: selectedLocation } : {}) };
}
