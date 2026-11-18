import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { RuntimeApi } from '../server/runtime.js';
import { RuntimeStateStream } from '../server/runtime-stream.js';

class Reader extends EventEmitter {
  destroyed = false; writableEnded = false; slow = false; frames: string[] = [];
  writeHead() {} flushHeaders() {}
  write(frame: string) { this.frames.push(frame); return !this.slow; }
  end(frame?: string) { if (frame) this.frames.push(frame); this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  get updates(): number[] { return this.frames.flatMap(frame => /^event: state$/m.test(frame) ? [JSON.parse(frame.match(/^data: (.+)$/m)![1]).revision as number] : []); }
}
async function flush() { for (let index = 0; index < 5; index++) await Promise.resolve(); }

test('a slow live reader receives the latest state after drain without holding up another reader', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let changed!: () => void; let revision = 1; let detaches = 0;
  const runtime = { snapshot: async () => ({ revision }), subscribe(listener: () => void) { changed = listener; return () => { detaches++; }; } } as unknown as RuntimeApi;
  const stream = new RuntimeStateStream(runtime, JSON.stringify); const slow = new Reader(); const fast = new Reader();
  try {
    stream.connect(slow as unknown as ServerResponse); slow.slow = true; stream.connect(fast as unknown as ServerResponse);
    context.mock.timers.tick(30); await flush(); assert.deepEqual(slow.updates, [1]); assert.deepEqual(fast.updates, [1]);
    revision = 2; changed(); context.mock.timers.tick(30); await flush();
    revision = 3; changed(); context.mock.timers.tick(30); await flush();
    assert.deepEqual(slow.updates, [1]); assert.deepEqual(fast.updates, [1, 2, 3]);
    slow.slow = false; slow.emit('drain'); assert.deepEqual(slow.updates, [1, 3]);
    stream.close(); assert.equal(slow.destroyed, true); assert.equal(fast.destroyed, true); assert.equal(detaches, 1);
    context.mock.timers.tick(60_000); await flush(); assert.deepEqual(fast.updates, [1, 2, 3]);
  } finally { stream.close(); }
});

test('idle live connections recheck login on heartbeat without reading runtime state again', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let reads = 0; let allowed = true; let detaches = 0;
  const runtime = { snapshot: async () => { reads++; return { revision: reads }; }, subscribe() { return () => { detaches++; }; } } as unknown as RuntimeApi;
  const stream = new RuntimeStateStream(runtime, JSON.stringify); const reader = new Reader();
  try {
    stream.connect(reader as unknown as ServerResponse, () => allowed); context.mock.timers.tick(30); await flush(); assert.equal(reads, 1);
    allowed = false; context.mock.timers.tick(15_000); await flush();
    assert.equal(reader.writableEnded, true); assert.match(reader.frames.at(-1)!, /session-expired/); assert.equal(reads, 1); assert.equal(detaches, 1);
  } finally { stream.close(); }
});

test('heartbeat frames expose transport time without reading snapshots, notifying the runtime or advancing delta revisions', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  let reads = 0; let changed!: () => void; let revision = 1;
  const runtime = { snapshot: async () => { reads++; return { revision }; }, subscribe(listener: () => void) { changed = listener; return () => {}; } } as unknown as RuntimeApi;
  const stream = new RuntimeStateStream(runtime, JSON.stringify); const reader = new Reader();
  try {
    stream.connect(reader as unknown as ServerResponse, () => true, {}, true);
    context.mock.timers.tick(30); await flush();
    context.mock.timers.tick(15_000); await flush();
    const heartbeat = reader.frames.find(frame => /^event: heartbeat$/m.test(frame))!;
    assert.match(heartbeat, /^: keepalive\n\n/); assert.doesNotMatch(heartbeat, /^id: /m);
    const value = JSON.parse(heartbeat.match(/^data: (.+)$/m)![1]);
    assert.deepEqual(Object.keys(value), ['serverTime']); assert.ok(Number.isFinite(Date.parse(value.serverTime)));
    assert.equal(reads, 1, 'heartbeats must not request a snapshot or model work');
    revision = 2; changed(); context.mock.timers.tick(30); await flush();
    const delta = reader.frames.at(-1)!;
    assert.match(delta, /^id: 2\nevent: state-delta/m);
    assert.equal(JSON.parse(delta.match(/^data: (.+)$/m)![1]).base, '1');
    assert.equal(reads, 2);
  } finally { stream.close(); }
});

test('backpressure drops heartbeat backlog while another client stays live and expired sessions are still fenced', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let reads = 0; let allowed = true;
  const runtime = { snapshot: async () => { reads++; return { revision: reads }; }, subscribe() { return () => {}; } } as unknown as RuntimeApi;
  const stream = new RuntimeStateStream(runtime, JSON.stringify); const slow = new Reader(); const fast = new Reader();
  try {
    stream.connect(slow as unknown as ServerResponse, () => allowed); stream.connect(fast as unknown as ServerResponse);
    context.mock.timers.tick(30); await flush();
    slow.slow = true; context.mock.timers.tick(15_000); await flush();
    const pending = slow.frames.length;
    context.mock.timers.tick(30_000); await flush();
    assert.equal(slow.frames.length, pending, 'heartbeat ticks cannot queue unbounded writes');
    assert.equal(fast.frames.filter(frame => /^event: heartbeat$/m.test(frame)).length, 3);
    assert.equal(reads, 1);
    allowed = false; context.mock.timers.tick(15_000); await flush();
    assert.equal(slow.writableEnded, true); assert.match(slow.frames.at(-1)!, /session-expired/);
    const fastFrames = fast.frames.length; stream.close();
    context.mock.timers.tick(60_000); await flush(); assert.equal(fast.frames.length, fastFrames);
  } finally { stream.close(); }
});

test('a lagging delta client receives a combined update from its last delivered base', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let changed!: () => void;
  const sources = [{ content: 'private fixture text'.repeat(1000) }];
  let view = { sources, messages: [{ content: 'first' }], devices: [] as unknown[] | undefined };
  const runtime = { snapshot: async () => view, subscribe(listener: () => void) { changed = listener; return () => {}; } } as unknown as RuntimeApi;
  const stream = new RuntimeStateStream(runtime, JSON.stringify); const reader = new Reader();
  try {
    stream.connect(reader as unknown as ServerResponse, undefined, {}, true); reader.slow = true;
    context.mock.timers.tick(30); await flush();
    assert.match(reader.frames.at(-1)!, /event: state\n/); assert.match(reader.frames.at(-1)!, /private fixture text/);
    view = { ...view, messages: [{ content: 'second' }] }; changed(); context.mock.timers.tick(30); await flush();
    view = { ...view, devices: undefined }; changed(); context.mock.timers.tick(30); await flush();
    assert.equal(reader.frames.length, 2);
    reader.slow = false; reader.emit('drain');
    const frame = reader.frames.at(-1)!;
    assert.match(frame, /event: state-delta\n/);
    assert.deepEqual(JSON.parse(frame.match(/^data: (.+)$/m)![1]), { base: '1', replace: { messages: [{ content: 'second' }] }, remove: ['devices'] });
    changed(); context.mock.timers.tick(30); await flush(); assert.equal(reader.frames.length, 3);
  } finally { stream.close(); }
});
