import { useRef, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, type Perform } from '../api';
import type { ConnectorConnection } from '../../shared/connectors';
import { EWS_MAX_PFX_BYTES, type EwsConnectInput, type EwsUpdateInput } from '../../shared/ews';

async function certificate(file: File | undefined, password: string) {
  if (!file || file.size === 0 || file.size > EWS_MAX_PFX_BYTES || !/\.(?:pfx|p12)$/i.test(file.name)) {
    throw new Error('请选择不超过 1 MB 的 PFX/P12 文件。');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const pkcs12Base64 = btoa(binary); bytes.fill(0);
  return { pkcs12Base64, password };
}

export function EwsConnectorForm({ cases, initialCaseId, perform, disabled, onSaved }: {
  cases: Array<{ id: string; title: string }>; initialCaseId?: string; perform: Perform; disabled: boolean; onSaved: () => void;
}) {
  const [caseId, setCaseId] = useState(initialCaseId ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [username, setUsername] = useState('');
  const [smime, setSmime] = useState(true);
  const [consent, setConsent] = useState(false);
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const password = useRef<HTMLInputElement>(null);
  const pfx = useRef<HTMLInputElement>(null);
  const pfxPassword = useRef<HTMLInputElement>(null);
  const caseAvailable = cases.some(item => item.id === caseId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || inFlight.current || !caseAvailable || !consent || !password.current?.value) return;
    inFlight.current = true; setWorking(true);
    let input: EwsConnectInput | undefined;
    try {
      const saved = await perform('connector-add', async () => {
        input = { caseId, scope: 'inbox', endpoint: endpoint.trim(), username: username.trim(), password: password.current!.value,
          observeNewMailAndAnalyze: true, persistCredentials: true,
          ...(smime ? { certificate: await certificate(pfx.current?.files?.[0], pfxPassword.current?.value ?? '') } : {}) };
        password.current!.value = '';
        if (pfxPassword.current) pfxPassword.current.value = '';
        if (pfx.current) pfx.current.value = '';
        await api('/api/connectors/ews', 'POST', input);
      }, '邮箱已连接，正在建立新邮件观察基线。');
      if (saved) onSaved();
    } finally {
      if (input) { input.password = ''; if (input.certificate) { input.certificate.password = ''; input.certificate.pkcs12Base64 = ''; } }
      if (password.current) password.current.value = '';
      if (pfxPassword.current) pfxPassword.current.value = '';
      if (pfx.current) pfx.current.value = '';
      inFlight.current = false; setWorking(false);
    }
  }

  return <form className="form-stack connector-form" onSubmit={event => void submit(event)} autoComplete="off">
    <fieldset className="form-stack" disabled={disabled || working}>
      <label>绑定场景<select required value={caseAvailable ? caseId : ''} onChange={event => setCaseId(event.target.value)}>
        <option value="" disabled>选择场景</option>{cases.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label>EWS 地址<input required type="url" maxLength={2048} value={endpoint} onChange={event => setEndpoint(event.target.value)}
        placeholder="https://mail.example.com/EWS/Exchange.asmx" autoComplete="off" spellCheck={false} /></label>
      <label>邮箱登录名<input required maxLength={320} value={username} onChange={event => setUsername(event.target.value)}
        placeholder="完整登录名或 公司域\用户名" autoComplete="off" spellCheck={false} /></label>
      <label>邮箱密码<input ref={password} type="password" required maxLength={1024} autoComplete="new-password" /></label>
      <label className="checkbox-label"><input type="checkbox" checked={smime} onChange={event => setSmime(event.target.checked)} />读取 S/MIME 加密邮件</label>
      {smime && <>
        <label>解密证书<input ref={pfx} type="file" required accept=".pfx,.p12" /></label>
        <label>证书文件密码<input ref={pfxPassword} type="password" maxLength={1024} autoComplete="new-password" placeholder="证书没有密码时留空" /></label>
      </>}
      <p className="field-note">密码和证书会保存到当前榫服务端，重启后继续连接。私钥只用于服务器解密，不会发送给模型。</p>
      <p className="field-note">仅观察连接后收到的收件箱新邮件，不回读旧邮件、不标记已读、不发送邮件。正文会作为资料保存；加密正文可解密时一并纳入。长邮件会明确标记读取上限。</p>
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
        保存凭据并观察新邮件，允许榫使用已配置的模型分析邮件正文</label>
      <p className="field-note">榫暂停推理时仍可同步邮件，恢复推理后沿用既有分析节奏。</p>
      <div className="form-actions"><button type="submit" className="button button-primary" disabled={!caseAvailable || !consent}>
        {working && <LoaderCircle size={15} className="spin" />}{working ? '正在连接…' : '连接并观察新邮件'}
      </button></div>
    </fieldset>
  </form>;
}

export function EwsCredentialsForm({ connection, perform, onSaved, onCancel }: {
  connection: ConnectorConnection; perform: Perform; onSaved: () => void; onCancel: () => void;
}) {
  const [action, setAction] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [working, setWorking] = useState(false);
  const password = useRef<HTMLInputElement>(null); const pfx = useRef<HTMLInputElement>(null); const pfxPassword = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !connection.ews) return;
    inFlight.current = true; setWorking(true);
    let input: EwsUpdateInput | undefined;
    try {
      const saved = await perform(`connector:${connection.id}:credentials`, async () => {
        const changedPassword = password.current?.value;
        if (!changedPassword && action === 'keep') throw new Error('请填写新密码或选择证书变更。');
        input = { expectedRevision: connection.ews!.credentialRevision,
          ...(changedPassword ? { password: changedPassword } : {}),
          ...(action === 'remove' ? { certificate: null } : action === 'replace'
            ? { certificate: await certificate(pfx.current?.files?.[0], pfxPassword.current?.value ?? '') } : {}) };
        if (password.current) password.current.value = '';
        if (pfxPassword.current) pfxPassword.current.value = '';
        if (pfx.current) pfx.current.value = '';
        await api(`/api/connectors/ews/${encodeURIComponent(connection.id)}/credentials`, 'PATCH', input);
      }, '凭据已更新，保留原邮件观察范围与同步位置。');
      if (saved) onSaved();
    } finally {
      if (input) { input.password = undefined; input.certificate = undefined; }
      if (password.current) password.current.value = '';
      if (pfxPassword.current) pfxPassword.current.value = '';
      if (pfx.current) pfx.current.value = '';
      inFlight.current = false; setWorking(false);
    }
  }
  return <form className="form-stack connector-form" onSubmit={event => void submit(event)} autoComplete="off">
    <fieldset className="form-stack" disabled={working}>
      <label>新邮箱密码<input ref={password} type="password" maxLength={1024} autoComplete="new-password" placeholder="留空保留现有密码" /></label>
      <label>解密证书<select value={action} onChange={event => setAction(event.target.value as typeof action)}>
        <option value="keep">保留现有证书</option><option value="replace">选择新 PFX/P12</option><option value="remove">移除已保存的证书</option>
      </select></label>
      {action === 'replace' && <><label>新证书<input ref={pfx} type="file" accept=".pfx,.p12" required /></label>
        <label>新证书密码<input ref={pfxPassword} type="password" maxLength={1024} autoComplete="new-password" /></label></>}
      <p className="field-note">新凭据验证成功后替换；不回读历史邮件。邮箱账号或服务器改变时，请建立新连接。</p>
      <div className="form-actions"><button type="submit" className="button button-primary">{working ? '正在验证…' : '验证并保存'}</button>
        <button type="button" className="button" onClick={onCancel}>取消</button></div>
    </fieldset>
  </form>;
}
