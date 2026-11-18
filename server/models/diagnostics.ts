import type { ModelBinding, ModelConnectionDiagnostic } from '../../shared/model-connections.js';
import type { ModelConnections } from './connections.js';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const terminalCredentialCodes = new Set(['invalid_api_key', 'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const quotaCodes = new Set(['insufficient_quota', 'rate_limit_exceeded', 'subscription_sharing_usage_limit_exceeded']);
const modelCodes = new Set(['model_not_found', 'invalid_model', 'unsupported_model']);
const transportCodes = new Set(['rae_stream_interrupted', 'stream_interrupted', 'transport_interrupted', 'missing_terminal', 'request_timeout', 'first_response_timeout', 'downstream_timeout', 'subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable', 'temporarily_unavailable']);

/** Diagnostic wording comes from a closed local map, never an upstream response body or token-bearing SDK cause. */
export function modelConnectionDiagnostic(error: unknown, modelId?: string): ModelConnectionDiagnostic {
  const root = object(error) ? error : {};
  const data = object(root.data) ? root.data : {};
  const nested = object(root.error) ? root.error : object(data.error) ? data.error : object(root.response) && object(root.response.error) ? root.response.error : {};
  const rawCode = typeof nested.code === 'string' ? nested.code : typeof root.error === 'string' ? root.error : root.code;
  const code = typeof rawCode === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(rawCode) ? rawCode : undefined;
  const rawStatus = root.statusCode ?? root.status ?? (object(root.response) ? root.response.status : undefined);
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  let category: ModelConnectionDiagnostic['category'] = 'protocol';
  let message = '最近一次模型请求未完成，请检查模型与接口配置后重试。';
  if (code && terminalCredentialCodes.has(code)) { category = 'credential'; message = '模型服务明确拒绝了此连接凭据，请重新连接或更新密钥。'; }
  else if (code === 'plan_permission_missing' || code === 'login_required' || code === 'credential_missing') {
    category = 'credential'; message = code === 'plan_permission_missing' ? '此连接尚未授权使用 ChatGPT 套餐，请重新授权。' : '此模型连接尚未配置有效凭据，请先连接。';
  } else if (code && quotaCodes.has(code) || status === 429) { category = 'quota'; message = '此连接达到用量或请求频率限制，请检查服务方用量设置后重试。'; }
  else if (code && modelCodes.has(code)) { category = 'model'; message = '服务方未提供或不允许使用所选模型，请核对该账号的模型列表。'; }
  else if (status === 401 || status === 403 || code?.startsWith('chatpass_v2_') || code === 'subscription_sharing_user_not_eligible') {
    category = 'permission'; message = '模型服务未接受当前请求的认证、权限或服务区域；连接已保留，请核对账号与资格。';
  } else if (code && transportCodes.has(code) || status !== undefined && status >= 500 || root.name === 'TimeoutError' || root.name === 'TypeError' || code?.startsWith('ECONN') || code === 'ETIMEDOUT') {
    category = 'transport'; message = '最近一次连接中断或服务暂时不可用，已保留账号凭据，可稍后重试。';
  } else if (code === 'response_incomplete') { message = '最近一次模型输出未完整结束，已收到的内容已保留。'; }
  return { category, message, ...(code ? { code } : {}), ...(status ? { status } : {}), ...(modelId ? { modelId } : {}), at: new Date().toISOString() };
}

export function recordConnectionDiagnostic(connections: ModelConnections, connectionId: string, error: unknown,
  expected: { expectedIdentityRevision: number; expectedBindingRevision?: number }, modelId?: string): void {
  if (object(error) && (error.name === 'ModelConnectionError' && error.status === 409 ||
    typeof error.code === 'string' && ['binding_changed', 'closed', 'logout_pending', 'cancelled'].includes(error.code))) return;
  const diagnostic = modelConnectionDiagnostic(error, modelId);
  if (!connections.recordDiagnostic(connectionId, diagnostic, expected)) return;
  // A bare 401 is not evidence of revoked credentials. Only this explicit API-key error changes key auth state.
  if (diagnostic.code === 'invalid_api_key') {
    const current = connections.get(connectionId);
    if (current?.kind === 'api-key') connections.setAuthState(connectionId, 'reauth-required',
      { expectedCredentialVersion: current.credentialVersion, expectedIdentityRevision: current.identityRevision });
  }
}
export function recordModelDiagnostic(binding: ModelBinding, error: unknown, connections: ModelConnections): void {
  recordConnectionDiagnostic(connections, binding.selection.connectionId, error,
    { expectedIdentityRevision: binding.identityRevision, expectedBindingRevision: binding.bindingRevision }, binding.selection.modelId);
}
export function clearModelDiagnostic(binding: ModelBinding, connections: ModelConnections): void {
  connections.clearDiagnostic(binding.selection.connectionId, { expectedIdentityRevision: binding.identityRevision, expectedBindingRevision: binding.bindingRevision });
}

/** Read only a bounded error code; caller persists a local message, never the upstream body. */
export async function readModelErrorResponse(response: Response): Promise<{ status: number; code?: string }> {
  const result: { status: number; code?: string } = { status: response.status };
  if (!response.body) return result;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 64 * 1024) return result; chunks.push(next.value); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const body = object(parsed) ? parsed : {}; const nested = object(body.error) ? body.error : {};
    const code = nested.code ?? (typeof body.error === 'string' ? body.error : body.code);
    if (typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(code)) result.code = code;
  } catch { /* Non-JSON error bodies are described by HTTP status only. */ }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return result;
}
