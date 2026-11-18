import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { EWS_MAX_ATTACHMENT_BYTES, ewsAttachmentInput } from '../../shared/ews.js';
import type { RuntimeApi } from '../runtime.js';
import { HttpError, readRequestBytes } from '../http.js';

/** Called only after normal session and Origin checks in the single HTTP server. */
export async function routeMailFiles(api: RuntimeApi, request: IncomingMessage, response: ServerResponse, path: string, method: string,
  readJson: () => Promise<unknown>): Promise<boolean> {
  const route = path.match(/^\/api\/connectors\/ews\/([A-Za-z0-9_-]+)\/(mail-uploads|attachment)$/);
  if (!route || method !== 'POST') return false;
  const connectors = api.connectorSettings; if (!connectors) throw new HttpError(409, '邮箱连接不可用。');
  if (route[2] === 'attachment') {
    const input = ewsAttachmentInput.parse(await readJson());
    const file = await connectors.downloadEwsAttachment(route[1], input);
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.bytes.length,
      'content-disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    response.end(file.bytes); return true;
  }
  const type = request.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type) || type.length > 300) { request.resume(); throw new HttpError(415, '附件上传需要 multipart/form-data。'); }
  const bytes = await readRequestBytes(request);
  let form: FormData;
  try { form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(bytes) }).formData(); }
  catch { throw new HttpError(400, '附件表单无效。'); }
  const values = [...form.entries()];
  if (values.length !== 1 || values[0][0] !== 'file' || !(values[0][1] instanceof File)) throw new HttpError(400, '每次请选择一个附件。');
  const file = values[0][1];
  if (file.size > EWS_MAX_ATTACHMENT_BYTES) throw new HttpError(413, '附件超过 5 MiB。');
  const uploaded = await connectors.uploadEwsMailAttachment(route[1], { name: z.string().min(1).max(200).parse(file.name),
    contentType: file.type || 'application/octet-stream', bytes: Buffer.from(await file.arrayBuffer()) });
  response.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(uploaded)); return true;
}
