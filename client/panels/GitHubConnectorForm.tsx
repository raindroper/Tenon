import { useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import type { ConnectorConnection } from '../../shared/connectors';
import { githubConnectInputSchema, githubUpdateInputSchema, githubUpgradeInputSchema, type GitHubConnectInput, type GitHubUpdateInput } from '../../shared/github-connection';
import { api, type Perform } from '../api';

const tokenGuide = 'https://github.com/settings/personal-access-tokens/new';
const tokenDocumentation = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';
interface GitHubFormProps {
  perform: Perform;
  disabled: boolean;
  onSaved: () => void;
  connection?: ConnectorConnection;
  onCancel?: () => void;
}

export function GitHubConnectorForm({ perform, disabled, onSaved, connection, onCancel }: GitHubFormProps) {
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const token = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const editing = Boolean(connection);
  const canSubmit = consent && (!editing || Boolean(connection?.github));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || inFlight.current || !canSubmit || !token.current?.value.trim()) return;
    inFlight.current = true; setWorking(true);
    let input: GitHubConnectInput | GitHubUpdateInput | undefined;
    try {
      const saved = await perform(connection ? `connector:${connection.id}:credentials` : 'connector-add', async () => {
        const secret = token.current?.value.trim() ?? '';
        const parsed = connection
          ? githubUpdateInputSchema.safeParse({ token: secret, expectedRevision: connection.github?.credentialRevision, persistCredentials: true, accessAllRepositories: true })
          : githubConnectInputSchema.safeParse({ token: secret, persistCredentials: true, accessAllRepositories: true });
        if (token.current) token.current.value = '';
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '请核对 GitHub 连接信息。');
        input = parsed.data;
        await api(connection ? `/api/connectors/github/${encodeURIComponent(connection.id)}/credentials` : '/api/connectors/github',
          connection ? 'PATCH' : 'POST', input);
      }, editing ? 'GitHub 账号令牌已更新，原资料与任务记录保留。' : 'GitHub 账号已连接，可以按需搜索仓库。');
      if (saved) { setConsent(false); onSaved(); }
    } finally {
      if (input) input.token = '';
      if (token.current) token.current.value = '';
      inFlight.current = false; setWorking(false);
    }
  }

  return <form className="form-stack connector-form" onSubmit={event => void submit(event)} autoComplete="off">
    <fieldset className="form-stack" disabled={disabled || working}>
      <legend>{editing ? '更新 GitHub 账号令牌' : 'GitHub 官方 MCP'}</legend>
      {connection?.github?.kind === 'account' && <p className="field-note">当前账号：<strong>@{connection.github.login}</strong>。更新后仍核对为同一账号，原资料和任务记录保留。</p>}
      <p className="field-note">连接账号可访问的全部仓库，可在所有本人场景中按需搜索仓库、读取代码和 Issue/PR。实际能力由 GitHub 账号及令牌权限决定。</p>
      <p className="field-note">创建 fine-grained 令牌时，在所选 Resource owner 下选择 All repositories，并按需授予 Contents、Issues、Pull requests 权限。
        {' '}<a className="text-link" href={tokenGuide} target="_blank" rel="noreferrer">创建访问令牌<ArrowUpRight size={13} /></a>
      </p>
      <p className="field-note">fine-grained 令牌的 All repositories 只覆盖所选用户或组织。跨多个组织或外部协作者仓库时，可能需要 classic 令牌及 repo 权限。
        组织审批、SSO 和私有仓库限制仍然有效，令牌不会超过你本人的权限。
        {' '}<a className="text-link" href={tokenDocumentation} target="_blank" rel="noreferrer">GitHub 令牌权限说明<ArrowUpRight size={13} /></a>
      </p>
      <label>{editing ? '新个人访问令牌' : '个人访问令牌'}<input ref={token} type="password" required minLength={20} maxLength={4096}
        autoComplete="new-password" spellCheck={false} placeholder="github_pat_…" /></label>
      <p className="field-note">令牌加密保存在当前榫服务端。请只在此处填写，不要发送到聊天。</p>
      <p className="field-note">连接不会自动遍历或观察所有仓库。提交代码、创建或修改 Issue/PR 仍在你明确委托后执行。</p>
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        加密保存令牌，允许榫在所有本人场景使用此账号可访问的全部仓库</label>
      <div className="form-actions"><button type="submit" className="button button-primary" disabled={!canSubmit}>
        {working && <LoaderCircle size={15} className="spin" />}{working ? '正在验证…' : editing ? '验证并保存' : '连接 GitHub 账号'}
      </button>{onCancel && <button type="button" className="button" onClick={onCancel}>取消</button>}</div>
    </fieldset>
  </form>;
}

export function GitHubCredentialsForm({ connection, perform, disabled, onSaved, onCancel }: {
  connection: ConnectorConnection; perform: Perform; disabled: boolean; onSaved: () => void; onCancel: () => void;
}) {
  return <GitHubConnectorForm connection={connection} perform={perform} disabled={disabled} onSaved={onSaved} onCancel={onCancel} />;
}

export function GitHubAccountUpgradeForm({ connection, perform, disabled, onSaved, onCancel }: {
  connection: ConnectorConnection; perform: Perform; disabled: boolean; onSaved: () => void; onCancel: () => void;
}) {
  const [confirmAllRepositories, setConfirmAllRepositories] = useState(false);
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || inFlight.current || !confirmAllRepositories || !connection.github) return;
    inFlight.current = true; setWorking(true);
    try {
      const saved = await perform(`connector:${connection.id}:credentials`, async () => {
        const input = githubUpgradeInputSchema.safeParse({ expectedRevision: connection.github!.credentialRevision, accessAllRepositories: true });
        if (!input.success) throw new Error('连接版本已变化，请刷新后重新确认账号接入。');
        await api(`/api/connectors/github/${encodeURIComponent(connection.id)}/account`, 'POST', input.data);
      }, 'GitHub 账号接入已启用，原资料保留。');
      if (saved) onSaved();
    } finally { inFlight.current = false; setWorking(false); }
  }
  return <form className="form-stack connector-form" onSubmit={event => void submit(event)}>
    <fieldset className="form-stack" disabled={disabled || working}>
      <legend>升级为 GitHub 账号接入</legend>
      <p className="field-note">原仓库连接：<strong>{connection.scope}</strong>。使用已保存的令牌核对账号，无需重新填写或回显令牌。</p>
      <p className="field-note">升级后可在所有本人场景按需使用该账号可访问的全部仓库，实际仍受令牌及 GitHub 权限限制。原资料和任务记录保留，不自动观察所有仓库，也不为旧任务扩大许可。</p>
      <label className="checkbox-label"><input type="checkbox" checked={confirmAllRepositories} onChange={event => setConfirmAllRepositories(event.target.checked)} />
        允许使用已保存令牌，升级为账号可访问的全部仓库</label>
      <div className="form-actions"><button type="submit" className="button button-primary" disabled={!confirmAllRepositories || !connection.github}>
        {working && <LoaderCircle size={15} className="spin" />}{working ? '正在升级…' : '升级账号接入'}
      </button><button type="button" className="button" onClick={onCancel}>取消</button></div>
    </fieldset>
  </form>;
}

export function GitHubAccountDetails({ connection }: { connection: ConnectorConnection }) {
  return connection.github?.kind === 'account' ? <>
    <dt>GitHub 账号</dt><dd>@{connection.github.login}</dd>
    <dt>仓库范围</dt><dd>账号可访问的全部仓库</dd>
    <dt>可用场景</dt><dd>所有本人场景</dd>
    <dt>实际权限</dt><dd>由 GitHub 账号和令牌授权决定</dd>
  </> : <><dt>旧仓库连接</dt><dd>{connection.scope}</dd><dt>接入状态</dt><dd>待升级为账号接入</dd></>;
}
