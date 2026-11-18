import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { PersonalMemoryStore } from '../server/v2/personal-memory-store.js';
import type { SharedFact } from '../server/v2/memory.js';

const fact = (key: string, value = key): SharedFact => ({ key, value, domains: ['personal'], evidenceIds: [], createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' });

test('ledger cutover atomically freezes the original and never falls back to a modified native core', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rae-ledger-')), 'events.sqlite');
  let store = new PersonalMemoryStore(path, 'owner', value => value);
  const original = [fact('identity'), fact('withdrawal-history')];
  const raw = JSON.stringify({ version: 2, facts: original });
  try {
    store.importLegacy(raw, original);
    store.mutate('identity', current => ({ fact: { ...current!, value: 'new identity' }, result: undefined }));
    store.close(); store = new PersonalMemoryStore(path, 'owner', value => value);
    store.importLegacy('tampered native core', [fact('unexpected')]);
    assert.deepEqual(store.list().map(value => value.key).sort(), original.map(value => value.key).sort());
    assert.equal(store.list()[0].value, 'withdrawal-history');
    assert.equal(store.list().find(value => value.key === 'identity')!.value, 'new identity');
    assert.equal(store.archive()!.content, raw); assert.equal(store.archive()!.importedCount, 2);
  } finally { store.close(); }
});

test('a fault before the cutover marker rolls back every imported head and resumes losslessly', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rae-ledger-fault-')), 'events.sqlite');
  const store = new PersonalMemoryStore(path, 'owner', value => value);
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TRIGGER reject_cutover BEFORE INSERT ON rae_personal_memory_cutovers BEGIN SELECT RAISE(ABORT,'cutover fault'); END`);
    assert.throws(() => store.importLegacy('original bytes', [fact('a'), fact('b')]), /cutover fault/);
    assert.equal(store.migrated, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rae_personal_memory_versions').get()!.count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rae_personal_memory_heads').get()!.count, 0);
    assert.throws(() => store.list(), /迁移尚未提交/);
    db.exec('DROP TRIGGER reject_cutover');
    store.importLegacy('original bytes', [fact('a'), fact('b')]);
    assert.equal(store.list().length, 2); assert.equal(store.archive()!.content, 'original bytes');
  } finally { db.close(); store.close(); }
});

test('row mutations enforce revisions across connections and pagination preserves all retired keys', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rae-ledger-race-')), 'events.sqlite');
  const first = new PersonalMemoryStore(path, 'owner', value => value);
  const second = new PersonalMemoryStore(path, 'owner', value => value);
  try {
    first.importLegacy(null, Array.from({ length: 80 }, (_, index) => fact(`key-${index}`)));
    first.mutate('key-0', current => ({ fact: { ...current!, value: 'changed' }, result: undefined }), 1);
    assert.throws(() => second.mutate('missing', () => ({ fact: fact('missing'), result: undefined }), 1), /当前版本/);
    const seen = new Set<string>();
    for (let offset: number | null = 0; offset !== null;) {
      const page = second.page(offset, 7);
      for (const value of page.facts) { assert.ok(!seen.has(value.key)); seen.add(value.key); }
      offset = page.nextOffset;
    }
    assert.equal(seen.size, 80);
    const other = new PersonalMemoryStore(path, 'stranger', value => value);
    try { other.importLegacy(null, []); assert.deepEqual(other.list(), []); } finally { other.close(); }
  } finally { first.close(); second.close(); }
});

test('cold process termination before and after migration commit preserves the single authoritative cutover', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rae-ledger-process-'));
  const moduleUrl = new URL('../server/v2/personal-memory-store.ts', import.meta.url).href;
  for (const point of ['before', 'after']) {
    const file = join(directory, `${point}.sqlite`);
    const script = `const {PersonalMemoryStore}=await import(${JSON.stringify(moduleUrl)});
      const values=${JSON.stringify([fact('a'), fact('b')])};
      const store=new PersonalMemoryStore(process.argv[1],'owner',value=>{
        if(process.argv[2]==='before'&&value.key==='b')process.exit(73); return value;
      }); store.importLegacy('original archive',values); process.exit(73);`;
    const child = spawnSync(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx', '--input-type=module', '--eval', script, file, point],
      { encoding: 'utf8', env: process.env, windowsHide: true, timeout: 15000 });
    assert.equal(child.status, 73, child.stderr);
    const recovered = new PersonalMemoryStore(file, 'owner', value => value);
    try {
      assert.equal(recovered.migrated, point === 'after');
      recovered.importLegacy('original archive', [fact('a'), fact('b')]);
      assert.equal(recovered.list().length, 2);
      assert.equal(recovered.exportLedger().versions.length, 2, 'recovery never duplicates imported versions');
    } finally { recovered.close(); }
  }
});

test('SQL pages count all retained heads but deserialize only the requested limit', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rae-ledger-page-')), 'events.sqlite');
  let decoded = 0;
  const store = new PersonalMemoryStore(path, 'owner', value => { decoded++; return value; });
  try {
    store.importLegacy(null, Array.from({ length: 180 }, (_, index) => fact(`legacy-${index}`)));
    decoded = 0;
    const page = store.page(20, 7, 'owner');
    assert.equal(page.total, 180); assert.equal(page.offset, 20); assert.equal(page.nextOffset, 27);
    assert.equal(page.facts.length, 7); assert.equal(decoded, 7);
    assert.equal(store.page(0, 7, 'agent').total, 0);
    assert.throws(() => store.page(0, 7, 'external' as never), /主体无效/);
  } finally { store.close(); }
});
