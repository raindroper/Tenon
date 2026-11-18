import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LocalProjectEntry } from './project-journal.js';
import { projectCheckpoint } from './project-checkpoint.js';

const snapshotId = /^snapshot-[a-f0-9]{64}$/;
const generated = /^(?:snapshot-[a-f0-9]{64}|pending-[A-Za-z0-9_-]+)$/;
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
async function checkedDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory), info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(absolute)) !== canonical(absolute)) throw new Error('检查点目录身份不安全。');
  return absolute;
}
async function rootFor(privateDirectory: string): Promise<string> {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 }); await checkedDirectory(privateDirectory);
  const root = path.join(privateDirectory, 'workspace-snapshots');
  await mkdir(root, { mode: 0o700, recursive: true }); return checkedDirectory(root);
}
export async function pruneProjectArchives(privateDirectory: string, keep?: string): Promise<void> {
  const root = await rootFor(privateDirectory);
  for (const item of await readdir(root)) {
    if (item === keep || !generated.test(item)) continue;
    const target = path.join(root, item);
    if (path.dirname(target) !== root) throw new Error('检查点清理范围无效。');
    await checkedDirectory(target); await rm(target, { recursive: true });
  }
}

/** Called only after native tools/processes drained, under a specific persistent
 * workspace grant. The only retained copy lives in the worker's private journal. */
export async function archiveProject(work: string, privateDirectory: string, entry: LocalProjectEntry): Promise<NonNullable<LocalProjectEntry['workspaceArchive']>> {
  const resources = entry.input.spec.serverResources;
  if (resources?.workspaceStorage !== 'persistent' || !resources.checkpointMiB || resources.checkpointMiB < 2 * resources.diskMiB || !entry.identity) {
    throw new Error('本任务没有持久工作区及检查点空间许可。');
  }
  const root = await rootFor(privateDirectory); await checkedDirectory(work);
  await pruneProjectArchives(privateDirectory, entry.workspaceArchive?.id);
  const hash = await projectCheckpoint(work, true, resources.diskMiB * 1024 * 1024);
  const id = 'snapshot-' + createHash('sha256').update(JSON.stringify([hash, entry.identity, entry.input.requirementsRevision, entry.input.specHash])).digest('hex');
  const destination = path.join(root, id);
  const archive = { id, hash, identity: entry.identity, requirementsRevision: entry.input.requirementsRevision };
  if (entry.workspaceArchive?.id === id) return archive;
  const pending = await mkdtemp(path.join(root, 'pending-'));
  try {
    await cp(work, path.join(pending, 'content'), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    if (await projectCheckpoint(path.join(pending, 'content'), true, resources.diskMiB * 1024 * 1024) !== hash
      || await projectCheckpoint(work, true, resources.diskMiB * 1024 * 1024) !== hash) throw new Error('工作区快照未能完整核对，原文件已保留。');
    await writeFile(path.join(pending, 'manifest.json'), JSON.stringify({ ...archive, operationId: entry.input.operationId, specHash: entry.input.specHash }), { mode: 0o600 });
    await rename(pending, destination); return archive;
  } catch (error) {
    if (path.dirname(pending) === root) { await checkedDirectory(pending); await rm(pending, { recursive: true }); }
    throw error;
  }
}

export async function restoreProjectArchive(work: string, privateDirectory: string, entry: LocalProjectEntry): Promise<void> {
  const archive = entry.workspaceArchive, resources = entry.input.spec.serverResources;
  if (!archive || !snapshotId.test(archive.id) || resources?.workspaceStorage !== 'persistent') throw new Error('缺少当前任务的持久检查点。');
  const root = await rootFor(privateDirectory), source = path.join(root, archive.id);
  await checkedDirectory(source);
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  if (manifest.operationId !== entry.input.operationId || manifest.specHash !== entry.input.specHash || manifest.hash !== archive.hash
    || manifest.identity !== archive.identity || manifest.requirementsRevision !== archive.requirementsRevision) throw new Error('工作区检查点与原操作不匹配。');
  const content = path.join(source, 'content'); await checkedDirectory(content);
  if (await projectCheckpoint(content, true, resources.diskMiB * 1024 * 1024) !== archive.hash) throw new Error('工作区检查点已变化，未恢复执行。');
  const parent = await checkedDirectory(path.dirname(work));
  if (path.dirname(path.resolve(work)) !== parent || !/^[a-f0-9]{64}$/.test(path.basename(work))) throw new Error('恢复目录不属于已分配的任务空间。');
  try { await lstat(work); throw new Error('恢复目标已存在，未覆盖实际文件。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pending = await mkdtemp(path.join(parent, 'restore-'));
  try {
    const staged = path.join(pending, 'content');
    await cp(content, staged, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    if (await projectCheckpoint(staged, true, resources.diskMiB * 1024 * 1024) !== archive.hash) throw new Error('恢复后的实际文件与检查点不一致。');
    try { await lstat(work); throw new Error('恢复目标已变化，未覆盖。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(staged, work);
  } finally {
    if (path.dirname(pending) === parent && path.basename(pending).startsWith('restore-')) {
      await checkedDirectory(pending); await rm(pending, { recursive: true });
    }
  }
}
