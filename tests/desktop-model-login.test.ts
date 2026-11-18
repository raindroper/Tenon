import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelLoginBridge } from '../desktop/model-login.js';

function authorization(redirectUri: string, state = 'offline-state') {
  const url = new URL('https://auth.openai.com/api/accounts/authorize');
  url.search = new URLSearchParams({ redirect_uri: redirectUri, state, response_type: 'code', client_id: 'fixture-client' }).toString();
  return url.href;
}

test('desktop callback is bound to the initiating window, callback and OAuth state', async () => {
  const opened: string[] = []; const bridge = new ModelLoginBridge(async url => { opened.push(url); });
  try {
    const prepared = await bridge.prepare(7);
    await assert.rejects(bridge.open(8, { attemptId: prepared.attemptId, authUrl: authorization(prepared.redirectUri) }), /失效/);
    const result = bridge.open(7, { attemptId: prepared.attemptId, authUrl: authorization(prepared.redirectUri) });
    assert.equal(opened.length, 1);
    const wrong = await fetch(prepared.redirectUri + '?code=fixture&state=wrong');
    assert.equal(wrong.status, 400); await wrong.text();
    const callback = prepared.redirectUri + '?code=fixture&state=offline-state&client_id=issued-fixture';
    const accepted = await fetch(callback); assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    const text = await accepted.text(); assert.ok(!text.includes('fixture'));
    assert.deepEqual(await result, { callbackUrl: callback });
  } finally { await bridge.close(); }
});

test('desktop bridge never opens an arbitrary origin or leaks a retained ID token', async () => {
  let opens = 0; const bridge = new ModelLoginBridge(async () => { opens++; });
  try {
    const prepared = await bridge.prepare(1);
    for (const authUrl of [authorization(prepared.redirectUri).replace('auth.openai.com', 'attacker.invalid'),
      authorization(prepared.redirectUri) + '&id_token_hint=not-for-renderer', authorization('http://127.0.0.1:1234/auth/callback')]) {
      await assert.rejects(bridge.open(1, { attemptId: prepared.attemptId, authUrl }), /不匹配/);
    }
    assert.equal(opens, 0);
  } finally { await bridge.close(); }
});

test('cancelling one desktop login drains its listener without cancelling another window', async () => {
  const bridge = new ModelLoginBridge(async () => {});
  try {
    const first = await bridge.prepare(1), second = await bridge.prepare(2);
    const pending = bridge.open(1, { attemptId: first.attemptId, authUrl: authorization(first.redirectUri) });
    const rejected = assert.rejects(pending, /取消或超时/);
    await assert.rejects(bridge.cancel(2, first.attemptId), /不属于/);
    await bridge.close(1); await rejected;
    const other = bridge.open(2, { attemptId: second.attemptId, authUrl: authorization(second.redirectUri) });
    await fetch(second.redirectUri + '?error=access_denied&state=offline-state').then(response => response.text());
    assert.match((await other).callbackUrl, /access_denied/);
  } finally { await bridge.close(); }
});
