import { z } from 'zod';

export const MODEL_PROTOCOLS = ['deepseek', 'openai-chat', 'openai-responses', 'siwc-responses'] as const;
export type ModelProtocol = typeof MODEL_PROTOCOLS[number];
const protocolUseLabels: Readonly<Record<ModelProtocol, string>> = {
  'openai-chat': '聊天协议。项目执行需 Responses 连接。',
  deepseek: 'DeepSeek 兼容聊天协议。兼容 Hub 的项目执行还需该接口支持 Responses。',
  'openai-responses': '已声明 Responses 协议，可接入聊天与项目执行。',
  'siwc-responses': '已声明 Responses 协议，可接入聊天与项目执行。',
};
/** Protocol capability only; account access and individual model behavior remain request-specific. */
export function modelProtocolUseLabel(protocol: ModelProtocol): string {
  return protocolUseLabels[protocol];
}
export type ModelConnectionKind = 'api-key' | 'siwc';
export type ModelConnectionStatus = 'ready' | 'needs-login' | 'disabled' | 'reauth-required' | 'scope-required';
export type ModelPurpose = 'conversation' | 'background' | 'task' | 'connection';
export interface ModelSelection { connectionId: string; modelId: string; reasoning: string; maxOutputTokens: number | null }
export type ModelPreference = { mode: 'inherit-global' } | { mode: 'explicit'; selection: ModelSelection };
export interface ModelDefaults { global: ModelSelection | null; background: ModelPreference; revision: number }
export interface SceneModelPreference { caseId: string; preference: ModelPreference; revision: number }
export interface OAuthRegistration { issuer: string; clientId: string }
export interface ModelIdentity extends OAuthRegistration { subject: string; accountId?: string; label?: string }
export interface ModelCatalogEntry {
  id: string; name: string; reasoning?: string[]; inputModalities?: string[]; contextWindow?: number;
  source: 'provider' | 'manual'; updatedAt?: string;
}
export interface ModelContextWindowOverride { modelId: string; contextWindow: number }
export interface ModelConnectionDiagnostic {
  category: 'quota' | 'transport' | 'model' | 'permission' | 'credential' | 'protocol';
  message: string; code?: string; status?: number; at: string; modelId?: string;
}
export interface ModelConnection {
  id: string; name: string; kind: ModelConnectionKind; protocol: ModelProtocol; endpoint: string; enabled: boolean;
  status: ModelConnectionStatus; credentialConfigured: boolean;
  editRevision: number; bindingRevision: number; identityRevision: number; credentialVersion: number;
  identity?: ModelIdentity; oauthRegistration?: OAuthRegistration; models?: ModelCatalogEntry[]; archived?: boolean;
  contextWindows?: ModelContextWindowOverride[];
  credentialSource?: 'environment' | 'saved';
  recentDiagnostic?: ModelConnectionDiagnostic;
}
export interface ModelBinding {
  selection: ModelSelection; source: 'global' | 'background' | 'scene' | 'explicit'; purpose: ModelPurpose;
  bindingRevision: number; identityRevision: number; protocol: ModelProtocol; endpoint: string;
  adapterVersion: 1; resolvedAt: string; contextWindow?: number;
}
export interface ModelDirectory {
  connections: ModelConnection[]; defaults: ModelDefaults; scenes: SceneModelPreference[]; hub: { configured: boolean };
}
export interface ModelConnectionInput {
  id?: string; name: string; kind: ModelConnectionKind; protocol: ModelProtocol; endpoint?: string;
  apiKey?: string; clearApiKey?: boolean; enabled?: boolean; expectedRevision?: number;
  contextWindows?: ModelContextWindowOverride[];
}
export interface ModelConnectionReferences { global: boolean; background: boolean; scenes: string[]; activeRuns: string[]; activeTasks: string[] }
export interface SiwcLoginStatus {
  loginId: string; connectionId: string; status: 'pending' | 'completed' | 'failed' | 'cancelled'; expiresAt: number; message?: string;
}
export interface SiwcLoginStart extends SiwcLoginStatus { authUrl: string; redirectUri: string }
export function modelReasoningOptions(connection: ModelConnection, modelId: string): string[] {
  if (connection.protocol === 'deepseek') return ['default', 'auto', 'none', 'low', 'high', 'max'];
  return [...new Set(['default', ...(connection.models?.find(model => model.id === modelId)?.reasoning ?? [])])];
}
export const modelEndpointSchema = z.string().trim().url().max(500).refine(value => {
  try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); }
  catch { return false; }
}, '模型地址需为 HTTPS，或本机测试地址。');
const identifier = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
export const modelContextWindowSchema = z.number().int().positive();
const modelContextWindowsSchema = z.array(z.object({ modelId: z.string().trim().min(1).max(200),
  contextWindow: modelContextWindowSchema }).strict()).max(100)
  .refine(entries => new Set(entries.map(entry => entry.modelId)).size === entries.length, '同一连接的模型 ID 只能配置一次。');
export const modelSelectionSchema = z.object({ connectionId: identifier, modelId: z.string().trim().min(1).max(200),
  reasoning: z.string().trim().min(1).max(80), maxOutputTokens: z.number().int().positive().max(2_147_483_647).nullable() }).strict();
export const modelPreferenceSchema = z.discriminatedUnion('mode', [z.object({ mode: z.literal('inherit-global') }).strict(),
  z.object({ mode: z.literal('explicit'), selection: modelSelectionSchema }).strict()]);
export const modelConnectionInputSchema = z.object({ id: identifier.optional(), name: z.string().trim().min(1).max(100),
  kind: z.enum(['api-key', 'siwc']), protocol: z.enum(MODEL_PROTOCOLS), endpoint: modelEndpointSchema.optional(),
  apiKey: z.string().trim().min(1).max(16384).optional(), clearApiKey: z.boolean().optional(), enabled: z.boolean().optional(),
  expectedRevision: z.number().int().nonnegative().optional(), contextWindows: modelContextWindowsSchema.optional() }).strict().superRefine((value, context) => {
  if (value.apiKey && value.clearApiKey) context.addIssue({ code: 'custom', message: '不能同时保存并清除密钥。' });
  if ((value.kind === 'siwc') !== (value.protocol === 'siwc-responses')) context.addIssue({ code: 'custom', message: '认证类型与协议不匹配。' });
  if (value.kind === 'siwc' && (value.apiKey || value.clearApiKey)) context.addIssue({ code: 'custom', message: 'ChatGPT 连接须通过登录管理凭据。' });
  if (value.kind === 'api-key' && !value.endpoint) context.addIssue({ code: 'custom', message: '请填写模型接口地址。' });
  if (value.kind === 'siwc' && value.endpoint && value.endpoint.replace(/\/+$/, '') !== 'https://api.openai.com/v1') {
    context.addIssue({ code: 'custom', message: 'ChatGPT 连接只能使用官方模型接口。' });
  }
});
export const modelBindingSchema = z.object({ selection: modelSelectionSchema, source: z.enum(['global', 'background', 'scene', 'explicit']),
  purpose: z.enum(['conversation', 'background', 'task', 'connection']), bindingRevision: z.number().int().nonnegative(),
  identityRevision: z.number().int().nonnegative(), protocol: z.enum(MODEL_PROTOCOLS), endpoint: modelEndpointSchema,
  adapterVersion: z.literal(1), resolvedAt: z.string().datetime(), contextWindow: modelContextWindowSchema.optional() }).strict();
