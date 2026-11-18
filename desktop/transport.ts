import { deviceCommandSpecSchema, type DeviceServerMessage } from '../shared/local-device.js';
import { secureBaseUrl } from './security.js';
import { projectServerMessageSchema } from '../shared/local-project.js';

export class DeviceHttpError extends Error {
  constructor(readonly status: number, message?: string) { super(message ?? '设备服务请求失败（' + status + '）。'); }
}

async function ownServiceError(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) {
    await response.body?.cancel().catch(() => {}); return;
  }
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (size <= 8192) {
      const value = await reader.read();
      if (value.done) {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { error?: unknown };
        return typeof body.error === 'string' && body.error.length <= 2000 ? body.error : undefined;
      }
      size += value.value.byteLength; parts.push(value.value);
    }
  } catch { /* Proxy HTML, broken bodies and other formats are not exposed as application messages. */ }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function deviceFetch(base: string, route: string, credential: string | undefined, init: RequestInit = {}): Promise<Response> {
  if (!/^\/api\/device\/[a-z]+$/.test(route)) throw new Error('无效设备接口。');
  const headers = new Headers(init.headers);
  if (credential) headers.set('Authorization', `Bearer ${credential}`);
  const response = await fetch(secureBaseUrl(base) + route, { ...init, headers, redirect: 'error' });
  if (!response.ok) {
    const detail = await ownServiceError(response);
    const stage = route === '/api/device/projectguard' ? '任务许可核对服务'
      : route === '/api/device/projectmodel' ? '项目模型转发服务'
      : route === '/api/device/projectcontext' ? '项目资料服务' : '设备服务';
    throw new DeviceHttpError(response.status, detail ?? stage + '暂未连通（HTTP ' + response.status + '）。');
  }
  return response;
}
export function parseOperation(data: string): DeviceServerMessage {
  if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new Error('设备消息超过大小限制。');
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设备消息格式无效。');
  const message = value as Record<string, unknown>;
  if (typeof message.kind === 'string' && message.kind.startsWith('project-')) return projectServerMessageSchema.parse(message);
  if (Buffer.byteLength(data) > 128 * 1024) throw new Error('设备消息超过大小限制。');
  if (typeof message.operationId !== 'string' || !message.operationId || message.operationId.length > 200) throw new Error('无效操作编号。');
  if (message.kind === 'cancel') {
    if (typeof message.reason !== 'string' || message.reason.length > 4000 || Object.keys(message).some(key => !['kind','operationId','reason'].includes(key))) throw new Error('取消消息格式无效。');
    return message as unknown as DeviceServerMessage;
  }
  if (message.kind !== 'execute' || typeof message.taskId !== 'string' || typeof message.runId !== 'string' ||
    typeof message.specHash !== 'string' || !/^[a-f0-9]{64}$/.test(message.specHash) || typeof message.issuedAt !== 'string' ||
    !Number.isSafeInteger(message.taskRevision) || !Number.isSafeInteger(message.deadline) ||
    Object.keys(message).some(key => !['kind','operationId','taskId','taskRevision','runId','specHash','spec','issuedAt','deadline'].includes(key))) throw new Error('执行消息格式无效。');
  return { ...message, spec: deviceCommandSpecSchema.parse(message.spec) } as unknown as DeviceServerMessage;
}
export async function consumeEvents(response: Response, accept: (message: DeviceServerMessage) => void, signal: AbortSignal): Promise<void> {
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('设备事件通道格式错误。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (!signal.aborted) {
      const item = await reader.read();
      if (item.done) break;
      buffer += decoder.decode(item.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n'); // CR/LF may straddle network chunks.
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new Error('设备事件帧超过限制。');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const lines = frame.split('\n');
        if (lines.some(line => line === 'event: operation' || line === 'event:operation')) {
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          accept(parseOperation(data));
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
