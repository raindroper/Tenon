import { isAbsolute } from 'node:path';
import { Agent, Headers as UndiciHeaders, fetch } from 'undici';
import { DeviceHttpError, type deviceFetch } from '../desktop/transport.js';

export function createWorkerDeviceFetch(socket: string): typeof deviceFetch {
  if (!isAbsolute(socket)) throw new Error('服务端设备接口需要绝对 Unix 套接字路径。');
  const dispatcher = new Agent({ connect: { socketPath: socket } });
  return async (base, route, credential, init = {}) => {
    if (base !== 'http://127.0.0.1' || !/^\/api\/device\/[a-z]+$/.test(route)) throw new Error('无效服务端设备接口。');
    const headers = new UndiciHeaders([...new Headers(init.headers).entries()]);
    if (credential) headers.set('Authorization', `Bearer ${credential}`);
    if (init.body != null && typeof init.body !== 'string') throw new Error('服务端设备接口仅发送 JSON 正文。');
    // The URL supplies the allowed Host header. The dispatcher dials the private Unix socket.
    const response = await fetch('http://127.0.0.1:4317' + route, { method: init.method, body: init.body, signal: init.signal,
      headers, redirect: 'error', dispatcher });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DeviceHttpError(response.status);
    }
    return response as unknown as Response;
  };
}
