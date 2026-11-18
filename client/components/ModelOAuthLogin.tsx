import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ModelConnection } from '../../shared/model-connections';
import { api } from '../api';
import { createModelLogin, localModelLoginHost, modelLoginBridge } from '../lib/model-oauth';

export function ModelOAuthLogin({ connection, onClose, onConnected }: {
  connection?: ModelConnection; onClose(): void; onConnected(): Promise<void>;
}) {
  const [name, setName] = useState(connection?.name ?? '');
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const operation = useRef<ReturnType<typeof createModelLogin>>(undefined);
  const mounted = useRef(true);
  const canLogin = Boolean(modelLoginBridge()) || typeof window !== 'undefined' && localModelLoginHost(window.location.hostname);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void operation.current?.cancel().catch(() => {}); };
  }, []);
  async function start() {
    if (pending || !canLogin) return;
    if (!name.trim()) { setFailed(true); setMessage('请为这个 ChatGPT 账号填写一个便于区分的连接名称。'); return; }
    const bridge = modelLoginBridge();
    const popup = bridge ? undefined : window.open('about:blank', '_blank');
    if (!bridge && !popup) { setFailed(true); setMessage('浏览器阻止了登录窗口，请允许弹窗后重试。'); return; }
    if (popup) popup.opener = null;
    setPending(true); setFailed(false); setMessage('请在打开的浏览器中完成 ChatGPT 授权。');
    const current = createModelLogin({ request: api, bridge, popup: popup ?? undefined, name: name.trim(), connectionId: connection?.id,
      reconsent: connection?.status === 'scope-required' });
    operation.current = current;
    try {
      const status = await current.result;
      if (!mounted.current || operation.current !== current) return;
      await onConnected();
      if (!mounted.current) return;
      setFailed(status.status !== 'completed');
      setMessage(status.message ?? (status.status === 'completed' ? '账号已连接。请选择模型并保存默认或场景配置；已有选择没有改变。' : '登录未完成，已有连接保持不变。'));
    } catch (error) {
      if (mounted.current && operation.current === current) { setFailed(true); setMessage(error instanceof Error ? error.message : '登录未完成，请重试。'); }
    } finally {
      if (mounted.current && operation.current === current) { operation.current = undefined; setPending(false); }
    }
  }
  async function cancel() {
    if (!pending) { onClose(); return; }
    setCancelling(true);
    try {
      await operation.current?.cancel();
      await onConnected();
      if (mounted.current) onClose();
    } catch (error) { if (mounted.current) { setFailed(true); setMessage(error instanceof Error ? error.message : '取消结果未确认，请刷新连接状态。'); } }
    finally { if (mounted.current) setCancelling(false); }
  }
  return <section className="form-stack model-editor model-oauth" aria-label="连接 ChatGPT 账号">
    <h4>{connection ? `重新连接 ${connection.name}` : '添加 ChatGPT 账号'}</h4>
    {!canLogin ? <p className="field-note">请使用最新的榫桌面客户端完成 ChatGPT 登录。当前远程网页可以选择和管理已连接的账号。</p>
      : <><label>连接名称<input value={name} maxLength={100} disabled={pending || Boolean(connection)} autoComplete="off"
        placeholder="例如：我的 ChatGPT" onChange={event => setName(event.target.value)} /></label>
        <p className="field-note">每个账号独立保存授权，登录不会替换其他账号，也不会自动开启推理。</p></>}
    {message && <p className={`inline-result ${failed ? 'failure' : 'success'}`} role="status">{message}</p>}
    <div className="form-actions">
      {canLogin && <button type="button" className="button button-primary" disabled={pending || cancelling} onClick={() => void start()}>
        {pending && <LoaderCircle size={14} className="spin" />}{pending ? '等待授权完成' : 'Continue with ChatGPT'}</button>}
      <button type="button" className="button button-quiet" disabled={cancelling} onClick={() => void cancel()}>
        {cancelling && <LoaderCircle size={14} className="spin" />}{pending ? '取消登录' : '关闭'}</button>
    </div>
  </section>;
}
