import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Auth is enforced by the application before streaming its own generated file. */
export async function serveMedia(request: IncomingMessage, response: ServerResponse, file: { path: string; mediaType: string; size: number; name: string }): Promise<void> {
  let start = 0; let end = file.size - 1; let partial = false;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (match && (match[1] || match[2])) {
      partial = true;
      if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), file.size - 1); }
    }
    if (!partial || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size || !match?.[1] && Number(match?.[2]) <= 0) {
      response.writeHead(416, { 'content-range': `bytes */${file.size}`, 'cache-control': 'no-store' }); response.end(); return;
    }
  }
  const download = new URL(request.url ?? '/', 'http://localhost').searchParams.get('download') === '1';
  response.writeHead(partial ? 206 : 200, { 'content-type': file.mediaType, 'content-length': end - start + 1,
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}), 'accept-ranges': 'bytes',
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, '-') }"` });
  if (request.method === 'HEAD') { response.end(); return; }
  await pipeline(createReadStream(file.path, { start, end }), response);
}
