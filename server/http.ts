import type { IncomingMessage } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Shared request lifecycle for owner JSON, device JSON and multipart uploads. */
export function readRequestBytes(request: IncomingMessage, maxBytes = Infinity): Promise<Buffer> {
  if (request.destroyed || request.readableEnded) return Promise.reject(new HttpError(400, '请求已结束或中断。'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: HttpError) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    const data = (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(new HttpError(413, '请求正文超过此接口的容量限制。')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      if (settled) return;
      settled = true;
      try { resolve(Buffer.concat(chunks, bytes)); }
      catch (error) { reject(error); }
      finally { chunks.length = 0; }
    };
    const interrupted = () => fail(new HttpError(400, '请求读取中断。'));
    const close = () => {
      interrupted();
      request.off('data', data); request.off('end', end);
      request.off('error', interrupted); request.off('aborted', interrupted); request.off('close', close);
    };
    // Keep the error listener until close: aborted may be followed by an error.
    request.on('data', data); request.once('end', end);
    request.on('error', interrupted); request.once('aborted', interrupted); request.once('close', close);
  });
}

export async function readJsonBody(request: IncomingMessage, maxBytes = Infinity): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new HttpError(415, '请求需要 application/json。');
  }
  const bytes = await readRequestBytes(request, maxBytes);
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'JSON 格式无效。'); }
}
