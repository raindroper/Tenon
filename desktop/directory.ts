import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { deviceDirectoryLookupResultSchema, type DeviceDirectoryLookupResult, type DeviceDirectoryLookupSpec, type DeviceExecuteMessage } from '../shared/local-device.js';
import { NativeDrainError } from './mxc.js';
import { literalDirectoryIdentity, localPath, validateDeviceMessage, within, type FileIdentity } from './security.js';

interface DirectoryScope {
  readonly spec: DeviceDirectoryLookupSpec;
  readonly identity: FileIdentity;
  readonly privateRoot: string;
}

interface FileMetadata {
  name: string;
  size: number;
  modifiedAt: string;
}

export async function prepareDirectoryLookup(message: DeviceExecuteMessage, deviceId: string, privateDirectory: string, downloadsDirectory?: string, previous?: DirectoryScope): Promise<DirectoryScope> {
  const spec = validateDeviceMessage(message, deviceId);
  if (!('kind' in spec) || spec.kind !== 'list_directory') throw new Error('设备操作不是只读目录查询。');
  const directory = spec.root === 'windows-downloads' ? downloadsDirectory : spec.root;
  if (!directory) throw new Error('设备无法解析 Windows 下载目录。');
  const privateRoot = await realpath(localPath(privateDirectory));
  if (within(privateRoot, directory)) throw new Error('任务不能访问应用的私有配置和回执目录。');
  const identity = await literalDirectoryIdentity(directory, previous?.identity);
  return { spec, identity, privateRoot };
}

const maxScannedEntries = 10000;

/** Enumerate the approved entry type in one directory; never follow child links. */
export async function listDirectory(scope: DirectoryScope, signal: AbortSignal): Promise<DeviceDirectoryLookupResult> {
  const directory = scope.identity.realPath;
  const extension = scope.spec.extension?.toLowerCase();
  const nameContains = scope.spec.nameContains?.toLowerCase();
  const directories = scope.spec.entryType === 'directory';
  const files: FileMetadata[] = [];
  let scanned = 0;
  let matched = 0;
  let truncated = false;

  signal.throwIfAborted();
  await literalDirectoryIdentity(directory, scope.identity);
  signal.throwIfAborted();
  const reader = await opendir(directory);
  try {
    await literalDirectoryIdentity(directory, scope.identity);
    for (;;) {
      signal.throwIfAborted();
      const entry = await reader.read();
      if (!entry) break;
      if (scanned === maxScannedEntries) { truncated = true; break; }
      scanned++;
      if (entry.isSymbolicLink() || !(directories ? entry.isDirectory() : entry.isFile())
        || entry.name.length > 255 || entry.name !== path.win32.basename(entry.name) || /[:\x00-\x1f]/.test(entry.name)) continue;
      const candidate = path.win32.join(directory, entry.name);
      if (within(scope.privateRoot, candidate)) continue;
      if (extension && path.win32.extname(entry.name).slice(1).toLowerCase() !== extension) continue;
      if (nameContains && !entry.name.toLowerCase().includes(nameContains)) continue;

      // lstat also rejects a regular file swapped for a symlink after enumeration.
      let information;
      try { information = await lstat(candidate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (information.isSymbolicLink() || !(directories ? information.isDirectory() : information.isFile())) continue;
      matched++;
      const file = { name: entry.name, size: directories ? 0 : information.size, modifiedAt: information.mtime.toISOString() };
      files.push(file);
      files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.name.localeCompare(right.name));
      if (files.length > scope.spec.limit) files.pop();
    }
  } finally {
    try { await reader.close(); }
    catch (error) { throw new NativeDrainError(`无法确认目录读取句柄已关闭：${(error as Error).message}`); }
  }
  await literalDirectoryIdentity(directory, scope.identity);
  signal.throwIfAborted();
  return deviceDirectoryLookupResultSchema.parse({ directory, files, scanned, truncated: truncated || matched > scope.spec.limit,
    ...(directories ? { entryType: 'directory' } : {}) });
}
