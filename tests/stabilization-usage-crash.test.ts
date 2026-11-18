import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { UsageTracker } from '../server/v2/usage.js';

function crashFixture(mode: 'reported' | 'pending' | 'settling-call' | 'settling-run') {
  const prefix = join(tmpdir(), 'rae-usage-crash-test-'); const directory = mkdtempSync(prefix);
  const storeUrl = pathToFileURL(resolve('server/store.ts')).href;
  const trackerUrl = pathToFileURL(resolve('server/v2/usage.ts')).href;
  const source = `import {Store} from ${JSON.stringify(storeUrl)}; import {UsageTracker} from ${JSON.stringify(trackerUrl)}; import {MockLanguageModelV4} from 'ai/test';
const store=new Store(${JSON.stringify(directory)});store.getApiKey=()=>undefined;
const run={id:'fixture-run',trigger:'manual',status:'running',startedAt:new Date().toISOString(),steps:0,inputTokens:0,outputTokens:0,usageStatus:'not_used'};store.insert('runs',run);
store.subscribe(()=>{if(${JSON.stringify(mode)}==='reported'&&store.get('runs','fixture-run')?.usageStatus==='reported')process.exit(79);});
const original=store.put.bind(store);store.put=(collection,item)=>{const result=original(collection,item);if(${JSON.stringify(mode)}==='settling-call'&&collection==='modelCalls'&&item.status==='settled')process.exit(81);if(${JSON.stringify(mode)}==='settling-run'&&collection==='runs'&&item.usageStatus==='reported')process.exit(82);return result;};
const model=new MockLanguageModelV4({doGenerate:async()=>{if(${JSON.stringify(mode)}==='pending')process.exit(80);return {content:[{type:'text',text:'Mock fixture only'}],usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[],finishReason:{unified:'stop',raw:'stop'}};}});
await new UsageTracker(store).meter(run,model,new AbortController().signal).doGenerate({prompt:[{role:'user',content:[{type:'text',text:'software fixture only'}]}]});`;
  const child = spawnSync(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 10000 });
  const store = new Store(directory); store.getApiKey = () => undefined;
  return { child, store, close() { store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); } };
}

test('a crash after reported usage commits cannot count the call again or downgrade its report', () => {
  const f = crashFixture('reported');
  try {
    assert.equal(f.child.status, 79, 'Child must exit from the post-commit notification, after both usage facts commit');
    const before = f.store.get('runs', 'fixture-run')!;
    assert.equal(before.usageStatus, 'reported'); assert.equal(before.pendingModelCalls, 0);
    assert.equal(before.inputTokens, 10); assert.equal(before.outputTokens, 1);
    const calls = f.store.list('modelCalls'); assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'settled'); assert.equal(calls[0].usageStatus, 'reported');
    assert.equal(calls[0].inputTokens, 10); assert.equal(calls[0].outputTokens, 1);
    const tracker = new UsageTracker(f.store); tracker.recover(); tracker.recover();
    assert.deepEqual(f.store.get('runs', 'fixture-run'), before);
    assert.deepEqual(f.store.list('modelCalls'), calls);
  } finally { f.close(); }
});

test('a crash with an unfinished provider call recovers unknown usage without inventing tokens', () => {
  const f = crashFixture('pending');
  try {
    assert.equal(f.child.status, 80); const before = f.store.get('runs', 'fixture-run')!;
    assert.equal(before.pendingModelCalls, 1); assert.equal(before.inputTokens, 0); assert.equal(before.outputTokens, 0);
    const calls = f.store.list('modelCalls'); assert.equal(calls.length, 1); assert.equal(calls[0].status, 'pending');
    const tracker = new UsageTracker(f.store); tracker.recover(); const recovered = f.store.get('runs', 'fixture-run')!;
    assert.equal(recovered.usageStatus, 'unknown'); assert.equal(recovered.pendingModelCalls, 0);
    assert.equal(recovered.inputTokens, 0); assert.equal(recovered.outputTokens, 0);
    const settled = f.store.list('modelCalls'); assert.equal(settled.length, 1); assert.equal(settled[0].id, calls[0].id);
    assert.equal(settled[0].status, 'settled'); assert.equal(settled[0].usageStatus, 'unknown');
    assert.equal(settled[0].inputTokens, 0); assert.equal(settled[0].outputTokens, 0);
    tracker.recover(); assert.deepEqual(f.store.get('runs', 'fixture-run'), recovered);
    assert.deepEqual(f.store.list('modelCalls'), settled);
  } finally { f.close(); }
});

for (const [mode, code] of [['settling-call', 81], ['settling-run', 82]] as const) {
  test(`a crash inside usage settlement at ${mode} rolls back both call facts and run totals`, () => {
    const f = crashFixture(mode);
    try {
      assert.equal(f.child.status, code, 'Child must exit at the selected pre-commit write');
      const before = f.store.get('runs', 'fixture-run')!; const calls = f.store.list('modelCalls');
      assert.equal(before.pendingModelCalls, 1); assert.equal(before.inputTokens, 0); assert.equal(before.outputTokens, 0);
      assert.equal(calls.length, 1); assert.equal(calls[0].status, 'pending');
      assert.equal(calls[0].inputTokens, 0); assert.equal(calls[0].outputTokens, 0);
      const tracker = new UsageTracker(f.store); tracker.recover();
      const recovered = f.store.get('runs', 'fixture-run')!; const settled = f.store.list('modelCalls');
      assert.equal(recovered.pendingModelCalls, 0); assert.equal(recovered.usageStatus, 'unknown');
      assert.equal(recovered.inputTokens, 0); assert.equal(recovered.outputTokens, 0);
      assert.equal(settled.length, 1); assert.equal(settled[0].id, calls[0].id); assert.equal(settled[0].usageStatus, 'unknown');
      tracker.recover(); assert.deepEqual(f.store.get('runs', 'fixture-run'), recovered); assert.deepEqual(f.store.list('modelCalls'), settled);
    } finally { f.close(); }
  });
}
