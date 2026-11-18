import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelProtocolUseLabel, type ModelConnection, type ModelDirectory, type ModelSelection } from '../shared/model-connections.js';
import { chooseModel, connectionReferences, effectiveSelection, reasoningLabel, selectionAvailability, selectionIssue } from '../client/lib/model-selection.js';
import { ModelSelectionPicker } from '../client/components/ModelSelectionPicker.js';
import { SceneModelSelector } from '../client/components/SceneModelSelector.js';
import { ApiConnectionEditor, ModelConnectionDiagnostic, ModelConnectionsPanel, ModelLogoutNotice } from '../client/components/ModelConnectionsPanel.js';

const deepseek: ModelConnection = { id: 'api-one', name: '自定义连接', kind: 'api-key', protocol: 'deepseek', endpoint: 'https://api.example.com/v1',
  enabled: true, status: 'ready', credentialConfigured: true, editRevision: 1, bindingRevision: 1, identityRevision: 1, credentialVersion: 1 };
const siwc: ModelConnection = { ...deepseek, id: 'siwc-one', name: 'ChatGPT 一号', kind: 'siwc', protocol: 'siwc-responses', endpoint: 'https://api.openai.com/v1',
  models: [{ id: 'allowed-model', name: '账号可用模型', reasoning: ['low', 'high'], source: 'provider' }] };
const selection: ModelSelection = { connectionId: deepseek.id, modelId: 'deepseek-model', reasoning: 'high', maxOutputTokens: null };
const directory: ModelDirectory = { connections: [deepseek, siwc], defaults: { global: selection, background: { mode: 'inherit-global' }, revision: 1 },
  scenes: [{ caseId: 'explicit', preference: { mode: 'explicit', selection: { ...selection } }, revision: 2 }], hub: { configured: true } };

test('inheritance follows a new global value while an equal explicit scene remains unchanged', () => {
  const changed = { ...selection, connectionId: siwc.id, modelId: 'allowed-model' };
  assert.equal(effectiveSelection({ mode: 'inherit-global' }, changed), changed);
  assert.deepEqual(effectiveSelection(directory.scenes[0].preference, changed), selection);
  assert.equal(effectiveSelection({ mode: 'inherit-global' }, null), null);
  assert.deepEqual(connectionReferences(directory, deepseek.id), ['全局默认', '1 个场景配置']);
});

test('connection failures retain the chosen identity and do not invalidate unrelated selections', () => {
  const connections = [{ ...deepseek, credentialConfigured: false }, siwc];
  assert.equal(selectionAvailability(selection, connections), '尚未保存密钥');
  assert.equal(selectionAvailability({ ...selection, connectionId: siwc.id, modelId: 'allowed-model' }, connections), null);
  assert.equal(selection.connectionId, 'api-one');
});

test('model switches require a supported thinking choice, and SIWC choices stay account-scoped', () => {
  assert.equal(selectionIssue(selection, [deepseek]), null);
  assert.equal(chooseModel({ ...selection, reasoning: 'max' }, 'allowed-model', siwc).reasoning, '');
  assert.match(selectionIssue({ ...selection, connectionId: siwc.id, modelId: 'not-in-account' }, [siwc])!, /账号的模型目录/);
  assert.match(selectionIssue({ ...selection, connectionId: siwc.id, modelId: 'allowed-model', maxOutputTokens: 32 }, [siwc])!, /不支持自定义输出上限/);
  assert.equal(selectionIssue({ ...selection, connectionId: siwc.id, modelId: 'allowed-model', reasoning: 'default' }, [siwc]), null);
});

test('picker retains stale values visibly without offering invented SIWC capabilities', () => {
  const stale = { ...selection, connectionId: siwc.id, modelId: 'removed-model', reasoning: 'ultra' };
  const html = renderToStaticMarkup(createElement(ModelSelectionPicker, { connections: [siwc], value: stale, onChange() {} }));
  assert.match(html, /removed-model · 当前目录中不可用/);
  assert.match(html, /极致 · 未确认支持/);
  assert.match(html, /服务商默认/);
  assert.doesNotMatch(html, /value="max"/);
  assert.equal(reasoningLabel('auto'), '自动');
});

test('scene selector exposes persisted source and failure without a per-message override', () => {
  const props = { directory, perform: async () => true, busy: [], onManage() {} };
  const inherited = renderToStaticMarkup(createElement(SceneModelSelector, { ...props, caseId: 'other' }));
  assert.match(inherited, /跟随全局 · 自定义连接/);
  const explicit = renderToStaticMarkup(createElement(SceneModelSelector, { ...props, caseId: 'explicit' }));
  assert.match(explicit, /场景配置 · 自定义连接/);
  const failed = renderToStaticMarkup(createElement(SceneModelSelector, { ...props, caseId: 'explicit',
    directory: { ...directory, connections: [{ ...deepseek, status: 'disabled', enabled: false }] } }));
  assert.match(failed, /已停用 · 选择与历史已保留/);
  assert.doesNotMatch(failed, /本次消息的思考强度|发送后恢复默认/);
});

test('existing API connection protocol is fixed while a new connection still offers a protocol choice', () => {
  const props = { busy: [], mutate: async () => true, onClose() {} };
  const existing = renderToStaticMarkup(createElement(ApiConnectionEditor, { ...props, original: deepseek }));
  assert.match(existing, /<select[^>]*aria-label="接口协议"[^>]*disabled=""/);
  assert.match(existing, /需要其他协议时，请添加独立连接/);
  assert.match(existing, /<option value="deepseek" selected="">/);
  const fresh = renderToStaticMarkup(createElement(ApiConnectionEditor, props));
  assert.doesNotMatch(fresh, /<select[^>]*aria-label="接口协议"[^>]*disabled/);
});

test('logout notice distinguishes an unconfirmed remote revocation and preserves the provider result', () => {
  const unconfirmed = renderToStaticMarkup(createElement(ModelLogoutNotice, { result: { remoteRevoked: false, message: '撤销请求暂未得到响应，已有连接配置保留。' } }));
  assert.match(unconfirmed, /role="status"/);
  assert.match(unconfirmed, /远端撤销未确认/);
  assert.match(unconfirmed, /撤销请求暂未得到响应，已有连接配置保留/);
  assert.doesNotMatch(unconfirmed, /账号已退出。/);
  const fallback = renderToStaticMarkup(createElement(ModelLogoutNotice, { result: { remoteRevoked: false } }));
  assert.match(fallback, /ChatGPT 设置中断开此应用/);
  const confirmed = renderToStaticMarkup(createElement(ModelLogoutNotice, { result: { remoteRevoked: true } }));
  assert.match(confirmed, /账号已退出/);
  assert.doesNotMatch(confirmed, /远端撤销未确认/);
});

test('recent connection failure is visible while authentication stays ready and absent when the server clears it', () => {
  const connection: ModelConnection = { ...siwc, recentDiagnostic: { category: 'quota', message: '该连接的用量已达限制，请在 ChatGPT 设置中管理用量。',
    at: '2026-11-14T00:00:00.000Z', modelId: 'allowed-model', code: 'subscription_sharing_usage_limit_exceeded', status: 429 } };
  const markup = () => renderToStaticMarkup(createElement(ModelConnectionDiagnostic, { connection }));
  assert.match(markup(), /role="status"/);
  assert.match(markup(), /allowed-model/);
  assert.match(markup(), /用量已达限制/);
  assert.equal(connection.status, 'ready');
  assert.equal(renderToStaticMarkup(createElement(ModelConnectionDiagnostic, { connection: siwc })), '');
});

test('protocol use is visible without disabling chat selection or claiming model quality', () => {
  const chat: ModelConnection = { ...deepseek, id: 'chat-only', name: 'Chat connection', protocol: 'openai-chat' };
  const responses: ModelConnection = { ...deepseek, id: 'responses', name: 'Responses connection', protocol: 'openai-responses' };
  const connections = [chat, responses, deepseek, siwc];
  let changes = 0;
  for (const connection of connections) {
    const value = { connectionId: connection.id, modelId: connection.kind === 'siwc' ? 'allowed-model' : 'configured-model', reasoning: 'default', maxOutputTokens: null };
    const html = renderToStaticMarkup(createElement(ModelSelectionPicker, { connections, value, onChange() { changes++; } }));
    assert.ok(html.includes(modelProtocolUseLabel(connection.protocol)));
    assert.match(html, /aria-describedby="[^"]+-protocol"/);
    assert.match(html, new RegExp(`<option value="${connection.id}" selected=""`));
    assert.equal(selectionIssue(value, connections), null);
    assert.doesNotMatch(html, /质量已验证|效果已验证|自动切换/);
  }
  assert.equal(changes, 0);
  assert.match(modelProtocolUseLabel('openai-chat'), /聊天协议。项目执行需 Responses/);
  assert.match(modelProtocolUseLabel('deepseek'), /兼容 Hub.*还需.*Responses/);
  const panel = renderToStaticMarkup(createElement(ModelConnectionsPanel, { directory: { ...directory, connections }, perform: async () => true, busy: [] }));
  for (const connection of connections) assert.ok(panel.includes(modelProtocolUseLabel(connection.protocol)));
});
