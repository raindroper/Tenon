import type { ServerResponse } from 'node:http';
import type { RuntimeMessage } from '../shared/runtime-view.js';
import type { Store } from './store.js';

async function write(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed) throw new Error('导出连接已关闭。');
  if (response.write(chunk)) return;
  await new Promise<void>((done, fail) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
    const drained = () => { cleanup(); done(); };
    const closed = () => { cleanup(); fail(new Error('导出连接已关闭。')); };
    const failed = (error: Error) => { cleanup(); fail(error); };
    response.once('drain', drained); response.once('close', closed); response.once('error', failed);
  });
}

/** Export one attachment at a time, respecting backpressure on the small host. */
export async function writeRuntimeExport(response: ServerResponse, data: Record<string, unknown>, messages: RuntimeMessage[], store: Store,
  readProjectImage?: (id: string) => { data: Buffer } | undefined): Promise<void> {
  const encode = (value: unknown) => store.models.redact(JSON.stringify(value), true);
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  await write(response, '{');
  for (const [key, value] of Object.entries(data)) await write(response, `${encode(key)}:${encode(value)},`);
  await write(response, '"imageFiles":[');
  let first = true;
  for (const message of messages) for (const attachment of message.attachments ?? []) {
    if (response.destroyed) throw new Error('导出连接已关闭。');
    const image = store.readImage(attachment.id) ?? readProjectImage?.(attachment.id);
    await write(response, (first ? '' : ',') + encode({ ...attachment, messageId: message.id, caseId: message.caseId, data: image?.data.toString('base64') ?? null }));
    first = false;
  }
  await write(response, '],"chatFiles":[');
  first = true;
  for (const message of messages) for (const attachment of message.files ?? []) {
    if (response.destroyed) throw new Error('导出连接已关闭。');
    const file = store.readChatFile(attachment.id, message.id);
    const metadata = encode({ ...attachment, messageId: message.id, caseId: message.caseId });
    // Redact structured metadata while preserving the original file's exact bytes.
    const data = JSON.stringify(file?.data.toString('base64') ?? null);
    await write(response, (first ? '' : ',') + metadata.slice(0, -1) + ',"data":' + data + '}');
    first = false;
  }
  response.end(']}');
}
