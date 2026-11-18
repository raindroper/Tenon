import { z } from 'zod';
import { weChatObservationId, weChatObservationSelection, weChatObservationBatch, type WeChatObservationSelection } from '../shared/wechat-observation.js';
import { secureBaseUrl } from './security.js';
import { deviceFetch } from './transport.js';

export type OwnerFetch = (url: string, init: RequestInit) => Promise<Response>;
export type WeChatTopic = { id: string; title: string };
type GrantBinding = WeChatObservationSelection;
export type WeChatGrant = GrantBinding & { id: string };
type WeChatRow = z.infer<typeof weChatObservationBatch>['rows'][number];

export class WeChatLoginRequired extends Error {
  constructor() { super('请登录榫，已保存的微信观察范围会自动恢复。'); }
}

export class WeChatGrantUnavailable extends Error {
  constructor() { super('榫无法恢复此会话的观察授权，请检查设备和关联场景。'); }
}

const topicSummary = z.object({ id: weChatObservationId, title: z.string().trim().min(1), status: z.enum(['active', 'waiting', 'completed', 'cancelled']) });
const grantSchema = weChatObservationSelection.extend({ id: z.uuid() }).strip();

async function ownerRequest(baseUrl: string, ownerFetch: OwnerFetch,
  route: '/api/cases' | '/api/wechat-observations' | `/api/wechat-observations/${string}`,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: GrantBinding | Record<string, never>, signal?: AbortSignal) {
  const origin = secureBaseUrl(baseUrl);
  const failure = body ? '未能确认榫已登记本次观察。' : '暂时无法读取榫场景。';
  const timeout = AbortSignal.timeout(12000);
  let response: Response;
  try {
    response = await ownerFetch(origin + route, {
      method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error(failure); }
  if (response.status === 200 || response.status === 201) return response;
  void response.body?.cancel().catch(() => {});
  if (response.status === 401) throw new WeChatLoginRequired();
  if (body && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    throw new WeChatGrantUnavailable();
  }
  throw new Error(failure);
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(json + decoder.decode());
      size += value.byteLength;
      if (size > limit) throw new Error('Response too large');
      json += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function listWeChatTopics(baseUrl: string, ownerFetch: OwnerFetch): Promise<WeChatTopic[]> {
  const response = await ownerRequest(baseUrl, ownerFetch, '/api/cases');
  try {
    return z.array(z.unknown()).parse(await boundedJson(response, 1024 * 1024)).flatMap(row => {
      const topic = topicSummary.safeParse(row);
      if (!topic.success) return [];
      const { id, title, status } = topic.data;
      return status === 'active' || status === 'waiting' ? [{ id, title }] : [];
    });
  } catch { throw new Error('暂时无法读取榫场景。'); }
}

export async function registerWeChatGrant(baseUrl: string, ownerFetch: OwnerFetch, binding: GrantBinding): Promise<WeChatGrant> {
  const response = await ownerRequest(baseUrl, ownerFetch, '/api/wechat-observations', 'POST', binding);
  return readGrant(response, binding);
}

export async function renewWeChatGrant(baseUrl: string, ownerFetch: OwnerFetch, grant: WeChatGrant, signal: AbortSignal): Promise<void> {
  const { id, ...binding } = grant;
  const response = await ownerRequest(baseUrl, ownerFetch, `/api/wechat-observations/${id}`, 'PATCH', binding, signal);
  if ((await readGrant(response, binding)).id !== id) throw new WeChatGrantUnavailable();
}

async function readGrant(response: Response, binding: GrantBinding): Promise<WeChatGrant> {
  try {
    const grant = grantSchema.parse(await boundedJson(response, 4096));
    if (grant.deviceId === binding.deviceId && grant.windowId === binding.windowId && grant.caseId === binding.caseId) return grant;
  } catch { /* Never expose remote response content. */ }
  throw new Error('榫返回的微信观察授权不匹配。');
}

export async function pushWeChatRows(baseUrl: string, token: string, grant: WeChatGrant, rows: readonly WeChatRow[], signal: AbortSignal): Promise<void> {
  const response = await deviceFetch(baseUrl, '/api/device/wechatobservations', token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantId: grant.id, windowId: grant.windowId, rows }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  const receipt = z.object({ accepted: z.number().int().min(0), duplicates: z.number().int().min(0) }).parse(await boundedJson(response, 4096));
  if (receipt.accepted + receipt.duplicates !== rows.length) throw new Error('榫未确认收到本批微信变化。');
}

export async function stopWeChatGrant(baseUrl: string, token: string, grant: WeChatGrant): Promise<void> {
  const response = await deviceFetch(baseUrl, '/api/device/wechatobservations', token, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantId: grant.id, windowId: grant.windowId }), signal: AbortSignal.timeout(8000),
  });
  const receipt = z.object({ id: z.uuid(), stopped: z.literal(true) }).parse(await boundedJson(response, 4096));
  if (receipt.id !== grant.id) throw new Error('榫未确认结束本次微信采集。');
}

const sourceStatus = z.object({
  title: z.string().nullable(), coverageStartAt: z.string().nullable(), totalRows: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative().optional(),
  lastReceivedAt: z.string().nullable(),
  analysis: z.object({ pendingCount: z.number(), processingCount: z.number(), failedCount: z.number(), analyzedCount: z.number(), lastAnalyzedAt: z.string().nullable() }),
  recent: z.array(z.object({ content: z.string(), senderName: z.string().nullable().optional(), sentAt: z.string().nullable().optional(),
    receivedAt: z.string(), isSelf: z.boolean().nullable().optional(), messageType: z.string().nullable().optional() })).max(5),
});
export async function readWeChatStatus(baseUrl: string, ownerFetch: OwnerFetch, id: string) {
  const response = await ownerRequest(baseUrl, ownerFetch, `/api/wechat-observations/${weChatObservationId.parse(id)}/status`);
  return sourceStatus.parse(await boundedJson(response, 128 * 1024));
}
export async function analyzeWeChat(baseUrl: string, ownerFetch: OwnerFetch, id: string): Promise<void> {
  const response = await ownerRequest(baseUrl, ownerFetch, `/api/wechat-observations/${weChatObservationId.parse(id)}/analyze`, 'POST', {});
  await response.body?.cancel();
}

export async function findWeChatGrant(baseUrl: string, ownerFetch: OwnerFetch, deviceId: string, windowId: string): Promise<string | undefined> {
  const response = await ownerRequest(baseUrl, ownerFetch, '/api/wechat-observations');
  const grants = z.array(grantSchema).parse(await boundedJson(response, 1024 * 1024));
  return grants.filter(grant => grant.deviceId === deviceId && grant.windowId === windowId).at(-1)?.id;
}
export async function revokeWeChatGrant(baseUrl: string, ownerFetch: OwnerFetch, id: string): Promise<void> {
  const response = await ownerRequest(baseUrl, ownerFetch, `/api/wechat-observations/${weChatObservationId.parse(id)}`, 'DELETE');
  await response.body?.cancel();
}
