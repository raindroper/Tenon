import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { windowsDesktopApplications } from '../shared/local-project.js';

const CUA_VERSION = '0.49.1';
const CUA_TAG = 'cua-driver-rs-v' + CUA_VERSION;
export const CUA_DRIVER_RUNTIME = {
  version: CUA_VERSION,
  url: 'https://github.com/trycua/cua/releases/download/' + CUA_TAG + '/cua-driver-rs-' + CUA_VERSION + '-windows-x86_64-binary.zip',
  archiveSha256: '18ea28a86bc940d5ae8266db7801219671e8aef6cd26d56c7e4fc86f8014f661',
  executableSha256: 'f55d05e0f95327f6cbb4b35f1629e0cd6110debf5ef237c66b45b7040e31fc48',
  licenseUrl: 'https://raw.githubusercontent.com/trycua/cua/' + CUA_TAG + '/LICENSE.md',
} as const;

const appName = z.enum(windowsDesktopApplications);
type Application = z.infer<typeof appName>;
const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])\.txt$/iu;
const filenameSchema = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,64}\.txt$/iu)
  .refine(name => !reserved.test(name), '请提供一个不含路径或系统保留名称的新 .txt 文件名。');
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open_notepad_sample'), text: z.string().min(1).max(12000).optional() }).strict(),
  z.object({ action: z.literal('notepad_open_save_as') }).strict(),
  z.object({ action: z.literal('notepad_save_as'), filename: filenameSchema }).strict(),
  z.object({ action: z.literal('clash_navigate'), page: z.enum(['home', 'logs']) }).strict(),
  z.object({ action: z.literal('list'), app: appName }).strict(),
  z.object({ action: z.literal('inspect'), app: appName }).strict(),
  z.object({ action: z.literal('screenshot'), app: appName }).strict(),
]);
type Action = z.infer<typeof actionSchema>;
export const desktopAutomationTool = {
  name: 'operate_windows',
  description: 'Operate Windows applications on the selected device within this task permission. Notepad: open_notepad_sample opens one synthetic task text file; notepad_open_save_as opens its Save As dialog; notepad_save_as submits a new .txt basename within the task workspace and verifies bytes on disk. Clash Verge: clash_navigate to home or logs, verifies actual heading; system proxy, nodes and settings are outside scope. list or inspect reads a scoped app; screenshot captures a scoped app window for the conversation. Operations use background controls and may report that the application changed focus. Treat tool output as evidence; a screenshot is supplemental to verified state.',
  inputSchema: z.toJSONSchema(actionSchema, { io: 'input' }),
};
export interface DesktopAutomationResources { driver: string; guard: string }
export function desktopAutomationResources(vendorDirectory: string): DesktopAutomationResources {
  return { driver: path.join(vendorDirectory, 'cua-driver/cua-driver.exe'), guard: path.join(vendorDirectory, 'cua-driver/window-guard.exe') };
}
const verified = new Map<string, Promise<void>>();
export function verifyDesktopAutomationResources(resources: DesktopAutomationResources): Promise<void> {
  const key = JSON.stringify(resources);
  let promise = verified.get(key);
  if (!promise) {
    promise = (async () => {
      if (createHash('sha256').update(await readFile(resources.driver)).digest('hex') !== CUA_DRIVER_RUNTIME.executableSha256) {
        throw new Error('内置 Cua Driver 校验失败。');
      }
      await access(resources.guard, constants.X_OK);
    })().catch(error => { verified.delete(key); throw error; });
    verified.set(key, promise);
  }
  return promise;
}

const exec = promisify(execFile);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const winSchema = z.object({ pid: z.number().int().positive(), hwnd: z.number().int().positive(), owner: z.number().int().nonnegative(),
  started: z.string(), windowClass: z.string(), title: z.string(), visible: z.boolean(), minimized: z.boolean(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable() });
type Window = z.infer<typeof winSchema>;
const elementSchema = z.object({ role: z.string(), label: z.string().nullish(), value: z.string().nullish(),
  actions: z.array(z.string()).default([]), enabled: z.boolean().optional(), element_token: z.string().regex(/^s[0-9a-f]{8}:\d+$/).nullish(),
  frame: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullish() });
type Element = z.infer<typeof elementSchema>;
type Result = { text: string; screenshot?: { file: string; name: string } };
interface Options {
  resources: DesktopAutomationResources;
  directory: string;
  workspace: string;
  applications: readonly Application[];
  guard(): Promise<void>;
}

class DriverConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private id = 0;
  private failure?: Error;
  private closePromise?: Promise<void>;

  constructor(driver: string, directory: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.DO_NOT_TRACK = '1';
    env.CUA_DRIVER_RS_HOME = directory;
    env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
    env.CUA_DRIVER_RS_UPDATE_CHECK = 'false';
    this.child = spawn(driver, ['mcp', '--direct'], { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', () => {
      this.fail(new Error('Cua Driver 已退出。')); resolve();
    }));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: Record<string, unknown>;
      try { message = record(JSON.parse(line)); }
      catch { this.fail(new Error('Cua Driver 返回了无效的响应。')); return; }
      const request = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!request) return;
      this.pending.delete(message.id as number);
      if (message.error) request.reject(new Error(String(record(message.error).message ?? 'Cua Driver 请求失败。')));
      else request.resolve(message.result);
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }

  private async request(method: string, params: object): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = ++this.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.fail(new Error('Cua Driver 等待超时。已发送操作的结果未知，请核对应用实际状态。'));
          void this.close();
        }, 25000);
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  async initialize(): Promise<void> {
    const result = record(await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'another_rae_windows', version: CUA_VERSION } }));
    if (record(result.serverInfo).version !== CUA_VERSION) throw new Error('Cua Driver 协议版本不符合客户端要求。');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = record(await this.request('tools/call', { name, arguments: { ...args, session: 'another-rae-task' } }));
    const text = Array.isArray(result.content) ? result.content.flatMap(item => {
      const part = record(item); return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
    }).join('\n') : '';
    if (result.isError === true) throw new Error(text.slice(0, 400) || 'Cua Driver 拒绝操作。');
    if (result.structuredContent) return record(result.structuredContent);
    try { return record(JSON.parse(text)); }
    catch { throw new Error('Cua Driver 未返回结构化结果。'); }
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.child.stdin.end();
      const timeout = new AbortController();
      try {
        const closed = await Promise.race([this.exited.then(() => true), delay(8000, false, { signal: timeout.signal })]);
        if (!closed) this.child.kill();
        await this.exited;
      } finally { timeout.abort(); }
    })();
  }
}

interface Sample { name: string; source: string; digest: string; window?: Window; dialog?: Window }
const ownWindow = (a: Window, b: Window) => a.hwnd === b.hwnd && a.pid === b.pid && a.started === b.started;
const titleMatches = (window: Window, name: string) => window.title === name || window.title.startsWith(name + ' - ')
  || window.title.startsWith(name + ' — ');
const noSpace = (value: string | null | undefined) => (value ?? '').replace(/\s/g, '');
const notepadAppId = 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const dialogTitle = (window: Window) => ['另存为', 'Save as', 'Save As'].includes(window.title);
const keyOf = (window: Window) => ({ kind: 'window', pid: window.pid, window_id: window.hwnd });

export class DesktopAutomation {
  private driver?: DriverConnection;
  private sample?: Sample;
  private readonly applications: ReadonlySet<Application>;
  private readonly output: string;
  private pending: Promise<unknown> = Promise.resolve();
  private draining = false;

  constructor(private readonly options: Options) {
    this.applications = new Set(options.applications);
    this.output = path.join(options.directory, 'desktop-evidence');
  }

  call(args: unknown): Promise<Result> {
    if (this.draining) return Promise.reject(new Error('Windows 执行已停止接收操作。'));
    const next = this.pending.then(() => this.perform(actionSchema.parse(args)));
    this.pending = next.catch(() => {});
    return next;
  }

  async drain(): Promise<void> {
    this.draining = true;
    await this.pending;
    await this.driver?.close();
  }

  private async permit(app: Application): Promise<void> {
    if (this.draining || !this.applications.has(app)) throw new Error('此任务当前不允许操作该 Windows 应用。');
    await this.options.guard();
  }

  private async native<T>(...args: string[]): Promise<T> {
    try {
      const { stdout } = await exec(this.options.resources.guard, args, { windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024 });
      return JSON.parse(stdout) as T;
    } catch (error) {
      const detail = record(error);
      const message = typeof detail.stderr === 'string' ? detail.stderr.trim() : '';
      throw new Error(message.slice(0, 400) || '无法验证 Windows 目标窗口或取得截图。');
    }
  }

  private async windows(app: Application): Promise<Window[]> {
    return z.array(winSchema).parse(await this.native<unknown>('windows', app));
  }

  private async connection(): Promise<DriverConnection> {
    if (this.driver) return this.driver;
    await verifyDesktopAutomationResources(this.options.resources);
    const directory = path.join(this.options.directory, 'desktop-driver');
    await mkdir(directory, { recursive: true });
    const driver = new DriverConnection(this.options.resources.driver, directory);
    this.driver = driver;
    try { await driver.initialize(); }
    catch (error) { await driver.close(); throw error; }
    return driver;
  }

  private async checkedTarget(app: Application, expected: Window): Promise<Window> {
    await this.permit(app);
    const actual = (await this.windows(app)).find(item => ownWindow(item, expected));
    if (!actual || !actual.visible || actual.minimized || actual.windowClass !== expected.windowClass || actual.title !== expected.title
      || actual.owner !== expected.owner) throw new Error('目标窗口已变化或未保持可用，请重新观察。');
    return actual;
  }

  private async snapshot(app: Application, window: Window): Promise<Element[]> {
    const driver = await this.connection();
    await this.checkedTarget(app, window);
    const result = await driver.call('get_window_state', { pid: window.pid, window_id: window.hwnd, tree_format: 'elements',
      include_screenshot: false, max_elements: 1100, timeout_ms: 3500 });
    await this.checkedTarget(app, window);
    if (result.status === 'refused' || !Array.isArray(result.elements)) throw new Error('目标窗口未提供可用的控件树。');
    return z.array(elementSchema).parse(result.elements);
  }

  private element(elements: Element[], role: string, labels: readonly string[], action: string): string {
    const matching = elements.filter(element => element.role === role && labels.includes(noSpace(element.label))
      && element.enabled !== false && element.actions.includes(action) && element.element_token);
    if (matching.length !== 1) throw new Error('无法唯一定位当前可用控件：' + labels.join('、') + '。');
    return matching[0].element_token!;
  }

  private async mutate(app: Application, window: Window, name: 'click' | 'set_value', args: Record<string, unknown>): Promise<void> {
    const driver = await this.connection();
    await this.checkedTarget(app, window);
    await this.permit(app);
    const result = await driver.call(name, { ...args, ...(name === 'set_value' ? { pid: window.pid } : {}), delivery_mode: 'background' });
    if (result.effect === 'refused' || result.status === 'refused' || result.refusal) throw new Error('Windows 后台控件操作未获执行。');
  }

  private async foreground(): Promise<number> { return this.native<number>('foreground'); }
  private async focusResult(before: number): Promise<{ backgroundRequested: true; foregroundChanged: boolean }> {
    return { backgroundRequested: true, foregroundChanged: before !== await this.foreground() };
  }

  private async poll<T>(callback: () => Promise<T | undefined>, timeout = 6500): Promise<T | undefined> {
    const until = Date.now() + timeout;
    do {
      const found = await callback();
      if (found !== undefined) return found;
      await delay(175);
    } while (Date.now() < until && !this.draining);
    return undefined;
  }

  private async workspace(): Promise<string> {
    const actual = await realpath(this.options.workspace);
    if (actual.toLowerCase() !== this.options.workspace.toLowerCase()) throw new Error('Windows 任务工作区发生重定向。');
    return actual;
  }

  private async safeFile(file: string): Promise<Buffer | undefined> {
    try {
      const entry = await lstat(file, { bigint: true });
      if (!entry.isFile() || entry.size > 50000n || (await realpath(file)).toLowerCase() !== file.toLowerCase()) {
        throw new Error('目标文本不是任务工作区内的普通文件。');
      }
      const handle = await open(file, 'r');
      try {
        const verified = await handle.stat({ bigint: true });
        if (verified.dev !== entry.dev || verified.ino !== entry.ino || verified.size !== entry.size) {
          throw new Error('目标文件在核验期间已更换。');
        }
        const content = Buffer.alloc(Number(verified.size));
        for (let offset = 0; offset < content.length;) {
          const { bytesRead } = await handle.read(content, offset, content.length - offset);
          if (!bytesRead) throw new Error('目标文件在核验期间已改变。');
          offset += bytesRead;
        }
        return content;
      } finally { await handle.close(); }
    } catch (error) {
      if (record(error).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async assertVacant(file: string): Promise<void> {
    if (await lstat(file).then(() => true, error => {
      if (record(error).code !== 'ENOENT') throw error;
      return false;
    })) throw new Error('目标文件已存在，另存为只能创建新文件。');
  }

  private async openNotepad(text: string | undefined): Promise<Result> {
    const app = 'notepad';
    if (this.sample) throw new Error('此任务已创建记事本样本，请继续使用当前样本。');
    const directory = await this.workspace();
    const name = 'rae-sample-' + randomUUID().slice(0, 8) + '.txt';
    const source = path.join(directory, name);
    const content = Buffer.from(text ?? 'Tenon Windows automation sample.\r\n', 'utf8');
    const sample: Sample = { name, source, digest: sha(content) };
    const driver = await this.connection();
    await this.permit(app);
    await writeFile(source, content, { flag: 'wx' });
    this.sample = sample;
    const before = await this.foreground();
    await this.permit(app);
    const opened = await driver.call('launch_app', { aumid: notepadAppId, additional_arguments: ['"' + source + '"'] });
    if (opened.status === 'refused' || opened.refusal) throw new Error('记事本样本无法启动。');
    sample.window = await this.poll(async () => {
      await this.permit(app);
      const matching = (await this.windows(app)).filter(window => window.windowClass === 'Notepad'
        && window.visible && !window.minimized && titleMatches(window, name));
      if (matching.length > 1) throw new Error('多个窗口显示同一个样本，无法唯一定位。');
      return matching[0];
    });
    if (!sample.window) throw new Error('未能确认记事本已打开当前任务样本。');
    return this.result({ sample: name, opened: true, ...await this.focusResult(before) });
  }

  private async notepadDialog(sample: Sample): Promise<Window | undefined> {
    if (!sample.window) return undefined;
    const main = await this.checkedTarget('notepad', sample.window);
    const related = (await this.windows('notepad')).filter(window => window.windowClass === '#32770' && dialogTitle(window)
      && window.owner === main.hwnd && window.pid === main.pid && window.started === main.started && window.visible && !window.minimized);
    if (related.length > 1) throw new Error('出现多个另存为对话框，已停止。');
    return related[0];
  }

  private async openSave(): Promise<Result> {
    const app = 'notepad';
    const sample = this.sample;
    if (!sample?.window) throw new Error('请先打开本任务的记事本样本。');
    const existing = await this.notepadDialog(sample);
    if (existing) {
      if (!await this.sampleDialogFields(existing, sample)) throw new Error('当前另存为对话框并非本任务样本。');
      sample.dialog = existing;
      return this.result({ saveDialog: 'open' });
    }
    const before = await this.foreground();
    const file = this.element(await this.snapshot(app, sample.window), 'MenuItem', ['文件', 'File'], 'expand');
    await this.mutate(app, sample.window, 'click', { target: keyOf(sample.window), element_token: file, action: 'expand' });
    const menu = this.element(await this.snapshot(app, sample.window), 'MenuItem', ['另存为', 'Saveas', 'SaveAs', 'Saveas…', 'Saveas...'], 'invoke');
    await this.mutate(app, sample.window, 'click', { target: keyOf(sample.window), element_token: menu });
    sample.dialog = await this.poll(() => this.notepadDialog(sample));
    if (!sample.dialog || !await this.sampleDialogFields(sample.dialog, sample)) {
      sample.dialog = undefined;
      throw new Error('未观察到属于本任务样本的另存为对话框。');
    }
    return this.result({ saveDialog: 'open', ...await this.focusResult(before) });
  }

  private async sampleDialogFields(dialog: Window, sample: Sample): Promise<Element[] | undefined> {
    const fields = await this.snapshot('notepad', dialog);
    const candidates = fields.filter(item => item.role === 'Edit' && ['文件名:', 'Filename:', 'Filename'].includes(noSpace(item.label)));
    if (candidates.length !== 1) return undefined;
    const value = candidates[0].value?.toLowerCase();
    return value === sample.name.toLowerCase() || value === sample.source.toLowerCase() ? fields : undefined;
  }

  private async saveNotepad(filename: string): Promise<Result> {
    const app = 'notepad';
    const sample = this.sample;
    if (!sample?.window || !sample.dialog) throw new Error('请先打开本任务记事本样本的另存为对话框。');
    const dialog = sample.dialog;
    const workspace = await this.workspace();
    const destination = path.join(workspace, filename);
    await this.assertVacant(destination);
    const expected = await this.safeFile(sample.source);
    if (!expected || sha(expected) !== sample.digest) throw new Error('原样本已改变，已停止另存为。');
    const before = await this.foreground();
    const fields = await this.snapshot(app, dialog);
    const current = fields.find(item => item.role === 'Edit' && ['文件名:', 'Filename:', 'Filename'].includes(noSpace(item.label)));
    if (current?.value?.toLowerCase() !== sample.name.toLowerCase() && current?.value?.toLowerCase() !== sample.source.toLowerCase()) {
      throw new Error('另存为对话框的文件名与任务样本不一致，已停止。');
    }
    const edit = this.element(fields, 'Edit', ['文件名:', 'Filename:', 'Filename'], 'set_value');
    await this.mutate(app, dialog, 'set_value', { element_token: edit, value: destination });
    const observed = await this.snapshot(app, dialog);
    const confirmed = observed.some(item => item.role === 'Edit' && item.element_token
      && ['文件名:', 'Filename:', 'Filename'].includes(noSpace(item.label)) && item.value?.toLowerCase() === destination.toLowerCase());
    if (!confirmed) throw new Error('文件名回读与任务工作区目标不一致，已停止提交。');
    const save = this.element(observed, 'Button', ['保存(S)', '保存', 'Save', 'Save(S)'], 'invoke');
    await this.assertVacant(destination);
    await this.mutate(app, dialog, 'click', { target: keyOf(dialog), element_token: save });
    const actual = await this.poll(async () => {
      try {
        const bytes = await this.safeFile(destination);
        if (!bytes) return undefined;
        return bytes.equals(expected) ? bytes : undefined;
      } catch (error) { if (record(error).code !== 'ENOENT') throw error; return undefined; }
    });
    const windows = await this.windows(app);
    const active = windows.find(window => ownWindow(window, sample.window!) && titleMatches(window, filename));
    if (!actual || !active || windows.some(window => ownWindow(window, dialog))) {
      throw new Error('保存已调用，但没有同时确认目标文件内容、记事本标题和对话框关闭。请先核对实际结果，避免重复提交。');
    }
    sample.window = active;
    sample.dialog = undefined;
    return this.result({ saved: filename, verified: true, bytes: actual.length, sha256: sha(actual), ...await this.focusResult(before) });
  }

  private async clash(): Promise<Window> {
    const candidates = (await this.windows('clash-verge')).filter(window => window.visible && !window.minimized && window.title === 'Clash Verge');
    if (candidates.length !== 1) throw new Error('请打开一个可见、未最小化的已安装 Clash Verge 主窗口，再继续此任务。');
    return candidates[0];
  }

  private async navigateClash(page: 'home' | 'logs'): Promise<Result> {
    const app = 'clash-verge';
    const window = await this.clash();
    const before = await this.foreground();
    const labels = page === 'home' ? ['首页', 'Home'] : ['日志', 'Logs'];
    const tree = await this.snapshot(app, window);
    const hasHeading = (items: Element[]) => items.some(element => ['Text', 'Heading'].includes(element.role)
      && labels.includes(noSpace(element.label)));
    if (!hasHeading(tree)) {
      const button = this.element(tree, 'Button', labels, 'invoke');
      await this.mutate(app, window, 'click', { target: keyOf(window), element_token: button });
      const observed = await this.poll(async () => hasHeading(await this.snapshot(app, window)) ? true : undefined);
      if (!observed) throw new Error('已发起导航，但未核对到预期页面标题。');
    }
    return this.result({ page, observedHeading: labels[0], verified: true, ...await this.focusResult(before) });
  }

  private async target(app: Application, capture = false): Promise<Window> {
    if (app === 'clash-verge') return this.clash();
    const sample = this.sample;
    if (!sample?.window) throw new Error('请先打开本任务的记事本样本。');
    if (sample.dialog) return this.checkedTarget(app, sample.dialog);
    if (capture) throw new Error('记事本窗口可能包含其他文档标签。请在本任务的另存为对话框打开时截图。');
    return this.checkedTarget(app, sample.window);
  }

  private async screenshot(app: Application): Promise<Result> {
    const window = await this.target(app, true);
    if (!window.bounds) throw new Error('无法读取目标窗口位置。');
    const area = app === 'notepad' ? await this.notepadEvidenceArea(window) : await this.clashEvidenceArea(window);
    const before = await this.foreground();
    await mkdir(this.output, { recursive: true });
    if ((await realpath(this.output)).toLowerCase() !== this.output.toLowerCase()) throw new Error('截图输出目录发生重定向。');
    const name = app + '-' + randomUUID().slice(0, 8) + '.png';
    const file = path.join(this.output, name);
    try {
      await this.checkedTarget(app, window);
      await this.native<boolean>('capture', app, String(window.hwnd), String(window.pid), window.started, file, ...[...area, ...window.bounds].map(String));
      await this.checkedTarget(app, window);
      const image = await lstat(file);
      if (!image.isFile() || image.size < 64 || image.size > 1000000 || (await realpath(file)).toLowerCase() !== file.toLowerCase()) {
        throw new Error('截图不是任务目录内有效的图像文件。');
      }
      return { ...this.result({ screenshot: name, method: 'window-only', ...await this.focusResult(before) }), screenshot: { file, name } };
    } catch (error) {
      await unlink(file).catch(() => {});
      throw new Error(errorText(error));
    }
  }

  private async notepadEvidenceArea(window: Window): Promise<number[]> {
    const fields = this.sample && await this.sampleDialogFields(window, this.sample);
    const edit = fields?.find(item => item.role === 'Edit' && ['文件名:', 'Filename:', 'Filename'].includes(noSpace(item.label)))?.frame;
    const save = fields?.find(item => item.role === 'Button' && ['保存(S)', '保存', 'Save', 'Save(S)'].includes(noSpace(item.label)))?.frame;
    if (!edit || !save || edit.w <= 0 || edit.h <= 0 || save.w <= 0 || save.h <= 0) {
      throw new Error('无法确认本任务另存为对话框的截图范围。');
    }
    const left = Math.floor(Math.min(edit.x, save.x) - 4);
    const top = Math.floor(Math.min(edit.y, save.y) - 6);
    const right = Math.ceil(Math.max(edit.x + edit.w, save.x + save.w) + 4);
    const bottom = Math.ceil(Math.max(edit.y + edit.h, save.y + save.h) + 6);
    return [left, top, right - left, bottom - top];
  }

  private async clashEvidenceArea(window: Window): Promise<number[]> {
    const tree = await this.snapshot('clash-verge', window);
    const matches = tree.filter(element => ['Text', 'Heading'].includes(element.role) && ['日志', 'Logs'].includes(noSpace(element.label)));
    const frame = matches.length === 1 && matches[0].frame;
    if (!frame || frame.w <= 0 || frame.h <= 0) throw new Error('Clash Verge 取证范围仅限日志页。请先切换并核对页面。');
    // Keep the verified heading and its surrounding banner, excluding live connection records.
    return [Math.floor(frame.x - 18), Math.floor(frame.y - 9), Math.ceil(frame.w + 170), Math.ceil(frame.h + 18)];
  }

  private async perform(action: Action): Promise<Result> {
    const app = 'app' in action ? action.app : action.action === 'clash_navigate' ? 'clash-verge' : 'notepad';
    await this.permit(app);
    if (action.action === 'open_notepad_sample') return this.openNotepad(action.text);
    if (action.action === 'notepad_open_save_as') return this.openSave();
    if (action.action === 'notepad_save_as') return this.saveNotepad(action.filename);
    if (action.action === 'clash_navigate') return this.navigateClash(action.page);
    if (action.action === 'screenshot') return this.screenshot(app);
    const window = await this.target(app);
    if (action.action === 'list') return this.result({ application: app, title: window.title, visible: window.visible });
    const tree = await this.snapshot(app, window);
    const relevant = app === 'notepad' ? ['文件', 'File', '另存为', 'Saveas', 'SaveAs', '文件名:', 'Filename:', '保存(S)', 'Save']
      : ['首页', 'Home', '日志', 'Logs'];
    return this.result({ application: app, title: window.title, controls: tree.filter(element => relevant.includes(noSpace(element.label)))
      .map(({ role, label, enabled, actions }) => ({ role, label, enabled, actions })) });
  }

  private result(value: object): Result { return { text: JSON.stringify(value) }; }
}
