import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import type { LocalProjectEntry } from './project-journal.js';
import { projectDeliveryProblem } from '../shared/project-contract.js';
import { captureProject } from './project-configuration.js';
import { projectCheckpoint, projectExecutionCheckpoint } from './project-checkpoint.js';
import { isProjectResultPath, projectFilePathSchema, projectFilesManifestSchema, projectFinalFileIdentity, requiresProjectFileDelivery, PROJECT_FILE_CHUNK_BYTES, MAX_PROJECT_FILES,
  type ProjectFilesRequest, type ProjectFilesUpload, type ProjectFilesManifest } from '../shared/project-files.js';

const sameFile = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function checkedDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) throw new Error('成果目录身份不安全。');
}
async function regularFile(roots: ReadonlyMap<string, string>, relative: string) {
  projectFilePathSchema.parse(relative);
  const [kind, ...parts] = relative.split('/');
  const root = roots.get(kind);
  if (!root) throw new Error('成果目录身份不安全。');
  await checkedDirectory(root);
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !samePath(await realpath(target), target)) throw new Error('成果路径发生重定向，未读取文件。');
  }
  const before = await lstat(target);
  if (!before.isFile() || before.nlink !== 1) throw new Error('只领取本任务的普通文件，不跟随链接。');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const check = async () => {
    const current = await lstat(target);
    if (current.isSymbolicLink() || !samePath(await realpath(target), target) || !sameFile(before, current) || !sameFile(before, await handle.stat())) throw new Error('领取期间成果文件已改变。');
  };
  try { await check(); } catch (error) { await handle.close(); throw error; }
  return { handle, info: before, check };
}

function finalIdentity(entry: LocalProjectEntry) {
  const { input } = entry;
  if (!input.deliverFiles || input.spec.serverResources || input.contract?.version !== 2) return;
  const identity = projectFinalFileIdentity(entry.delivery, input.requirementsRevision);
  if (identity) return { files: identity.files, fingerprint: createHash('sha256').update(identity.proofIdentity).digest('hex') };
}

const resultRoots = (root: string, workspace = path.join(root, 'workspace')) =>
  new Map([['workspace', workspace], ['temporary', path.join(root, 'temporary')], ['outputs', path.join(root, 'outputs')]]);

async function readChunk(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, size: number, offset: number) {
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await handle.read(buffer, filled, size - filled, offset + filled);
    if (!bytesRead) throw new Error('成果文件未读取完整。');
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** Freeze only verified outputs in the task's private journal before marking Windows work complete. */
export async function captureProjectFinalFiles(entry: LocalProjectEntry, privateDirectory: string,
  assertActive: () => void | Promise<void>): Promise<LocalProjectEntry['finalFilesSnapshot']> {
  const final = finalIdentity(entry);
  if (!final) {
    if (!entry.input.spec.serverResources && requiresProjectFileDelivery(entry)) throw new Error('最终成果缺少当前可发布的验收清单。');
    return;
  }
  const requirementsRevision = entry.input.requirementsRevision;
  const contract = entry.input.contract;
  const problem = projectDeliveryProblem(entry.delivery, requirementsRevision, final.files, contract?.version === 2 ? contract.finalFiles : undefined);
  if (problem) throw new Error(problem);
  if (entry.finalFilesSnapshot?.fingerprint === final.fingerprint
    && entry.finalFilesSnapshot.requirementsRevision === requirementsRevision) return entry.finalFilesSnapshot;
  if (!entry.realPath || !entry.identity) throw new Error('最终成果缺少原工作区身份。');
  const captured = { realPath: entry.realPath, identity: entry.identity };
  await assertActive();
  await captureProject(entry.input, captured, path.join(privateDirectory, 'workspace'));
  await checkedDirectory(privateDirectory);
  const root = path.join(privateDirectory, 'final-files');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkedDirectory(root);
  const destination = path.join(root, final.fingerprint);
  const pending = await mkdtemp(path.join(root, 'pending-'));
  const roots = resultRoots(privateDirectory, captured.realPath);
  let saved = false;
  try {
    for (const expected of final.files) {
      await assertActive();
      const file = await regularFile(roots, expected.path);
      try {
        if (file.info.size !== expected.size) throw new Error('最终文件与通过检查的内容不一致。');
        const target = path.join(pending, ...expected.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await checkedDirectory(path.dirname(target));
        const digest = createHash('sha256');
        let copied = 0;
        await pipeline(file.handle.createReadStream({ autoClose: false }), new Transform({ transform(chunk: Buffer, _encoding, callback) {
          copied += chunk.length;
          if (copied > expected.size) { callback(new Error('最终文件与通过检查的内容不一致。')); return; }
          digest.update(chunk); callback(null, chunk);
        } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        await file.check();
        if (copied !== expected.size || digest.digest('hex') !== expected.sha256) throw new Error('最终文件与通过检查的内容不一致。');
      } finally { await file.handle.close(); }
    }
    await captureProject(entry.input, captured, path.join(privateDirectory, 'workspace'));
    if (finalIdentity(entry)?.fingerprint !== final.fingerprint) throw new Error('保存期间最终成果或任务要求已变化。');
    await assertActive();
    try { await rename(pending, destination); saved = true; }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // A restart may find the exact same snapshot already frozen. Verify it before reusing it.
      const existing = resultRoots(destination);
      await checkedDirectory(destination);
      for (const expected of final.files) {
        const file = await regularFile(existing, expected.path), digest = createHash('sha256');
        try {
          for await (const chunk of file.handle.createReadStream({ autoClose: false })) digest.update(chunk);
          await file.check();
          if (file.info.size !== expected.size || digest.digest('hex') !== expected.sha256) throw error;
        } finally { await file.handle.close(); }
      }
    }
    await assertActive();
    return { fingerprint: final.fingerprint, requirementsRevision };
  } finally {
    if (!saved) { await checkedDirectory(pending); await rm(pending, { recursive: true }); }
  }
}

/** Reads the frozen final outputs, archived server outputs, or exact paused stage files. */
export async function sendProjectFiles(entry: LocalProjectEntry, privateDirectory: string, request: ProjectFilesRequest,
  post: (input: ProjectFilesUpload) => Promise<{ deliveryId?: string; ready?: boolean }>, assertActive = () => {}): Promise<void> {
  const archive = entry.workspaceArchive, input = entry.input;
  const server = input.spec.serverResources;
  const selection = request.selection;
  const final = request.finalSelection && finalIdentity(entry);
  const eligibleFinal = () => entry.state === 'completed' && ['closed', 'active'].includes(entry.environment ?? '');
  if (request.finalSelection && (!final || !eligibleFinal() || !isDeepStrictEqual(final.files, request.finalSelection)
    || entry.finalFilesSnapshot?.fingerprint !== final.fingerprint || entry.finalFilesSnapshot.requirementsRevision !== input.requirementsRevision)) {
    throw new Error('文件领取请求与最终验收快照不一致。');
  }
  if (!final && (entry.environment !== 'closed' || !['paused', 'completed', 'failed'].includes(entry.state))) throw new Error('任务尚未暂停并保存可领取的成果。');
  if (!final && (server ? server.workspaceStorage !== 'persistent' || !archive : !selection || entry.state !== 'paused' || !entry.checkpoint || !entry.realPath)) {
    throw new Error('原工作区没有可读取的阶段快照或持久归档。');
  }
  if (selection && input.contract?.version !== 2) throw new Error('此任务版本尚未接入阶段成果领取。');
  const snapshot = { operationId: input.operationId, taskId: input.taskId, specHash: input.specHash,
    approvalRevision: input.approvalRevision, requirementsRevision: input.requirementsRevision, checkpoint: final?.fingerprint ?? (server ? archive!.hash : entry.checkpoint!),
    ...(selection ? { stageFingerprint: selection.fingerprint } : {}), ...(final ? { finalFingerprint: final.fingerprint } : {}) };
  if (!isDeepStrictEqual(request.snapshot, snapshot)) throw new Error('文件领取请求与原操作快照不一致。');
  const maxBytes = server ? server.diskMiB * 1024 * 1024 : (final?.files ?? selection!.files).reduce((total, file) => total + file.size, 0);
  let root = privateDirectory;
  if (server) {
    if (!/^snapshot-[a-f0-9]{64}$/.test(archive!.id)) throw new Error('归档标识无效。');
    const archiveDirectory = path.resolve(privateDirectory, 'workspace-snapshots', archive!.id);
    for (const directory of [privateDirectory, path.join(privateDirectory, 'workspace-snapshots'), archiveDirectory]) {
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) throw new Error('归档目录身份不安全。');
    }
    const manifest = JSON.parse(await readFile(path.join(archiveDirectory, 'manifest.json'), 'utf8'));
    if (manifest.operationId !== input.operationId || manifest.specHash !== input.specHash || manifest.hash !== archive!.hash
      || manifest.identity !== archive!.identity || manifest.requirementsRevision !== input.requirementsRevision) throw new Error('原归档的身份校验失败。');
    root = path.join(archiveDirectory, 'content');
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('归档内容目录身份不安全。');
  }
  if (final) {
    root = path.join(privateDirectory, 'final-files', final.fingerprint);
    for (const directory of [privateDirectory, path.dirname(root), root]) await checkedDirectory(directory);
  }
  const roots = resultRoots(root, !server && !final ? entry.realPath : undefined);
  const checkSource = async () => {
    assertActive();
    if (entry.input.requirementsRevision !== snapshot.requirementsRevision || entry.input.specHash !== snapshot.specHash
      || entry.input.approvalRevision !== snapshot.approvalRevision
      || (final ? !eligibleFinal() : entry.environment !== 'closed' || !['paused', 'completed', 'failed'].includes(entry.state))) throw new Error('任务已继续或要求已变化，未继续领取文件。');
    if (final) {
      if (entry.finalFilesSnapshot?.fingerprint !== final.fingerprint || finalIdentity(entry)?.fingerprint !== final.fingerprint) throw new Error('最终成果快照已变化，未继续领取文件。');
    } else if (server) {
      if (entry.workspaceArchive?.id !== archive!.id || await projectCheckpoint(root, true, maxBytes) !== archive!.hash) throw new Error('归档已变更，未发布不一致的成果。');
    } else if (entry.state !== 'paused' || entry.checkpoint !== snapshot.checkpoint
      || await projectExecutionCheckpoint(entry.realPath!, privateDirectory) !== snapshot.checkpoint) throw new Error('本机阶段现场已变化，请重新核对成果。');
  };
  await checkSource();
  const files: ProjectFilesManifest['files'] = []; let omittedLinks = 0, bytes = 0, visited = 0;
  const finalChunks = new Map<string, string[]>();
  const append = async (name: string, expected?: { path: string; size: number; sha256: string }) => {
    const file = await regularFile(roots, name), digest = createHash('sha256');
    try {
      if (files.length >= MAX_PROJECT_FILES || (bytes += file.info.size) > maxBytes) throw new Error('成果文件数量或容量超过本任务的可领取范围。');
      if (final) {
        const buffer = Buffer.alloc(PROJECT_FILE_CHUNK_BYTES), chunks: string[] = [];
        for (let offset = 0; offset < file.info.size; offset += buffer.length) {
          assertActive();
          const chunk = await readChunk(file.handle, buffer, Math.min(buffer.length, file.info.size - offset), offset);
          chunks.push(createHash('sha256').update(chunk).digest('hex'));
          digest.update(chunk);
        }
        finalChunks.set(name, chunks);
      } else {
        for await (const chunk of file.handle.createReadStream({ autoClose: false })) { assertActive(); digest.update(chunk); }
      }
      await file.check();
      const sha256 = digest.digest('hex');
      if (expected && (expected.size !== file.info.size || expected.sha256 !== sha256)) throw new Error(final ? '冻结的最终文件与验收快照不一致。' : '阶段文件已变化，不能领取为原待审成果。');
      files.push({ path: name, size: file.info.size, sha256, ...(expected && !final ? { sourcePath: expected.path } : {}) });
    } finally { await file.handle.close(); }
  };
  const verificationOnly = new Set(entry.delivery?.verification?.dependencies?.map(file => file.publishedPath));
  const walk = async (relative: string) => {
    const directory = path.join(root, relative), info = await lstat(directory);
    if (info.isSymbolicLink()) { omittedLinks++; return; }
    if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error('成果目录身份不安全。');
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 100000) throw new Error('成果目录项过多，请缩小交付范围。');
      const name = relative + '/' + item.name, target = path.join(root, name), stat = await lstat(target);
      if (!isProjectResultPath(name) || verificationOnly.has(name)) continue;
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) { omittedLinks++; continue; }
      if (stat.isDirectory()) { await walk(name); continue; }
      if (!stat.isFile()) throw new Error('成果目录包含非普通文件。');
      projectFilePathSchema.parse(name);
      await append(name);
    }
  };
  if (final) {
    for (const expected of final.files) await append(expected.path, expected);
  } else if (selection) {
    if (!entry.realPath) throw new Error('阶段成果缺少原工作区路径。');
    const sourceDirectory = server ? path.dirname(entry.realPath) : privateDirectory;
    const sourceRoots = [['workspace', entry.realPath], ['temporary', path.join(sourceDirectory, 'temporary')], ['outputs', path.join(sourceDirectory, 'outputs')]];
    for (const expected of selection.files) {
      const absolute = path.resolve(entry.realPath, expected.path);
      const source = sourceRoots.map(([kind, directory]) => ({ kind, relative: path.relative(directory, absolute) }))
        .find(value => value.relative && value.relative !== '..' && !value.relative.startsWith('..' + path.sep) && !path.isAbsolute(value.relative));
      if (!source) throw new Error('阶段文件超出本任务的成果目录。');
      await append(projectFilePathSchema.parse(source.kind + '/' + source.relative.split(path.sep).join('/')), expected);
    }
  } else {
    for (const publicRoot of ['workspace', 'temporary', 'outputs']) {
      try { await lstat(path.join(root, publicRoot)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      await walk(publicRoot);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const value = projectFilesManifestSchema.parse({ snapshot, files, omittedLinks });
  assertActive();
  const started = await post({ action: 'begin', requestId: request.requestId, manifest: value });
  if (started.ready) return;
  if (!started.deliveryId) throw new Error('服务端未确认成果传输。');
  for (const expected of files) {
    const file = await regularFile(roots, expected.path), digest = createHash('sha256'); let offset = 0;
    try {
      const buffer = Buffer.alloc(PROJECT_FILE_CHUNK_BYTES);
      while (offset < expected.size) {
        assertActive();
        const size = Math.min(buffer.length, expected.size - offset);
        const bytes = final ? await readChunk(file.handle, buffer, size, offset)
          : buffer.subarray(0, (await file.handle.read(buffer, 0, size, offset)).bytesRead);
        if (!bytes.length) throw new Error('成果文件未读取完整。');
        if (final && createHash('sha256').update(bytes).digest('hex') !== finalChunks.get(expected.path)?.[offset / buffer.length]) {
          throw new Error('冻结的最终文件在传输中已变化。');
        }
        digest.update(bytes);
        await post({ action: 'chunk', requestId: request.requestId, deliveryId: started.deliveryId,
          path: expected.path, offset, data: bytes.toString('base64') }); offset += bytes.length;
      }
      await file.check();
      if (digest.digest('hex') !== expected.sha256) throw new Error('成果内容与清单不一致。');
    } finally { await file.handle.close(); }
  }
  await checkSource();
  await post({ action: 'commit', requestId: request.requestId, deliveryId: started.deliveryId });
}
