import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import * as lockfile from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireRuntimeLease, type RuntimeLease } from '../runtime-lease.js';

export interface WorkspaceJsonRule { file: string; path: string[]; equals: unknown }
export type WorkspaceState = 'prepared' | 'verified' | 'failed';
export interface WorkspaceCheck { name: string; exitCode: number; passed: boolean; detail: string }
export interface WorkspaceReceipt {
  id: string; caseId: string; worktreePath: string; baselineCommit: string; status: WorkspaceState;
  changedFiles: string[]; fileHashes: Record<string, string | null>; checks: WorkspaceCheck[];
  diffStat: string; patch: string; createdAt: string;
  authorizationRevision: number;
}
export interface WorkspaceGrant {
  caseId: string; repoRoot: string; worktreePath: string; baselineCommit: string; allowedFiles: string[];
  jsonRules: WorkspaceJsonRule[]; createdAt: string; sourceWasDirty: boolean;
  status: WorkspaceState; latestReceipt?: WorkspaceReceipt; revokedAt?: string;
  revision: number; progressRevision: number; specFingerprint: string; repoIdentity?: string;
}
export interface WorkspaceFile { relativePath: string; content: string; sha256: string }
export interface WorkspaceHandoff { caseId: string; worktreePath: string; baselineCommit: string; status: WorkspaceState; receipt: WorkspaceReceipt }
interface GitResult { exitCode: number; stdout: string; stderr: string }
type GrantSpec = Omit<WorkspaceGrant, 'status' | 'latestReceipt' | 'revokedAt' | 'revision' | 'progressRevision'>;
interface PrepareIntent extends GrantSpec {
  state: 'preparing' | 'ready' | 'failed' | 'revoked'; intentRevision: number; unownedDestination?: boolean; lastError?: string; revokedAt?: string;
}
const MAX_FILE_BYTES = 200 * 1024;
const caseIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const prepareSchema = z.object({ caseId: caseIdSchema, repoRoot: z.string().min(1),
  allowedFiles: z.array(z.string().min(1)).min(1).max(50),
  jsonRules: z.array(z.object({ file: z.string().min(1), path: z.array(z.string().max(500)).max(50), equals: z.json() }).strict()).max(100).optional(),
}).strict();
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
// rev-parse writes one path followed by LF. Whitespace within that path is significant.
const gitPath = (output: string): string => {
  if (!output.endsWith('\n') || output.includes('\0') || !isAbsolute(output.slice(0, -1))) throw new Error('Git returned an invalid absolute path');
  return output.slice(0, -1);
};
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const contained = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

/**
 * A narrow data-file editor, not an OS sandbox. Only a trusted user/API calls prepare;
 * model tools may receive read/write/verify for an existing case, never prepare or Git command access.
 * Git hooks, configured filters, fsmonitor, external diff and textconv are disabled.
 */
export class WorkspaceExecutor {
  private readonly base: string;
  private readonly db: DatabaseSync;
  private readonly emptyConfig: string;
  private readonly hooks: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(workspaceBase: string) {
    if (!isAbsolute(workspaceBase)) throw new Error('Workspace base must be an absolute path');
    this.base = resolve(workspaceBase); mkdirSync(this.base, { recursive: true, mode: 0o700 });
    this.emptyConfig = resolve(this.base, '.empty-git-config'); this.hooks = resolve(this.base, '.empty-hooks');
    mkdirSync(this.hooks, { recursive: true, mode: 0o700 });
    writeFileSync(this.emptyConfig, '', { mode: 0o600 });
    const file = resolve(this.base, 'workspaces.sqlite'); this.db = new DatabaseSync(file);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace_grants (case_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_authorizations (case_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, revision INTEGER NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS workspace_progress (case_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, receipt_json TEXT);
      CREATE TABLE IF NOT EXISTS workspace_prepare_intents (case_id TEXT PRIMARY KEY, json TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL);`);
    // Copy legacy data once. Mutable progress can never rewrite the immutable authorization row.
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT case_id,json FROM workspace_grants').all()) {
        const old = JSON.parse(String(row.json)) as WorkspaceGrant;
        const { status, latestReceipt, revokedAt, revision: _revision, progressRevision: _progress, ...input } = old;
        const spec: GrantSpec = { ...input, specFingerprint: old.specFingerprint ?? hash(canonical({ caseId: old.caseId, repoRoot: old.repoRoot, allowedFiles: old.allowedFiles, jsonRules: old.jsonRules })) };
        const inserted = this.db.prepare('INSERT OR IGNORE INTO workspace_authorizations(case_id,spec_json,revision,revoked_at) VALUES(?,?,1,?)').run(String(row.case_id), JSON.stringify(spec), revokedAt ?? null);
        if (inserted.changes) this.db.prepare('INSERT INTO workspace_progress(case_id,revision,status,receipt_json) VALUES(?,1,?,?)')
          .run(String(row.case_id), revokedAt ? 'prepared' : status, !revokedAt && latestReceipt ? JSON.stringify({ ...latestReceipt, authorizationRevision: 1 }) : null);
      }
    });
  }
  private locked<T>(caseId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(caseId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.queues.set(caseId, current);
    void current.finally(() => { if (this.queues.get(caseId) === current) this.queues.delete(caseId); }).catch(() => undefined);
    return current;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** A shared filesystem lease linearizes physical commits across objects and processes. */
  private async commitLocked<T>(caseId: string, work: (assertCommit: () => void) => Promise<T>): Promise<T> {
    caseIdSchema.parse(caseId);
    const root = resolve(this.base, '.commit-leases'); const directory = resolve(root, caseId);
    if (await realpath(this.base) !== this.base) throw new Error('Workspace base must not be a symlink');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Workspace commit lease root must not be a symlink');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Workspace commit lease must not be a symlink');
    const deadline = Date.now() + 45000; let lease: RuntimeLease;
    for (;;) {
      try { lease = await acquireRuntimeLease(directory); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error; await delay(25); }
    }
    const assertCommit = () => lease.assertOwned(directory);
    try { assertCommit(); const result = await work(assertCommit); assertCommit(); return result; }
    finally { await lease.release(); }
  }
  private path(value: string): string {
    if (!value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[\\\0]/.test(value)) throw new Error('Only exact repository-relative paths are allowed');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) {
      throw new Error('Unsafe relative path');
    }
    if (!['.txt', '.md', '.json'].includes(extname(value).toLowerCase())) throw new Error('Only UTF-8 txt, md and json data files are allowed');
    return value;
  }
  private async git(cwd: string, args: string[], extra: string[] = []): Promise<GitResult> {
    const environment = { ...process.env };
    // A parent process's GIT_INDEX_FILE/GIT_DIR/config injection must never redirect these commands.
    for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
    const options = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${this.hooks}`, '-c', `core.attributesFile=${this.emptyConfig}`,
      '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'core.quotePath=false', '-c', 'submodule.recurse=false', ...extra, '-C', cwd, ...args];
    return new Promise(done => {
      execFile('git', options, { shell: false, windowsHide: true, timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.emptyConfig, GIT_ATTR_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1' },
      }, (error, stdout, stderr) => done({ exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0,
        stdout: String(stdout), stderr: String(stderr) }));
    });
  }
  private async grantGit(grant: WorkspaceGrant, args: string[], extra: string[] = []): Promise<GitResult> {
    this.assertAuthorization(grant); const result = await this.git(grant.worktreePath, args, extra); this.assertAuthorization(grant); return result;
  }
  private async filters(repoRoot: string, guard?: () => void): Promise<string[]> {
    guard?.();
    const listed = await this.git(repoRoot, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
    guard?.();
    if (listed.exitCode !== 0 && listed.exitCode !== 1) throw new Error('Cannot inspect repository Git filters');
    const drivers = new Set(listed.stdout.split(/\r?\n/).map(line => line.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/)?.[1]).filter((value): value is string => Boolean(value)));
    return [...drivers].flatMap(driver => ['-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`]);
  }
  getGrant(caseId: string): WorkspaceGrant | undefined {
    caseIdSchema.parse(caseId);
    const row = this.db.prepare(`SELECT a.spec_json,a.revision,a.revoked_at,p.revision AS progress_revision,p.status,p.receipt_json
      FROM workspace_authorizations a JOIN workspace_progress p ON p.case_id=a.case_id WHERE a.case_id=?`).get(caseId);
    if (!row) return undefined;
    return { ...JSON.parse(String(row.spec_json)) as GrantSpec, revision: Number(row.revision), progressRevision: Number(row.progress_revision),
      status: String(row.status) as WorkspaceState, ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {}),
      ...(row.receipt_json ? { latestReceipt: JSON.parse(String(row.receipt_json)) as WorkspaceReceipt } : {}) };
  }
  private assertAuthorization(grant: WorkspaceGrant, progress = false): void {
    const current = this.getGrant(grant.caseId);
    if (!current || current.revokedAt) throw new Error('Workspace authorization has been revoked or removed');
    if (current.revision !== grant.revision || current.specFingerprint !== grant.specFingerprint) throw new Error('Workspace authorization revision changed');
    if (progress && current.progressRevision !== grant.progressRevision) throw new Error('Workspace progress revision changed; retry from current state');
  }
  private saveProgress(grant: WorkspaceGrant): void {
    this.assertAuthorization(grant, true);
    const result = this.db.prepare(`UPDATE workspace_progress SET revision=revision+1,status=?,receipt_json=?
      WHERE case_id=? AND revision=? AND EXISTS(SELECT 1 FROM workspace_authorizations a WHERE a.case_id=? AND a.revision=? AND a.revoked_at IS NULL)`)
      .run(grant.status, grant.latestReceipt ? JSON.stringify(grant.latestReceipt) : null, grant.caseId, grant.progressRevision, grant.caseId, grant.revision);
    if (!result.changes) throw new Error('Workspace authorization or progress revision changed before commit');
    grant.progressRevision++;
  }
  private requireGrant(caseId: string): WorkspaceGrant {
    const grant = this.getGrant(caseId); if (!grant) throw new Error('No user-authorized workspace grant exists for this case');
    if (grant.revokedAt) throw new Error('Workspace grant has been revoked');
    return grant;
  }
  async revoke(caseId: string): Promise<void> {
    caseIdSchema.parse(caseId);
    // Revocation is effective at this serialized commit, never halfway through another physical commit.
    return this.commitLocked(caseId, async assertCommit => { assertCommit(); this.transaction(() => {
      const grant = this.getGrant(caseId); const intent = this.getPreparation(caseId);
      if (!grant && !intent) throw new Error('No workspace grant or preparation intent exists for this case');
      const at = grant?.revokedAt ?? intent?.revokedAt ?? new Date().toISOString();
      this.db.prepare('UPDATE workspace_authorizations SET revision=revision+1,revoked_at=? WHERE case_id=? AND revoked_at IS NULL').run(at, caseId);
      this.db.prepare("UPDATE workspace_progress SET revision=revision+1,status='prepared',receipt_json=NULL WHERE case_id=?").run(caseId);
      if (intent) { intent.state = 'revoked'; intent.revokedAt = at; this.db.prepare("UPDATE workspace_prepare_intents SET revision=revision+1,status='revoked',json=? WHERE case_id=?").run(JSON.stringify(intent), caseId); }
    }); });
  }
  getPreparation(caseId: string): PrepareIntent | undefined {
    caseIdSchema.parse(caseId); const row = this.db.prepare('SELECT json,revision,status FROM workspace_prepare_intents WHERE case_id=?').get(caseId);
    return row ? { ...JSON.parse(String(row.json)) as PrepareIntent, intentRevision: Number(row.revision), state: String(row.status) as PrepareIntent['state'] } : undefined;
  }
  private async repositoryIdentity(repoRoot: string, guard?: () => void): Promise<string> {
    guard?.();
    const common = await this.git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    guard?.();
    if (common.exitCode) throw new Error('Cannot identify the source Git repository');
    const path = await realpath(gitPath(common.stdout)); guard?.(); const info = await lstat(path, { bigint: true }); guard?.();
    return canonical({ commonDir: path, dev: String(info.dev), ino: String(info.ino) });
  }
  private async preparedIdentity(intent: GrantSpec, guard?: () => void): Promise<void> {
    guard?.();
    const rootInfo = await lstat(intent.worktreePath);
    guard?.();
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(intent.worktreePath) !== intent.worktreePath || !contained(this.base, intent.worktreePath)) throw new Error('Worktree path no longer matches its preparation intent');
    const top = await this.git(intent.worktreePath, ['rev-parse', '--show-toplevel']);
    guard?.();
    const head = await this.git(intent.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    guard?.();
    if (top.exitCode || head.exitCode || await realpath(gitPath(top.stdout)) !== intent.worktreePath || head.stdout.trim() !== intent.baselineCommit) throw new Error('Worktree root or baseline commit changed');
    const sourceIdentity = await this.repositoryIdentity(intent.repoRoot, guard); const targetIdentity = await this.repositoryIdentity(intent.worktreePath, guard);
    if (sourceIdentity !== targetIdentity || intent.repoIdentity && sourceIdentity !== intent.repoIdentity) throw new Error('Worktree belongs to another repository identity');
    // Git 2.34 has neither list -z nor safe newline quoting in porcelain paths.
    // Verify the same bidirectional registration that Git itself validates instead of parsing a listing.
    const directory = await this.git(intent.worktreePath, ['rev-parse', '--absolute-git-dir']);
    guard?.();
    if (directory.exitCode) throw new Error('Cannot identify the registered worktree directory');
    const admin = resolve(gitPath(directory.stdout));
    const registrations = resolve((JSON.parse(sourceIdentity) as { commonDir: string }).commonDir, 'worktrees');
    if (dirname(admin) !== registrations) throw new Error('Worktree registration is outside the source repository');
    for (const path of [registrations, admin]) {
      const info = await lstat(path); guard?.();
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Invalid Git worktree registration directory');
      guard?.();
    }
    const dotGit = resolve(intent.worktreePath, '.git');
    const pointer = await this.registrationPointer(dotGit); guard?.();
    const backlink = await this.registrationPointer(resolve(admin, 'gitdir')); guard?.();
    const rawPath = (base: string, value: string) => isAbsolute(value) ? value : `${base}${sep}${value}`;
    if (!pointer.startsWith('gitdir: ') || await realpath(rawPath(intent.worktreePath, pointer.slice(8))) !== admin
      || resolve(admin, backlink) !== dotGit || await realpath(rawPath(admin, backlink)) !== dotGit
      || await realpath(dotGit) !== dotGit) throw new Error('Git worktree registration pointers do not match the prepared workspace');
    guard?.();
    let locked = false;
    try { await lstat(resolve(admin, 'locked')); locked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    guard?.();
    if (locked) throw new Error('Git worktree registration is locked or still initializing');
    const branch = await this.git(intent.worktreePath, ['symbolic-ref', '--quiet', 'HEAD']);
    guard?.();
    if (branch.exitCode !== 1) throw new Error('Workspace must remain a detached Git worktree');
  }
  private async registrationPointer(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new Error('Invalid Git worktree registration file');
    const bytes = await readFile(path);
    if (bytes.length > 65_536) throw new Error('Invalid Git worktree registration file');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (!value || value.includes('\0')) throw new Error('Invalid Git worktree registration pointer');
    return value;
  }
  private putIntent(intent: PrepareIntent): void {
    const result = this.db.prepare('UPDATE workspace_prepare_intents SET json=?,revision=revision+1,status=? WHERE case_id=? AND revision=? AND status<>?')
      .run(JSON.stringify(intent), intent.state, intent.caseId, intent.intentRevision, 'revoked');
    if (!result.changes) throw new Error('Preparation intent was revoked or its revision changed');
    intent.intentRevision++;
  }
  private commitPreparation(intent: PrepareIntent): WorkspaceGrant {
    return this.transaction(() => {
      const current = this.getPreparation(intent.caseId);
      if (!current || current.state === 'revoked' || current.intentRevision !== intent.intentRevision || current.specFingerprint !== intent.specFingerprint) throw new Error('Preparation authorization was revoked or changed');
      const { state: _state, intentRevision: _revision, unownedDestination: _unknown, lastError: _error, revokedAt: _revoked, ...spec } = intent;
      this.db.prepare('INSERT INTO workspace_authorizations(case_id,spec_json,revision,revoked_at) VALUES(?,?,1,NULL)').run(intent.caseId, JSON.stringify(spec));
      this.db.prepare("INSERT INTO workspace_progress(case_id,revision,status,receipt_json) VALUES(?,1,'prepared',NULL)").run(intent.caseId);
      intent.state = 'ready'; this.putIntent(intent); return this.getGrant(intent.caseId)!;
    });
  }
  async prepare(input: { caseId: string; repoRoot: string; allowedFiles: string[]; jsonRules?: WorkspaceJsonRule[] }): Promise<WorkspaceGrant> {
    const parsed = prepareSchema.parse(input);
    const allowedFiles = [...new Set(parsed.allowedFiles.map(file => this.path(file)))].sort();
    const jsonRules: WorkspaceJsonRule[] = parsed.jsonRules ?? [];
    for (const rule of jsonRules) {
      this.path(rule.file);
      if (!allowedFiles.includes(rule.file) || extname(rule.file).toLowerCase() !== '.json') throw new Error('JSON rules must target an allowed JSON file');
      if (Buffer.byteLength(JSON.stringify(rule.equals)) > MAX_FILE_BYTES) throw new Error('JSON rule is too large');
    }
    if (!isAbsolute(parsed.repoRoot)) throw new Error('Repository root must be absolute');
    return this.locked(parsed.caseId, async () => {
      const anchor = resolve(this.base, `.prepare-${parsed.caseId}.anchor`);
      try { writeFileSync(anchor, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const anchorInfo = await lstat(anchor); if (!anchorInfo.isFile() || anchorInfo.isSymbolicLink()) throw new Error('Preparation lock anchor must be a regular owned file');
      let compromised: Error | undefined;
      const release = await lockfile.lock(anchor, { stale: 30000, update: 10000, retries: { retries: 100, minTimeout: 25, maxTimeout: 200 },
        onCompromised: error => { compromised = error; } });
      const assertPreparation = () => { if (compromised) throw compromised; };
      try {
        return await this.commitLocked(parsed.caseId, assertCommit => this.prepareNow(parsed, allowedFiles, jsonRules, assertCommit, assertPreparation));
      } finally { await release(); }
    });
  }
  private async prepareNow(
    parsed: z.infer<typeof prepareSchema>, allowedFiles: string[], jsonRules: WorkspaceJsonRule[],
    assertCommit: () => void, assertPreparation: () => void,
  ): Promise<WorkspaceGrant> {
    let intent: PrepareIntent | undefined;
    try {
      const sourceInfo = await lstat(parsed.repoRoot);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Repository root must be a real directory');
      const repoRoot = await realpath(parsed.repoRoot);
      const baseReal = await realpath(this.base);
      if (baseReal !== this.base) throw new Error('Workspace base must not be a symlink');
      if (repoRoot === this.base) throw new Error('Workspace base cannot be the source repository');
      const existing = this.getGrant(parsed.caseId);
      if (existing) {
        if (existing.revokedAt) throw new Error('Workspace grant has been revoked; a new grant version is required');
        if (existing.repoRoot !== repoRoot || !isDeepStrictEqual(existing.allowedFiles, allowedFiles) || !isDeepStrictEqual(existing.jsonRules, jsonRules)) throw new Error('This case already has a different user grant');
        await this.validateWorkspace(existing); this.assertAuthorization(existing, true); return existing;
      }
      const top = await this.git(repoRoot, ['rev-parse', '--show-toplevel']);
      if (top.exitCode || await realpath(gitPath(top.stdout)) !== repoRoot) throw new Error('repoRoot must be the exact Git working-tree root');
      const disabledFilters = await this.filters(repoRoot);
      const worktreePath = resolve(this.base, parsed.caseId);
      if (!contained(this.base, worktreePath) || worktreePath === this.base) throw new Error('Invalid worktree destination');
      const specFingerprint = hash(canonical({ caseId: parsed.caseId, repoRoot, worktreePath, allowedFiles, jsonRules }));
      const repoIdentity = await this.repositoryIdentity(repoRoot);
      let destinationExists = false;
      try { await lstat(worktreePath); destinationExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      intent = this.getPreparation(parsed.caseId);
      if (intent) {
        if (intent.state === 'revoked') throw new Error('Workspace preparation was revoked; a new grant version is required');
        if (intent.specFingerprint !== specFingerprint || intent.repoRoot !== repoRoot || intent.worktreePath !== worktreePath || intent.repoIdentity !== repoIdentity) throw new Error('Existing preparation intent has another specification or repository identity');
        if (intent.unownedDestination && destinationExists) throw new Error('Existing workspace destination is unowned; preserve it and resolve manually');
        intent.state = 'preparing'; intent.unownedDestination = false; delete intent.lastError; this.putIntent(intent);
      } else {
        const head = await this.git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
        if (head.exitCode || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) throw new Error('Repository must have a baseline commit');
        const sourceState = await this.git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], disabledFilters);
        if (sourceState.exitCode) throw new Error('Cannot inspect source repository');
        intent = { caseId: parsed.caseId, repoRoot, repoIdentity, worktreePath, baselineCommit: head.stdout.trim(), allowedFiles, jsonRules, specFingerprint,
          createdAt: new Date().toISOString(), sourceWasDirty: Boolean(sourceState.stdout), state: destinationExists ? 'failed' : 'preparing', intentRevision: 1,
          ...(destinationExists ? { unownedDestination: true, lastError: 'Destination existed before the durable preparation intent' } : {}) };
        // This commit is before Git worktree creation; an absent journal means no Git side effect is attempted.
        this.db.prepare('INSERT INTO workspace_prepare_intents(case_id,json,revision,status) VALUES(?,?,1,?)').run(intent.caseId, JSON.stringify(intent), intent.state);
        if (destinationExists) throw new Error('Workspace destination already exists without an owned preparation intent');
      }
      assertPreparation();
      if (!destinationExists) {
        assertCommit();
        const current = this.getPreparation(intent.caseId); if (current?.state === 'revoked' || current?.intentRevision !== intent.intentRevision) throw new Error('Preparation authorization was revoked or changed before Git creation');
        const add = await this.git(repoRoot, ['worktree', 'add', '--detach', '--', worktreePath, intent.baselineCommit], disabledFilters);
        if (add.exitCode) throw new Error('Git could not create the detached worktree; preparation intent is retained for inspection');
      }
      await this.preparedIdentity(intent);
      const index = await this.git(worktreePath, ['diff', '--cached', '--quiet', intent.baselineCommit, '--'], disabledFilters);
      if (index.exitCode) throw new Error('Prepared worktree index is incomplete or diverged from its recorded baseline');
      const candidate: WorkspaceGrant = { ...intent, revision: 1, progressRevision: 1, status: 'prepared' };
      for (const file of allowedFiles) await this.safePath(candidate, file, true);
      assertPreparation();
      assertCommit();
      return this.commitPreparation(intent);
    } catch (error) {
      if (intent) {
        try { intent.state = 'failed'; intent.lastError = error instanceof Error ? error.message.slice(0, 1000) : 'Preparation failed'; this.putIntent(intent); } catch { /* A newer revocation or journal failure must never be overwritten. */ }
      }
      // Keep a created destination: deleting it on metadata failure destroys evidence and makes recovery ambiguous.
      throw error;
    }
  }
  private async validateWorkspace(grant: WorkspaceGrant): Promise<void> {
    this.assertAuthorization(grant); await this.preparedIdentity(grant, () => this.assertAuthorization(grant)); this.assertAuthorization(grant);
  }
  private async safePath(grant: WorkspaceGrant, value: string, allowMissing: boolean): Promise<string> {
    const file = this.path(value);
    if (!grant.allowedFiles.includes(file)) throw new Error('File is outside the exact user allowlist');
    const destination = resolve(grant.worktreePath, file);
    if (!contained(grant.worktreePath, destination)) throw new Error('File escapes its worktree');
    let current = grant.worktreePath;
    const parts = file.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !contained(grant.worktreePath, await realpath(current))) throw new Error('Symlinks and junctions are not allowed in file paths');
        if (index < parts.length - 1 && !info.isDirectory()) throw new Error('File parent is not a directory');
        if (index === parts.length - 1 && !info.isFile()) throw new Error('Allowed path is not a regular file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw error;
        break;
      }
    }
    return destination;
  }
  private async readFile(grant: WorkspaceGrant, file: string): Promise<WorkspaceFile | null> {
    this.assertAuthorization(grant);
    const path = await this.safePath(grant, file, true);
    this.assertAuthorization(grant);
    let handle;
    try { handle = await open(path, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.assertAuthorization(grant); return null; } throw error; }
    try {
      const before = await handle.stat({ bigint: true });
      const pathInfo = await lstat(path, { bigint: true });
      if (!before.isFile() || pathInfo.isSymbolicLink() || before.ino !== pathInfo.ino || before.dev !== pathInfo.dev || !contained(grant.worktreePath, await realpath(path))) throw new Error('File identity changed during access');
      if (before.size > BigInt(MAX_FILE_BYTES)) throw new Error('Data file exceeds 200 KiB');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let size = 0;
      for (;;) { this.assertAuthorization(grant); const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size); size += bytesRead; if (!bytesRead || size === buffer.length) break; }
      const after = await handle.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size) throw new Error('File changed during access');
      if (size > MAX_FILE_BYTES) throw new Error('Data file exceeds 200 KiB');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); } catch { throw new Error('Data file must be valid UTF-8'); }
      if (content.includes('\0')) throw new Error('Binary data is not allowed');
      this.assertAuthorization(grant); return { relativePath: file, content, sha256: hash(buffer.subarray(0, size)) };
    } finally { await handle.close(); }
  }
  read(caseId: string, relativePath: string): Promise<WorkspaceFile> {
    return this.locked(caseId, () => this.commitLocked(caseId, async assertCommit => {
      const grant = this.requireGrant(caseId); await this.validateWorkspace(grant);
      assertCommit(); const file = await this.readFile(grant, relativePath); if (!file) throw new Error('Allowed data file does not exist'); this.assertAuthorization(grant); assertCommit(); return file;
    }));
  }
  write(caseId: string, relativePath: string, content: string, expectedSha256?: string | null): Promise<{ relativePath: string; sha256: string; bytes: number }> {
    return this.locked(caseId, async () => {
      if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Content must be UTF-8 text of at most 200 KiB');
      const grant = this.requireGrant(caseId); await this.validateWorkspace(grant);
      const destination = await this.safePath(grant, relativePath, true);
      const before = await this.readFile(grant, relativePath);
      if (expectedSha256 !== undefined && (before?.sha256 ?? null) !== expectedSha256) throw new Error('File changed since it was read; optimistic hash does not match');
      this.assertAuthorization(grant, true); await mkdir(dirname(destination), { recursive: true });
      await this.safePath(grant, relativePath, true);
      const temporary = resolve(dirname(destination), `.rae-write-${randomUUID()}.tmp`);
      try {
        this.assertAuthorization(grant, true); const handle = await open(temporary, 'wx', 0o600);
        try { this.assertAuthorization(grant, true); await handle.writeFile(content, 'utf8'); this.assertAuthorization(grant, true); await handle.sync(); } finally { await handle.close(); }
        return await this.commitLocked(caseId, async assertCommit => {
        assertCommit(); this.assertAuthorization(grant, true);
        const beforeRename = await this.readFile(grant, relativePath);
        if ((beforeRename?.sha256 ?? null) !== (before?.sha256 ?? null)) throw new Error('File changed during write preparation');
        await this.safePath(grant, relativePath, true); assertCommit(); this.assertAuthorization(grant, true);
        // Invalidate old receipts and win the CAS before the physical rename. CAS failure cannot overwrite a winner.
        delete grant.latestReceipt; grant.status = 'prepared'; this.saveProgress(grant);
        assertCommit(); await rename(temporary, destination);
        const written = await this.readFile(grant, relativePath);
        if (!written || written.sha256 !== hash(content)) throw new Error('Written content could not be verified by rereading');
        assertCommit(); this.assertAuthorization(grant, true);
        return { relativePath, sha256: written.sha256, bytes: Buffer.byteLength(content) };
        });
      } finally { await rm(temporary, { force: true }); }
    });
  }
  private changedPaths(output: string): string[] {
    const records = output.split('\0'); const paths = new Set<string>();
    for (let index = 0; index < records.length; index++) {
      const record = records[index]; if (!record) continue;
      paths.add(record.slice(3)); if (/[RC]/.test(record.slice(0, 2)) && records[index + 1]) paths.add(records[++index]);
    }
    return [...paths].sort();
  }
  private async changes(grant: WorkspaceGrant, filters: string[]): Promise<{ paths: string[]; exitCode: number; detail: string }> {
    this.assertAuthorization(grant);
    const state = await this.grantGit(grant, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], filters);
    const ignored = await this.grantGit(grant, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], filters);
    return { paths: [...new Set([...this.changedPaths(state.stdout), ...ignored.stdout.split('\0').filter(Boolean)])].sort(),
      exitCode: state.exitCode || ignored.exitCode, detail: state.stderr || ignored.stderr };
  }
  verify(caseId: string): Promise<WorkspaceReceipt> {
    return this.locked(caseId, () => this.commitLocked(caseId, assertCommit => this.verifyNow(this.requireGrant(caseId), assertCommit)));
  }
  private async verifyNow(grant: WorkspaceGrant, assertCommit: () => void): Promise<WorkspaceReceipt> {
    const receipt: WorkspaceReceipt = { id: randomUUID(), caseId: grant.caseId, worktreePath: grant.worktreePath, baselineCommit: grant.baselineCommit,
      authorizationRevision: grant.revision, status: 'prepared', changedFiles: [], fileHashes: Object.create(null) as Record<string, string | null>, checks: [], diffStat: '', patch: '', createdAt: new Date().toISOString() };
    const check = (name: string, exitCode: number, detail: string): void => { receipt.checks.push({ name, exitCode, passed: exitCode === 0, detail }); };
    try {
      await this.validateWorkspace(grant); check('worktree.boundary', 0, 'Detached worktree root and baseline commit match the user grant');
      const filters = await this.filters(grant.worktreePath, () => this.assertAuthorization(grant));
      const state = await this.changes(grant, filters);
      receipt.changedFiles = state.paths; check('git.status', state.exitCode, state.detail || 'Collected tracked, untracked and ignored changed paths');
      const unauthorized = receipt.changedFiles.filter(file => !grant.allowedFiles.includes(file));
      check('files.allowlist', unauthorized.length ? 1 : 0, unauthorized.length ? `Paths outside grant changed: ${unauthorized.join(', ')}` : 'All changes are in the exact user allowlist');
      const parsedJson = new Map<string, unknown>(); const existing: string[] = [];
      for (const file of grant.allowedFiles) {
        const current = await this.readFile(grant, file); receipt.fileHashes[file] = current?.sha256 ?? null;
        if (!current) { if (extname(file).toLowerCase() === '.json' && grant.jsonRules.some(rule => rule.file === file)) check(`json.parse:${file}`, 1, 'Required JSON file is missing'); continue; }
        existing.push(file);
        if (extname(file).toLowerCase() === '.json') {
          try { parsedJson.set(file, JSON.parse(current.content)); check(`json.parse:${file}`, 0, 'Trusted JSON.parse succeeded'); }
          catch { check(`json.parse:${file}`, 1, 'File is not valid JSON'); }
        }
      }
      for (const [index, rule] of grant.jsonRules.entries()) {
        let value = parsedJson.get(rule.file); let found = parsedJson.has(rule.file);
        for (const segment of rule.path) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) { found = false; break; }
          value = (value as Record<string, unknown>)[segment];
        }
        const passed = found && isDeepStrictEqual(value, rule.equals);
        check(`json.rule:${index}`, passed ? 0 : 1, passed ? `Rule matched ${rule.file}:${rule.path.join('.') || '$'}` : `Rule did not match ${rule.file}:${rule.path.join('.') || '$'}`);
      }
      if (!unauthorized.length) {
        if (existing.length) {
          assertCommit();
          this.assertAuthorization(grant, true);
          const intent = await this.grantGit(grant, ['add', '--intent-to-add', '--force', '--', ...existing], filters);
          check('git.intent-to-add', intent.exitCode, intent.stderr || 'Included only allowed files so new files appear in the diff');
        }
        const whitespace = await this.grantGit(grant, ['diff', '--no-ext-diff', '--no-textconv', '--check', grant.baselineCommit, '--', ...grant.allowedFiles], filters);
        check('git.diff-check', whitespace.exitCode, whitespace.stdout || whitespace.stderr || 'git diff --check passed');
        const stat = await this.grantGit(grant, ['diff', '--no-ext-diff', '--no-textconv', '--stat', grant.baselineCommit, '--', ...grant.allowedFiles], filters);
        receipt.diffStat = stat.stdout; check('git.diff-stat', stat.exitCode, stat.stderr || 'Collected actual Git diff statistics');
        const patch = await this.grantGit(grant, ['diff', '--no-ext-diff', '--no-textconv', '--binary', grant.baselineCommit, '--', ...grant.allowedFiles], filters);
        receipt.patch = patch.stdout; check('git.patch', patch.exitCode, patch.stderr || 'Collected actual Git patch');
      }
      let stable = true;
      for (const file of grant.allowedFiles) if ((await this.readFile(grant, file))?.sha256 !== (receipt.fileHashes[file] ?? undefined)) stable = false;
      const finalState = await this.changes(grant, filters);
      check('files.stable', stable && !finalState.exitCode && isDeepStrictEqual(finalState.paths, receipt.changedFiles) ? 0 : 1, 'Rechecked hashes and changed paths after collecting the diff');
      if (!receipt.checks.every(item => item.passed)) receipt.status = 'failed';
      else if (grant.jsonRules.length && receipt.changedFiles.length && receipt.patch) receipt.status = 'verified';
      else receipt.status = 'prepared';
    } catch {
      check('workspace.verification', 1, 'Worktree boundary, file identity or trusted verification could not be established'); receipt.status = 'failed';
    }
    assertCommit(); grant.status = receipt.status; grant.latestReceipt = receipt; this.saveProgress(grant); return structuredClone(receipt);
  }
  handoff(caseId: string): Promise<WorkspaceHandoff> {
    return this.locked(caseId, () => this.commitLocked(caseId, async assertCommit => {
      const grant = this.requireGrant(caseId); const receipt = grant.latestReceipt;
      if (!receipt || receipt.status === 'failed') throw new Error('A current successful verification receipt is required before handoff');
      if (receipt.authorizationRevision !== grant.revision) throw new Error('Verification receipt belongs to another authorization revision');
      try {
        await this.validateWorkspace(grant);
        for (const file of grant.allowedFiles) {
          const current = await this.readFile(grant, file);
          if ((current?.sha256 ?? null) !== receipt.fileHashes[file]) throw new Error('File changed after verification');
        }
        const filters = await this.filters(grant.worktreePath, () => this.assertAuthorization(grant));
        const state = await this.changes(grant, filters);
        const changedFiles = state.paths;
        if (state.exitCode || !isDeepStrictEqual(changedFiles, receipt.changedFiles) || changedFiles.some(file => !grant.allowedFiles.includes(file))) throw new Error('Worktree changed after verification');
      } catch {
        assertCommit();
        delete grant.latestReceipt; grant.status = 'prepared'; this.saveProgress(grant);
        throw new Error('Verification receipt was invalidated by a later workspace change');
      }
      assertCommit(); this.assertAuthorization(grant, true); return { caseId: grant.caseId, worktreePath: grant.worktreePath, baselineCommit: grant.baselineCommit, status: receipt.status, receipt: structuredClone(receipt) };
    }));
  }
  close(): void { this.db.close(); }
}
