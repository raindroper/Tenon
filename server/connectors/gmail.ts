import { z } from 'zod';
import { gmail } from '@googleapis/gmail';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { assertProviderOk, providerFetch, providerSdkError, readProviderJson } from './oauth.js';
import { ConnectorProviderError, type ConnectorChange, type ConnectorProvider, type ConnectorToken, type ScanInput, type ScanResult } from './types.js';

const provider = 'Gmail';
const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const labelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const messageId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const historyId = z.string().regex(/^\d{1,32}$/);
const pageToken = z.string().min(1).max(8192);
const accountId = z.email().max(320).transform(value => value.toLowerCase());
const profile = z.object({ historyId, emailAddress: accountId });
const label = z.object({ id: labelId });
const cursorSchema = z.object({ labelId, historyId, account: accountId.optional(), pageToken: pageToken.optional(), offset: z.number().int().min(0).optional() });
const historyPage = z.object({
  historyId,
  nextPageToken: pageToken.optional(),
  history: z.array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: messageId }) })).optional() })).optional(),
});
const metadata = z.object({
  id: messageId,
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().regex(/^\d{1,16}$/).optional(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() }).optional(),
});
const preview = z.object({ id: messageId, labelIds: z.array(z.string()).optional(), snippet: z.string().optional() });
const messagesPerScan = 6;

function validateScope(scope: string): string {
  const result = labelId.safeParse(scope.trim());
  if (!result.success) throw new ConnectorProviderError('Gmail 观察范围必须是一个确切的标签 ID，例如 INBOX 或 Label_123。', 400);
  return result.data;
}

function readCursor(raw: string, scope: string): z.infer<typeof cursorSchema> {
  try {
    const cursor = cursorSchema.parse(JSON.parse(raw));
    if (cursor.labelId === scope) return cursor;
  } catch { /* Invalid cursors must not expand the selected label. */ }
  throw new ConnectorProviderError('Gmail 观察游标无效，请重新设置此观察范围。', 409, { needsAttention: true });
}

async function get(input: ScanInput, request: (client: ReturnType<typeof gmail>) => Promise<{ data: unknown; status: number }>): Promise<Response> {
  // Only the saved access token reaches data requests. Explicit refresh is persisted by ConnectorService.
  const client = gmail({ version: 'v1', headers: { Authorization: `Bearer ${input.token.accessToken}` },
    retry: false, maxRedirects: 0, timeout: 10_000, signal: input.signal,
    fetchImplementation: providerFetch(input.signal, provider, url => url.origin === 'https://gmail.googleapis.com' && url.pathname.startsWith('/gmail/v1/users/me/')) });
  try { const response = await request(client); return Response.json(response.data, { status: response.status }); }
  catch (error) {
    const mapped = providerSdkError(error, provider, input.signal);
    if (mapped.status === 404) return Response.json({}, { status: 404 });
    throw mapped;
  }
}

async function parse<T>(response: Response, input: ScanInput, schema: z.ZodType<T>): Promise<T> {
  await assertProviderOk(response, provider);
  const result = schema.safeParse(await readProviderJson(response, input.signal, provider));
  if (!result.success) throw new ConnectorProviderError('Gmail 返回的观察数据格式无效。');
  return result.data;
}

async function baseline(input: ScanInput, scope: string): Promise<ScanResult> {
  const labelResponse = await get(input, client => client.users.labels.get({ userId: 'me', id: scope, fields: 'id' }));
  if (labelResponse.status === 404) {
    await labelResponse.body?.cancel().catch(() => undefined);
    throw new ConnectorProviderError('Gmail 找不到已选标签，请检查标签 ID。', 400, { needsAttention: true });
  }
  const selected = await parse(labelResponse, input, label);
  if (selected.id !== scope) throw new ConnectorProviderError('Gmail 返回的标签与已授权范围不符。');
  const current = await currentProfile(input);
  return { cursor: JSON.stringify({ labelId: scope, historyId: current.historyId, account: current.emailAddress }), changes: [] };
}

function currentProfile(input: ScanInput) {
  return get(input, client => client.users.getProfile({ userId: 'me', fields: 'historyId,emailAddress' })).then(response => parse(response, input, profile));
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string, limit: number): string {
  return headers?.find(item => item.name.toLowerCase() === name)?.value.trim().slice(0, limit) ?? '';
}

async function readMessage(input: ScanInput, scope: string, id: string): Promise<ConnectorChange | undefined> {
  const response = await get(input, client => client.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject'], fields: 'id,labelIds,internalDate,payload(headers)' }));
  if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return; }
  const message = await parse(response, input, metadata);
  if (message.id !== id || !message.labelIds?.includes(scope)) return;

  // Request only the small preview after verifying the selected label on the message itself.
  const previewResponse = await get(input, client => client.users.messages.get({ userId: 'me', id, format: 'full', fields: 'id,labelIds,snippet' }));
  if (previewResponse.status === 404) { await previewResponse.body?.cancel().catch(() => undefined); return; }
  const detail = await parse(previewResponse, input, preview);
  if (detail.id !== id || !detail.labelIds?.includes(scope)) return;

  const title = header(message.payload?.headers, 'subject', 240) || '（无主题）';
  const received = message.internalDate === undefined ? undefined : new Date(Number(message.internalDate));
  const timestamp = received && Number.isFinite(received.valueOf()) ? `收到时间：${received.toISOString()}` : '';
  const snippet = detail.snippet?.trim().slice(0, 600);
  return {
    id, revision: 'received', title,
    content: [`Gmail 邮件主题：${title}`, timestamp, snippet && `邮件预览：${snippet}`].filter(Boolean).join('\n'),
    url: `https://mail.google.com/mail/#all/${encodeURIComponent(id)}`,
  };
}

async function scan(input: ScanInput): Promise<ScanResult> {
  const scope = validateScope(input.scope);
  if (input.cursor === undefined) return baseline(input, scope);
  const previous = readCursor(input.cursor, scope);
  const current = await currentProfile(input);
  if (previous.account && previous.account !== current.emailAddress) {
    throw new ConnectorProviderError('Gmail 邮箱身份已变化，请建立独立连接；原观察位置已保留。', 409, { needsAttention: true });
  }
  const cursor = { ...previous, account: current.emailAddress };
  const response = await get(input, client => client.users.history.list({ userId: 'me',
    startHistoryId: cursor.historyId, labelId: scope, historyTypes: ['messageAdded'], maxResults: 20,
    fields: 'history(messagesAdded(message(id))),historyId,nextPageToken',
    ...(cursor.pageToken && { pageToken: cursor.pageToken }),
  }));
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { ...await baseline(input, scope), notice: 'Gmail 变更游标已失效，已从当前时点重新观察。失效期间的邮件可能遗漏。' };
  }
  const page = await parse(response, input, historyPage);
  if (BigInt(page.historyId) < BigInt(cursor.historyId)) throw new ConnectorProviderError('Gmail 返回的观察游标未能继续。');
  const ids = [...new Set(page.history?.flatMap(item => item.messagesAdded?.map(entry => entry.message.id) ?? []))];
  const offset = cursor.offset ?? 0;
  if (offset > ids.length || page.nextPageToken === cursor.pageToken && cursor.pageToken !== undefined) {
    throw new ConnectorProviderError('Gmail 返回的观察分页无法继续。');
  }
  const batch = ids.slice(offset, offset + messagesPerScan);
  const messages = await Promise.allSettled(batch.map(id => readMessage(input, scope, id)));
  const changes: ConnectorChange[] = [];
  for (const message of messages) {
    if (message.status === 'rejected') throw message.reason;
    if (message.value) changes.push(message.value);
  }
  if (offset + batch.length < ids.length) {
    return { cursor: JSON.stringify({ ...cursor, offset: offset + batch.length }), changes, more: true };
  }
  if (page.nextPageToken) {
    return { cursor: JSON.stringify({ labelId: scope, historyId: cursor.historyId, account: cursor.account, pageToken: page.nextPageToken }), changes, more: true };
  }
  return { cursor: JSON.stringify({ labelId: scope, historyId: page.historyId, account: cursor.account }), changes };
}

export function createGmailProvider(env: NodeJS.ProcessEnv): ConnectorProvider | undefined {
  const clientId = env.RAE_GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.RAE_GMAIL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return;
  const authorization = (redirectUri: string, signal: AbortSignal) => {
    const client = new OAuth2Client({ clientId, clientSecret, redirectUri, transporterOptions: {
      retry: false, timeout: 10_000, maxRedirects: 0, signal,
      fetchImplementation: providerFetch(signal, provider, url => url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token'),
    } });
    // Google Auth intentionally enables retries on token requests; this app's call budget owns retries instead.
    client.transporter.interceptors.request.add({ resolved: async options => ({ ...options, retry: false, retryConfig: { retry: 0 } }) });
    return client;
  };
  const saved = (credentials: Credentials, previous?: string): ConnectorToken => {
    const parsed = z.object({ access_token: z.string().min(1).max(16_384), refresh_token: z.string().min(1).max(16_384).nullish(),
      expiry_date: z.number().finite().positive().nullish(), scope: z.string().optional() }).safeParse(credentials);
    if (!parsed.success) throw new ConnectorProviderError('Gmail 返回的凭据无效。');
    if (parsed.data.scope && !parsed.data.scope.split(/\s+/).includes(gmailScope)) {
      throw new ConnectorProviderError('Gmail 未授予只读邮件权限，请重新连接。', 403, { needsAttention: true });
    }
    const refreshToken = parsed.data.refresh_token ?? previous;
    if (!refreshToken) throw new ConnectorProviderError('Gmail 未授予离线续期权限，请重新连接。', 401, { needsAttention: true });
    return { accessToken: parsed.data.access_token, refreshToken, ...(parsed.data.expiry_date ? { expiresAt: parsed.data.expiry_date } : {}) };
  };
  return {
    validateScope,
    authorize({ scope, state, redirectUri, challenge }) {
      validateScope(scope);
      return new URL(authorization(redirectUri, new AbortController().signal).generateAuthUrl({
        scope: gmailScope, access_type: 'offline', prompt: 'consent', state,
        code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256 }));
    },
    async exchange({ code, redirectUri, verifier }, signal) {
      try { return saved((await authorization(redirectUri, signal).getToken({ code, redirect_uri: redirectUri, codeVerifier: verifier })).tokens); }
      catch (error) { throw providerSdkError(error, provider, signal); }
    },
    async refresh(token, redirectUri, signal) {
      if (!token.refreshToken) throw new ConnectorProviderError('Gmail 缺少续期凭据，请重新连接。', 401, { needsAttention: true });
      const client = authorization(redirectUri, signal); client.setCredentials({ refresh_token: token.refreshToken });
      let rotated: Credentials | undefined;
      client.once('tokens', credentials => { rotated = { ...credentials }; });
      try {
        const response = await client.refreshAccessToken();
        return saved(rotated ?? response.credentials, token.refreshToken);
      } catch (error) { throw providerSdkError(error, provider, signal); }
    },
    canRefresh: token => Boolean(token.refreshToken),
    async validateReauthorization({ previousToken, nextToken, scope, cursor }, signal) {
      const selected = validateScope(scope); const savedCursor = readCursor(cursor, selected);
      let previousAccount = savedCursor.account;
      if (!previousAccount) {
        try { previousAccount = (await currentProfile({ token: previousToken, scope: selected, signal })).emailAddress; }
        catch { signal.throwIfAborted(); throw new ConnectorProviderError('Gmail 旧连接缺少可核对的账号标识，请建立独立连接；原资料和凭据已保留。', 409, { needsAttention: true }); }
      }
      if ((await currentProfile({ token: nextToken, scope: selected, signal })).emailAddress !== previousAccount) {
        throw new ConnectorProviderError('Gmail 邮箱身份已变化，请建立独立连接；原观察位置已保留。', 409, { needsAttention: true });
      }
    },
    scan,
  };
}
