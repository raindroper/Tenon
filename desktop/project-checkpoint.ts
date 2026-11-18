import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

/** A content checkpoint, never a copy of project text. Symlinks are hashed as links
 * and never followed. Dependencies and VCS objects are excluded; source and Git's
 * selected HEAD/index are included so branch/index changes cannot be overlooked. */
export async function projectCheckpoint(root: string, full = false, maxBytes = 512 * 1024 * 1024): Promise<string> {
  const canonical = await realpath(root), hash = createHash('sha256');
  let files = 0, bytes = 0;
  const walk = async (directory: string, relative: string): Promise<void> => {
    if (await realpath(directory) !== directory) throw new Error('检查点目录发生重定向，未读取其内容。');
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!full && entry.name === 'node_modules') continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (++files > 100000 || (bytes += info.isFile() ? info.size : 0) > maxBytes) throw new Error('项目超出自动检查点范围，请缩小工作区后继续。');
      hash.update(name + '\0' + String(info.mode) + '\0');
      if (info.isSymbolicLink()) { hash.update(await readlink(target)); continue; }
      if (info.isDirectory()) {
        if (!full && entry.name === '.git') {
          for (const selected of ['HEAD', 'index', 'packed-refs']) {
            const file = path.join(target, selected);
            try {
              const metadata = await lstat(file);
              if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Git 检查点包含非普通文件。');
              hash.update(selected); for await (const chunk of createReadStream(file)) hash.update(chunk);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          for (const metadata of ['refs', 'worktrees']) {
            try { await walk(path.join(target, metadata), name + '/' + metadata); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        } else await walk(target, name);
      } else if (info.isFile()) {
        const before = [info.size, info.mtimeMs, info.ino].join(':');
        for await (const chunk of createReadStream(target)) hash.update(chunk);
        const after = await lstat(target);
        if (before !== [after.size, after.mtimeMs, after.ino].join(':') || after.isSymbolicLink()) throw new Error('保存检查点时项目仍在变化，请核对其他写入进程。');
      } else throw new Error('项目包含无法安全保存检查点的文件类型。');
      hash.update('\0');
    }
  };
  await walk(canonical, '');
  if (await realpath(root) !== canonical) throw new Error('项目目录身份在保存检查点期间发生变化。');
  return hash.digest('hex');
}

/** A permitted Git worktree may live in the task's scratch area. Bind that area
 * and saved outputs too, without hashing the engine's independently changing journal. */
export async function projectExecutionCheckpoint(project: string, directory: string): Promise<string> {
  const hash = createHash('sha256');
  for (const [kind, root] of [['project', project], ['temporary', path.join(directory, 'temporary')], ['outputs', path.join(directory, 'outputs')]]) {
    hash.update(kind + '\0');
    try { hash.update(await projectCheckpoint(root)); }
    catch (error) { if (kind === 'project' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update('missing'); }
  }
  return hash.digest('hex');
}
