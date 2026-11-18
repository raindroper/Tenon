import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Client, ResponseType, type Middleware } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication, LogLevel, ResponseMode, type AuthenticationResult, type NetworkRequestOptions, type NetworkResponse } from '@azure/msal-node';
import { assertProviderOk, providerResponseError, providerSdkError, readProviderJson, requestProvider } from './oauth.js';
import { ConnectorProviderError, type ConnectorProvider, type ConnectorToken, type ScanInput, type ScanResult } from './types.js';

const provider = 'Outlook';
const graph = 'https://graph.microsoft.com';
const authority = 'https://login.microsoftonline.com/common';
const mailScopes = ['https://graph.microsoft.com/Mail.Read', 'offline_access'];
const pageSize = 6;
const graphId = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_+=/-]{0,511}$/);
const dateTime = z.iso.datetime({ offset: true });
const pageLink = z.string().min(1).max(16_384);
const folder = z.object({ id: graphId });
const cursorSchema = z.object({ scope: graphId, folderId: graphId, since: dateTime, link: pageLink.optional() });
const deltaPage = z.object({
  value: z.array(z.object({
    id: graphId, parentFolderId: graphId.optional(), receivedDateTime: dateTime.optional(),
    subject: z.string().nullish(), bodyPreview: z.string().nullish(), webLink: z.string().nullish(), '@removed': z.unknown().optional(),
  })).max(pageSize),
  '@odata.nextLink': pageLink.optional(), '@odata.deltaLink': pageLink.optional(),
});
const graphError = z.object({ error: z.object({ code: z.string() }) });

function validateScope(scope: string): string {
  const selected = scope.trim();
  const result = graphId.safeParse(selected.toLowerCase() === 'inbox' ? 'inbox' : selected);
  if (!result.success) throw new ConnectorProviderError('Outlook 观察范围必须是 inbox 或一个确切的文件夹 ID。', 400);
  return result.data;
}

function readCursor(raw: string, scope: string): z.infer<typeof cursorSchema> {
  try {
    const cursor = cursorSchema.parse(JSON.parse(raw));
    if (cursor.scope === scope && (scope === 'inbox' || cursor.folderId === scope)) return cursor;
  } catch { /* Invalid cursors must not expand the selected folder. */ }
  throw new ConnectorProviderError('Outlook 观察游标无效，请重新设置此观察范围。', 409, { needsAttention: true });
}

function deltaLink(link: string, folderId: string): URL {
  try {
    const url = new URL(link);
    const path = /^\/v1\.0\/me\/mailfolders(?:\/([^/]+)|\('([^']+)'\))\/messages\/(?:microsoft\.graph\.)?delta\/?$/i.exec(url.pathname);
    const params = [...url.searchParams];
    if (url.origin === graph && !url.username && !url.password && !url.hash && path &&
      decodeURIComponent(path[1] ?? path[2]) === folderId && params.length === 1 &&
      /^\$(?:skiptoken|deltatoken)$/i.test(params[0][0]) && params[0][1]) return url;
  } catch { /* Never send credentials to a different endpoint. */ }
  throw new ConnectorProviderError('Outlook 返回的分页地址超出已授权文件夹。');
}

async function get(input: ScanInput, url: URL): Promise<Response> {
  if (url.origin !== graph || url.username || url.password || url.hash) throw new ConnectorProviderError('Outlook 请求超出已授权服务。', 400, { needsAttention: true });
  let failure: unknown;
  // An SDK transport adapter preserves this application's timeout, cancellation and fetch mocks.
  // No retry/redirect/auth middleware can replace the explicitly persisted access token.
  const transport: Middleware = { async execute(context) {
    try { context.response = await requestProvider(new URL(typeof context.request === 'string' ? context.request : context.request.url), context.options ?? {}, input.signal, provider); }
    catch (error) { failure = error; throw error; }
  } };
  const client = Client.initWithMiddleware({ middleware: [transport], baseUrl: graph, defaultVersion: 'v1.0' });
  try {
    return await client.api(url.href).headers({ Authorization: `Bearer ${input.token.accessToken}`, Accept: 'application/json',
      Prefer: `odata.maxpagesize=${pageSize}, IdType="ImmutableId"` }).responseType(ResponseType.RAW).get() as Response;
  } catch (error) { throw providerSdkError(failure ?? error, provider, input.signal); }
}

function messageUrl(link: string | null | undefined): string | undefined {
  if (!link || link.length > 4096) return;
  try {
    const url = new URL(link);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft'].includes(url.hostname)) return url.href;
  } catch { /* Some accounts have no supported web link. */ }
}

async function baseline(input: ScanInput, scope: string): Promise<ScanResult> {
  const selected = await selectedFolder(input, scope);
  // Establish a time fence without fetching or persisting any historical mail.
  return { cursor: JSON.stringify({ scope, folderId: selected.id, since: new Date().toISOString() }), changes: [] };
}

async function selectedFolder(input: ScanInput, scope: string): Promise<z.infer<typeof folder>> {
  const url = new URL(`${graph}/v1.0/me/mailFolders/${encodeURIComponent(scope)}`);
  url.searchParams.set('$select', 'id');
  const response = await get(input, url);
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorProviderError('Outlook 找不到已选文件夹，请检查文件夹 ID。', 400, { needsAttention: true });
  }
  await assertProviderOk(response, provider);
  const result = folder.safeParse(await readProviderJson(response, input.signal, provider));
  if (!result.success || scope !== 'inbox' && result.data.id !== scope) {
    throw new ConnectorProviderError('Outlook 返回的文件夹与已授权范围不符。');
  }
  return result.data;
}

function initialDelta(folderId: string, since: string): URL {
  const url = new URL(`${graph}/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`);
  url.search = new URLSearchParams({ changeType: 'created', '$select': 'id,parentFolderId,subject,receivedDateTime,bodyPreview,webLink',
    '$filter': `receivedDateTime ge ${since}`, '$top': String(pageSize) }).toString();
  return url;
}

async function scan(input: ScanInput): Promise<ScanResult> {
  const scope = validateScope(input.scope);
  if (input.cursor === undefined) return baseline(input, scope);
  const cursor = readCursor(input.cursor, scope);
  const url = cursor.link ? deltaLink(cursor.link, cursor.folderId) : initialDelta(cursor.folderId, cursor.since);
  // A newly authorized account must never silently replace the old account's inbox.
  if ((await selectedFolder(input, scope)).id !== cursor.folderId) {
    throw new ConnectorProviderError('Outlook 邮箱身份已变化，请建立独立连接；原观察位置已保留。', 409, { needsAttention: true });
  }
  const response = await get(input, url);
  let expired = response.status === 410 && !!cursor.link;
  if (cursor.link && (response.status === 400 || response.status === 404)) {
    const error = graphError.safeParse(await readProviderJson(response, input.signal, provider));
    expired = error.success && ['syncStateNotFound', 'resyncRequired'].includes(error.data.error.code);
  }
  if (expired) {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
    return { ...await baseline(input, scope), notice: 'Outlook 变更游标已失效，已从当前时点重新观察。失效期间的邮件可能遗漏。' };
  }
  await assertProviderOk(response, provider);
  const page = deltaPage.safeParse(await readProviderJson(response, input.signal, provider));
  if (!page.success) throw new ConnectorProviderError('Outlook 返回的邮件分页无效或超出读取上限。');
  const next = page.data['@odata.nextLink'];
  const link = next ?? page.data['@odata.deltaLink'];
  if (!link || next && next === cursor.link) throw new ConnectorProviderError('Outlook 返回的观察分页无法继续。');
  deltaLink(link, cursor.folderId);
  const since = Date.parse(cursor.since);
  const changes = page.data.value.flatMap(message => {
    if (message['@removed'] !== undefined || message.parentFolderId !== cursor.folderId || !message.receivedDateTime) return [];
    const received = Date.parse(message.receivedDateTime);
    if (!Number.isFinite(received) || received < since) return [];
    const title = message.subject?.trim().slice(0, 240) || '（无主题）';
    const preview = message.bodyPreview?.trim().slice(0, 600);
    return [{ id: message.id, revision: 'received', title,
      content: [`Outlook 邮件主题：${title}`, `收到时间：${new Date(received).toISOString()}`, preview && `邮件预览：${preview}`].filter(Boolean).join('\n'),
      url: messageUrl(message.webLink) }];
  });
  return { cursor: JSON.stringify({ ...cursor, link }), changes, more: !!next };
}

export function createOutlookProvider(env: NodeJS.ProcessEnv): ConnectorProvider | undefined {
  const clientId = env.RAE_OUTLOOK_CLIENT_ID?.trim();
  const clientSecret = env.RAE_OUTLOOK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;
  const authorization = (signal: AbortSignal) => {
    let failure: unknown;
    const request = async <T>(url: string, options: NetworkRequestOptions | undefined, method: 'GET' | 'POST'): Promise<NetworkResponse<T>> => {
      try {
        const endpoint = new URL(url);
        if (endpoint.origin !== 'https://login.microsoftonline.com' || endpoint.username || endpoint.password || endpoint.hash) {
          throw new ConnectorProviderError('Outlook 授权地址超出已配置的登录服务。', 400, { needsAttention: true });
        }
        const response = await requestProvider(endpoint, { method, headers: options?.headers, ...(options?.body ? { body: options.body } : {}) }, signal, provider);
        const body = await readProviderJson(response, signal, provider);
        if (!response.ok) throw providerResponseError(response, provider, body);
        return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: body as T };
      } catch (error) { failure = error; throw error; }
    };
    const client = new ConfidentialClientApplication({ auth: { clientId, clientSecret, authority }, system: {
      disableInternalRetries: true,
      loggerOptions: { loggerCallback: () => undefined, piiLoggingEnabled: false, logLevel: LogLevel.Error },
      networkClient: {
        sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => request<T>(url, options, 'GET'),
        sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => request<T>(url, options, 'POST'),
      },
    } });
    return { client, error: (error: unknown) => providerSdkError(failure ?? error, provider, signal) };
  };
  const saved = (client: ConfidentialClientApplication, result: AuthenticationResult | null): ConnectorToken => {
    const cache = client.getTokenCache().serialize();
    const refreshes = JSON.parse(cache).RefreshToken as Record<string, { secret?: string }> | undefined;
    if (!result?.accessToken || result.accessToken.length > 16_384 || !result.account || !refreshes || !Object.values(refreshes).some(value => value.secret) || cache.length > 2 * 1024 * 1024) {
      throw new ConnectorProviderError('Outlook 未授予离线续期权限，请重新连接。', 401, { needsAttention: true });
    }
    if (!result.scopes.some(scope => ['mail.read', 'https://graph.microsoft.com/mail.read'].includes(scope.toLowerCase()))) {
      throw new ConnectorProviderError('Outlook 未授予只读邮件权限，请重新连接。', 403, { needsAttention: true });
    }
    return { accessToken: result.accessToken, msalCache: cache, msalAccountId: result.account.homeAccountId,
      ...(result.expiresOn ? { expiresAt: result.expiresOn.valueOf() } : {}) };
  };
  return {
    validateScope,
    async authorize({ scope, state, redirectUri, challenge }, signal = new AbortController().signal) {
      validateScope(scope);
      const auth = authorization(signal);
      try { return new URL(await auth.client.getAuthCodeUrl({ scopes: mailScopes, state, redirectUri, responseMode: ResponseMode.QUERY,
        codeChallenge: challenge, codeChallengeMethod: 'S256', nonce: challenge })); }
      catch (error) { throw auth.error(error); }
    },
    async exchange({ code, redirectUri, verifier }, signal) {
      const auth = authorization(signal);
      try { return saved(auth.client, await auth.client.acquireTokenByCode({ scopes: mailScopes, code, redirectUri, codeVerifier: verifier,
        nonce: createHash('sha256').update(verifier).digest('base64url') })); }
      catch (error) { throw auth.error(error); }
    },
    async refresh(token, _redirectUri, signal) {
      const auth = authorization(signal);
      try {
        if (token.msalCache) {
          if (token.msalCache.length > 2 * 1024 * 1024 || !token.msalAccountId) throw new ConnectorProviderError('Outlook 续期缓存无效，请重新连接。', 401, { needsAttention: true });
          auth.client.getTokenCache().deserialize(token.msalCache);
          const account = await auth.client.getTokenCache().getAccountByHomeId(token.msalAccountId);
          if (!account) throw new ConnectorProviderError('Outlook 续期账号不匹配，请重新连接。', 401, { needsAttention: true });
          const result = await auth.client.acquireTokenSilent({ account, scopes: mailScopes, forceRefresh: true });
          if (result.account?.homeAccountId !== token.msalAccountId) throw new ConnectorProviderError('Outlook 续期账号已变化，请重新连接。', 401, { needsAttention: true });
          return saved(auth.client, result);
        }
        if (!token.refreshToken) throw new ConnectorProviderError('Outlook 缺少续期凭据，请重新连接。', 401, { needsAttention: true });
        // Explicit one-time migration of existing encrypted refresh credentials into MSAL's cache.
        return saved(auth.client, await auth.client.acquireTokenByRefreshToken({ refreshToken: token.refreshToken, scopes: mailScopes, forceCache: true }));
      } catch (error) { throw auth.error(error); }
    },
    canRefresh: token => Boolean(token.msalCache || token.refreshToken),
    async validateReauthorization({ previousToken, nextToken, scope, cursor }, signal) {
      const selected = validateScope(scope);
      let previousFolder: string;
      try { previousFolder = readCursor(cursor, selected).folderId; }
      catch {
        try { previousFolder = (await selectedFolder({ token: previousToken, scope: selected, signal }, selected)).id; }
        catch { signal.throwIfAborted(); throw new ConnectorProviderError('Outlook 旧连接缺少可核对的邮箱标识，请建立独立连接；原资料和凭据已保留。', 409, { needsAttention: true }); }
      }
      if ((await selectedFolder({ token: nextToken, scope: selected, signal }, selected)).id !== previousFolder) {
        throw new ConnectorProviderError('Outlook 邮箱身份已变化，请建立独立连接；原观察位置已保留。', 409, { needsAttention: true });
      }
    },
    scan,
  };
}
