import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import { modelContextWindowSchema, modelProtocolUseLabel, type ModelConnection, type ModelConnectionInput, type ModelDirectory, type ModelPreference,
  type ModelProtocol, type ModelSelection } from '../../shared/model-connections';
import { api, type Perform } from '../api';
import { connectionReferences, connectionStatusLabel, effectiveSelection, selectionAvailability, selectionIssue, selectionLabel } from '../lib/model-selection';
import { ModelSelectionPicker } from './ModelSelectionPicker';
import { ModelOAuthLogin } from './ModelOAuthLogin';

type Mutate = (key: string, work: () => Promise<unknown>, success?: string) => Promise<boolean>;
const connectionPath = (id: string) => `/api/models/connections/${encodeURIComponent(id)}`;

function DefaultModelEditor({ scope, directory, busy, mutate }: {
  scope: 'global' | 'background'; directory: ModelDirectory; busy: readonly string[]; mutate: Mutate;
}) {
  const title = scope === 'global' ? '全局默认' : '后台默认';
  const preference: ModelPreference = scope === 'background' ? directory.defaults.background : directory.defaults.global
    ? { mode: 'explicit', selection: directory.defaults.global } : { mode: 'inherit-global' };
  const selected = scope === 'global' ? directory.defaults.global : effectiveSelection(preference, directory.defaults.global);
  const [draft, setDraft] = useState<{ selection: ModelSelection | null; inherit: boolean; revision: number }>();
  const [error, setError] = useState('');
  const key = `model-default:${scope}`;
  const saving = busy.includes(key);
  const unavailable = selectionAvailability(selected, directory.connections);
  async function save() {
    if (!draft || saving) return;
    if (!draft.inherit) {
      const issue = selectionIssue(draft.selection, directory.connections);
      if (issue) { setError(issue); return; }
    }
    setError('');
    const body = scope === 'global' ? { global: draft.selection, expectedRevision: draft.revision }
      : { background: draft.inherit ? { mode: 'inherit-global' } : { mode: 'explicit', selection: draft.selection }, expectedRevision: draft.revision };
    const accepted = await mutate(key, async () => {
      try { await api('/api/models/defaults', 'PATCH', body); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '默认配置未保存。'); throw cause; }
    }, `${title}已保存。`);
    if (accepted) setDraft(undefined);
  }
  return <section className="model-default-section" aria-label={title}>
    <div className="model-section-heading"><h4>{title}{scope === 'background' && preference.mode === 'inherit-global' && <span className="tag">跟随全局</span>}</h4>
      {!draft && <button type="button" className="text-link" onClick={() => { setError(''); setDraft({ selection: selected ? { ...selected } : null,
        inherit: scope === 'background' && preference.mode === 'inherit-global', revision: directory.defaults.revision }); }}>修改</button>}
    </div>
    {!draft ? <><p className="model-selection-summary">{selectionLabel(selected, directory.connections)}</p>
      {unavailable && <p className="field-note">{unavailable}，已保存的选择保持不变。</p>}
      <p className="field-note">{scope === 'global' ? '没有单独配置的场景使用这组选择。' : '用于新的自主后台分析；不会改变前台场景或已经开始的任务。'}</p></>
      : <fieldset disabled={saving} className="form-stack model-editor">
        {scope === 'background' && <label className="checkbox-label"><input type="checkbox" checked={draft.inherit}
          onChange={event => setDraft({ ...draft, inherit: event.target.checked })} />跟随全局默认</label>}
        {draft.inherit ? <p className="field-note">{selectionLabel(directory.defaults.global, directory.connections)}</p>
          : <ModelSelectionPicker connections={directory.connections} value={draft.selection} label={title}
            onChange={value => setDraft({ ...draft, selection: value })} />}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="form-actions"><button type="button" className="button button-primary" onClick={() => void save()}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存{title}</button>
          <button type="button" className="button button-quiet" onClick={() => setDraft(undefined)}>取消修改</button></div>
      </fieldset>}
  </section>;
}

export function ApiConnectionEditor({ original, busy, mutate, onClose }: {
  original?: ModelConnection; busy: readonly string[]; mutate: Mutate; onClose(): void;
}) {
  const [initial] = useState(original);
  const [form, setForm] = useState({ name: original?.name ?? '', endpoint: original?.endpoint ?? '',
    protocol: original?.protocol ?? 'openai-chat' as ModelProtocol, apiKey: '', clearApiKey: false });
  const [error, setError] = useState('');
  const key = `model-connection:${original?.id ?? 'new'}`;
  const saving = busy.includes(key);
  async function save() {
    if (saving) return;
    if (!form.name.trim() || !form.endpoint.trim()) { setError('请填写连接名称和接口地址。'); return; }
    const body: ModelConnectionInput = { name: form.name.trim(), kind: 'api-key', protocol: initial?.protocol ?? form.protocol, endpoint: form.endpoint.trim(),
      ...(initial ? { expectedRevision: initial.editRevision } : {}),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : form.clearApiKey ? { clearApiKey: true } : {}) };
    setError('');
    if (await mutate(key, async () => {
      try { await api(original ? connectionPath(original.id) : '/api/models/connections', original ? 'PATCH' : 'POST', body); }
      catch (cause) { setError(cause instanceof Error ? cause.message : '连接未保存。'); throw cause; }
    }, original ? '连接已保存，默认与场景选择保持不变。' : '连接已添加，可在默认或场景中选择。')) onClose();
  }
  return <fieldset disabled={saving} className="form-stack model-editor" aria-label={original ? `修改 ${original.name}` : '添加 API 连接'}>
    <div className="form-row"><label>连接名称<input value={form.name} maxLength={100} autoComplete="off"
      onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：我的 DeepSeek" /></label>
      <label>接口协议<select aria-label="接口协议" value={form.protocol} disabled={Boolean(initial)} onChange={event => setForm({ ...form, protocol: event.target.value as ModelProtocol })}>
        <option value="openai-chat">OpenAI Chat Completions 兼容</option><option value="deepseek">DeepSeek 兼容</option><option value="openai-responses">OpenAI Responses 兼容</option>
      </select></label></div>
    {initial && <p className="field-note">已有连接的协议保持不变。需要其他协议时，请添加独立连接，再修改默认或场景选择。</p>}
    <label>Base URL<input type="url" value={form.endpoint} maxLength={500} autoComplete="off" placeholder="https://api.example.com/v1"
      onChange={event => setForm({ ...form, endpoint: event.target.value })} /></label>
    <label>API Key<input type="password" autoComplete="new-password" value={form.apiKey} maxLength={16384}
      placeholder={original?.credentialConfigured ? '留空保留已保存的密钥' : '输入接口密钥'}
      onChange={event => setForm({ ...form, apiKey: event.target.value, clearApiKey: false })} /></label>
    <p className="field-note">密钥保存在服务端，添加连接不会替换当前默认。更换地址时，请核对新的资料接收方。</p>
    {original?.credentialSource === 'environment' && <p className="field-note">这个连接的密钥由服务端环境配置提供，环境配置仍优先。</p>}
    {original?.credentialConfigured && <label className="checkbox-label"><input type="checkbox" checked={form.clearApiKey} disabled={Boolean(form.apiKey.trim()) || original.credentialSource === 'environment'}
      onChange={event => setForm({ ...form, clearApiKey: event.target.checked })} />清除已保存的密钥，保留连接配置</label>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="button button-primary" onClick={() => void save()}>{saving && <LoaderCircle size={14} className="spin" />}保存连接</button>
      <button type="button" className="button button-quiet" onClick={onClose}>取消修改</button></div>
  </fieldset>;
}

function ModelContextWindowEditor({ connection, busy, mutate, onClose }: {
  connection: ModelConnection; busy: readonly string[]; mutate: Mutate; onClose(): void;
}) {
  const [original] = useState(connection);
  const [modelId, setModelId] = useState('');
  const [windowInput, setWindowInput] = useState('');
  const [error, setError] = useState('');
  const key = `model-context-window:${connection.id}`;
  const catalogId = `model-context-catalog-${connection.id}`;
  const saving = busy.includes(key);
  const configured = original.contextWindows ?? [];
  const candidates = new Set([...(connection.models ?? []).map(model => model.id), ...configured.map(model => model.modelId)]);
  const providerWindow = connection.models?.find(model => model.id === modelId.trim())?.contextWindow;

  async function save() {
    if (saving) return;
    const id = modelId.trim();
    if (!id) { setError('请填写模型 ID。'); return; }
    const window = windowInput.trim();
    const parsed = modelContextWindowSchema.safeParse(Number(window));
    if (window && (!/^\d+$/.test(window) || !parsed.success)) { setError('请输入大于零的整数 token 数。'); return; }
    const contextWindows = configured.filter(model => model.modelId !== id);
    if (parsed.success) contextWindows.push({ modelId: id, contextWindow: parsed.data });
    setError('');
    if (await mutate(key, () => api(connectionPath(original.id), 'PATCH', {
      name: original.name, kind: original.kind, protocol: original.protocol, endpoint: original.endpoint,
      expectedRevision: original.editRevision, contextWindows,
    }), '项目上下文设置已保存。')) onClose();
  }

  return <fieldset disabled={saving} className="form-stack model-editor" aria-label={`配置 ${connection.name} 的项目上下文`}>
    <div className="form-row"><label>模型 ID<input value={modelId} list={catalogId} maxLength={200} autoComplete="off"
      onChange={event => {
        const value = event.target.value;
        const existing = configured.find(model => model.modelId === value.trim());
        setModelId(value);
        setWindowInput(existing ? String(existing.contextWindow) : '');
      }} /></label>
    <label>上下文窗口（token）<input value={windowInput} inputMode="numeric" autoComplete="off" maxLength={16}
      placeholder={providerWindow?.toLocaleString('zh-CN') ?? '供应商未报告'} onChange={event => setWindowInput(event.target.value)} /></label></div>
    <datalist id={catalogId}>{Array.from(candidates, id => <option key={id} value={id} />)}</datalist>
    <p className="field-note">填写此模型在当前连接上的输入和输出总容量。留空使用供应商目录，供新项目任务自动整理上下文。</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="button button-primary" onClick={() => void save()}>
      {saving && <LoaderCircle size={14} className="spin" />}保存窗口</button>
      <button type="button" className="button button-quiet" onClick={onClose}>取消修改</button></div>
  </fieldset>;
}

interface LogoutResult { remoteRevoked: boolean; message?: string }
export function ModelLogoutNotice({ result }: { result: LogoutResult }) {
  return <p className={`inline-result ${result.remoteRevoked ? 'success' : 'failure'}`} role="status">
    <strong>{result.remoteRevoked ? '账号已退出。' : '远端撤销未确认。'}</strong>{' '}
    {result.message || (result.remoteRevoked ? '本地凭据已清除，连接和场景选择保留。' : '本地已退出，可在 ChatGPT 设置中断开此应用；连接和场景选择保留。')}
  </p>;
}

export function ModelConnectionDiagnostic({ connection }: { connection: ModelConnection }) {
  const diagnostic = connection.recentDiagnostic;
  if (!diagnostic) return null;
  return <p className="inline-result failure" role="status">
    最近调用{diagnostic.modelId ? `（${diagnostic.modelId}）` : ''}：{diagnostic.message}
  </p>;
}

function ConnectionTest({ connection, directory, busy, mutate, onClose }: {
  connection: ModelConnection; directory: ModelDirectory; busy: readonly string[]; mutate: Mutate; onClose(): void;
}) {
  const candidates = [directory.defaults.global, directory.defaults.background.mode === 'explicit' ? directory.defaults.background.selection : null,
    ...directory.scenes.map(scene => scene.preference.mode === 'explicit' ? scene.preference.selection : null)];
  const [selection, setSelection] = useState<ModelSelection>(() => candidates.find(item => item?.connectionId === connection.id)
    ?? { connectionId: connection.id, modelId: '', reasoning: '', maxOutputTokens: null });
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const key = `model-test:${connection.id}`; const testing = busy.includes(key);
  async function test() {
    if (testing) return;
    const issue = selectionIssue(selection, [connection]);
    if (issue) { setResult({ ok: false, message: issue }); return; }
    setResult(undefined);
    await mutate(key, async () => {
      try { setResult(await api<{ ok: boolean; message: string }>(`${connectionPath(connection.id)}/test`, 'POST', { selection })); }
      catch (cause) { setResult({ ok: false, message: cause instanceof Error ? cause.message : '连接测试未完成。' }); throw cause; }
    });
  }
  return <fieldset className="form-stack model-editor" disabled={testing} aria-label={`测试 ${connection.name}`}>
    <ModelSelectionPicker connections={[connection]} value={selection} onChange={setSelection} />
    <p className="field-note">点击测试会使用此连接发起一次真实模型请求，消耗其额度；不会修改默认配置或开启自主推理。</p>
    {result && <p className={`inline-result ${result.ok ? 'success' : 'failure'}`} role="status">{result.message}</p>}
    <div className="form-actions"><button type="button" className="button" onClick={() => void test()}>{testing && <LoaderCircle size={14} className="spin" />}发起一次测试</button>
      <button type="button" className="button button-quiet" onClick={onClose}>关闭测试</button></div>
  </fieldset>;
}

export function ModelConnectionsPanel({ directory: initial, perform, busy }: {
  directory?: ModelDirectory; perform: Perform; busy: readonly string[];
}) {
  const [directory, setDirectory] = useState(initial);
  const [loadingError, setLoadingError] = useState('');
  const [editing, setEditing] = useState<string>();
  const [editingWindow, setEditingWindow] = useState<string>();
  const [testing, setTesting] = useState<string>();
  const [oauth, setOAuth] = useState<{ connection?: ModelConnection }>();
  const [actionError, setActionError] = useState('');
  const [logoutResults, setLogoutResults] = useState<Record<string, LogoutResult>>({});
  useEffect(() => { if (initial) setDirectory(initial); }, [initial]);
  useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    void api<ModelDirectory>('/api/models', 'GET', undefined, controller.signal).then(setDirectory).catch(error => {
      if (!controller.signal.aborted) setLoadingError(error instanceof Error ? error.message : '模型连接暂时无法读取。');
    });
    return () => controller.abort();
  }, [Boolean(initial)]);
  async function refresh() {
    const next = await api<ModelDirectory>('/api/models'); setDirectory(next); setLoadingError('');
  }
  const mutate: Mutate = async (key, work, success) => {
    setActionError('');
    return perform(key, async () => {
      try {
        await work();
        try { await refresh(); }
        catch { setLoadingError('操作已提交，但最新状态尚未读取。请刷新状态后核对。'); }
      }
      catch (cause) { setActionError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); throw cause; }
    }, success);
  };
  async function changeEnabled(connection: ModelConnection) {
    await mutate(`model-state:${connection.id}`, () => api(connectionPath(connection.id), 'PATCH', {
      name: connection.name, kind: connection.kind, protocol: connection.protocol, endpoint: connection.endpoint,
      expectedRevision: connection.editRevision, enabled: !connection.enabled,
    }), connection.enabled ? '连接已停用，已保存的选择保留。' : '连接已启用。');
  }
  async function logout(connection: ModelConnection) {
    await mutate(`model-logout:${connection.id}`, async () => {
      const result = await api<LogoutResult>(`${connectionPath(connection.id)}/logout`, 'POST', {});
      setLogoutResults(current => ({ ...current, [connection.id]: result }));
    });
  }
  return <section className="panel-section model-connections" aria-label="模型连接与默认配置">
    <div className="model-section-heading"><h3>模型连接</h3><button type="button" className="text-link" disabled={busy.includes('model-directory')}
      onClick={() => void perform('model-directory', refresh)}><RefreshCw size={13} />刷新状态</button></div>
    <p className="field-note">分别保存接口与 ChatGPT 账号，再为默认或场景选择模型。新增连接不会改变已有选择。</p>
    {loadingError && <p className="field-error" role="alert">{loadingError}</p>}
    {!directory ? <p className="field-note" role="status">正在读取模型连接…</p> : <>
      <ul className="model-connection-list">
        {directory.connections.filter(connection => !connection.archived).map(connection => {
          const references = connectionReferences(directory, connection.id);
          const changing = busy.some(key => key.endsWith(`:${connection.id}`));
          return <li key={connection.id} className="model-connection-record">
            <div className="model-section-heading"><h4>{connection.name}</h4><span className={`tag${connection.status !== 'ready' || !connection.enabled ? ' model-status-muted' : ''}`}>{connectionStatusLabel(connection)}</span></div>
            <p className="field-note model-connection-identity">{connection.kind === 'siwc' ? connection.identity?.label ?? 'ChatGPT 账号' : connection.endpoint}</p>
            <p className="field-note">{modelProtocolUseLabel(connection.protocol)}</p>
            {references.length > 0 && <p className="field-note">用于：{references.join('、')}</p>}
            <ModelConnectionDiagnostic connection={connection} />
            <div className="model-connection-actions">
              {connection.kind === 'api-key' ? <button type="button" className="text-link" disabled={changing} onClick={() => { setTesting(undefined); setEditingWindow(undefined); setEditing(connection.id); }}>修改连接</button>
                : <><button type="button" className="text-link" disabled={changing || Boolean(oauth)} onClick={() => setOAuth({ connection })}>{connection.status === 'scope-required' ? '授权模型调用' : '重新登录'}</button>
                  {connection.credentialConfigured && <button type="button" className="text-link" disabled={changing} onClick={() => void logout(connection)}>退出账号</button>}
                  <a className="text-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">管理用量</a></>}
              <button type="button" className="text-link" disabled={changing || !connection.enabled || !connection.credentialConfigured} onClick={() => void mutate(`model-catalog:${connection.id}`,
                () => api(`${connectionPath(connection.id)}/catalog`, 'POST', {}), '模型目录已更新。')}>获取模型目录</button>
              {connection.protocol !== 'openai-chat' && <button type="button" className="text-link" disabled={changing}
                onClick={() => { setEditing(undefined); setTesting(undefined); setEditingWindow(connection.id); }}>项目上下文</button>}
              <button type="button" className="text-link" disabled={changing || !connection.enabled || !connection.credentialConfigured}
                onClick={() => { setEditing(undefined); setEditingWindow(undefined); setTesting(connection.id); }}>测试连接</button>
              <button type="button" className="text-link" disabled={changing} onClick={() => void changeEnabled(connection)}>{connection.enabled ? '停用' : '启用'}</button>
              {!references.length && !connection.enabled && <button type="button" className="text-link model-danger" disabled={changing} onClick={() => void mutate(`model-delete:${connection.id}`,
                () => api(connectionPath(connection.id), 'DELETE', { expectedRevision: connection.editRevision }), '已移除连接，历史记录保留。')}>移除已停用连接</button>}
            </div>
            {logoutResults[connection.id] && <ModelLogoutNotice result={logoutResults[connection.id]} />}
            {editing === connection.id && <ApiConnectionEditor original={connection} busy={busy} mutate={mutate} onClose={() => setEditing(undefined)} />}
            {editingWindow === connection.id && <ModelContextWindowEditor connection={connection} busy={busy} mutate={mutate} onClose={() => setEditingWindow(undefined)} />}
            {testing === connection.id && <ConnectionTest connection={connection} directory={directory} busy={busy} mutate={mutate} onClose={() => setTesting(undefined)} />}
          </li>;
        })}
      </ul>
      {!directory.connections.length && <p className="field-note">还没有模型连接。添加后可以设置默认模型。</p>}
      {editing === 'new' && <ApiConnectionEditor busy={busy} mutate={mutate} onClose={() => setEditing(undefined)} />}
      {oauth && <ModelOAuthLogin connection={oauth.connection} onClose={() => setOAuth(undefined)} onConnected={refresh} />}
      <div className="form-actions model-add-actions">
        <button type="button" className="button" disabled={editing === 'new'} onClick={() => { setTesting(undefined); setEditingWindow(undefined); setEditing('new'); }}><Plus size={14} />添加 API 连接</button>
        <button type="button" className="button" disabled={Boolean(oauth)} onClick={() => setOAuth({})}>连接 ChatGPT 账号</button>
      </div>
      {actionError && <p className="field-error" role="alert">{actionError}</p>}
      <div className="model-defaults">
        <DefaultModelEditor scope="global" directory={directory} busy={busy} mutate={mutate} />
        <DefaultModelEditor scope="background" directory={directory} busy={busy} mutate={mutate} />
      </div>
    </>}
  </section>;
}
