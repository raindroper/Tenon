import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectInputFileSchema, type ProjectInputFile } from '../shared/project-contract.js';
import { MAX_PROJECT_FILES } from '../shared/project-files.js';

const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
async function directoryIdentity(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(directory)) !== canonical(path.resolve(directory))) {
    throw new Error('任务输入目录身份发生变化。');
  }
}
export async function receiveProjectInputs(directory: string, raw: unknown,
  context: (input: Record<string, unknown>) => Promise<unknown>, guard: () => Promise<unknown>): Promise<Array<ProjectInputFile & { path: string }>> {
  const files = projectInputFileSchema.array().max(MAX_PROJECT_FILES).parse(raw ?? []);
  const root = path.join(directory, 'inputs');
  await mkdir(root, { recursive: true, mode: 0o700 }); await directoryIdentity(root);
  const result: Array<ProjectInputFile & { path: string }> = [];
  for (const file of files) {
    await guard();
    if (file.name !== path.basename(file.name) || /[\\/\x00-\x1f:]/.test(file.name) || /^\.+$/.test(file.name)) throw new Error('附件文件名无效。');
    const key = createHash('sha256').update(file.id + ':' + file.sha256).digest('hex');
    const folder = path.join(root, key);
    await mkdir(folder, { recursive: true, mode: 0o700 }); await directoryIdentity(folder);
    const destination = path.join(folder, file.name);
    const existing = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size !== file.size
        || createHash('sha256').update(await readFile(destination)).digest('hex') !== file.sha256) throw new Error('已保存的任务输入与原件不一致。');
    } else {
      const temporary = path.join(folder, '.incoming-' + randomUUID());
      const handle = await open(temporary, 'wx', 0o600);
      try {
        const hash = createHash('sha256'); let offset = 0;
        while (offset < file.size) {
          const chunk = await context({ action: 'input_file', id: file.id, offset }) as { sha256: string; data: string; offset: number; size: number };
          await guard();
          const bytes = Buffer.from(chunk.data, 'base64');
          if (chunk.sha256 !== file.sha256 || chunk.offset !== offset || chunk.size !== file.size
            || !bytes.length || bytes.length > 256 * 1024 || offset + bytes.length > file.size) throw new Error('附件分片与原件不匹配。');
          await handle.writeFile(bytes); hash.update(bytes); offset += bytes.length;
        }
        if (hash.digest('hex') !== file.sha256) throw new Error('附件校验失败。');
        await handle.sync(); await handle.close(); await guard(); await directoryIdentity(folder);
        await rename(temporary, destination);
      } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    result.push({ ...file, path: destination });
  }
  return result;
}
