import { z } from 'zod';
import { ConnectorProviderError } from './types.js';

/** SDKs share the existing bounded fetch boundary instead of opening their own HTTP stack. */
export function providerFetch(signal: AbortSignal, provider: string, allowed: (url: URL) => boolean): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!allowed(url) || url.username || url.password || url.hash) throw new ConnectorProviderError(`${provider} 请求超出已授权服务。`, 400, { needsAttention: true });
    const response = await requestProvider(url, init ?? {}, signal, provider);
    const data = await readProviderJson(response, signal, provider);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const retry = response.headers.get('Retry-After'); if (retry !== null) headers.set('Retry-After', retry);
    return new Response(JSON.stringify(data), { status: response.status, headers });
  };
}

function retryAt(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')?.trim(); if (!value) return;
  const time = /^\d+(?:\.\d+)?$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(time) && time >= Date.now() && time <= 8.64e15 ? time : undefined;
}

export function providerResponseError(response: Response, provider: string, body?: unknown): ConnectorProviderError {
  const oauth = z.object({ error: z.string() }).safeParse(body);
  if ([400, 401].includes(response.status) && oauth.success && ['invalid_grant', 'interaction_required', 'consent_required', 'login_required'].includes(oauth.data.error)) {
    return new ConnectorProviderError(`${provider} 授权已过期或被撤销，请重新连接。`, 401, { needsAttention: true });
  }
  if ([400, 401].includes(response.status) && oauth.success && ['invalid_client', 'unauthorized_client', 'invalid_scope'].includes(oauth.data.error)) {
    return new ConnectorProviderError(`${provider} 登录应用配置或权限无效，请核对后重新连接。`, 400, { needsAttention: true });
  }
  const reasons = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }) }).safeParse(body);
  const limited = reasons.success && reasons.data.error.errors?.some(item => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(item.reason));
  if (response.status === 429 || response.status === 403 && limited) {
    return new ConnectorProviderError(`${provider} 正在限制请求频率，请稍后重试。`, 429, { retryAt: retryAt(response) });
  }
  if (response.status === 401) return new ConnectorProviderError(`${provider} 授权已过期或被撤销，请重新连接。`, 401, { needsAttention: true });
  if (response.status === 403) return new ConnectorProviderError(`${provider} 拒绝访问，请检查账号与观察范围权限。`, 403, { needsAttention: true });
  return new ConnectorProviderError(`${provider} 未能读取已授权范围。`, response.status >= 400 && response.status < 500 ? response.status : 502,
    { retryAt: retryAt(response) });
}

/** SDK exceptions may contain tokens, request bodies and private mail; never forward their message. */
export function providerSdkError(error: unknown, provider: string, signal: AbortSignal): ConnectorProviderError {
  signal.throwIfAborted();
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (current instanceof ConnectorProviderError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  const details = error as { response?: { status?: number; data?: unknown; headers?: HeadersInit }; errorCode?: string } | undefined;
  if (details?.response?.status) {
    return providerResponseError(new Response(null, { status: details.response.status, headers: details.response.headers }), provider, details.response.data);
  }
  if (details?.errorCode && ['invalid_grant', 'interaction_required', 'consent_required', 'login_required', 'no_tokens_found', 'no_account_in_silent_request'].includes(details.errorCode)) {
    return new ConnectorProviderError(`${provider} 授权已过期或被撤销，请重新连接。`, 401, { needsAttention: true });
  }
  return new ConnectorProviderError(`${provider} 请求失败或凭据无效，请检查连接状态。`);
}

export async function requestProvider(url: string | URL, init: RequestInit, signal: AbortSignal, provider: string,
  timeoutMs = 10_000): Promise<Response> {
  signal.throwIfAborted();
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]) });
  } catch {
    signal.throwIfAborted();
    throw new ConnectorProviderError(`${provider} 请求失败或超时。`);
  }
}

export async function readProviderJson(response: Response, signal: AbortSignal, provider: string): Promise<unknown> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    if (!reader) throw new Error();
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error();
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    signal.throwIfAborted();
    throw new ConnectorProviderError(`${provider} 返回的响应不完整或超出读取上限。`);
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

export async function assertProviderOk(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  let body: unknown;
  try { body = await readProviderJson(response, AbortSignal.timeout(10_000), provider); }
  catch { await response.body?.cancel().catch(() => undefined); }
  throw providerResponseError(response, provider, body);
}
