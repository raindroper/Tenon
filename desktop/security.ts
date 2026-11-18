import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { deviceCommandSpecSchema, type DeviceCommandSpec, type DeviceExecuteMessage, type DeviceGrant, type LegacyDeviceCommandSpec } from '../shared/local-device.js';

export interface FileIdentity { realPath: string; dev: string; ino: string; size: number; mtimeMs: number; sha256?: string }
export interface LocalGrant extends DeviceGrant { rootIdentity: FileIdentity; executableIdentity: FileIdentity; toolchainRoot: string; executableOnly?: boolean }

export function localPath(value: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(value) || /[\0\r\n]/.test(value) || value.slice(2).includes(':') || /[. ](?:[\\/]|$)/.test(value)) {
    throw new Error('只允许本机盘符绝对路径，不能使用网络路径、设备路径或备用数据流。');
  }
  return path.win32.normalize(value);
}
export function within(root: string, target: string): boolean {
  const relative = path.win32.relative(localPath(root), localPath(target));
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative));
}
export function quoteWindowsArg(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('命令参数不能包含 NUL 或换行。');
  // CreateProcessW passes a command line directly; use the conventional Windows
  // argv rules. Shell interpretation, when explicitly selected, stays inside MXC.
  if (value.length && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
export function commandLine(executable: string, args: string[]): string {
  if (!/\.exe$/i.test(localPath(executable))) throw new Error('当前只支持明确选择的 .exe 可执行文件。');
  const value = ['"' + executable + '"', ...args.map(quoteWindowsArg)].join(' ');
  if (value.length > 30000) throw new Error('命令参数总长度超过本地限制。');
  return value;
}
export function specHash(spec: DeviceCommandSpec): string {
  return createHash('sha256').update(JSON.stringify(deviceCommandSpecSchema.parse(spec))).digest('hex');
}
async function identity(file: string, binary = false): Promise<FileIdentity> {
  const canonical = localPath(await realpath(localPath(file)));
  const info = await stat(canonical);
  if (binary ? !info.isFile() : !info.isDirectory()) throw new Error(binary ? '所选程序不是文件。' : '所选工作区不是目录。');
  const result: FileIdentity = { realPath: canonical, dev: String(info.dev), ino: String(info.ino), size: info.size, mtimeMs: info.mtimeMs };
  if (binary) {
    const hash = createHash('sha256');
    for await (const data of createReadStream(canonical)) hash.update(data);
    result.sha256 = hash.digest('hex');
  }
  return result;
}
export async function captureGrant(grant: DeviceGrant): Promise<LocalGrant> {
  commandLine(grant.executable, []);
  const rootIdentity = await identity(grant.root);
  const executableIdentity = await identity(grant.executable, true);
  return { ...grant, root: rootIdentity.realPath, executable: executableIdentity.realPath,
    rootIdentity, executableIdentity, toolchainRoot: path.win32.dirname(executableIdentity.realPath), available: false };
}
function matches(saved: FileIdentity, current: FileIdentity, binary: boolean): boolean {
  return saved.realPath.toLowerCase() === current.realPath.toLowerCase() && saved.dev === current.dev && saved.ino === current.ino &&
    (!binary || (saved.size === current.size && saved.mtimeMs === current.mtimeMs && saved.sha256 === current.sha256));
}
function samePath(left: string, right: string): boolean {
  return path.win32.relative(localPath(left), localPath(right)) === '';
}
export function validateDeviceMessage(message: DeviceExecuteMessage, deviceId: string, now = Date.now()): DeviceCommandSpec {
  const spec = deviceCommandSpecSchema.parse(message.spec);
  if (spec.deviceId !== deviceId) throw new Error('命令不属于此设备。');
  if (!message.taskId || !Number.isSafeInteger(message.taskRevision) || message.taskRevision < 1 || !message.runId || !message.operationId) throw new Error('缺少任务授权来源。');
  if (!Number.isSafeInteger(message.deadline) || message.deadline <= now || message.deadline - now > 300000) throw new Error('任务执行期限已失效。');
  if (!Number.isFinite(Date.parse(message.issuedAt)) || Date.parse(message.issuedAt) > now + 30000) throw new Error('任务签发时间无效。');
  if (message.specHash !== specHash(spec)) throw new Error('命令内容摘要不匹配。');
  return spec;
}

export async function literalDirectoryIdentity(directory: string, previous?: FileIdentity): Promise<FileIdentity> {
  const current = await identity(directory);
  if (!samePath(current.realPath, directory)) throw new Error('所选目录路径已重定向到其他位置。');
  if (previous && !matches(previous, current, false)) throw new Error('所选目录在执行前发生变化。');
  return current;
}

export async function taskScratchParent(privateDirectory: string): Promise<FileIdentity> {
  const privateRoot = await identity(privateDirectory);
  if (!samePath(privateRoot.realPath, privateDirectory)) throw new Error('应用数据目录已重定向，无法建立独立临时工作区。');
  const parent = path.win32.join(path.win32.dirname(privateRoot.realPath), `${path.win32.basename(privateRoot.realPath)}-scratch`);
  await mkdir(parent, { recursive: true });
  const root = await identity(parent);
  if (!samePath(root.realPath, parent) || within(privateRoot.realPath, root.realPath)) throw new Error('临时工作区父目录已重定向。');
  return root;
}

async function removeTaskScratch(parent: FileIdentity, scratch: FileIdentity): Promise<void> {
  const [parentNow, scratchNow] = await Promise.all([identity(parent.realPath), identity(scratch.realPath)]);
  if (!matches(parent, parentNow, false) || !matches(scratch, scratchNow, false) ||
    !samePath(path.win32.dirname(scratchNow.realPath), parentNow.realPath) || !path.win32.basename(scratchNow.realPath).startsWith('operation-')) {
    throw new Error('临时工作区位置或身份已改变，已保留以便检查。');
  }
  await rm(scratchNow.realPath, { recursive: true, force: true });
}

export async function prepareTaskGrant(message: DeviceExecuteMessage, deviceId: string, privateDirectory: string): Promise<{ grant: LocalGrant; cleanup?: () => Promise<void> }> {
  const spec = validateDeviceMessage(message, deviceId);
  if (!('access' in spec)) throw new Error('任务未指定单次本地访问范围。');
  const executable = localPath(spec.executable);
  commandLine(executable, spec.args);
  const executableIdentity = await identity(executable, true);
  if (!samePath(executableIdentity.realPath, executable)) throw new Error('所选程序路径已重定向到其他位置。');
  const directory = spec.access.kind === 'directory' ? spec.access : undefined;
  let rootIdentity: FileIdentity;
  let cleanup: (() => Promise<void>) | undefined;
  if (directory) {
    rootIdentity = await literalDirectoryIdentity(directory.root);
    if (within(privateDirectory, rootIdentity.realPath)) throw new Error('任务不能访问应用的私有配置和回执目录。');
  } else {
    const parent = await taskScratchParent(privateDirectory);
    const scratchPath = await mkdtemp(path.win32.join(parent.realPath, 'operation-'));
    rootIdentity = await identity(scratchPath);
    if (!samePath(rootIdentity.realPath, scratchPath) || !samePath(path.win32.dirname(rootIdentity.realPath), parent.realPath)) {
      throw new Error('新建临时工作区已重定向，已保留以便检查。');
    }
    cleanup = () => removeTaskScratch(parent, rootIdentity);
  }
  return { grant: { id: message.operationId, revision: message.taskRevision, root: rootIdentity.realPath, executable: executableIdentity.realPath,
    readOnly: directory?.readOnly ?? false, rootIdentity, executableIdentity, toolchainRoot: path.win32.dirname(executableIdentity.realPath), executableOnly: true }, cleanup };
}

export async function validateExecution(message: DeviceExecuteMessage, deviceId: string, grant: LocalGrant, now = Date.now()): Promise<LegacyDeviceCommandSpec> {
  const spec = validateDeviceMessage(message, deviceId, now);
  if ('kind' in spec) throw new Error('此操作不需要启动本地程序。');
  const taskScoped = 'access' in spec;
  const grantId = taskScoped ? message.operationId : spec.grantId;
  const grantRevision = taskScoped ? message.taskRevision : spec.grantRevision;
  if (grantId !== grant.id || grantRevision !== grant.revision) throw new Error('设备或本地授权版本不匹配。');
  const executable = spec.executable;
  const workingDirectory = taskScoped ? grant.root : spec.cwd;
  if (!samePath(executable, grant.executable) || !within(grant.root, workingDirectory)) throw new Error('命令超出本地授权范围。');
  if (taskScoped && (!grant.executableOnly || (spec.access.kind === 'directory' &&
    (!samePath(spec.access.root, grant.root) || spec.access.readOnly !== grant.readOnly)))) throw new Error('单次目录授权快照不匹配。');
  const [rootNow, executableNow, cwd] = await Promise.all([identity(grant.root), identity(grant.executable, true), realpath(localPath(workingDirectory))]);
  if (!matches(grant.rootIdentity, rootNow, false) || !matches(grant.executableIdentity, executableNow, true) || !within(grant.root, cwd)) throw new Error('工作区、程序或目录链接已变化，请在本地重新授权。');
  commandLine(executableNow.realPath, spec.args);
  const timeoutMs = Math.min(spec.timeoutMs, message.deadline - Date.now());
  if (timeoutMs <= 0) throw new Error('任务执行期限已失效。');
  return { deviceId, grantId, grantRevision, executable: executableNow.realPath, args: spec.args, cwd: localPath(cwd), timeoutMs };
}

export function secureBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('服务地址必须是无账号、参数和路径的 HTTPS 来源。');
  return url.origin;
}

/** Preserve the shared page's Copy action without granting clipboard reads or native tools. */
export function allowPagePermission(permission: string, pageOrigin: string, requestingUrl: string, isMainFrame: boolean): boolean {
  if (permission !== 'clipboard-sanitized-write' || !isMainFrame) return false;
  try { return new URL(requestingUrl).origin === secureBaseUrl(pageOrigin); } catch { return false; }
}
