import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EwsConnectorForm, EwsCredentialsForm } from './EwsConnectorForm';
import { EwsMailboxBrowser } from './EwsMailboxBrowser';
import { GitHubAccountDetails, GitHubAccountUpgradeForm, GitHubConnectorForm, GitHubCredentialsForm } from './GitHubConnectorForm';
import { OAuthAppForm } from './OAuthAppForm';
import { ArrowUpRight, Cable, LoaderCircle, RefreshCw, Unplug } from 'lucide-react';
import type { ConnectorConnection, ConnectorDirectory, ConnectorDocumentMetadata, ConnectorKind, TencentDocsCredential } from '../../shared/connectors';
import { api } from '../api';
import { connectorOAuthBrowserRequired as isDesktop, startConnectorOAuth, type ConnectorOAuthResult, type OAuthConnectorKind } from '../lib/connector-oauth';
import { dateTime } from '../lib/format';
import { DEFAULT_SCENE_ID, openSceneChoices, sceneName } from '../state/ui-state';
import type { PanelContext } from './types';

type WebConnectorKind = 'tencent-docs' | 'ews' | 'github' | OAuthConnectorKind;
const providers: Record<WebConnectorKind, { name: string; label: string; placeholder: string; hint: string; defaultScope?: string }> = {
  'tencent-docs': { name: '腾讯文档', label: '文档 ID 或直链', placeholder: 'https://docs.qq.com/doc/…', hint: '填写单个文档的 ID 或 docs.qq.com 文档直链。' },
  github: { name: 'GitHub', label: '账号', placeholder: '个人访问令牌', hint: '通过 GitHub 官方 MCP 按需使用账号可访问的全部仓库。' },
  gmail: { name: 'Gmail', label: '标签 ID', placeholder: 'INBOX', hint: '默认观察收件箱。Gmail 会申请只读邮箱权限，榫只同步所选标签。', defaultScope: 'INBOX' },
  outlook: { name: 'Outlook', label: '文件夹 ID', placeholder: 'inbox', hint: '默认观察收件箱。Microsoft 会申请只读邮件权限，榫只同步所选文件夹。', defaultScope: 'inbox' },
  ews: { name: '企业 Exchange（EWS）', label: '收件箱', placeholder: 'inbox', hint: '服务端读取并解密收件箱新邮件。', defaultScope: 'inbox' },
};
type ObservationTopic = Pick<PanelContext['runtime']['cases'][number], 'id' | 'title'>;
const tencentDocsEndpoint = '/api/connectors/tencent-docs';
const tencentPreviewId = /^[A-Za-z0-9_-]{12,128}$/;
const tencentPreviewPath = /^\/(?:doc|sheet|slide|form|mind|flowchart|board|smartcanvas|smartsheet|pdf|aio)\/([A-Za-z0-9_-]{12,128})\/?$/;
const tencentDocumentTypes = new Map([
  ['doc', '在线文档'], ['word', 'Word 文档'], ['sheet', '在线表格'], ['excel', '在线表格'],
  ['slide', '幻灯片'], ['ppt', '幻灯片'], ['form', '收集表'], ['mind', '思维导图'],
  ['flowchart', '流程图'], ['board', '白板'], ['smartcanvas', '智能文档'], ['smartsheet', '智能表格'], ['pdf', 'PDF'],
]);

function tencentDocumentType(document: ConnectorDocumentMetadata) {
  const reportedType = document.type?.trim().toLowerCase() ?? '';
  const urlType = document.url?.match(/^https:\/\/docs\.qq\.com\/([a-z]+)\//)?.[1] ?? '';
  return tencentDocumentTypes.get(reportedType) ?? tencentDocumentTypes.get(urlType) ?? '未知类型';
}

function tencentPreviewScope(scope: string) {
  const value = scope.trim();
  // Preview only complete-looking IDs. Saving still uses the server's full validation.
  if (tencentPreviewId.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin === 'https://docs.qq.com' && !url.username && !url.password) return tencentPreviewPath.exec(url.pathname)?.[1];
  } catch { /* A partial or malformed address has no preview. */ }
}

function tencentCredentialLabel(credential: TencentDocsCredential, timezone: string) {
  const date = dateTime(credential.createdAt, timezone, true);
  const reference = `令牌 ${credential.id.slice(0, 8)}`;
  return date ? `${reference} · ${date} 保存` : reference;
}

function isWebConnector<T extends { kind: ConnectorKind }>(item: T): item is T & { kind: WebConnectorKind } {
  return Object.hasOwn(providers, item.kind);
}

function isOAuthKind(kind: ConnectorKind): kind is OAuthConnectorKind { return kind === 'gmail' || kind === 'outlook'; }

export function ConnectorsPanel({ runtime, perform, busy, onOpenPanel, initialCaseId, oauthResult }: PanelContext & {
  initialCaseId?: string | null;
  oauthResult?: ConnectorOAuthResult;
}) {
  const [directory, setDirectory] = useState<ConnectorDirectory>();
  const [selectedKind, setSelectedKind] = useState<WebConnectorKind>();
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingEws, setEditingEws] = useState<string>();
  const [editingGithub, setEditingGithub] = useState<string>();
  const [browsingEws, setBrowsingEws] = useState<string>();
  const oauthPending = oauthResult?.status === 'pending';
  useEffect(() => {
    if (oauthPending) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<ConnectorDirectory>('/api/connectors', 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDirectory(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '连接器暂时无法读取。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [oauthPending, reload]);

  const available = directory?.providers.filter(isWebConnector) ?? [];
  const connections = directory?.connections.filter(isWebConnector) ?? [];
  const provider = available.find(item => item.kind === selectedKind) ?? available.find(item => item.configured) ?? available[0];
  const cases = openSceneChoices(runtime.cases);
  const preferredCase = cases.find(item => item.id === (initialCaseId ?? DEFAULT_SCENE_ID));
  const credentials = directory?.tencentDocsCredentials ?? [];
  const timezone = runtime.settings.timezone;
  const refresh = () => {
    setLoading(true);
    setReload(value => value + 1);
  };
  const formProps = { cases, initialCaseId: preferredCase?.id, perform,
    disabled: oauthPending || busy.includes('connector-add'), onSaved: refresh };
  function updateConnection(connection: ConnectorConnection, action: 'sync' | 'disconnect') {
    const path = `/api/connectors/${encodeURIComponent(connection.id)}`;
    void perform(`connector:${connection.id}`, async () => {
      try {
        if (action === 'sync') await api(`${path}/sync`, 'POST', {});
        else await api(path, 'DELETE');
      } finally {
        refresh();
      }
    }, action === 'sync' ? '已完成同步请求。' : '已断开连接。');
  }
  function reauthorize(connection: ConnectorConnection) {
    if (!isOAuthKind(connection.kind)) return;
    const kind = connection.kind;
    if (!available.find(item => item.kind === kind)?.configured) { setSelectedKind(kind); return; }
    if (isDesktop()) return;
    void perform(`connector:${connection.id}:credentials`, () => startConnectorOAuth(kind, connection.caseId, connection.scope, connection.id));
  }

  return <div className="connector-panel form-stack">
    <p className="field-note">GitHub 账号可在所有本人场景使用，其他资料连接绑定到指定场景。发信、提交代码等操作仍须你明确委托。</p>
    {oauthResult && <p className={`inline-result ${oauthResult.status === 'error' ? 'failure' : oauthResult.status}`}
      role={oauthResult.status === 'error' ? 'alert' : 'status'}>{oauthResult.message}</p>}
    <section className="connector-section" aria-labelledby="connector-connections">
      <div className="connector-section-heading"><h3 id="connector-connections">已添加的连接</h3>
        <button type="button" className="text-link" disabled={loading || oauthPending} onClick={refresh}><RefreshCw size={14} />刷新状态</button>
      </div>
      {loading && !oauthPending && <p className="field-note" role="status">正在读取连接器…</p>}
      {error && <p className="inline-result failure" role="alert">{error}</p>}
      {!loading && !error && !connections.length && <p className="field-note">还没有连接，选一个服务开始。</p>}
      <ul className="connector-list">
        {connections.map(connection => {
          const working = oauthPending || busy.includes(`connector:${connection.id}`) || busy.includes(`connector:${connection.id}:credentials`);
          const topic = runtime.cases.find(item => item.id === connection.caseId);
          const credential = connection.kind === 'tencent-docs' && credentials.find(item => item.id === connection.credentialId);
          const document = connection.kind === 'tencent-docs' && connection.document;
          const githubAccount = connection.github?.kind === 'account' ? connection.github : undefined;
          return <li className="connector-record" key={connection.id}>
            <div className="connector-record-heading">
              <h4>{document ? document.title : githubAccount ? `GitHub · @${githubAccount.login}` : providers[connection.kind].name}</h4>
              <span className={`tag${connection.status === 'error' ? ' connector-error' : ''}`}>{connection.needsAttention ? '需要处理' : connection.status === 'error' ? connection.kind === 'github' ? '连接异常' : '等待重试'
                : githubAccount ? '已连接' : connection.kind === 'github' ? '待升级' : connection.ews?.establishingBaseline ? '建立观察基线' : '观察中'}</span>
            </div>
            <dl className="connector-details">
              {connection.ews && <><dt>EWS 地址</dt><dd>{connection.ews.endpoint}</dd><dt>S/MIME 证书</dt><dd>{connection.ews.hasCertificate ? '已配置' : '未配置'}</dd></>}
              {connection.kind === 'github' && <GitHubAccountDetails connection={connection} />}
              {document && <><dt>类型</dt><dd>{tencentDocumentType(document)}</dd></>}
              {connection.kind !== 'github' && <><dt>场景</dt><dd>{sceneName(connection.caseId, topic?.title ?? connection.caseId)}</dd>
                <dt>范围</dt><dd>{connection.scope}</dd></>}
              {credential && <><dt>授权</dt><dd>{tencentCredentialLabel(credential, timezone)}</dd></>}
              <dt>{githubAccount ? '最近检查' : '最近同步'}</dt><dd>{connection.lastSyncedAt ? dateTime(connection.lastSyncedAt, timezone, true) : githubAccount ? '尚未检查' : '尚未同步'}</dd>
              {connection.kind !== 'github' && !connection.needsAttention && connection.nextSyncAt && <><dt>下次检查</dt><dd>{dateTime(connection.nextSyncAt, timezone, true)}</dd></>}
            </dl>
            {connection.message && <p className={`inline-result${connection.status === 'error' ? ' failure' : ''}`}>{connection.message}</p>}
            <div className="form-actions">
              {(connection.kind !== 'github' || githubAccount) && <button className="text-link" type="button" disabled={working} onClick={() => updateConnection(connection, 'sync')}>
                {working ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{githubAccount ? '检查连接' : '同步一次'}
              </button>}
              <button className="text-link" type="button" disabled={working} onClick={() => updateConnection(connection, 'disconnect')}><Unplug size={14} />断开</button>
              {connection.ews && <button className="text-link" type="button" disabled={working} onClick={() => setEditingEws(connection.id)}>更新密码或证书</button>}
              {connection.kind === 'github' && <button className="text-link" type="button" disabled={working} onClick={() => setEditingGithub(value => value === connection.id ? undefined : connection.id)}>
                {githubAccount ? '更新账号令牌' : '升级账号接入'}</button>}
              {isOAuthKind(connection.kind) && <button className="text-link" type="button" disabled={working || isDesktop() && Boolean(available.find(item => item.kind === connection.kind)?.configured)} onClick={() => reauthorize(connection)}>
                {available.find(item => item.kind === connection.kind)?.configured ? '重新授权' : '配置登录应用'}</button>}
              {connection.kind === 'ews' && <button className="text-link" type="button" disabled={working}
                onClick={() => setBrowsingEws(value => value === connection.id ? undefined : connection.id)}>查看邮件</button>}
              {connection.kind === 'ews' && <button className="text-link" type="button" disabled={working}
                onClick={() => onOpenPanel({ type: 'ewsCompose', connectionId: connection.id, mode: 'send' })}>写邮件</button>}
            </div>
            {isOAuthKind(connection.kind) && isDesktop() && connection.needsAttention && <OAuthBrowserGuide />}
            {connection.kind === 'github' && editingGithub === connection.id && (githubAccount
              ? <GitHubCredentialsForm connection={connection} perform={perform} disabled={working}
                onCancel={() => setEditingGithub(undefined)} onSaved={() => { setEditingGithub(undefined); refresh(); }} />
              : <GitHubAccountUpgradeForm connection={connection} perform={perform} disabled={working}
                onCancel={() => setEditingGithub(undefined)} onSaved={() => { setEditingGithub(undefined); refresh(); }} />)}
            {connection.ews && editingEws === connection.id && <EwsCredentialsForm connection={connection} perform={perform}
              onCancel={() => setEditingEws(undefined)} onSaved={() => { setEditingEws(undefined); refresh(); }} />}
            {connection.kind === 'ews' && browsingEws === connection.id && <EwsMailboxBrowser connectionId={connection.id} timezone={timezone}
              onClose={() => setBrowsingEws(undefined)} onCompose={(mode, original) => onOpenPanel({ type: 'ewsCompose', connectionId: connection.id, mode, original })} />}
          </li>;
        })}
      </ul>
    </section>
    {provider && <section className="connector-section" aria-labelledby="connector-add">
      <div className="connector-section-heading"><h3 id="connector-add">添加连接</h3><Cable size={17} aria-hidden="true" /></div>
      <label>服务<select value={provider.kind} disabled={oauthPending || busy.includes('connector-add')}
        onChange={event => setSelectedKind(available.find(item => item.kind === event.target.value)?.kind)}>
        {available.map(item => <option key={item.kind} value={item.kind}>{providers[item.kind].name}{item.configured ? '' : '（尚未配置）'}</option>)}
      </select></label>
      {isOAuthKind(provider.kind) && <OAuthAppForm key={`${provider.kind}:${provider.setup?.revision ?? 0}`} kind={provider.kind} setup={provider.setup}
        configured={provider.configured} perform={perform} disabled={oauthPending || loading || busy.includes(`connector-app:${provider.kind}`)}
        onSaved={refresh} origin={typeof window === 'undefined' ? '' : window.location.origin} />}
      {!provider.configured ? isOAuthKind(provider.kind) ? <p className="field-note">保存应用配置后，再选择场景和观察范围完成账号授权。</p> : <p className="field-note">{provider.kind === 'ews'
        ? '请先在榫服务端运行 npm run prepare:ews，重启服务后刷新此面板。'
        : '服务端尚未配置此连接器。配置完成后，刷新状态即可连接。'}</p>
        : provider.kind === 'tencent-docs' ? <TencentDocsForms {...formProps} disabled={formProps.disabled || loading}
          grantUrl={provider.grantUrl} credentials={credentials} connections={connections} timezone={timezone} />
          : provider.kind === 'ews' ? <EwsConnectorForm {...formProps} disabled={formProps.disabled || loading} />
          : provider.kind === 'github' ? <GitHubConnectorForm perform={perform} onSaved={refresh} disabled={formProps.disabled || loading} />
          : <OAuthConnectorForm key={provider.kind} kind={provider.kind} {...formProps} />}
    </section>}
  </div>;
}

interface ConnectorFormProps {
  cases: ObservationTopic[];
  initialCaseId?: string;
  perform: PanelContext['perform'];
  disabled: boolean;
  onSaved: () => void;
}

function TopicSelect({ cases, caseId, onChange }: { cases: ObservationTopic[]; caseId: string; onChange: (id: string) => void }) {
  return <label>绑定场景<select required value={cases.some(item => item.id === caseId) ? caseId : ''} onChange={event => onChange(event.target.value)}>
    <option value="" disabled>选择场景</option>
    {cases.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
  </select></label>;
}

function OAuthBrowserGuide() {
  const entry = typeof window === 'undefined' ? '' : new URL('/', window.location.origin).href;
  return <div className="form-stack" aria-label="在浏览器完成账号授权">
    <p className="field-note">请在系统浏览器打开下面的榫网页地址，登录后进入连接器，在同一标签页开始并完成授权。完成后可回到桌面客户端。</p>
    <label>榫网页地址<input readOnly value={entry} onFocus={event => event.target.select()} spellCheck={false} /></label>
  </div>;
}

function GrantLink({ url, label }: { url?: string; label: string }) {
  if (!url?.startsWith('https://')) return null;
  return isDesktop()
    ? <label>{label}，请在浏览器打开<input readOnly value={url} onFocus={event => event.target.select()} /></label>
    : <a className="text-link" href={url} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={14} /></a>;
}

export function OAuthConnectorForm({ kind, cases, initialCaseId, perform, disabled }: ConnectorFormProps & {
  kind: OAuthConnectorKind;
}) {
  const fields = providers[kind];
  const [caseId, setCaseId] = useState(initialCaseId ?? '');
  const [scope, setScope] = useState(fields.defaultScope ?? '');
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const browserRequired = isDesktop();
  const caseAvailable = cases.some(item => item.id === caseId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || inFlight.current || browserRequired || !caseAvailable || !scope.trim()) return;
    inFlight.current = true; setWorking(true);
    try { await perform('connector-add', () => startConnectorOAuth(kind, caseId, scope.trim())); }
    finally { inFlight.current = false; setWorking(false); }
  }

  return <form onSubmit={event => void submit(event)} className="form-stack connector-form">
    <fieldset className="form-stack" disabled={disabled || working}>
      <div className="form-row">
        <TopicSelect cases={cases} caseId={caseId} onChange={setCaseId} />
        <label>{fields.label}<input required maxLength={512} value={scope} onChange={event => setScope(event.target.value)}
          placeholder={fields.placeholder} autoComplete="off" spellCheck={false} /></label>
      </div>
      <p className="field-note">{fields.hint}</p>
      {browserRequired && <OAuthBrowserGuide />}
      {!cases.length && <p className="field-note">需要一个进行中或等待中的场景才能添加连接。</p>}
      <div className="form-actions"><button type="submit" className="button button-primary"
        disabled={browserRequired || !caseAvailable || !scope.trim()}>
        {disabled || working ? <LoaderCircle size={15} className="spin" /> : <ArrowUpRight size={15} />}
        前往 {fields.name} 授权
      </button></div>
    </fieldset>
  </form>;
}

function TencentDocsForms({ cases, initialCaseId, perform, disabled, onSaved, grantUrl, credentials, connections, timezone }: ConnectorFormProps & {
  grantUrl?: string;
  credentials: TencentDocsCredential[];
  connections: ConnectorConnection[];
  timezone: string;
}) {
  const [token, setToken] = useState('');
  const [selectedCredentialId, setCredentialId] = useState('');
  const [caseId, setCaseId] = useState(initialCaseId ?? '');
  const [scope, setScope] = useState('');
  const credential = credentials.length === 1 ? credentials[0] : credentials.find(item => item.id === selectedCredentialId);
  const caseAvailable = cases.some(item => item.id === caseId);
  const canAdd = Boolean(credential && scope.trim() && caseAvailable);
  const previewScope = tencentPreviewScope(scope);
  const fields = providers['tencent-docs'];

  async function saveCredential(event: FormEvent) {
    event.preventDefault();
    if (disabled || !token.trim()) return;
    const saved = await perform('connector-add', async () => {
      const authorization = await api<TencentDocsCredential>(`${tencentDocsEndpoint}/credentials`, 'POST', { token: token.trim() });
      setCredentialId(authorization.id);
    }, '腾讯文档令牌已保存。');
    if (saved) {
      setToken('');
      onSaved();
    }
  }

  function deleteCredential(id: string) {
    if (disabled) return;
    void perform('connector-add', async () => {
      try {
        await api(`${tencentDocsEndpoint}/credentials/${encodeURIComponent(id)}`, 'DELETE');
      } finally {
        onSaved();
      }
    }, '已删除腾讯文档令牌。');
  }

  async function addDocument(event: FormEvent) {
    event.preventDefault();
    if (disabled || !canAdd || !credential) return;
    const saved = await perform('connector-add', () => api(`${tencentDocsEndpoint}/documents`, 'POST',
      { caseId, scope: scope.trim(), credentialId: credential.id }), '腾讯文档已添加。');
    if (saved) {
      setScope('');
      onSaved();
    }
  }

  return <>
    <form className="form-stack connector-form" onSubmit={event => void saveCredential(event)}>
      <fieldset className="form-stack" disabled={disabled}>
        <legend>腾讯文档授权</legend>
        <p className="field-note">令牌保存后可用于添加多份文档。榫只观察你添加的文档。</p>
        {credentials.length > 0 && <ul className="connector-list">
          {credentials.map(item => {
            const label = tencentCredentialLabel(item, timezone);
            const usedBy = connections.filter(connection => connection.kind === 'tencent-docs' && connection.credentialId === item.id).length;
            return <li key={item.id} className="connector-record">
              <div className="connector-record-heading"><h4>{label}</h4>
                {usedBy > 0 ? <span className="field-note">用于 {usedBy} 份文档</span>
                  : <button type="button" className="text-link" aria-label={`删除${label}`} onClick={() => deleteCredential(item.id)}>删除令牌</button>}
              </div>
            </li>;
          })}
        </ul>}
        <label>腾讯文档个人令牌<input type="password" required value={token} onChange={event => setToken(event.target.value)}
          autoComplete="new-password" maxLength={8192} /></label>
        <GrantLink url={grantUrl} label="到腾讯文档获取令牌" />
        <div className="form-actions"><button type="submit" className="button" disabled={!token.trim()}>保存令牌</button></div>
      </fieldset>
    </form>
    <form className="form-stack connector-form" onSubmit={event => void addDocument(event)}>
      <fieldset className="form-stack" disabled={disabled || !credentials.length}>
        <legend>添加要观察的文档</legend>
        {!credentials.length && <p className="field-note">先保存腾讯文档令牌，再添加文档。</p>}
        {credentials.length > 1 && <label>使用的令牌<select required value={credential?.id ?? ''} onChange={event => setCredentialId(event.target.value)}>
          <option value="" disabled>选择已保存的令牌</option>
          {credentials.map(item => <option key={item.id} value={item.id}>{tencentCredentialLabel(item, timezone)}</option>)}
        </select></label>}
        <div className="form-row">
          <TopicSelect cases={cases} caseId={caseId} onChange={setCaseId} />
          <label>{fields.label}<input required maxLength={300} value={scope} onChange={event => setScope(event.target.value)}
            placeholder={fields.placeholder} autoComplete="off" spellCheck={false} /></label>
        </div>
        <p className="field-note">{fields.hint}</p>
        {previewScope && caseAvailable && credential && <TencentDocumentPreview key={JSON.stringify([previewScope, caseId, credential.id])}
          scope={previewScope} caseId={caseId} credentialId={credential.id} disabled={disabled} />}
        {!cases.length && <p className="field-note">需要一个进行中或等待中的场景才能添加连接。</p>}
        <div className="form-actions"><button type="submit" className="button button-primary" disabled={!canAdd}>
          <Cable size={15} />添加文档
        </button></div>
      </fieldset>
    </form>
  </>;
}

function TencentDocumentPreview({ scope, caseId, credentialId, disabled }: {
  scope: string;
  caseId: string;
  credentialId: string;
  disabled: boolean;
}) {
  const [result, setResult] = useState<{ document: ConnectorDocumentMetadata } | { error: string }>();
  useEffect(() => {
    if (disabled || result) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<ConnectorDocumentMetadata>(`${tencentDocsEndpoint}/preview`, 'POST', { scope, caseId, credentialId }, controller.signal)
        .then(document => {
          if (!controller.signal.aborted) setResult({ document });
        }, cause => {
          if (!controller.signal.aborted) setResult({ error: cause instanceof Error ? cause.message : '腾讯文档预览暂不可用。' });
        });
    }, 650);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, caseId, credentialId, disabled, result]);

  if (!result) return disabled ? null : <p className="field-note" role="status">正在识别腾讯文档…</p>;
  if ('error' in result) return <p className="inline-result failure" role="status">{result.error} 添加时会重新检查链接和权限。</p>;
  return <div role="status" aria-label="腾讯文档预览">
    <dl className="connector-details">
      <dt>文档名称</dt><dd><strong>{result.document.title}</strong></dd>
      <dt>文档类型</dt><dd>{tencentDocumentType(result.document)}</dd>
    </dl>
  </div>;
}
