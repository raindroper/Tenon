import type { ServerResponse } from 'node:http';

export class ProjectStreamWriteTimeoutError extends Error {
  constructor() { super('项目模型接收端长时间未继续读取。'); this.name = 'ProjectStreamWriteTimeoutError'; }
}

/** Both relay hops pause upstream reads while their HTTP consumer is backpressured. */
export async function writeProjectStreamFrame(response: ServerResponse, frame: string, signal: AbortSignal,
  timeoutMs = 300_000): Promise<boolean> {
  signal.throwIfAborted();
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(frame) !== false) return true;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timeout);
      response.removeListener('drain', drained);
      response.removeListener('close', closed);
      response.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve();
    };
    const drained = () => finish();
    const closed = () => finish();
    const failed = (error: Error) => finish(error);
    const aborted = () => finish(signal.reason);
    const timeout = setTimeout(() => finish(new ProjectStreamWriteTimeoutError()), timeoutMs);
    timeout.unref();
    response.once('drain', drained);
    response.once('close', closed);
    response.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else if (response.destroyed || response.writableEnded) closed();
  });
  signal.throwIfAborted();
  return !response.destroyed;
}
