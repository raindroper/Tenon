import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { WorkspaceExecutor } from '../server/v2/workspace.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function replaceFixturePointer(file: string, value: string): void {
  // Git marks .git hidden on Windows. Opening the existing file preserves that attribute.
  const handle = openSync(file, 'r+');
  try { ftruncateSync(handle, 0); writeFileSync(handle, value); } finally { closeSync(handle); }
}
function fixture(names: { repo?: string; workspaces?: string } = {}): { directory: string; repo: string; workspaces: string; cleanup(): void } {
  const prefix = join(tmpdir(), 'rae-v2-workspace-test-'); const directory = mkdtempSync(prefix);
  const repo = join(directory, names.repo ?? 'source-repo'); mkdirSync(repo);
  git(repo, ['init']);
  writeFileSync(join(repo, 'config.json'), '{\n  "feature": { "enabled": false },\n  "title": "software fixture"\n}\n');
  writeFileSync(join(repo, 'notes.md'), 'Original software test fixture.\n');
  writeFileSync(join(repo, 'run.js'), 'throw new Error("Never execute repository scripts");\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  git(repo, ['add', '--', 'config.json', 'notes.md', 'run.js', '.gitignore']);
  git(repo, ['-c', 'user.name=Rae Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Test fixture baseline']);
  return { directory, repo, workspaces: join(directory, names.workspaces ?? 'detached-workspaces'), cleanup() {
    assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true });
  } };
}
const enabledJson = '{\n  "feature": { "enabled": true },\n  "title": "software fixture"\n}\n';

const workspacePathCases = [
  { name: 'ordinary paths' },
  { name: 'spaces and Unicode', repo: '源 仓库 [中文]', workspaces: '隔离 工作区 [中文]' },
  ...(process.platform === 'win32' ? [] : [{ name: 'POSIX quoted, newline and trailing-whitespace paths',
    repo: '源 "repo"\\名称\n下一行 \r', workspaces: '隔离 "work"\\目录\n下一行' }]),
];
for (const paths of workspacePathCases) test(`real detached Git worktree edits, verifies and hands off without changing the source tree (${paths.name})`, async () => {
  const f = fixture(paths); const executor = new WorkspaceExecutor(f.workspaces);
  try {
    const sourceBefore = readFileSync(join(f.repo, 'config.json'), 'utf8');
    const baseline = git(f.repo, ['rev-parse', 'HEAD']).trim();
    const grant = await executor.prepare({ caseId: 'case-real-json', repoRoot: f.repo, allowedFiles: ['config.json'],
      jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    assert.equal(grant.baselineCommit, baseline); assert.notEqual(grant.worktreePath, f.repo); assert.equal(grant.sourceWasDirty, false);
    assert.equal(git(grant.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD');
    const read = await executor.read(grant.caseId, 'config.json'); assert.equal(read.content, sourceBefore);
    const written = await executor.write(grant.caseId, 'config.json', enabledJson, read.sha256); assert.notEqual(written.sha256, read.sha256);
    const receipt = await executor.verify(grant.caseId); assert.equal(receipt.status, 'verified');
    assert.deepEqual(receipt.changedFiles, ['config.json']); assert.match(receipt.patch, /-.*false/); assert.match(receipt.patch, /\+.*true/);
    assert.match(receipt.diffStat, /config\.json/); assert.ok(receipt.checks.every(check => check.passed && check.exitCode === 0));
    assert.equal(receipt.fileHashes['config.json'], written.sha256);
    const handoff = await executor.handoff(grant.caseId); assert.equal(handoff.status, 'verified'); assert.ok(existsSync(handoff.worktreePath));
    assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), sourceBefore); assert.equal(git(f.repo, ['status', '--porcelain']), '');
  } finally { executor.close(); f.cleanup(); }
});

for (const mutation of ['branch', 'locked'] as const) test(`an authorized worktree changed to ${mutation} is rejected before file access and handoff`, async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  let restore: (() => void) | undefined;
  try {
    const sourceBefore = readFileSync(join(f.repo, 'config.json'), 'utf8');
    const grant = await executor.prepare({ caseId: 'case-registration-' + mutation, repoRoot: f.repo,
      allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    await executor.write(grant.caseId, 'config.json', enabledJson);
    assert.equal((await executor.verify(grant.caseId)).status, 'verified');
    if (mutation === 'branch') {
      git(grant.worktreePath, ['checkout', '-b', 'unexpected-branch']);
      restore = () => { git(grant.worktreePath, ['checkout', '--detach', grant.baselineCommit]); };
    } else {
      git(f.repo, ['worktree', 'lock', '--reason', 'fixture registration must stay blocked', grant.worktreePath]);
      restore = () => { git(f.repo, ['worktree', 'unlock', grant.worktreePath]); };
    }
    assert.equal(git(grant.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']).trim(), grant.baselineCommit,
      'A matching commit alone must not make a changed registration valid');
    await assert.rejects(executor.read(grant.caseId, 'config.json'), /worktree|detached|locked|registration/i);
    await assert.rejects(executor.write(grant.caseId, 'config.json', '{}'), /worktree|detached|locked|registration/i);
    const failed = await executor.verify(grant.caseId);
    assert.equal(failed.status, 'failed'); assert.equal(failed.patch, '');
    await assert.rejects(executor.handoff(grant.caseId));
    assert.equal(readFileSync(join(grant.worktreePath, 'config.json'), 'utf8'), enabledJson);
    assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), sourceBefore);
    restore(); restore = undefined;
    assert.equal((await executor.read(grant.caseId, 'config.json')).content, enabledJson);
    assert.equal((await executor.verify(grant.caseId)).status, 'verified');
  } finally { restore?.(); executor.close(); f.cleanup(); }
});

test('a forged registration back-pointer cannot redirect an existing workspace grant to another destination', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  let pointer: string | undefined; let originalPointer: string | undefined;
  try {
    const grant = await executor.prepare({ caseId: 'case-back-pointer', repoRoot: f.repo, allowedFiles: ['config.json'] });
    const admin = git(grant.worktreePath, ['rev-parse', '--absolute-git-dir']).trim();
    pointer = join(admin, 'gitdir'); originalPointer = readFileSync(pointer, 'utf8');
    const other = join(f.directory, 'unowned-destination'); mkdirSync(other);
    const outsideContent = '{"outside":"must remain unchanged"}\n';
    writeFileSync(join(other, 'config.json'), outsideContent);
    writeFileSync(join(other, '.git'), readFileSync(join(grant.worktreePath, '.git')));
    writeFileSync(pointer, join(other, '.git').replaceAll('\\', '/') + '\n');
    // Git still resolves the same commit/repository from the original .git file.
    assert.equal(git(grant.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']).trim(), grant.baselineCommit);
    await assert.rejects(executor.read(grant.caseId, 'config.json'), /worktree|registration/i);
    await assert.rejects(executor.write(grant.caseId, 'config.json', '{}'), /worktree|registration/i);
    assert.equal((await executor.verify(grant.caseId)).status, 'failed');
    await assert.rejects(executor.handoff(grant.caseId));
    assert.equal(readFileSync(join(other, 'config.json'), 'utf8'), outsideContent);
    assert.equal(readFileSync(join(grant.worktreePath, 'config.json'), 'utf8'), readFileSync(join(f.repo, 'config.json'), 'utf8'));
    writeFileSync(pointer, originalPointer); originalPointer = undefined;
    assert.equal((await executor.read(grant.caseId, 'config.json')).content, readFileSync(join(f.repo, 'config.json'), 'utf8'));
  } finally {
    if (pointer && originalPointer !== undefined) writeFileSync(pointer, originalPointer);
    executor.close(); f.cleanup();
  }
});

test('relative registration pointers preserve the detached workspace boundary without newer Git options', async () => {
  const f = fixture({ repo: '原 仓库', workspaces: '隔离 工作区' }); const executor = new WorkspaceExecutor(f.workspaces);
  let dotGit: string | undefined; let pointer: string | undefined;
  let originalDotGit: string | undefined; let originalPointer: string | undefined;
  try {
    const grant = await executor.prepare({ caseId: 'case-relative-registration', repoRoot: f.repo, allowedFiles: ['config.json'],
      jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    const admin = git(grant.worktreePath, ['rev-parse', '--absolute-git-dir']).trim();
    dotGit = join(grant.worktreePath, '.git'); pointer = join(admin, 'gitdir');
    originalDotGit = readFileSync(dotGit, 'utf8'); originalPointer = readFileSync(pointer, 'utf8');
    // Relative .git references are rooted at the checkout; gitdir back-pointers are rooted at its registration.
    replaceFixturePointer(dotGit, 'gitdir: ' + relative(grant.worktreePath, admin).replaceAll('\\', '/') + '\n');
    writeFileSync(pointer, relative(admin, dotGit).replaceAll('\\', '/') + '\n');
    const original = await executor.read(grant.caseId, 'config.json');
    assert.equal(original.content, readFileSync(join(f.repo, 'config.json'), 'utf8'));
    await executor.write(grant.caseId, 'config.json', enabledJson, original.sha256);
    assert.equal((await executor.verify(grant.caseId)).status, 'verified');
    assert.equal((await executor.handoff(grant.caseId)).baselineCommit, grant.baselineCommit);
    assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), original.content);
  } finally {
    if (dotGit && originalDotGit !== undefined) replaceFixturePointer(dotGit, originalDotGit);
    if (pointer && originalPointer !== undefined) writeFileSync(pointer, originalPointer);
    executor.close(); f.cleanup();
  }
});

test('malformed or missing registration files cannot authorize workspace access', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  let pointer: string | undefined; let originalPointer: string | undefined;
  try {
    const grant = await executor.prepare({ caseId: 'case-missing-registration', repoRoot: f.repo, allowedFiles: ['config.json'] });
    const admin = git(grant.worktreePath, ['rev-parse', '--absolute-git-dir']).trim();
    pointer = join(admin, 'gitdir'); originalPointer = readFileSync(pointer, 'utf8');
    const unchanged = readFileSync(join(grant.worktreePath, 'config.json'), 'utf8');
    for (const invalid of ['', '\n', '\uFEFF' + originalPointer,
      ...(process.platform === 'win32' ? [] : [`${grant.worktreePath}/missing-component/../.git\n`]), null]) {
      if (invalid === null) unlinkSync(pointer); else writeFileSync(pointer, invalid);
      await assert.rejects(executor.read(grant.caseId, 'config.json'));
      await assert.rejects(executor.write(grant.caseId, 'config.json', '{}'));
      assert.equal((await executor.verify(grant.caseId)).status, 'failed');
      assert.equal(readFileSync(join(grant.worktreePath, 'config.json'), 'utf8'), unchanged);
      writeFileSync(pointer, originalPointer);
      assert.equal((await executor.read(grant.caseId, 'config.json')).content, unchanged);
    }
  } finally {
    if (pointer && originalPointer !== undefined) writeFileSync(pointer, originalPointer);
    executor.close(); f.cleanup();
  }
});

test('no semantic rules yields prepared, while invalid JSON, rule mismatch and whitespace errors yield failed', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  try {
    const plain = await executor.prepare({ caseId: 'case-plain', repoRoot: f.repo, allowedFiles: ['notes.md'] });
    await executor.write(plain.caseId, 'notes.md', 'A prepared text result.\n');
    assert.equal((await executor.verify(plain.caseId)).status, 'prepared'); assert.equal((await executor.handoff(plain.caseId)).status, 'prepared');
    const json = await executor.prepare({ caseId: 'case-json', repoRoot: f.repo, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    assert.equal((await executor.verify(json.caseId)).status, 'failed');
    await executor.write(json.caseId, 'config.json', '{broken'); assert.equal((await executor.verify(json.caseId)).status, 'failed');
    await assert.rejects(executor.handoff(json.caseId), /receipt/);
    await executor.write(plain.caseId, 'notes.md', 'Trailing whitespace fixture.  \n');
    const whitespace = await executor.verify(plain.caseId); assert.equal(whitespace.status, 'failed');
    assert.ok(whitespace.checks.some(check => check.name === 'git.diff-check' && check.exitCode !== 0));
  } finally { executor.close(); f.cleanup(); }
});

test('grants and receipts persist across executor reopening; later writes invalidate the handoff', async () => {
  const f = fixture(); let executor = new WorkspaceExecutor(f.workspaces);
  try {
    await executor.prepare({ caseId: 'case-persist', repoRoot: f.repo, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    await executor.write('case-persist', 'config.json', enabledJson); const receipt = await executor.verify('case-persist');
    executor.close(); executor = new WorkspaceExecutor(f.workspaces);
    assert.equal(executor.getGrant('case-persist')?.latestReceipt?.id, receipt.id);
    assert.equal((await executor.handoff('case-persist')).receipt.id, receipt.id);
    await executor.write('case-persist', 'config.json', enabledJson.replace('software fixture', 'changed fixture'));
    assert.equal(executor.getGrant('case-persist')?.latestReceipt, undefined); await assert.rejects(executor.handoff('case-persist'), /receipt/);
    await executor.verify('case-persist');
    writeFileSync(join(executor.getGrant('case-persist')!.worktreePath, 'config.json'), enabledJson);
    await assert.rejects(executor.handoff('case-persist'), /invalidated/);
    assert.equal(executor.getGrant('case-persist')?.status, 'prepared');
  } finally { executor.close(); f.cleanup(); }
});

test('exact allowlists, traversal, executable extensions and optimistic hash conflicts are rejected', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  try {
    const grant = await executor.prepare({ caseId: 'case-paths', repoRoot: f.repo, allowedFiles: ['config.json', 'new/result.json'] });
    for (const path of ['../config.json', '.git/config.json', 'run.js', 'notes.md', 'C:/outside.json', 'new/../../outside.json', 'new\\escape.json']) {
      await assert.rejects(executor.read(grant.caseId, path)); await assert.rejects(executor.write(grant.caseId, path, '{}'));
    }
    const original = await executor.read(grant.caseId, 'config.json');
    await executor.write(grant.caseId, 'config.json', enabledJson, original.sha256);
    await assert.rejects(executor.write(grant.caseId, 'config.json', '{}', original.sha256), /optimistic hash/);
    assert.equal((await executor.read(grant.caseId, 'config.json')).content, enabledJson);
    await assert.rejects(executor.write(grant.caseId, 'config.json', 'x'.repeat(200 * 1024 + 1)), /200 KiB/);
    await executor.write(grant.caseId, 'new/result.json', '{"fixture":true}\n', null);
    const receipt = await executor.verify(grant.caseId); assert.equal(receipt.status, 'prepared'); assert.match(receipt.patch, /new\/result\.json/);
    assert.equal(existsSync(join(f.repo, 'new', 'result.json')), false);
    await assert.rejects(executor.prepare({ caseId: '../unsafe', repoRoot: f.repo, allowedFiles: ['notes.md'] }));
    await assert.rejects(executor.prepare({ caseId: 'case-code', repoRoot: f.repo, allowedFiles: ['run.js'] }), /data files/);
    await assert.rejects(executor.prepare({ caseId: grant.caseId, repoRoot: f.repo, allowedFiles: ['notes.md'] }), /different user grant/);
  } finally { executor.close(); f.cleanup(); }
});

test('junction or symlink paths cannot read or overwrite files outside the detached worktree', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  try {
    const grant = await executor.prepare({ caseId: 'case-links', repoRoot: f.repo, allowedFiles: ['folder/secret.json'] });
    const outside = join(f.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.json'), '{"fixture":"outside"}\n');
    symlinkSync(outside, join(grant.worktreePath, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(executor.read(grant.caseId, 'folder/secret.json'), /Symlinks/);
    await assert.rejects(executor.write(grant.caseId, 'folder/secret.json', '{}'), /Symlinks/);
    assert.equal(readFileSync(join(outside, 'secret.json'), 'utf8'), '{"fixture":"outside"}\n');
    assert.equal((await executor.verify(grant.caseId)).status, 'failed');
  } finally { executor.close(); f.cleanup(); }
});

test('unexpected changes including ignored files prevent verification and invalidate an existing receipt', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  try {
    const grant = await executor.prepare({ caseId: 'case-extra', repoRoot: f.repo, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    await executor.write(grant.caseId, 'config.json', enabledJson); assert.equal((await executor.verify(grant.caseId)).status, 'verified');
    writeFileSync(join(grant.worktreePath, 'notes.md'), 'Outside the grant.\n');
    await assert.rejects(executor.handoff(grant.caseId), /invalidated/);
    const failed = await executor.verify(grant.caseId); assert.equal(failed.status, 'failed'); assert.equal(failed.patch, '');
    assert.ok(failed.checks.some(check => check.name === 'files.allowlist' && !check.passed));
    git(grant.worktreePath, ['checkout', '--', 'notes.md']);
    mkdirSync(join(grant.worktreePath, 'ignored')); writeFileSync(join(grant.worktreePath, 'ignored', 'extra.txt'), 'Ignored is still a real unexpected change.\n');
    const ignored = await executor.verify(grant.caseId); assert.equal(ignored.status, 'failed'); assert.ok(ignored.changedFiles.includes('ignored/extra.txt'));
  } finally { executor.close(); f.cleanup(); }
});

test('Git hooks and configured clean/smudge/textconv helpers are not executed during prepare or verification', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  try {
    writeFileSync(join(f.repo, '.gitattributes'), '*.json filter=fixture diff=fixture\n');
    git(f.repo, ['add', '--', '.gitattributes']); git(f.repo, ['-c', 'user.name=Rae Test Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture attributes']);
    writeFileSync(join(f.repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch hook-fired.txt\n', { mode: 0o755 });
    git(f.repo, ['config', 'filter.fixture.smudge', 'touch smudge-fired.txt; cat']);
    git(f.repo, ['config', 'filter.fixture.clean', 'touch clean-fired.txt; cat']);
    git(f.repo, ['config', 'diff.fixture.textconv', 'touch textconv-fired.txt; cat']);
    const grant = await executor.prepare({ caseId: 'case-no-exec', repoRoot: f.repo, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] });
    await executor.write(grant.caseId, 'config.json', enabledJson);
    assert.equal((await executor.verify(grant.caseId)).status, 'verified');
    for (const file of ['hook-fired.txt', 'smudge-fired.txt', 'clean-fired.txt', 'textconv-fired.txt']) {
      assert.equal(existsSync(join(grant.worktreePath, file)), false); assert.equal(existsSync(join(f.repo, file)), false);
    }
  } finally { executor.close(); f.cleanup(); }
});

test('inherited Git environment cannot redirect the index and literal bracket paths remain exact', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.workspaces);
  const before = process.env.GIT_INDEX_FILE; const poisonedIndex = join(f.directory, 'must-not-be-created.index');
  process.env.GIT_INDEX_FILE = poisonedIndex;
  try {
    const grant = await executor.prepare({ caseId: 'case-env', repoRoot: f.repo, allowedFiles: ['result[1].json'],
      jsonRules: [{ file: 'result[1].json', path: ['fixture'], equals: true }] });
    await executor.write(grant.caseId, 'result[1].json', '{"fixture":true}\n');
    const receipt = await executor.verify(grant.caseId); assert.equal(receipt.status, 'verified');
    assert.deepEqual(receipt.changedFiles, ['result[1].json']); assert.match(receipt.patch, /result\[1\]\.json/);
    assert.equal(existsSync(poisonedIndex), false);
  } finally {
    if (before === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = before;
    executor.close(); f.cleanup();
  }
});

test('revocation persists and rejects every model workspace capability without deleting the worktree', async () => {
  const f = fixture(); let executor = new WorkspaceExecutor(f.workspaces);
  const input = { caseId: 'case-revoked', repoRoot: f.repo, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['feature', 'enabled'], equals: true }] };
  try {
    const grant = await executor.prepare(input); await executor.write(grant.caseId, 'config.json', enabledJson);
    assert.equal((await executor.verify(grant.caseId)).status, 'verified');
    await executor.revoke(grant.caseId); assert.ok(executor.getGrant(grant.caseId)?.revokedAt);
    assert.equal(executor.getGrant(grant.caseId)?.latestReceipt, undefined);
    assert.ok(existsSync(grant.worktreePath)); assert.equal(readFileSync(join(grant.worktreePath, 'config.json'), 'utf8'), enabledJson);
    for (const access of [() => executor.read(grant.caseId, 'config.json'), () => executor.write(grant.caseId, 'config.json', '{}'),
      () => executor.verify(grant.caseId), () => executor.handoff(grant.caseId), () => executor.prepare(input)]) await assert.rejects(access(), /revoked/);
    const revokedAt = executor.getGrant(grant.caseId)!.revokedAt;
    executor.close(); executor = new WorkspaceExecutor(f.workspaces);
    assert.equal(executor.getGrant(grant.caseId)?.revokedAt, revokedAt);
    await assert.rejects(executor.read(grant.caseId, 'config.json'), /revoked/);
    await assert.rejects(executor.write(grant.caseId, 'config.json', '{}'), /revoked/);
    await assert.rejects(executor.verify(grant.caseId), /revoked/);
    await assert.rejects(executor.handoff(grant.caseId), /revoked/);
    await assert.rejects(executor.prepare(input), /revoked/);
    assert.ok(existsSync(grant.worktreePath)); assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8').includes('false'), true);
  } finally { executor.close(); f.cleanup(); }
});
