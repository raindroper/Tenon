import { useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import type { OAuthAppKind, OAuthAppSetup } from '../../shared/oauth-apps';
import { oauthAppInputSchema } from '../../shared/oauth-apps';
import { api, type Perform } from '../api';

const guides = {
  gmail: { name: 'Gmail', console: 'https://console.cloud.google.com/apis/credentials',
    documentation: 'https://developers.google.com/identity/protocols/oauth2/web-server',
    instructions: '在 Google Cloud 启用 Gmail API，创建 Web application 类型的 OAuth 客户端。设置同意屏幕和测试用户，并允许 gmail.readonly。' },
  outlook: { name: 'Outlook', console: 'https://entra.microsoft.com/',
    documentation: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
    instructions: '在 Microsoft Entra 注册应用，按你的账号选择个人及工作或学校账户类型，添加 Web 回调地址、Mail.Read 委托权限，并创建客户端密码。' },
} as const;

export function OAuthAppForm({ kind, setup, configured, perform, disabled, onSaved, origin }: {
  kind: OAuthAppKind; setup?: OAuthAppSetup; configured: boolean; perform: Perform;
  disabled: boolean; onSaved: () => void; origin: string;
}) {
  const [clientId, setClientId] = useState(setup?.clientId ?? '');
  const [working, setWorking] = useState(false);
  const secret = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const environment = setup?.source === 'environment';
  const callback = origin ? new URL(`/connector-callback/${kind}`, origin).href : `/connector-callback/${kind}`;
  const guide = guides[kind];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || inFlight.current || environment || !clientId.trim() || !secret.current?.value.trim()) return;
    inFlight.current = true; setWorking(true);
    let input: { clientId: string; clientSecret: string; expectedRevision: number } | undefined;
    try {
      const saved = await perform(`connector-app:${kind}`, async () => {
        const parsed = oauthAppInputSchema.safeParse({ clientId: clientId.trim(), clientSecret: secret.current?.value.trim() ?? '',
          expectedRevision: setup?.revision ?? 0 });
        if (secret.current) secret.current.value = '';
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '请核对应用配置。');
        input = parsed.data;
        await api(`/api/connectors/${kind}/app`, 'POST', input);
      }, `${guide.name} 应用配置已保存，可以继续账号授权。`);
      if (saved) onSaved();
    } finally {
      if (input) input.clientSecret = '';
      if (secret.current) secret.current.value = '';
      inFlight.current = false; setWorking(false);
    }
  }

  return <details className="connector-registration" open={!configured}>
    <summary>{configured ? '应用配置与回调地址' : `先配置 ${guide.name} 登录应用`}</summary>
    <p className="field-note">{guide.instructions}</p>
    <div className="form-actions"><a className="text-link" href={guide.console} target="_blank" rel="noreferrer">打开官方控制台<ArrowUpRight size={13} /></a>
      <a className="text-link" href={guide.documentation} target="_blank" rel="noreferrer">查看官方注册指南<ArrowUpRight size={13} /></a></div>
    <label>授权回调地址<input readOnly value={callback} onFocus={event => event.target.select()} spellCheck={false} /></label>
    {environment ? <>
      <p className="field-note">当前应用配置来自服务环境，只能在服务环境中更新。账号授权仍使用下面的连接入口。</p>
      {setup.clientId && <label>当前 Client ID<input readOnly value={setup.clientId} spellCheck={false} /></label>}
    </> : <form className="form-stack connector-form" onSubmit={event => void submit(event)} autoComplete="off">
      <fieldset className="form-stack" disabled={disabled || working}>
        <label>Client ID<input required maxLength={512} value={clientId} onChange={event => setClientId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label>Client secret<input ref={secret} type="password" required maxLength={16_384} autoComplete="new-password"
          placeholder={configured ? '填写新密码以更新配置' : '从官方控制台复制客户端密码'} /></label>
        <p className="field-note">应用密码加密保存在当前榫服务端，不会回显，也不会发送给模型。账号授权在下一步单独完成。</p>
        {setup?.source === 'saved' && <p className="field-note">更换登录应用后，已有账号连接可能需要重新授权；原资料和观察范围会保留。</p>}
        <div className="form-actions"><button type="submit" className="button button-primary" disabled={!clientId.trim()}>
          {working && <LoaderCircle size={15} className="spin" />}{working ? '正在保存…' : configured ? '更新应用配置' : '保存应用配置'}
        </button></div>
      </fieldset>
    </form>}
  </details>;
}
