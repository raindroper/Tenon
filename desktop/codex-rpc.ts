import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface CodexMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface CodexRpcOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification(message: CodexMessage): void | Promise<void>;
  onRequest(message: CodexMessage): Promise<unknown>;
  onFailure(error: Error): void;
  onStderr?(chunk: Buffer): void;
  requestTimeoutMs?: number;
}

export class CodexDrainTimeoutError extends Error {
  constructor() { super('内置 Codex 尚未确认退出并排空，原操作状态保留。'); }
}

/** The public app-server JSON-RPC transport. The upstream process owns the agent loop. */
export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<string | number, Pending>();
  private readonly callbacks = new Set<Promise<void>>();
  private readonly notifications = new Set<(message: CodexMessage) => void>();
  private readonly closed: Promise<number | null>;
  private sequence = 0;
  private closing = false;
  private exitCode: number | null | undefined;
  private protocolFailed = false;
  private drained?: Promise<void>;

  constructor(private readonly options: CodexRpcOptions) {
    this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (options.onStderr) this.child.stderr.on('data', options.onStderr);
    else this.child.stderr.resume();
    this.closed = new Promise(resolve => {
      this.child.once('exit', code => { this.exitCode = code; });
      this.child.once('close', code => {
        this.exitCode = code;
        const failure = new Error('本地 Codex 进程已经结束。');
        for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(failure); }
        this.pending.clear();
        resolve(code);
        if (!this.closing) this.options.onFailure(failure);
      });
      this.child.once('error', error => {
        for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
        this.pending.clear();
        this.options.onFailure(error);
      });
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.receive(line));
    this.child.stdin.on('error', error => { if (!this.closing) this.options.onFailure(error); });
  }

  get pid(): number | undefined { return this.child.pid; }
  get running(): boolean { return this.exitCode === undefined; }

  private receive(line: string): void {
    let message: CodexMessage;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid message');
      message = value as CodexMessage;
      if (message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)
        || message.method !== undefined && (typeof message.method !== 'string' || !message.method)
        || message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) {
        throw new Error('Invalid message');
      }
    }
    catch {
      if (!this.protocolFailed) { this.protocolFailed = true; this.options.onFailure(new Error('内置 Codex 返回了无效协议数据。')); }
      return;
    }
    if (message.method) {
      if (message.id !== undefined) {
        if (this.closing) return;
        this.track(() => this.answer(message));
      } else {
        for (const listener of this.notifications) this.track(() => listener(message));
        this.track(() => this.options.onNotification(message));
      }
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? 'Codex 调用未完成。'));
    else pending.resolve(message.result);
  }

  private track(callback: () => void | Promise<void>): void {
    let result: void | Promise<void>;
    try { result = callback(); }
    catch (error) { this.options.onFailure(error instanceof Error ? error : new Error('项目进度处理失败。')); return; }
    if (!result) return;
    const pending = result.catch(error => this.options.onFailure(error instanceof Error ? error : new Error('项目进度处理失败。')))
      .finally(() => this.callbacks.delete(pending));
    this.callbacks.add(pending);
  }

  private send(message: unknown): void {
    if (!this.running || this.child.stdin.destroyed) throw new Error('本地 Codex 通道已经关闭。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private async answer(message: CodexMessage): Promise<void> {
    try {
      const result = await this.options.onRequest(message);
      if (this.running && !this.closing) this.send({ id: message.id, result });
    } catch (error) {
      if (this.running && !this.closing) this.send({ id: message.id, error: { code: -32000,
        message: error instanceof Error ? error.message : '当前项目请求未获准执行。' } });
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.options.requestTimeoutMs ?? 30000): Promise<T> {
    if (this.closing) return Promise.reject(new Error('项目执行进程正在关闭。'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('项目控制请求未及时返回（' + method + '）。'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void { this.send({ method, params }); }

  subscribe(listener: (message: CodexMessage) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  waitForDrain(): Promise<void> {
    if (!this.drained) {
      this.closing = true;
      this.child.stdin.end();
      this.drained = this.closed.then(async code => {
        await Promise.allSettled(this.callbacks);
        this.lines.close();
        if (this.pid !== undefined && code !== 0) throw new Error('内置 Codex 未正常退出，原生操作排空状态待核对。');
      });
    }
    return this.drained;
  }

  async close(timeoutMs = 30000): Promise<void> {
    // EOF asks upstream to drain its owned processes. An unconfirmed exit never counts as stopped.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.waitForDrain(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CodexDrainTimeoutError()), timeoutMs);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
