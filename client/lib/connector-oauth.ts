import type { ConnectorKind } from '../../shared/connectors';
import { api } from '../api';

const oauthStateKey = 'rae:connector-oauth';
const oauthConnectorKinds = ['gmail', 'outlook'] as const satisfies readonly ConnectorKind[];
export type OAuthConnectorKind = typeof oauthConnectorKinds[number];

export interface ConnectorOAuthResult {
  status: 'pending' | 'success' | 'error';
  message: string;
}

export function connectorOAuthBrowserRequired(): boolean {
  return typeof window !== 'undefined' && ('raeLocalDevice' in window || typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron/'));
}

export async function startConnectorOAuth(kind: OAuthConnectorKind, caseId: string, scope: string, connectionId?: string): Promise<void> {
  if (connectorOAuthBrowserRequired()) throw new Error('请先在系统浏览器打开榫网页版，并在同一浏览器标签页开始和完成授权。');
  const result = await api<{ url: string; state: string }>(`/api/connectors/${kind}/start`, 'POST', { caseId, scope, ...(connectionId ? { connectionId } : {}) });
  const target = new URL(result.url);
  const expectedOrigin = kind === 'gmail' ? 'https://accounts.google.com' : 'https://login.microsoftonline.com';
  if (target.origin !== expectedOrigin || target.username || target.password || target.hash || !/^[A-Za-z0-9_-]{43}$/.test(result.state)) {
    throw new Error('授权地址无效，请检查连接配置。');
  }
  sessionStorage.setItem(oauthStateKey, JSON.stringify({ kind, state: result.state }));
  window.location.assign(target.href);
}

export function takeConnectorOAuthReturn(): (() => Promise<void>) | undefined {
  const callback = new URL(window.location.href);
  const kind = callback.pathname.match(/^\/connector-callback\/([^/]+)\/?$/)?.[1];
  if (!kind) return;
  window.history.replaceState(null, '', '/');
  return async () => {
    const provider = oauthConnectorKinds.find(candidate => candidate === kind);
    const state = callback.searchParams.get('state');
    if (!provider || !state || sessionStorage.getItem(oauthStateKey) !== JSON.stringify({ kind, state })) {
      throw new Error('找不到本浏览器的授权请求。请在原标签页重试连接。');
    }
    sessionStorage.removeItem(oauthStateKey);
    const code = callback.searchParams.get('code');
    if (callback.searchParams.get('error') === 'access_denied') throw new Error('你取消了授权，可重新连接。');
    if (callback.searchParams.has('error') || !code) throw new Error('服务未返回有效授权，可重新连接。');
    await api(`/api/connectors/${provider}/complete`, 'POST', { state, code });
  };
}
