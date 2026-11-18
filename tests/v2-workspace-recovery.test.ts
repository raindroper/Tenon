import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { utimes } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WorkspaceExecutor } from '../server/v2/workspace.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const git = (root: string, args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
function fixture() {
  const prefix = join(tmpdir(), 'rae-workspace-recovery-'); const directory = mkdtempSync(prefix); const repo = join(directory, 'repo'); mkdirSync(repo);
  git(repo, ['init']); writeFileSync(join(repo, 'config.json'), '{"enabled":false}\n'); git(repo, ['add', 'config.json']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  return { directory, repo, base: join(directory, 'workspaces'), cleanup() { const target = resolve(directory); assert.ok(target.startsWith(resolve(prefix))); rmSync(target, { recursive: true, force: true }); } };
}
const spec = (repoRoot: string) => ({ caseId: 'case-recovery', repoRoot, allowedFiles: ['config.json'], jsonRules: [{ file: 'config.json', path: ['enabled'], equals: true }] });

test('two executor commits cannot physically overwrite an acknowledged winner before a stale CAS fails', async () => {
  const f = fixture(); const first = new WorkspaceExecutor(f.base); const second = new WorkspaceExecutor(f.base);
  const nativeRename = fs.promises.rename; let release!: () => void;
  try {
    const grant = await first.prepare(spec(f.repo)); const baseline = await first.read(grant.caseId, 'config.json'); const destination = join(grant.worktreePath, 'config.json');
    let entered!: () => void; let once = true;
    const reached = new Promise<void>(done => { entered = done; }); const gate = new Promise<void>(done => { release = done; });
    fs.promises.rename = async (from, to) => { if (once && String(to) === destination) { once = false; entered(); await gate; } return nativeRename(from, to); };
    syncBuiltinESMExports();
    const secondWrite = second.write(grant.caseId, 'config.json', '{"winner":"B"}\n', baseline.sha256).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await reached;
    const firstWrite = first.write(grant.caseId, 'config.json', '{"winner":"A"}\n', baseline.sha256).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    // The old implementation acknowledges A while B is parked at its final rename.
    // A correct inter-process commit lock keeps A waiting, so bound that observation window.
    await Promise.race([firstWrite, delay(2000)]); release();
    const results = await Promise.all([firstWrite, secondWrite]); const successful = results.filter(result => result.ok);
    assert.equal(successful.length, 1, 'same-baseline optimistic writes cannot both be acknowledged');
    const actual = await first.read(grant.caseId, 'config.json');
    assert.equal(actual.sha256, successful[0].value.sha256, 'the acknowledged successful write must remain the physical file');
  } finally { release?.(); fs.promises.rename = nativeRename; syncBuiltinESMExports(); first.close(); second.close(); f.cleanup(); }
});

test('the physical commit gate also protects an acknowledged file across separate Node processes', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.base); let child: ReturnType<typeof spawn> | undefined;
  try {
    const grant = await executor.prepare(spec(f.repo)); const baseline = await executor.read(grant.caseId, 'config.json'); const destination = join(grant.worktreePath, 'config.json');
    const moduleUrl = pathToFileURL(resolve('server/v2/workspace.ts')).href;
    const source = `(async()=>{
      const fs=(await import('node:fs')).default;const{syncBuiltinESMExports}=await import('node:module');
      const{WorkspaceExecutor}=await import(${JSON.stringify(moduleUrl)});const e=new WorkspaceExecutor(${JSON.stringify(f.base)});
      const native=fs.promises.rename;let release;const gate=new Promise(done=>{release=done});let once=true;
      process.stdin.once('data',()=>release());
      fs.promises.rename=async(from,to)=>{if(once&&String(to)===${JSON.stringify(destination)}){once=false;console.log('RENAME_GATED');await gate}return native(from,to)};syncBuiltinESMExports();
      try{const value=await e.write(${JSON.stringify(grant.caseId)},'config.json','{"winner":"child"}\\n',${JSON.stringify(baseline.sha256)});console.log('RESULT '+JSON.stringify({ok:true,value}))}
      catch(error){console.log('RESULT '+JSON.stringify({ok:false,error:String(error)}))}
      finally{fs.promises.rename=native;syncBuiltinESMExports();e.close()}
    })().catch(error=>{console.error(error);process.exitCode=2});`;
    child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '-e', source], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stderr!.on('data', chunk => stderr += chunk);
    const exited = new Promise<void>((done, fail) => { child!.once('error', fail); child!.once('close', code => code === 0 ? done() : fail(new Error(`Child commit failed ${code}: ${stderr}`))); });
    void exited.catch(() => undefined); // Awaited below; an early fixture failure must not become an unhandled rejection.
    await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error(`Child did not reach rename gate: ${stderr}`)), 10000);
      child!.once('close', code => { if (!stdout.includes('RENAME_GATED')) { clearTimeout(timer); fail(new Error(`Child exited before rename gate ${code}: ${stderr}`)); } });
      child!.stdout!.on('data', chunk => { stdout += chunk; if (stdout.includes('RENAME_GATED')) { clearTimeout(timer); done(); } }); });
    const parentWrite = executor.write(grant.caseId, 'config.json', '{"winner":"parent"}\n', baseline.sha256)
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: String(error) }));
    await Promise.race([parentWrite, delay(2000)]); child.stdin!.end('release');
    const parentResult = await parentWrite; await exited;
    const record = stdout.split(/\r?\n/).find(line => line.startsWith('RESULT ')); assert.ok(record, stdout);
    const childResult = JSON.parse(record.slice(7)) as { ok: boolean; value?: { sha256: string }; error?: string };
    const successes = [parentResult, childResult].filter(result => result.ok); assert.equal(successes.length, 1);
    const acknowledged = parentResult.ok ? parentResult.value : childResult.value; assert.ok(acknowledged);
    assert.equal((await executor.read(grant.caseId, 'config.json')).sha256, acknowledged.sha256);
  } finally { child?.stdin?.end('release'); child?.kill(); executor.close(); f.cleanup(); }
});

for (const operation of ['write', 'verify'] as const) test(`another executor's revoke fences an already-started ${operation} and cannot be overwritten by stale progress`, async () => {
  const f = fixture(); const first = new WorkspaceExecutor(f.base); const second = new WorkspaceExecutor(f.base);
  try {
    const grant = await first.prepare(spec(f.repo));
    if (operation === 'verify') await first.write(grant.caseId, 'config.json', '{"enabled":true}\n');
    // The async Git/filesystem boundary makes the first executor hold its original grant snapshot.
    const work = (operation === 'write' ? first.write(grant.caseId, 'config.json', '{"enabled":true}\n') : first.verify(grant.caseId))
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await immediate(); await second.revoke(grant.caseId); const revokedAt = second.getGrant(grant.caseId)?.revokedAt;
    assert.ok(revokedAt); const result = await work;
    assert.equal(second.getGrant(grant.caseId)?.revokedAt, revokedAt, 'stale worker must never restore permission');
    // An operation already holding the shared commit gate may linearize before revoke.
    // Its historical receipt cannot restore permission or be used for a new handoff afterward.
    if (result.ok && operation === 'verify' && 'authorizationRevision' in result.value) assert.ok(result.value.authorizationRevision < second.getGrant(grant.caseId)!.revision);
    assert.equal(second.getGrant(grant.caseId)?.latestReceipt, undefined);
    await assert.rejects(first.read(grant.caseId, 'config.json'), /revoked|authorization|revision/i);
  } finally { first.close(); second.close(); f.cleanup(); }
});

test('a grant DB failure after real Git creation leaves a durable intent and a recoverable original worktree', async () => {
  const f = fixture(); let executor = new WorkspaceExecutor(f.base); const db = new DatabaseSync(join(f.base, 'workspaces.sqlite'));
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_authorizations'").get() ? 'workspace_authorizations' : 'workspace_grants';
    db.exec(`CREATE TRIGGER fixture_deny_grant BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture grant commit failure'); END;`);
    await assert.rejects(executor.prepare(spec(f.repo)), /fixture grant commit failure/);
    const destination = join(f.base, 'case-recovery'); assert.ok(existsSync(destination), 'validated worktree is kept after metadata failure, never silently deleted');
    const baseline = git(destination, ['rev-parse', 'HEAD']).trim(); const original = readFileSync(join(destination, 'config.json'), 'utf8');
    db.exec('DROP TRIGGER fixture_deny_grant'); executor.close(); executor = new WorkspaceExecutor(f.base);
    // Source HEAD can move while recovery must preserve the originally authorized baseline.
    writeFileSync(join(f.repo, 'config.json'), '{"enabled":false,"newHead":true}\n'); git(f.repo, ['add', 'config.json']);
    git(f.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'later source commit']);
    const recovered = await executor.prepare(spec(f.repo)); assert.equal(recovered.worktreePath, destination); assert.equal(recovered.baselineCommit, baseline);
    assert.equal(readFileSync(join(destination, 'config.json'), 'utf8'), original);
  } finally { db.close(); executor.close(); f.cleanup(); }
});

test('recovery rejects a stale worktree registration without adopting or deleting either destination', async () => {
  const f = fixture(); let executor = new WorkspaceExecutor(f.base); const db = new DatabaseSync(join(f.base, 'workspaces.sqlite'));
  let pointer: string | undefined; let originalPointer: string | undefined;
  try {
    db.exec("CREATE TRIGGER fixture_hold_grant BEFORE INSERT ON workspace_authorizations BEGIN SELECT RAISE(ABORT, 'fixture held grant'); END;");
    await assert.rejects(executor.prepare(spec(f.repo)), /fixture held grant/);
    const destination = join(f.base, 'case-recovery');
    const before = readFileSync(join(destination, 'config.json'), 'utf8');
    const baseline = git(destination, ['rev-parse', 'HEAD']).trim();
    const admin = git(destination, ['rev-parse', '--absolute-git-dir']).trim();
    pointer = join(admin, 'gitdir'); originalPointer = readFileSync(pointer, 'utf8');
    const other = join(f.directory, 'unowned-stale-location'); mkdirSync(other);
    writeFileSync(join(other, 'keep.txt'), 'not part of this workspace grant');
    // No .git exists here, so the registered destination is stale/prunable even though the owned checkout remains.
    writeFileSync(pointer, join(other, '.git').replaceAll('\\', '/') + '\n');
    db.exec('DROP TRIGGER fixture_hold_grant'); executor.close(); executor = new WorkspaceExecutor(f.base);
    await assert.rejects(executor.prepare(spec(f.repo)), /worktree|registration/i);
    assert.equal(executor.getGrant('case-recovery'), undefined);
    assert.equal(executor.getPreparation('case-recovery')?.state, 'failed');
    assert.equal(readFileSync(join(destination, 'config.json'), 'utf8'), before);
    assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'not part of this workspace grant');
    writeFileSync(pointer, originalPointer); originalPointer = undefined;
    const recovered = await executor.prepare(spec(f.repo));
    assert.equal(recovered.worktreePath, destination); assert.equal(recovered.baselineCommit, baseline);
    assert.equal(readFileSync(join(f.repo, 'config.json'), 'utf8'), before);
  } finally {
    if (pointer && originalPointer !== undefined) writeFileSync(pointer, originalPointer);
    db.close(); executor.close(); f.cleanup();
  }
});

test('an unowned existing destination is preserved and is never adopted as a prepared workspace', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.base); const destination = join(f.base, 'case-recovery'); mkdirSync(destination);
  writeFileSync(join(destination, 'keep.txt'), 'unowned user data');
  try { await assert.rejects(executor.prepare(spec(f.repo)), /destination|intent|unowned/i); assert.equal(readFileSync(join(destination, 'keep.txt'), 'utf8'), 'unowned user data'); }
  finally { executor.close(); f.cleanup(); }
});

test('preparation journal failure happens before any Git worktree side effect', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.base); const db = new DatabaseSync(join(f.base, 'workspaces.sqlite'));
  try {
    db.exec("CREATE TRIGGER fixture_deny_intent BEFORE INSERT ON workspace_prepare_intents BEGIN SELECT RAISE(ABORT, 'fixture journal failure'); END;");
    await assert.rejects(executor.prepare(spec(f.repo)), /fixture journal failure/);
    assert.equal(existsSync(join(f.base, 'case-recovery')), false);
    assert.doesNotMatch(git(f.repo, ['worktree', 'list', '--porcelain']), /case-recovery/);
    db.exec('DROP TRIGGER fixture_deny_intent'); assert.equal((await executor.prepare(spec(f.repo))).status, 'prepared');
  } finally { db.close(); executor.close(); f.cleanup(); }
});

test('revocation of a durable preparation intent prevents a later grant commit and preserves the destination', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.base); const second = new WorkspaceExecutor(f.base); const db = new DatabaseSync(join(f.base, 'workspaces.sqlite'));
  try {
    // Fail only the final grant commit: this retains a real registered worktree and its intent.
    db.exec("CREATE TRIGGER fixture_pause_commit BEFORE INSERT ON workspace_authorizations BEGIN SELECT RAISE(ABORT, 'fixture pause commit'); END;");
    await assert.rejects(executor.prepare(spec(f.repo)), /fixture pause commit/);
    await second.revoke('case-recovery'); db.exec('DROP TRIGGER fixture_pause_commit');
    await assert.rejects(executor.prepare(spec(f.repo)), /revoked/);
    assert.equal(executor.getGrant('case-recovery'), undefined); assert.equal(executor.getPreparation('case-recovery')?.state, 'revoked');
    assert.ok(existsSync(join(f.base, 'case-recovery', 'config.json')));
  } finally { db.close(); executor.close(); second.close(); f.cleanup(); }
});

test('legacy grants, receipts and revokedAt migrate without making revoked authorization usable', async () => {
  const f = fixture(); let executor = new WorkspaceExecutor(f.base);
  try {
    const active = await executor.prepare(spec(f.repo)); await executor.write(active.caseId, 'config.json', '{"enabled":true}\n'); const receipt = await executor.verify(active.caseId);
    const revokedSpec = { ...spec(f.repo), caseId: 'legacy-revoked' }; const revoked = await executor.prepare(revokedSpec); await executor.revoke(revoked.caseId);
    const revokedAt = executor.getGrant(revoked.caseId)!.revokedAt;
    const legacyActive = { ...executor.getGrant(active.caseId)! }; const legacyRevoked = { ...executor.getGrant(revoked.caseId)! };
    executor.close(); const db = new DatabaseSync(join(f.base, 'workspaces.sqlite'));
    for (const value of [legacyActive, legacyRevoked]) db.prepare('INSERT INTO workspace_grants(case_id,json) VALUES(?,?)').run(value.caseId, JSON.stringify(value));
    db.exec('DELETE FROM workspace_authorizations; DELETE FROM workspace_progress'); db.close();
    executor = new WorkspaceExecutor(f.base);
    assert.equal(executor.getGrant(active.caseId)?.latestReceipt?.id, receipt.id); assert.equal((await executor.handoff(active.caseId)).status, 'verified');
    assert.equal(executor.getGrant(revoked.caseId)?.revokedAt, revokedAt); await assert.rejects(executor.read(revoked.caseId, 'config.json'), /revoked/);
    const db2 = new DatabaseSync(join(f.base, 'workspaces.sqlite')); assert.equal(db2.prepare('SELECT COUNT(*) AS count FROM workspace_grants').get()?.count, 2); db2.close();
  } finally { executor.close(); f.cleanup(); }
});

test('a process killed after Git creation recovers its preparing intent after the preparation lock is stale', async () => {
  const f = fixture(); const executor = new WorkspaceExecutor(f.base); const db = new DatabaseSync(join(f.base, 'workspaces.sqlite'));
  const moduleUrl = pathToFileURL(resolve('server/v2/workspace.ts')).href;
  const source = `(async()=>{const{WorkspaceExecutor}=await import(${JSON.stringify(moduleUrl)});const e=new WorkspaceExecutor(${JSON.stringify(f.base)});try{await e.prepare(${JSON.stringify(spec(f.repo))});console.log('COMMITTED')}catch(e){console.error(e.message);process.exitCode=2}finally{e.close()}})()`;
  const child = spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  let holding = false;
  try {
    const destination = join(f.base, 'case-recovery'); const deadline = Date.now() + 10000;
    while (!existsSync(join(destination, 'config.json'))) { if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Child did not create fixture worktree: ${output}`); await delay(1); }
    // The durable journal exists; hold the final metadata transaction while killing only this fixture process.
    db.exec('BEGIN IMMEDIATE'); holding = true;
    assert.equal(executor.getPreparation('case-recovery')?.state, 'preparing');
    const closed = new Promise<void>(done => child.once('close', () => done())); child.kill('SIGKILL'); await closed;
    db.exec('ROLLBACK'); holding = false;
    assert.equal(executor.getGrant('case-recovery'), undefined); assert.ok(existsSync(destination));
    const locks = [resolve(f.base, '.prepare-case-recovery.anchor.lock'), resolve(f.base, '.commit-leases', 'case-recovery', '.another-rae-runtime.lock')];
    for (const lock of locks) { assert.ok(lock.startsWith(resolve(f.base))); if (existsSync(lock)) { const stale = new Date(Date.now() - 40000); await utimes(lock, stale, stale); } }
    // A Git child may finish checkout after its parent exits; do not adopt an initializing registration.
    for (let i = 0; i < 100 && /locked/.test(git(f.repo, ['worktree', 'list', '--porcelain'])); i++) await delay(10);
    const recovered = await executor.prepare(spec(f.repo)); assert.equal(recovered.worktreePath, destination);
    assert.equal(executor.getPreparation('case-recovery')?.state, 'ready'); assert.equal(recovered.status, 'prepared');
  } finally { child.kill(); if (holding) db.exec('ROLLBACK'); db.close(); executor.close(); f.cleanup(); }
});
