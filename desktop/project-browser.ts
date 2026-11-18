import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';

export const projectPreviewTools = ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot',
  'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_emulate_media', 'browser_evaluate',
  'browser_fill_form', 'browser_find', 'browser_handle_dialog', 'browser_hover', 'browser_network_requests',
  'browser_press_key', 'browser_resize', 'browser_select_option', 'browser_tabs', 'browser_type', 'browser_wait_for'];

export function projectPreviewUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && !url.username && !url.password
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url;
  } catch { /* Invalid input is outside the preview capability. */ }
}

const execute = promisify(execFile);
const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
interface Endpoint { ip: string; port: number }
interface TcpEntry { local: Endpoint; remote: Endpoint; pid: number }

const normalizedIp = (value: string) => value.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');

async function tcpSnapshot(): Promise<TcpEntry[]> {
  const { stdout } = await execute(path.win32.join(windows, 'System32/netstat.exe'), ['-ano'],
    { windowsHide: true, timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  const endpoint = (value: string) => {
    const separator = value.lastIndexOf(':');
    return { ip: normalizedIp(value.slice(0, separator)), port: Number(value.slice(separator + 1)) };
  };
  return stdout.split(/\r?\n/).flatMap(line => {
    const [protocol, address, peer, , pid] = line.trim().split(/\s+/);
    return protocol === 'TCP' && /^\d+$/.test(pid ?? '') ? [{ local: endpoint(address), remote: endpoint(peer), pid: Number(pid) }] : [];
  });
}

async function processParents(): Promise<Map<number, { parent: number; started: number }>> {
  const executable = path.win32.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { "{0} {1} {2}" -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.Ticks }'],
  { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 });
  return new Map(stdout.trim().split(/\r?\n/).flatMap(line => {
    const [id, parent, started] = line.trim().split(/\s+/).map(Number);
    return id > 0 && started > 0 ? [[id, { parent, started }]] : [];
  }));
}

function belongsTo(pid: number, root: number, parents: Awaited<ReturnType<typeof processParents>>): boolean {
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) {
    if (pid === root) return true;
    seen.add(pid);
    const item = parents.get(pid);
    const parent = item && parents.get(item.parent);
    if (!item || !parent || parent.started > item.started) return false;
    pid = item.parent;
  }
  return false;
}

function possibleAddresses(host: string): Array<{ address: string; listeners: string[] }> {
  const v4 = { address: '127.0.0.1', listeners: ['127.0.0.1', '0.0.0.0'] };
  const v6 = { address: '::1', listeners: ['::1', '::'] };
  if (host === 'localhost') return [v4, v6];
  return host === '[::1]' ? [v6] : [v4];
}

/** Browser HTTP and WebSocket traffic can reach only listeners owned by this app-server process tree. */
export class ProjectBrowser {
  private readonly sockets = new Set<Duplex>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly server = createServer((incoming, outgoing) => this.track(this.forward(incoming, outgoing)));
  private socketQuery?: ReturnType<typeof tcpSnapshot>;
  private parentsQuery?: ReturnType<typeof processParents>;
  private stopped = false;

  constructor(private readonly processId: () => number | undefined) {
    this.server.on('connection', socket => this.trackSocket(socket));
    this.server.on('connect', (incoming, socket, head) => this.track(this.tunnel(incoming, socket, head)));
  }

  private track(operation: Promise<unknown>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
  }

  private trackSocket(socket: Duplex): void {
    if (this.stopped) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    return 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
  }

  private async target(value: string | undefined) {
    const url = projectPreviewUrl(value);
    const root = this.processId();
    if (!url || !root || this.stopped) return;
    const port = Number(url.port || 80);
    this.socketQuery ??= tcpSnapshot().finally(() => { this.socketQuery = undefined; });
    const sockets = await this.socketQuery;
    for (const endpoint of possibleAddresses(url.hostname)) {
      const owners = sockets.filter(listener => listener.remote.port === 0 && listener.local.port === port && endpoint.listeners.includes(listener.local.ip));
      if (owners.length !== 1) continue;
      const [{ pid }] = owners;
      this.parentsQuery ??= processParents().finally(() => { this.parentsQuery = undefined; });
      if (!belongsTo(pid, root, await this.parentsQuery)) continue;
      if (!this.stopped && this.processId() === root) return { hostname: endpoint.address, port, path: url.pathname + url.search, host: url.host, pid, root };
    }
  }

  async owns(url: string): Promise<boolean> {
    try { return Boolean(await this.target(url)); } catch { return false; }
  }

  private async peer(target: NonNullable<Awaited<ReturnType<ProjectBrowser['target']>>>) {
    const socket = connect({ host: target.hostname, port: target.port });
    socket.on('error', () => { /* HTTP attaches its own handler after the ownership check. */ });
    this.trackSocket(socket);
    socket.setTimeout(3000, () => socket.destroy(new Error('项目预览端口未及时连接。')));
    try {
      await once(socket, 'connect');
      const entries = await tcpSnapshot();
      if (socket.destroyed || this.stopped || this.processId() !== target.root || !entries.some(entry => entry.pid === target.pid
        && entry.local.port === target.port && entry.local.ip === target.hostname
        && entry.remote.port === socket.localPort && entry.remote.ip === normalizedIp(socket.localAddress ?? ''))) {
        throw new Error('已连接的预览进程与本任务不匹配。');
      }
      socket.setTimeout(0);
      return socket;
    } catch (error) { socket.destroy(); throw error; }
  }

  private async forward(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    try {
      const target = await this.target(incoming.url);
      if (!target || outgoing.destroyed || this.stopped) { outgoing.writeHead(403).end('只可访问本任务启动的本机预览。'); return; }
      const peer = await this.peer(target);
      if (outgoing.destroyed || this.stopped) { peer.destroy(); return; }
      const { 'proxy-authorization': _credential, 'proxy-connection': _proxy, ...headers } = incoming.headers;
      const upstream = request({ ...target, createConnection: () => peer, method: incoming.method, headers: { ...headers, host: target.host } }, response => {
        const redirect = response.headers.location;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && redirect
          && URL.parse(redirect, 'http://' + target.host)?.origin !== 'http://' + target.host) {
          response.resume(); outgoing.writeHead(403).end('已拒绝跳转到预览范围之外。'); return;
        }
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      outgoing.once('close', () => upstream.destroy());
      incoming.pipe(upstream);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(403); outgoing.end(); }
  }

  private async tunnel(incoming: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      // Chromium tunnels even plain WebSocket handshakes through an HTTP proxy.
      const authority = incoming.url ?? '';
      const target = /^(localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/i.test(authority)
        ? await this.target('http://' + authority) : undefined;
      if (!target || socket.destroyed || this.stopped) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      const peer = await this.peer(target);
      if (socket.destroyed || this.stopped) { peer.destroy(); return; }
      socket.once('close', () => peer.destroy());
      peer.once('close', () => socket.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    } catch { socket.destroy(); }
  }

  fence(): void { this.stopped = true; }

  async close(): Promise<void> {
    this.fence();
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled(this.pending);
  }
}
