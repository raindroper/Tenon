import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('offline test guard blocks SDK fetch and normalized native sockets before any transport', () => {
  // A second fake transport makes this regression incapable of reaching the
  // network even if the guard itself regresses.
  const script = `
    import assert from 'node:assert/strict';
    import { Socket, createConnection } from 'node:net';
    let sockets = 0; let fetches = 0;
    Socket.prototype.connect = function () { sockets++; return this; };
    globalThis.fetch = async () => { fetches++; return new Response('fixture'); };
    await import('./scripts/test-network-guard.mjs');
    await assert.rejects(fetch('https://provider.invalid/v1/chat/completions'), /loopback/);
    assert.throws(() => createConnection({ host: 'provider.invalid', port: 443 }), /loopback/);
    assert.throws(() => new Socket().connect(443, 'provider.invalid'), /loopback/);
    assert.equal(sockets, 0); assert.equal(fetches, 0);
    await fetch('http://127.0.0.1:4317/fixture');
    createConnection({ host: '127.0.0.1', port: 4317 });
    assert.equal(sockets, 1); assert.equal(fetches, 1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
});
