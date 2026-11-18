import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectorConnection } from '../shared/connectors.js';
import { GitHubAccountDetails, GitHubAccountUpgradeForm, GitHubConnectorForm, GitHubCredentialsForm } from '../client/panels/GitHubConnectorForm.js';
import { OAuthAppForm } from '../client/panels/OAuthAppForm.js';
import { OAuthConnectorForm } from '../client/panels/connectors.js';
import { startConnectorOAuth, takeConnectorOAuthReturn } from '../client/lib/connector-oauth.js';

const perform = async () => true;
const noop = () => undefined;
const timestamp = '2026-11-09T12:00:00.000Z';

function browser(t: TestContext, href = 'https://rae.example.com/') {
  const values = new Map<string, string>();
  const location = { href, origin: new URL(href).origin, assigned: '', assign(value: string) { this.assigned = value; } };
  const state = { replaced: '' };
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  for (const [key, value] of Object.entries({ sessionStorage: storage, window: {
    location, history: { replaceState(_data: unknown, _title: string, url: string) { state.replaced = url; } },
  } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  return { location, storage, values, state };
}

test('GitHub connects an account without repository, scene or custom read-write tiers', () => {
  const html = renderToStaticMarkup(createElement(GitHubConnectorForm, {
    perform, disabled: false, onSaved: noop,
  }));
  assert.match(html, /GitHub 官方 MCP/);
  assert.match(html, /All repositories/);
  assert.match(html, /https:\/\/github.com\/settings\/personal-access-tokens\/new/);
  assert.match(html, /所有本人场景/);
  assert.match(html, /不会超过你本人的权限/);
  assert.match(html, /不会自动遍历或观察所有仓库/);
  assert.match(html, /明确委托后执行/);
  assert.match(html, /type="password"[^>]*autoComplete="new-password"/);
  assert.doesNotMatch(html, /GitHub App|Client secret|connector-callback\/github|value="github_pat_|Only select repositories|owner\/repo|绑定场景|访问方式|<select/);
});

test('GitHub account credentials expose the authenticated login without narrowing access to one repository', () => {
  const connection: ConnectorConnection = { id: 'connection', kind: 'github', caseId: 'scene', scope: 'account',
    connectedAt: timestamp, lastSyncedAt: timestamp, status: 'watching',
    github: { kind: 'account', accountId: 123, login: 'sunny-user', credentialRevision: 4 } };
  const html = renderToStaticMarkup(createElement(GitHubCredentialsForm, { connection, perform, disabled: false, onSaved: noop, onCancel: noop }));
  assert.match(html, /@sunny-user/);
  assert.match(html, /同一账号/);
  assert.match(html, /账号可访问的全部仓库/);
  assert.doesNotMatch(html, /placeholder="owner\/repo"|选择场景|访问方式|<select/);
  const details = renderToStaticMarkup(createElement('dl', null, createElement(GitHubAccountDetails, { connection })));
  assert.match(details, /@sunny-user/);
  assert.match(details, /账号可访问的全部仓库/);
  assert.match(details, /所有本人场景/);
  assert.doesNotMatch(details, /<dd>account<\/dd>|<dd>scene<\/dd>|只读观察/);
});

test('legacy repository upgrade asks for explicit account-wide consent without revealing or recollecting a token', () => {
  const connection: ConnectorConnection = { id: 'legacy', kind: 'github', caseId: 'scene', scope: 'owner/legacy',
    connectedAt: timestamp, lastSyncedAt: timestamp, status: 'watching',
    github: { repositoryId: 123, credentialRevision: 1, access: 'read' } };
  const html = renderToStaticMarkup(createElement(GitHubAccountUpgradeForm, { connection, perform, disabled: false, onSaved: noop, onCancel: noop }));
  assert.match(html, /owner\/legacy/);
  assert.match(html, /使用已保存的令牌/);
  assert.match(html, /升级为账号可访问的全部仓库/);
  assert.match(html, /不为旧任务扩大许可/);
  assert.match(html, /type="submit"[^>]*disabled=""/);
  assert.doesNotMatch(html, /type="password"|checked=""|github_pat_/);
});

test('unconfigured Gmail has an owner configuration form and exact service callback', () => {
  const html = renderToStaticMarkup(createElement(OAuthAppForm, { kind: 'gmail', setup: { source: 'none', revision: 0 },
    configured: false, perform, disabled: false, onSaved: noop, origin: 'https://rae.example.com' }));
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /Google Cloud/);
  assert.match(html, /gmail.readonly/);
  assert.match(html, /value="https:\/\/rae.example.com\/connector-callback\/gmail"/);
  assert.match(html, /Client ID/); assert.match(html, /Client secret/);
  assert.match(html, /保存应用配置/);
  assert.match(html, /type="password"[^>]*autoComplete="new-password"/);
  assert.doesNotMatch(html, /找管理员/);
});

test('environment OAuth app configuration is read-only and never offers a secret replacement field', () => {
  const html = renderToStaticMarkup(createElement(OAuthAppForm, { kind: 'outlook',
    setup: { source: 'environment', revision: 2, clientId: 'public-client-id' }, configured: true,
    perform, disabled: false, onSaved: noop, origin: 'https://rae.example.com' }));
  assert.match(html, /Microsoft Entra/);
  assert.match(html, /Mail.Read/);
  assert.match(html, /来自服务环境/);
  assert.match(html, /<input[^>]*readOnly=""[^>]*value="public-client-id"/);
  assert.match(html, /connector-callback\/outlook/);
  assert.doesNotMatch(html, /type="password"|<form|更新应用配置/);
});

test('OAuth reauthorization sends the original connection binding and only saves local state', async t => {
  const fixture = browser(t);
  const state = 's'.repeat(43);
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, init?: RequestInit) => {
    assert.equal(path, '/api/connectors/gmail/start');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(init?.body as string), { caseId: 'original-scene', scope: 'Label_42', connectionId: 'original-connection' });
    return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state, state });
  });
  await startConnectorOAuth('gmail', 'original-scene', 'Label_42', 'original-connection');
  assert.match(fixture.location.assigned, /^https:\/\/accounts.google.com\//);
  assert.deepEqual(JSON.parse(fixture.storage.getItem('rae:connector-oauth')!), { kind: 'gmail', state });
  assert.equal(fixture.values.size, 1);
});

test('OAuth refuses an unexpected authorization host before storing state or navigating', async t => {
  const fixture = browser(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ url: 'https://unexpected.example/authorize', state: 's'.repeat(43) }));
  await assert.rejects(startConnectorOAuth('gmail', 'scene', 'INBOX'), /授权地址无效/);
  assert.equal(fixture.location.assigned, ''); assert.equal(fixture.values.size, 0);
});

test('OAuth callback clears the visible code, checks local state, and completes exactly once', async t => {
  const state = 's'.repeat(43);
  const fixture = browser(t, `https://rae.example.com/connector-callback/outlook?state=${state}&code=one-time-code`);
  fixture.storage.setItem('rae:connector-oauth', JSON.stringify({ kind: 'outlook', state }));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(path, '/api/connectors/outlook/complete');
    assert.deepEqual(JSON.parse(init?.body as string), { state, code: 'one-time-code' });
    return Response.json({ id: 'preserved-connection' });
  });
  const complete = takeConnectorOAuthReturn();
  assert.equal(fixture.state.replaced, '/');
  assert.ok(complete);
  await complete();
  await assert.rejects(complete(), /本浏览器/);
  assert.equal(requests, 1); assert.equal(fixture.values.size, 0);
});

test('retired GitHub OAuth callbacks and denied mailbox authorization do not call connector APIs', async t => {
  const fixture = browser(t, 'https://rae.example.com/connector-callback/github?state=old&code=unused');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected OAuth completion'); });
  await assert.rejects(takeConnectorOAuthReturn()!(), /本浏览器/);
  const state = 's'.repeat(43);
  fixture.location.href = `https://rae.example.com/connector-callback/gmail?state=${state}&error=access_denied`;
  fixture.storage.setItem('rae:connector-oauth', JSON.stringify({ kind: 'gmail', state }));
  await assert.rejects(takeConnectorOAuthReturn()!(), /取消了授权/);
  assert.equal(fixture.values.size, 0);
});

test('desktop mailbox authorization starts only after opening the clean Rae web entry in a browser', async t => {
  const fixture = browser(t, 'https://rae.example.com/connector-callback/gmail?code=must-not-transfer&state=must-not-transfer');
  Reflect.set(window, 'raeLocalDevice', {});
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Desktop must not initiate OAuth'); });
  const html = renderToStaticMarkup(createElement(OAuthConnectorForm, { kind: 'gmail',
    cases: [{ id: 'scene', title: '场景' }], initialCaseId: 'scene', perform, disabled: false, onSaved: noop }));
  assert.match(html, /同一标签页开始并完成授权/);
  assert.match(html, /value="https:\/\/rae.example.com\/"/);
  assert.match(html, /type="submit"[^>]*disabled=""/);
  assert.doesNotMatch(html, /must-not-transfer|accounts.google.com|code=|state=/);
  await assert.rejects(startConnectorOAuth('gmail', 'scene', 'INBOX'), /系统浏览器/);
  assert.equal(requests, 0); assert.equal(fixture.location.assigned, ''); assert.equal(fixture.values.size, 0);
});
