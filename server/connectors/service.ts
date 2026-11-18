import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ToolsInput } from '@mastra/core/agent';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskRecord } from '../../shared/task-consent.js';
import type { MailTaskSpec } from '../../shared/mail.js';
import { githubConnectInputSchema, githubUpdateInputSchema, githubUpgradeInputSchema, type GitHubConnectInput, type GitHubUpdateInput, type GitHubUpgradeInput } from '../../shared/github-connection.js';
import type { GitHubConnectionDetails, GitHubTaskRequest } from '../../shared/github.js';
import { GitHubOperations } from './github-operations.js';
import { inspectGitHubRepository, inspectGitHubAccount as inspectGitHubAccountProfile } from './github-mcp.js';
import { oauthAppInputSchema, type OAuthAppInput, type OAuthAppKind, type OAuthAppSetup } from '../../shared/oauth-apps.js';
import { EwsMail } from './ews-mail.js';
import { ewsSelectionInput, type EwsSelectionInput } from '../../shared/ews.js';
import { connectorKinds, type ConnectorConnection, type ConnectorDirectory,
  type ConnectorDocumentMetadata, type ConnectorKind, type TencentDocsCredential } from '../../shared/connectors.js';
import { MAX_WECHAT_OBSERVATIONS_PER_DEVICE, type WeChatObservationBatch, type WeChatObservationBinding, type WeChatObservationGrant,
  type WeChatObservationReceipt, type WeChatObservationSelection, type WeChatConversationStatus, type WeChatMessageView } from '../../shared/wechat-observation.js';
import { RuntimeInputError } from '../runtime.js';
import { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import type { EventInbox, InboxEvent, StoredEvent } from '../v2/events.js';
import { createGitHubProvider } from './github.js';
import { createGmailProvider } from './gmail.js';
import { createOutlookProvider } from './outlook.js';
import { createTencentDocsProvider } from './tencent-docs.js';
import { checkEwsCredentials, createEwsProvider, ewsAvailable, ewsCursor, queryEwsInbox, readEwsInboxMessage, runEwsNative, type EwsTransport } from './ews.js';
import { ewsConnectInput, ewsStoredCredentials, ewsUpdateInput, ewsQueryInput, ewsReadInput,
  type EwsConnectInput, type EwsUpdateInput, type EwsQueryInput, type EwsReadInput, type EwsMessagePage, type EwsMessageReadPage } from '../../shared/ews.js';
import { isOwnerChatEvent } from '../v2/consent.js';
import { ConnectorProviderError, type ConnectorProvider, type ConnectorToken, type ScanResult } from './types.js';

const RECORDS = 'connectors.v1';
const AGENT_WECHAT_ARCHIVE = 'connectors.agent-wechat.archive.v1';
const TENCENT_DOCS_CREDENTIALS = 'connectors.tencent-docs.credentials';
const TENCENT_DOCS_SECRET_PREFIX = 'tencent-docs-';
const TENCENT_DOCS_CREDENTIAL_UNAVAILABLE = '腾讯文档授权不可用，请保存授权后重新添加文档。';
const tencentDocsTokenPattern = /^[\x21-\x7e]{1,16384}$/;
const MAX_CONNECTIONS = 12;
const REQUEST_LIMIT = 20_000;
const POLL_INTERVAL = 5 * 60_000;
const TENCENT_DOCS_POLL_INTERVAL = 30 * 60_000;
const PAGE_INTERVAL = 15_000;
const AUTH_TTL = 10 * 60_000;
const SOURCE_PREFIX = 'connector:';
const LOCAL_WECHAT_INDEX = 'connectors.wechat-desktop.unrevoked';
const LOCAL_WECHAT_LEASE = 90_000;

type Selection = { caseId: string; scope: string; connectionId?: string };
type TencentDocumentSelection = Selection & { credentialId: string };
type ConnectionSelection = Selection & { redirectUri: string; credentialId?: string; github?: GitHubConnectionDetails };
type ConnectionUse = { credentialId?: string; connectionId?: string; credentialMutation?: boolean; accountOperation?: boolean };
interface Connection extends ConnectionSelection {
  id: string;
  kind: ConnectorKind;
  connectedAt: string;
}
type LegacyAgentWeChatConnection = Omit<Connection, 'kind'> & { kind: 'agent-wechat' };
interface StoredAgentWeChatArchive { retiredAt: string; connections: LegacyAgentWeChatConnection[] }
export interface RetiredAgentWeChatArchive {
  retiredAt: string;
  connections: Array<Pick<LegacyAgentWeChatConnection, 'id' | 'kind' | 'caseId' | 'scope' | 'connectedAt'> & { lastSyncedAt: string | null }>;
  events: InboxEvent[];
}
interface PendingAuthorization extends Selection {
  kind: ConnectorKind;
  redirectUri: string;
  verifier: string;
  expiresAt: number;
}
interface LocalWeChatGrant extends WeChatObservationGrant { revokedAt?: string }
interface LocalWeChatScope {
  caseId: string; revokedAt?: string; title?: string; chatType?: 'group' | 'private';
  coverageStartAt?: string; analysisIntervalMinutes?: number;
  historyUntil?: string;
  previousTitles?: string[];
}
interface Checkpoint {
  documentEventId?: string;
  cursor: string;
  lastSyncedAt: string;
  nextAt: number;
  pollIntervalMs?: number;
  error?: string;
  notice?: string;
  document?: ConnectorDocumentMetadata;
  needsAttention?: boolean;
  rateLimited?: boolean;
}

function nextScan(kind: ConnectorKind, completedAt: number, more = false): Pick<Checkpoint, 'nextAt' | 'pollIntervalMs'> {
  const interval = kind === 'tencent-docs' ? TENCENT_DOCS_POLL_INTERVAL : POLL_INTERVAL;
  return {
    nextAt: completedAt + (more ? PAGE_INTERVAL : interval),
    ...(kind === 'tencent-docs' ? { pollIntervalMs: interval } : {}),
  };
}

function tencentDocsAccessToken(value: string | undefined): string | undefined {
  const token: unknown = value ? (JSON.parse(value) as ConnectorToken | null)?.accessToken : undefined;
  return typeof token === 'string' && tencentDocsTokenPattern.test(token) ? token : undefined;
}

export type ConnectorProviders = Partial<Record<ConnectorKind, ConnectorProvider>>;

export function connectorProviders(env: NodeJS.ProcessEnv): ConnectorProviders {
  return {
    'tencent-docs': createTencentDocsProvider(env),
    github: createGitHubProvider(env),
    gmail: createGmailProvider(env),
    outlook: createOutlookProvider(env),
    ews: ewsAvailable() ? createEwsProvider() : undefined,
  };
}

/** Keeps grants and credentials separate from provider evidence, which uses the existing inbox. */
export class ConnectorService {
  private researchSourceAllowed?: (event: InboxEvent) => boolean;
  setResearchSourceGuard(allowed: (event: InboxEvent) => boolean): void { this.researchSourceAllowed = allowed; }
  private taskSourceAllowed?: (event: InboxEvent) => boolean;
  setTaskSourceGuard(allowed: (event: InboxEvent) => boolean): void { this.taskSourceAllowed = allowed; }
  private readonly authorizations = new Map<string, PendingAuthorization>();
  private readonly credentials = new Map<string, SecretStore>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly caseOperations = new Map<AbortController, ConnectionUse & { caseId: string; work: Promise<unknown> }>();
  private readonly scans = new Map<string, Promise<ConnectorConnection>>();
  private readonly shutdown = new AbortController();
  private readonly credentialUpdates = new Set<string>();
  private readonly ewsReadOperations = new Map<string, Promise<StoredEvent>>();
  private ewsMailService?: EwsMail;
  private githubOperations?: GitHubOperations;
  private readonly environmentOAuthKinds: ReadonlySet<OAuthAppKind>;
  private mailTasks: () => readonly TaskRecord[] = () => [];

  constructor(private readonly store: Store, private readonly inbox: EventInbox, private readonly directory: string,
    private readonly providers: ConnectorProviders, private readonly canObserve: (caseId: string) => boolean,
    private readonly assertActive: () => void, private readonly onChanges: () => void,
    private readonly isDeviceActive: (id: string) => boolean = () => false,
    private readonly ewsTransport: EwsTransport = runEwsNative,
    private readonly inspectGitHub = inspectGitHubRepository,
    private readonly inspectGitHubAccount = inspectGitHubAccountProfile) {
    this.environmentOAuthKinds = new Set((['gmail', 'outlook'] as const).filter(kind => Boolean(providers[kind])));
  }

  private storedConnections(): Array<Connection | LegacyAgentWeChatConnection> {
    return this.store.getMeta<Array<Connection | LegacyAgentWeChatConnection>>(RECORDS, []);
  }
  private connections(): Connection[] {
    return this.storedConnections().filter((record): record is Connection => record.kind !== 'agent-wechat');
  }
  private agentWeChatArchive(): StoredAgentWeChatArchive | undefined {
    return this.store.getMeta<StoredAgentWeChatArchive | undefined>(AGENT_WECHAT_ARCHIVE, undefined);
  }
  private retireAgentWeChat(): void {
    const archived = this.agentWeChatArchive();
    const records = this.storedConnections();
    const retired = records.filter(record => record.kind === 'agent-wechat');
    if (archived && !retired.length) return;
    const connections = new Map((archived?.connections ?? []).map(record => [record.id, record]));
    for (const record of retired) connections.set(record.id, record);
    // The inbox and Store use separate databases. Retire pending work first so a restart can safely repeat this migration.
    this.inbox.retireConnectorHistory('agent-wechat', [...connections.keys()]);
    this.store.atomic(() => {
      this.store.setMeta(AGENT_WECHAT_ARCHIVE, { retiredAt: archived?.retiredAt ?? new Date().toISOString(), connections: [...connections.values()] });
      if (retired.length) this.store.setMeta(RECORDS, records.filter(record => record.kind !== 'agent-wechat'));
    });
  }
  exportRetiredAgentWeChat(): RetiredAgentWeChatArchive | undefined {
    const archive = this.agentWeChatArchive();
    if (!archive) return undefined;
    const events = this.inbox.archivedConnectorEvents('agent-wechat', archive.connections.map(record => record.id));
    if (!archive.connections.length && !events.length) return undefined;
    return { retiredAt: archive.retiredAt, connections: archive.connections.map(({ id, kind, caseId, scope, connectedAt }) => ({
      id, kind, caseId, scope, connectedAt, lastSyncedAt: this.inbox.getCheckpoint<Checkpoint>(this.sourceId(id), null, id)?.lastSyncedAt ?? null,
    })), events };
  }
  private tencentDocsCredentials(): TencentDocsCredential[] {
    return this.store.getMeta<TencentDocsCredential[]>(TENCENT_DOCS_CREDENTIALS, []);
  }
  private migrateTencentDocsCredentials(): void {
    const connections = this.connections();
    if (!connections.some(connection => connection.kind === 'tencent-docs' && !connection.credentialId)) return;
    const credentials = this.tencentDocsCredentials();
    const byToken = new Map<string, TencentDocsCredential>();
    for (const credential of credentials) {
      const token = this.savedTencentDocsToken(credential.id);
      if (token) byToken.set(token, credential);
    }
    let migrated = false;
    const updated = connections.map(connection => {
      if (connection.kind !== 'tencent-docs' || connection.credentialId) return connection;
      let token: string | undefined;
      try {
        token = tencentDocsAccessToken(new SecretStore(this.directory, connection.id + '.json').get());
      } catch { /* Keep unreadable legacy data for recovery; do not use it to scan. */ }
      if (!token) return connection;
      let credential = byToken.get(token);
      if (!credential) {
        credential = { id: randomUUID(), createdAt: connection.connectedAt };
        this.credential(TENCENT_DOCS_SECRET_PREFIX + credential.id).set(JSON.stringify({ accessToken: token }));
        byToken.set(token, credential);
        credentials.push(credential);
      }
      migrated = true;
      return { ...connection, credentialId: credential.id };
    });
    if (migrated) this.store.atomic(() => {
      this.store.setMeta(TENCENT_DOCS_CREDENTIALS, credentials);
      this.store.setMeta(RECORDS, updated);
    });
  }
  recover(): void {
    this.retireAgentWeChat();
    if (!existsSync(this.directory)) return;
    for (const kind of ['gmail', 'outlook'] as const) {
      if (this.environmentOAuthKinds.has(kind)) continue;
      const saved = this.savedOAuthApp(kind);
      if (saved) this.providers[kind] = this.oauthAppProvider(kind, saved);
    }
    // Publish migrated references only after all protected secrets have been written.
    this.migrateTencentDocsCredentials();
    const current = new Set([
      ...this.connections().filter(connection => connection.kind !== 'tencent-docs' || !connection.credentialId).map(connection => connection.id + '.json'),
      ...this.tencentDocsCredentials().map(credential => TENCENT_DOCS_SECRET_PREFIX + credential.id + '.json'),
    ]);
    const archivedSecrets = new Set(this.agentWeChatArchive()?.connections.map(record => record.id));
    for (const name of readdirSync(this.directory)) {
      if (/^(?:tencent-docs-)?[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name) && !current.has(name)
        && !archivedSecrets.has(name.split('.json', 1)[0])) {
        rmSync(join(this.directory, name), { force: true });
      }
    }
  }
  private sourceId(id: string): string { return SOURCE_PREFIX + id; }
  private localWeChatKey(id: string): string { return 'connectors.wechat-desktop.grant.' + id; }
  private localWeChatGrant(id: string): LocalWeChatGrant | null {
    return this.store.getMeta<LocalWeChatGrant | null>(this.localWeChatKey(id), null);
  }
  private localWeChatScopeKey({ deviceId, windowId }: Pick<WeChatObservationSelection, 'deviceId' | 'windowId'>): string {
    return `connectors.wechat-desktop.scope.${deviceId}.${windowId}`;
  }
  private localWeChatScope(input: Pick<WeChatObservationSelection, 'deviceId' | 'windowId'>): LocalWeChatScope | null {
    return this.store.getMeta<LocalWeChatScope | null>(this.localWeChatScopeKey(input), null);
  }
  private localWeChatIndex(): string[] { return this.store.getMeta<string[]>(LOCAL_WECHAT_INDEX, []); }
  private localWeChatUnrevoked(): LocalWeChatGrant[] {
    return this.localWeChatIndex().flatMap(id => { const grant = this.localWeChatGrant(id); return grant ? [grant] : []; });
  }
  private localWeChatExpiry(grant: WeChatObservationGrant): string {
    return this.inbox.getCheckpoint<{ expiresAt: string }>(this.sourceId(grant.id), null, grant.id)?.expiresAt ?? grant.expiresAt;
  }
  private localWeChatEligible(grant: LocalWeChatGrant): boolean {
    const scope = this.localWeChatScope(grant);
    return !grant.revokedAt && !scope?.revokedAt && (!scope || scope.caseId === grant.caseId)
      && this.canObserve(grant.caseId) && this.isDeviceActive(grant.deviceId);
  }
  private localWeChatView(grant: LocalWeChatGrant): WeChatObservationGrant {
    const { revokedAt: _revokedAt, ...view } = grant;
    return { ...view, expiresAt: this.localWeChatExpiry(grant) };
  }
  listLocalWeChatObservations(): WeChatObservationGrant[] {
    this.assertOpen();
    return this.localWeChatUnrevoked().map(grant => this.localWeChatView(grant));
  }
  private localWeChatConversationId(grant: WeChatObservationSelection): string {
    return createHash('sha256').update(JSON.stringify([grant.deviceId, grant.windowId, grant.caseId])).digest('hex');
  }
  private localWeChatConversationGrants(grant: LocalWeChatGrant): LocalWeChatGrant[] {
    return this.localWeChatUnrevoked().filter(value => value.deviceId === grant.deviceId && value.windowId === grant.windowId
      && value.caseId === grant.caseId && this.localWeChatEligible(value));
  }
  localWeChatGenerations(id: string, includeRevoked = false): { caseId: string; sourceGenerations: string[] } {
    this.assertOpen();
    const grant = this.matchingLocalWeChatGrant(id);
    if (!includeRevoked && !this.localWeChatEligible(grant)) throw new RuntimeInputError(409, '微信会话授权已撤销或不可用。');
    const grants = includeRevoked ? this.localWeChatUnrevoked().filter(value => value.deviceId === grant.deviceId
      && value.windowId === grant.windowId && value.caseId === grant.caseId) : this.localWeChatConversationGrants(grant);
    return { caseId: grant.caseId, sourceGenerations: [...new Set([grant.id, ...grants.map(value => value.id)])] };
  }
  canReadWeChatConversation(caseId: string, id: string): boolean {
    return this.localWeChatUnrevoked().some(grant => grant.caseId === caseId && this.localWeChatEligible(grant)
      && this.localWeChatConversationId(grant) === id);
  }
  sameWeChatConversation(left: InboxEvent, right: InboxEvent): boolean {
    if (!this.isEventAllowed(left) || !this.isEventAllowed(right) || !left.sourceGeneration || !right.sourceGeneration) return false;
    const first = this.localWeChatGrant(left.sourceGeneration);
    const second = this.localWeChatGrant(right.sourceGeneration);
    return Boolean(first && second && this.localWeChatConversationId(first) === this.localWeChatConversationId(second));
  }
  listWeChatTopicHints(currentCaseId: string) {
    const hints = new Map<string, { hintId: string; caseId: string; title: string | null; chatType: 'group' | 'private' | null }>();
    for (const grant of this.localWeChatUnrevoked()) {
      if (grant.caseId === currentCaseId || !this.localWeChatEligible(grant)) continue;
      const scope = this.localWeChatScope(grant);
      const hintId = 'wechat-topic-' + this.localWeChatConversationId(grant);
      hints.set(hintId, { hintId, caseId: grant.caseId, title: scope?.title ?? grant.title ?? null,
        chatType: scope?.chatType ?? grant.chatType ?? null });
    }
    return [...hints.values()];
  }
  canReadWeChatTopicHint(id: string): boolean {
    return this.localWeChatUnrevoked().some(grant => this.localWeChatEligible(grant)
      && id === 'wechat-topic-' + this.localWeChatConversationId(grant));
  }
  weChatMessageView(event: InboxEvent): WeChatMessageView {
    const grant = event.sourceGeneration ? this.localWeChatGrant(event.sourceGeneration) : null;
    const scope = grant ? this.localWeChatScope(grant) : null;
    const payload = event.payload;
    const title = typeof payload.title === 'string' && payload.title !== '微信桌面会话' ? payload.title : scope?.title ?? grant?.title ?? null;
    return { id: event.id, messageId: typeof payload.messageId === 'string' ? payload.messageId : event.externalId,
      content: String(payload.content ?? ''), title,
      sentAt: typeof payload.sentAt === 'string' ? payload.sentAt : null, receivedAt: event.receivedAt,
      senderName: typeof payload.senderName === 'string' ? payload.senderName : null,
      isSelf: typeof payload.isSelf === 'boolean' ? payload.isSelf : null,
      messageType: typeof payload.messageType === 'string' ? payload.messageType : 'text',
      partIndex: typeof payload.partIndex === 'number' ? payload.partIndex : null,
      partCount: typeof payload.partCount === 'number' ? payload.partCount : null };
  }
  localWeChatStatus(id: string): WeChatConversationStatus {
    const { caseId, sourceGenerations } = this.localWeChatGenerations(id);
    const original = this.matchingLocalWeChatGrant(id);
    const grants = this.localWeChatConversationGrants(original).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const current = grants.at(-1)!;
    const scope = this.localWeChatScope(current);
    const recent = this.inbox.queryWeChatEvidence(caseId, sourceGenerations, { limit: 5 }).events.map(event => this.weChatMessageView(event));
    return { conversationId: this.localWeChatConversationId(current), grantId: current.id, caseId,
      title: scope?.title ?? current.title ?? null, chatType: scope?.chatType ?? current.chatType ?? null,
      previousTitles: scope?.previousTitles ?? [],
      transport: current.stoppedAt ? 'stopped' : Date.parse(this.localWeChatExpiry(current)) > Date.now() ? 'collecting' : 'reconnecting',
      coverageStartAt: scope?.coverageStartAt ?? grants[0].createdAt, analysisIntervalMinutes: scope?.analysisIntervalMinutes ?? 10,
      historyUntil: scope?.historyUntil ?? current.historyUntil ?? null, liveSince: current.createdAt,
      ...this.inbox.weChatEvidenceStats(caseId, sourceGenerations), analysis: this.inbox.observationStats(sourceGenerations), recent };
  }
  listWeChatConversations(caseId: string): Omit<WeChatConversationStatus, 'recent'>[] {
    this.assertOpen();
    const conversations = new Map<string, LocalWeChatGrant>();
    for (const grant of this.localWeChatUnrevoked()) {
      if (grant.caseId === caseId && this.localWeChatEligible(grant)) conversations.set(this.localWeChatConversationId(grant), grant);
    }
    return [...conversations.values()].map(grant => {
      const { recent: _recent, ...status } = this.localWeChatStatus(grant.id);
      return status;
    });
  }
  queryWeChatMessages(caseId: string, conversationId: string, options: {
    query?: string; sender?: string; from?: string; until?: string; before?: string; limit: number;
  }) {
    this.assertOpen();
    const grant = this.localWeChatUnrevoked().find(value => value.caseId === caseId && this.localWeChatEligible(value)
      && this.localWeChatConversationId(value) === conversationId);
    if (!grant) throw new RuntimeInputError(404, '当前主题没有这条已授权的微信会话。');
    const { sourceGenerations } = this.localWeChatGenerations(grant.id);
    const result = this.inbox.queryWeChatEvidence(caseId, sourceGenerations, options);
    return { ...result, events: result.events.map(event => this.weChatMessageView(event)) };
  }
  private assertLocalWeChatCapacity(grants: LocalWeChatGrant[], windowId: string, timestamp: number): void {
    const otherLive = grants.filter(grant => grant.windowId !== windowId && !grant.stoppedAt
      && Date.parse(this.localWeChatExpiry(grant)) > timestamp);
    if (otherLive.length >= MAX_WECHAT_OBSERVATIONS_PER_DEVICE) {
      throw new RuntimeInputError(409, `同一台电脑最多同时观察 ${MAX_WECHAT_OBSERVATIONS_PER_DEVICE} 个微信会话。`);
    }
  }
  startLocalWeChatObservation(input: WeChatObservationSelection): WeChatObservationGrant {
    this.assertOpen(); this.assertCase(input.caseId);
    if (input.historyUntil && (!input.historySince || Date.parse(input.historyUntil) < Date.parse(input.historySince))) {
      throw new RuntimeInputError(400, '历史采集结束时间必须晚于或等于起始时间。');
    }
    if (!this.isDeviceActive(input.deviceId)) throw new RuntimeInputError(409, '请先配对并连接这台电脑。');
    const timestamp = Date.now();
    const deviceGrants = this.localWeChatUnrevoked().filter(grant => grant.deviceId === input.deviceId);
    const savedScope = this.localWeChatScope(input);
    const scope = savedScope ?? deviceGrants.find(grant => grant.windowId === input.windowId);
    if (scope?.revokedAt || scope && scope.caseId !== input.caseId) {
      throw new RuntimeInputError(409, '此微信会话授权已撤销或绑定了其他主题，请在本机重新添加。');
    }
    const previous = deviceGrants.find(grant => grant.windowId === input.windowId && !grant.stoppedAt);
    this.assertLocalWeChatCapacity(deviceGrants, input.windowId, timestamp);
    const grant: WeChatObservationGrant = { ...input, id: randomUUID(), createdAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + LOCAL_WECHAT_LEASE).toISOString() };
    this.store.atomic(() => {
      if (previous) this.store.setMeta(this.localWeChatKey(previous.id), { ...previous, stoppedAt: grant.createdAt });
      this.store.setMeta(this.localWeChatScopeKey(input), { ...savedScope, caseId: input.caseId,
        ...(input.title ? { title: input.title } : {}), ...(input.chatType ? { chatType: input.chatType } : {}),
        previousTitles: [...new Set([...(savedScope?.previousTitles ?? []), ...(savedScope?.title && input.title && input.title !== savedScope.title ? [savedScope.title] : [])])].slice(-10),
        ...(input.historyUntil ? { historyUntil: input.historyUntil } : {}),
        coverageStartAt: [savedScope?.coverageStartAt, input.historySince ?? grant.createdAt,
          ...deviceGrants.filter(value => value.windowId === input.windowId).map(value => value.createdAt)]
          .filter((value): value is string => Boolean(value)).sort()[0],
        analysisIntervalMinutes: input.analysisIntervalMinutes ?? savedScope?.analysisIntervalMinutes ?? 10 } satisfies LocalWeChatScope);
      this.store.setMeta(this.localWeChatKey(grant.id), grant);
      this.store.setMeta(LOCAL_WECHAT_INDEX, [...this.localWeChatIndex(), grant.id]);
    });
    this.inbox.setObservationInterval(this.sourceId(grant.id), grant.id, grant.caseId, input.analysisIntervalMinutes ?? savedScope?.analysisIntervalMinutes ?? 10);
    return grant;
  }
  renewLocalWeChatObservation(id: string, input: WeChatObservationSelection): WeChatObservationGrant {
    this.assertOpen();
    const grant = this.matchingLocalWeChatGrant(id, input);
    if (grant.caseId !== input.caseId) throw new RuntimeInputError(404, '找不到这次微信观察授权。');
    const deviceGrants = this.localWeChatUnrevoked().filter(candidate => candidate.deviceId === grant.deviceId);
    const current = deviceGrants.find(candidate => candidate.windowId === grant.windowId && !candidate.stoppedAt);
    const scope = this.localWeChatScope(grant) ?? deviceGrants.find(candidate => candidate.windowId === grant.windowId);
    if (current?.id !== grant.id || !this.localWeChatEligible(grant) || scope?.revokedAt || scope?.caseId !== grant.caseId) {
      throw new RuntimeInputError(409, '微信观察授权已停止或撤销，请在本机检查已保存的范围。');
    }
    const previousScope = this.localWeChatScope(grant);
    if (input.title || input.chatType || input.analysisIntervalMinutes) {
      this.store.atomic(() => {
        this.store.setMeta(this.localWeChatScopeKey(grant), { ...previousScope, caseId: grant.caseId,
          ...(input.title ? { title: input.title } : {}), ...(input.chatType ? { chatType: input.chatType } : {}),
          previousTitles: [...new Set([...(previousScope?.previousTitles ?? []),
            ...(previousScope?.title && input.title && previousScope.title !== input.title ? [previousScope.title] : [])])].slice(-10),
          ...(input.analysisIntervalMinutes ? { analysisIntervalMinutes: input.analysisIntervalMinutes } : {}) } satisfies LocalWeChatScope);
        if (input.title) this.store.setMeta(this.localWeChatKey(grant.id), { ...grant, title: input.title });
      });
      for (const source of deviceGrants.filter(value => value.windowId === grant.windowId && value.caseId === grant.caseId)) {
        this.inbox.setObservationInterval(this.sourceId(source.id), source.id, source.caseId,
          input.analysisIntervalMinutes ?? previousScope?.analysisIntervalMinutes ?? 10);
      }
    }
    const view = this.localWeChatView(input.title ? { ...grant, title: input.title } : grant);
    const timestamp = Date.now();
    if (Date.parse(view.expiresAt) > timestamp) return view;
    this.assertLocalWeChatCapacity(deviceGrants, grant.windowId, timestamp);
    const expiresAt = new Date(timestamp + LOCAL_WECHAT_LEASE).toISOString();
    this.inbox.ingestBatch([], { sourceId: this.sourceId(grant.id), sourceGeneration: grant.id, value: { expiresAt } });
    return { ...view, expiresAt };
  }
  private matchingLocalWeChatGrant(id: string, binding?: { deviceId: string; windowId: string }): LocalWeChatGrant {
    const grant = this.localWeChatGrant(id);
    if (!grant || binding && (grant.deviceId !== binding.deviceId || grant.windowId !== binding.windowId)) {
      throw new RuntimeInputError(404, '找不到这次微信观察授权。');
    }
    return grant;
  }
  private revokeLocalWeChatGrants(grants: LocalWeChatGrant[]): void {
    if (!grants.length) return;
    const revokedAt = new Date().toISOString();
    const retired = new Set(grants.map(grant => grant.id));
    const scopes = new Set(grants.map(grant => this.localWeChatScopeKey(grant)));
    const transports = this.localWeChatUnrevoked().filter(grant => !grant.stoppedAt && !retired.has(grant.id) && scopes.has(this.localWeChatScopeKey(grant)));
    this.store.atomic(() => {
      for (const grant of grants) {
        const scope = this.localWeChatScope(grant);
        if (!scope?.revokedAt) this.store.setMeta(this.localWeChatScopeKey(grant), { caseId: scope?.caseId ?? grant.caseId, revokedAt } satisfies LocalWeChatScope);
        if (!grant.revokedAt) this.store.setMeta(this.localWeChatKey(grant.id), { ...grant, revokedAt });
      }
      for (const grant of transports) this.store.setMeta(this.localWeChatKey(grant.id), { ...grant, stoppedAt: revokedAt });
      this.store.setMeta(LOCAL_WECHAT_INDEX, this.localWeChatIndex().filter(id => !retired.has(id)));
    });
  }
  revokeLocalWeChatObservation(id: string): WeChatObservationGrant {
    this.assertOpen();
    const grant = this.matchingLocalWeChatGrant(id);
    if (!grant.revokedAt || !this.localWeChatScope(grant)?.revokedAt) this.revokeLocalWeChatGrants([grant]);
    return grant;
  }
  stopLocalWeChatObservation(deviceId: string, input: WeChatObservationBinding): { id: string; stopped: true } {
    this.assertOpen();
    const grant = this.matchingLocalWeChatGrant(input.grantId, { deviceId, windowId: input.windowId });
    if (!grant.stoppedAt && !grant.revokedAt) this.store.setMeta(this.localWeChatKey(grant.id), { ...grant, stoppedAt: new Date().toISOString() });
    return { id: grant.id, stopped: true };
  }
  revokeLocalWeChatObservations(scope: { caseId: string } | { deviceId: string }): WeChatObservationGrant[] {
    this.assertActive();
    const grants = this.localWeChatUnrevoked().filter(grant => 'caseId' in scope ? grant.caseId === scope.caseId : grant.deviceId === scope.deviceId);
    this.revokeLocalWeChatGrants(grants);
    return grants;
  }
  private validateLocalWeChatObservation(deviceId: string, input: WeChatObservationBinding): WeChatObservationGrant {
    this.assertOpen();
    const grant = this.matchingLocalWeChatGrant(input.grantId, { deviceId, windowId: input.windowId });
    const view = this.localWeChatView(grant);
    const scope = this.localWeChatScope(grant);
    const leaseIsLive = Date.parse(view.expiresAt) > Date.now();
    if (grant.stoppedAt || !leaseIsLive || !this.localWeChatEligible(grant) || scope?.revokedAt || scope && scope.caseId !== grant.caseId) {
      throw new RuntimeInputError(409, '微信观察授权已停止或过期，请重新确认。');
    }
    return view;
  }
  ingestLocalWeChatObservation(deviceId: string, input: WeChatObservationBatch): WeChatObservationReceipt {
    const grant = this.validateLocalWeChatObservation(deviceId, input);
    const sourceId = this.sourceId(grant.id);
    const timestamp = Date.now();
    const occurredAt = new Date(timestamp).toISOString();
    const expiresAt = new Date(timestamp + LOCAL_WECHAT_LEASE).toISOString();
    const scope = this.localWeChatScope(grant);
    const generations = this.localWeChatConversationGrants(grant).map(value => value.id);
    const existing = this.inbox.existingWeChatExternalIds(grant.caseId, generations, input.rows.map(row => row.id));
    const rows = input.rows.filter(row => !existing.has(row.id));
    const result = this.inbox.ingestBatch(rows.map(({ id, text, sentAt, ...metadata }) => ({
      sourceId, sourceGeneration: grant.id, caseId: grant.caseId, externalId: id,
      kind: 'connector.change', actor: 'external' as const, operation: 'create' as const, occurredAt,
      payload: { provider: 'wechat-desktop', title: scope?.title ?? grant.title ?? '微信桌面会话', content: text,
        ...metadata, ...(sentAt ? { sentAt: new Date(sentAt).toISOString() } : {}) },
    })), { sourceId, sourceGeneration: grant.id, value: { expiresAt } });
    const duplicates = input.rows.length - rows.length + result.duplicates;
    const accepted = input.rows.length - duplicates;
    if (accepted) this.onChanges();
    return { accepted, duplicates };
  }
  private checkpoint(connection: Connection): Checkpoint | null {
    const saved = this.inbox.getCheckpoint<Checkpoint & { ewsNeedsAttention?: boolean }>(this.sourceId(connection.id), null, connection.id);
    if (!saved) return null;
    // Read the retired EWS-only marker without maintaining a second writable state.
    const { ewsNeedsAttention, ...checkpoint } = saved;
    if (ewsNeedsAttention) checkpoint.needsAttention = true;
    if (!checkpoint || connection.kind !== 'tencent-docs') return checkpoint;
    const savedInterval = checkpoint.pollIntervalMs ?? POLL_INTERVAL;
    if (savedInterval === TENCENT_DOCS_POLL_INTERVAL) return checkpoint;
    // Legacy due times were measured from the last attempt, including failures.
    return { ...checkpoint, nextAt: checkpoint.nextAt - savedInterval + TENCENT_DOCS_POLL_INTERVAL };
  }
  private credential(id: string): SecretStore {
    const cached = this.credentials.get(id);
    if (cached) return cached;
    const secret = new SecretStore(this.directory, id + '.json');
    this.credentials.set(id, secret);
    return secret;
  }
  private savedOAuthApp(kind: OAuthAppKind): { clientId: string; clientSecret: string; revision: number } | undefined {
    const raw = this.credential('oauth-app-' + kind).get();
    if (!raw) return;
    const saved = JSON.parse(raw) as { clientId: string; clientSecret: string; revision: number };
    const parsed = oauthAppInputSchema.parse({ clientId: saved.clientId, clientSecret: saved.clientSecret, expectedRevision: saved.revision });
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, revision: parsed.expectedRevision };
  }
  private oauthAppProvider(kind: OAuthAppKind, app: { clientId: string; clientSecret: string }): ConnectorProvider {
    const provider = kind === 'gmail'
      ? createGmailProvider({ RAE_GMAIL_CLIENT_ID: app.clientId, RAE_GMAIL_CLIENT_SECRET: app.clientSecret })
      : createOutlookProvider({ RAE_OUTLOOK_CLIENT_ID: app.clientId, RAE_OUTLOOK_CLIENT_SECRET: app.clientSecret });
    if (!provider) throw new RuntimeInputError(409, '应用配置不完整。');
    return provider;
  }
  private oauthAppSetup(kind: OAuthAppKind): OAuthAppSetup {
    if (this.environmentOAuthKinds.has(kind)) return { source: 'environment', revision: 0 };
    const saved = this.savedOAuthApp(kind);
    return saved ? { source: 'saved', clientId: saved.clientId, revision: saved.revision } : { source: 'none', revision: 0 };
  }
  async saveOAuthApp(kind: OAuthAppKind, raw: OAuthAppInput): Promise<ConnectorDirectory> {
    this.assertOpen();
    const input = oauthAppInputSchema.parse(raw);
    if (this.environmentOAuthKinds.has(kind)) throw new RuntimeInputError(409, '此应用由部署环境配置，请由维护者在原配置中更新。');
    const key = 'oauth-app-' + kind;
    if (this.credentialUpdates.has(key)) throw new RuntimeInputError(409, '应用配置正在更新。');
    this.credentialUpdates.add(key);
    try {
      for (const [state, pending] of this.authorizations) if (pending.kind === kind) this.authorizations.delete(state);
      const active = [...this.caseOperations].filter(([, use]) => use.connectionId
        && this.connections().some(connection => connection.id === use.connectionId && connection.kind === kind));
      for (const [controller] of active) controller.abort();
      await Promise.allSettled(active.map(([, use]) => use.work));
      this.assertOpen();
      const secret = this.credential(key);
      const revision = this.savedOAuthApp(kind)?.revision ?? 0;
      if (input.expectedRevision !== revision) throw new RuntimeInputError(409, '应用配置已变化，请刷新后重试。');
      const next = { clientId: input.clientId, clientSecret: input.clientSecret, revision: revision + 1 };
      const provider = this.oauthAppProvider(kind, next);
      secret.set(JSON.stringify(next));
      this.providers[kind] = provider;
      return this.list();
    } finally { this.credentialUpdates.delete(key); }
  }
  private savedTencentDocsToken(id: string): string | undefined {
    try { return tencentDocsAccessToken(this.credential(TENCENT_DOCS_SECRET_PREFIX + id).get()); }
    catch { return undefined; }
  }
  private hasTencentDocsCredential(id: string | undefined): boolean {
    return id !== undefined && this.tencentDocsCredentials().some(credential => credential.id === id);
  }
  private requireTencentDocsToken(id: string | undefined): string {
    const token = id && this.hasTencentDocsCredential(id) ? this.savedTencentDocsToken(id) : undefined;
    if (!token) throw new ConnectorProviderError(TENCENT_DOCS_CREDENTIAL_UNAVAILABLE, 409);
    return token;
  }
  private provider(kind: ConnectorKind): ConnectorProvider {
    const provider = this.providers[kind];
    if (!provider) throw new RuntimeInputError(409, '此平台尚未配置登录应用。');
    return provider;
  }
  private assertOpen(): void {
    this.assertActive();
    if (this.shutdown.signal.aborted) throw new RuntimeInputError(409, '连接器服务正在关闭。');
  }
  private assertCase(caseId: string): void {
    if (!this.canObserve(caseId)) throw new RuntimeInputError(409, '请选择有效的观察主题。');
  }
  private assertCapacity(): void {
    if (this.connections().length >= MAX_CONNECTIONS) throw new RuntimeInputError(409, '已达到连接数上限，请先断开不用的连接。');
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.operations.delete(tracked));
    this.operations.add(tracked);
    return tracked;
  }
  private runForCase<T>(caseId: string, work: (signal: AbortSignal) => Promise<T>,
    use: ConnectionUse = {}, timeoutMs: number | null = REQUEST_LIMIT): Promise<T> {
    const controller = new AbortController();
    const operation = this.track(Promise.resolve().then(() => {
      const signal = AbortSignal.any([controller.signal, this.shutdown.signal,
        ...(timeoutMs === null ? [] : [AbortSignal.timeout(timeoutMs)])]);
      signal.throwIfAborted(); this.assertOpen(); if (!use.accountOperation) this.assertCase(caseId);
      return work(signal);
    }).finally(() => this.caseOperations.delete(controller)));
    this.caseOperations.set(controller, { caseId, work: operation, ...use });
    return operation;
  }
  async drainCase(caseId: string): Promise<void> {
    for (const [state, authorization] of this.authorizations) {
      if (authorization.caseId === caseId) this.authorizations.delete(state);
    }
    const operations = [...this.caseOperations].filter(([, value]) => value.caseId === caseId);
    for (const [controller] of operations) controller.abort();
    await Promise.allSettled(operations.map(([, value]) => value.work));
  }
  private view(connection: Connection): ConnectorConnection {
    const checkpoint = this.checkpoint(connection);
    const error = !this.providers[connection.kind]
      ? '此平台的登录应用配置已移除。'
      : connection.github?.kind !== 'account' && !this.canObserve(connection.caseId) ? '观察主题已停用。'
      : connection.kind === 'tencent-docs' && !this.hasTencentDocsCredential(connection.credentialId)
        ? TENCENT_DOCS_CREDENTIAL_UNAVAILABLE : checkpoint?.error;
    return { id: connection.id, kind: connection.kind, caseId: connection.caseId, scope: connection.scope, connectedAt: connection.connectedAt,
      lastSyncedAt: checkpoint?.lastSyncedAt ?? null, status: error ? 'error' : 'watching',
      ...(checkpoint?.needsAttention ? { needsAttention: true } : {}),
      ...(connection.kind !== 'github' && checkpoint && Number.isFinite(checkpoint.nextAt) && !checkpoint.needsAttention ? { nextSyncAt: new Date(checkpoint.nextAt).toISOString() } : {}),
      ...(connection.kind === 'ews' ? { ews: this.ewsDetails(connection) } : {}),
      ...(connection.kind === 'github' && connection.github ? { github: connection.github } : {}),
      ...(connection.credentialId ? { credentialId: connection.credentialId } : {}),
      ...(checkpoint?.document ? { document: checkpoint.document } : {}),
      ...(error || checkpoint?.notice ? { message: error || checkpoint?.notice } : {}) };
  }
  list(): ConnectorDirectory {
    return {
      providers: connectorKinds.map(kind => {
        const provider = this.providers[kind];
        return { kind, configured: Boolean(provider), authorization: kind === 'tencent-docs' || kind === 'github' ? 'token' : kind === 'ews' ? 'credentials' : 'oauth',
          ...(kind === 'gmail' || kind === 'outlook' ? { setup: this.oauthAppSetup(kind) } : {}),
          ...(provider?.tokenGrantUrl ? { grantUrl: provider.tokenGrantUrl } : {}) };
      }),
      connections: this.connections().map(connection => this.view(connection)),
      tencentDocsCredentials: this.tencentDocsCredentials(),
    };
  }

  private ewsDetails(connection: Connection) {
    const raw = this.credential(connection.id).get();
    if (!raw) return undefined;
    const saved = ewsStoredCredentials.parse((JSON.parse(raw) as ConnectorToken).ews);
    const checkpoint = this.checkpoint(connection);
    const cursor = checkpoint && ewsCursor.parse(JSON.parse(checkpoint.cursor));
    return { endpoint: saved.endpoint, hasCertificate: Boolean(saved.certificate), credentialRevision: saved.revision,
      observingSince: cursor?.since ?? connection.connectedAt, establishingBaseline: cursor?.catchup ?? true };
  }

  connectGitHub(raw: GitHubConnectInput): Promise<ConnectorConnection> {
    this.assertOpen();
    const input = githubConnectInputSchema.parse(raw);
    this.assertCapacity();
    const provider = this.provider('github');
    const caseId = input.caseId ?? 'personal-growth';
    return this.runForCase(caseId, async signal => {
      const token = { accessToken: input.token };
      const account = await this.inspectGitHubAccount(token, signal);
      signal.throwIfAborted(); this.assertOpen();
      return this.activate('github', { caseId, scope: 'account', redirectUri: '', github: {
        kind: 'account', accountId: account.id, login: account.login, credentialRevision: 1,
      } }, token, provider, signal);
    }, { accountOperation: true }, 90_000);
  }

  async updateGitHub(id: string, raw: GitHubUpdateInput): Promise<ConnectorConnection> {
    const input = githubUpdateInputSchema.parse(raw);
    return this.replaceGitHubAccount(id, input.expectedRevision, input.token);
  }
  async upgradeGitHub(id: string, raw: GitHubUpgradeInput): Promise<ConnectorConnection> {
    const input = githubUpgradeInputSchema.parse(raw);
    return this.replaceGitHubAccount(id, input.expectedRevision);
  }
  private async replaceGitHubAccount(id: string, expectedRevision: number, replacementToken?: string): Promise<ConnectorConnection> {
    this.assertOpen();
    const connection = this.connections().find(value => value.kind === 'github' && value.id === id);
    if (!connection) throw new RuntimeInputError(404, 'GitHub 连接不存在。');
    if (this.credentialUpdates.has(id)) throw new RuntimeInputError(409, '连接凭据正在更新。');
    this.credentialUpdates.add(id);
    try {
      const active = [...this.caseOperations].filter(([, use]) => use.connectionId === id);
      for (const [controller] of active) controller.abort();
      await Promise.allSettled(active.map(([, use]) => use.work));
      return await this.runForCase(connection.caseId, async signal => {
        if (!this.connections().some(value => value.id === id)) throw new RuntimeInputError(409, '此连接已断开。');
        const previousRevision = connection.github?.credentialRevision ?? 1;
        if (previousRevision !== expectedRevision) throw new RuntimeInputError(409, '连接凭据已变化，请刷新后重试。');
        const secret = this.credential(id); const original = secret.get();
        if (!original) throw new RuntimeInputError(409, '原 GitHub 凭据不可用，请重新连接账号。');
        const previousToken = JSON.parse(original) as ConnectorToken;
        const previousAccountId = connection.github?.kind === 'account' ? connection.github.accountId
          : (await this.inspectGitHubAccount(previousToken, signal)).id;
        const token = replacementToken ? { accessToken: replacementToken } : previousToken;
        const account = await this.inspectGitHubAccount(token, signal);
        signal.throwIfAborted(); this.assertOpen();
        const current = this.connections().find(value => value.id === id);
        if (!current || (current.github?.credentialRevision ?? 1) !== previousRevision) throw new RuntimeInputError(409, '连接凭据已变化。');
        const checkpoint = this.checkpoint(current);
        if (previousAccountId !== account.id) throw new RuntimeInputError(409, '新令牌属于另一个 GitHub 账号，请以新连接添加该账号。');
        const details: GitHubConnectionDetails = { kind: 'account', accountId: account.id, login: account.login, credentialRevision: previousRevision + 1 };
        const event = this.githubAccountGrant({ ...current, github: details }, checkpoint ?? undefined);
        details.grantEventId = event.id;
        const next: Connection = { ...current, scope: 'account', github: details };
        secret.set(JSON.stringify(token));
        try { this.store.setMeta(RECORDS, this.connections().map(value => value.id === id ? next : value)); }
        catch (error) { secret.set(original); throw error; }
        this.inbox.ingestBatch([], { sourceId: this.sourceId(id), sourceGeneration: id,
          value: { cursor: JSON.stringify({ version: 3, accountId: account.id, login: account.login, at: Date.now() }),
            lastSyncedAt: checkpoint?.lastSyncedAt ?? new Date().toISOString(), nextAt: Date.now() } satisfies Checkpoint });
        return this.view(next);
      }, { connectionId: id, accountOperation: true }, 90_000);
    } finally { this.credentialUpdates.delete(id); }
  }
  private githubAccountGrant(connection: Connection, previousCheckpoint?: Checkpoint) {
    if (connection.github?.kind !== 'account') throw new RuntimeInputError(409, 'GitHub 账号身份未核验。');
    const previous = this.connections().find(value => value.id === connection.id);
    return this.inbox.ingestProcessed({ sourceId: 'owner-ui', externalId: randomUUID(), kind: 'owner.github_account_access', actor: 'owner',
      operation: 'create', caseId: connection.caseId, occurredAt: new Date().toISOString(), payload: {
        connectionId: connection.id, accountId: connection.github.accountId, credentialRevision: connection.github.credentialRevision,
        accessAllRepositories: true, ...(previous ? { previousScope: previous.scope, previousGrant: previous.github, previousCheckpoint } : {}),
      } });
  }

  private github(): GitHubOperations {
    return this.githubOperations ??= new GitHubOperations({
      store: this.store,
      select: (id, caseId) => {
        this.assertOpen();
        const connection = this.connections().find(value => value.id === id && value.kind === 'github'
          && (value.github?.kind === 'account' || caseId === undefined || value.caseId === caseId));
        if (!connection || !this.current(connection)) throw new RuntimeInputError(409, '当前场景的 GitHub 连接已不可用。');
        if (caseId) this.assertCase(caseId);
        if (this.credentialUpdates.has(id)) throw new RuntimeInputError(409, 'GitHub 凭据正在更新。');
        if (!connection.github) throw new RuntimeInputError(409, '请先在原 GitHub 连接中更新令牌与访问范围。');
        const saved = this.credential(id).get();
        if (!saved) throw new RuntimeInputError(409, 'GitHub 凭据不可用，请更新令牌。');
        const token = JSON.parse(saved) as ConnectorToken;
        if (!token.accessToken) throw new RuntimeInputError(409, 'GitHub 凭据不可用。');
        if (connection.github.kind === 'account') {
          if (!this.validGitHubAccountGrant(connection)) throw new RuntimeInputError(409, '请确认 GitHub 账号级授权。');
          return { connectionId: id, caseId: caseId ?? connection.caseId, ...connection.github, token };
        }
        return { connectionId: id, caseId: connection.caseId, repository: connection.scope, ...connection.github, token };
      },
      run: (caseId, connectionId, work, timeoutMs) => this.runForCase(caseId, work, { connectionId }, timeoutMs),
      assertOwner: (caseId, eventId) => { this.ownerMailSource(caseId, eventId); },
      assertReadSource: (caseId, eventId) => { this.connectorReadSource(caseId, eventId); },
      assertActive: () => this.assertActive(),
      inspect: this.inspectGitHub,
    });
  }
  private validGitHubAccountGrant(connection: Connection): boolean {
    const details = connection.github;
    if (details?.kind !== 'account' || !details.grantEventId) return false;
    const event = this.inbox.get(details.grantEventId);
    return Boolean(event?.actor === 'owner' && event.kind === 'owner.github_account_access' && event.payload.accessAllRepositories === true
      && event.payload.connectionId === connection.id && event.payload.accountId === details.accountId
      && event.payload.credentialRevision === details.credentialRevision);
  }
  canReadGitHubConnection(caseId: string, id: string, snapshot?: { repositoryId?: number; accountId?: number; credentialRevision: number }): boolean {
    if (this.shutdown.signal.aborted || this.credentialUpdates.has(id) || !this.canObserve(caseId)) return false;
    const connection = this.connections().find(value => value.kind === 'github' && value.id === id && this.current(value)
      && (value.github?.kind === 'account' || value.caseId === caseId));
    const details = connection?.github;
    if (!connection || !details) return false;
    if (details.kind === 'account') return this.validGitHubAccountGrant(connection) && (!snapshot
      || snapshot.accountId === details.accountId && snapshot.credentialRevision === details.credentialRevision);
    return !snapshot || snapshot.accountId === undefined && details.repositoryId === snapshot.repositoryId && details.credentialRevision === snapshot.credentialRevision;
  }
  prepareGitHubTaskScope(caseId: string, input: GitHubTaskRequest, ownerEventId?: string) {
    return this.github().prepareScope(caseId, input, ownerEventId);
  }
  assertGitHubTaskScope(task: TaskRecord) { return this.github().assertTaskScope(task); }
  withGitHubTaskTools<T>(task: TaskRecord, input: { signal: AbortSignal; guard(): void }, work: (tools: ToolsInput) => Promise<T>) {
    return this.github().withTaskTools(task, input, work);
  }
  verifyGitHubTaskDelivery(task: TaskRecord) { this.github().verifyDelivery(task); }
  githubTaskReceipts(taskId: string) { return this.github().receipts(taskId); }
  async readGitHubTool(caseId: string, sourceEventId: string, input: { connectionId: string; tool: string; input: Record<string, unknown> }, signal: AbortSignal, guard: () => void) {
    const connection = this.connections().find(value => value.id === input.connectionId && value.kind === 'github');
    if (!connection?.github || !this.canReadGitHubConnection(caseId, connection.id)) throw new RuntimeInputError(409, 'GitHub 连接已不可用。');
    const snapshot = connection.github.kind === 'account'
      ? { accountId: connection.github.accountId, credentialRevision: connection.github.credentialRevision }
      : { repositoryId: connection.github.repositoryId, credentialRevision: connection.github.credentialRevision };
    const received = await this.github().read(caseId, sourceEventId, input, signal, guard);
    const result = received.result;
    guard(); signal.throwIfAborted(); this.connectorReadSource(caseId, sourceEventId);
    if (!this.canReadGitHubConnection(caseId, connection.id, snapshot)) throw new RuntimeInputError(409, '查询期间 GitHub 授权已变化。');
    const evidence = this.inbox.ingestProcessed({ sourceId: this.sourceId(connection.id), sourceGeneration: connection.id,
      kind: 'connector.github_read', actor: 'external', operation: 'create', caseId, externalId: randomUUID(),
      occurredAt: new Date().toISOString(), causationId: sourceEventId,
      payload: { provider: 'github', connectionId: connection.id, ...snapshot,
        ...(received.repositoryId ? { repositoryId: received.repositoryId } : {}), tool: input.tool, result } });
    return { connectionId: connection.id, ...snapshot, ...(received.repositoryId ? { repositoryId: received.repositoryId } : {}), evidenceId: evidence.id, result };
  }

  listEwsMailboxes(caseId: string) {
    this.assertOpen();
    return this.connections().filter(item => item.kind === 'ews' && item.caseId === caseId && this.canObserve(caseId))
      .flatMap(item => { const details = this.ewsDetails(item); return details ? [{ connectionId: item.id, scope: 'inbox' as const, endpoint: details.endpoint, credentialRevision: details.credentialRevision }] : []; });
  }

  canReadEwsMailbox(caseId: string, connectionId: string): boolean {
    return !this.shutdown.signal.aborted && Boolean(this.providers.ews) && this.connections().some(item => item.id === connectionId
      && item.kind === 'ews' && item.caseId === caseId && item.scope === 'inbox' && this.canObserve(caseId));
  }

  private ownerMailSource(caseId: string, eventId: string) {
    const event = this.inbox.get(eventId);
    const message = event && this.store.get('messages', event.externalId);
    if (!isOwnerChatEvent(event) || event!.caseId !== caseId || event!.status !== 'leased' || !event!.leaseUntil || Date.parse(event!.leaseUntil) <= Date.now()
      || message?.role !== 'user' || message.caseId !== caseId || message.content !== event!.payload.content) {
      throw new RuntimeInputError(409, '连接器查询只接受本人当前明确的请求，历史消息和外部资料不能授权。');
    }
    return eventId;
  }
  private connectorReadSource(caseId: string, eventId: string): 'owner-chat' | 'source-review' | 'approved-task' {
    const event = this.inbox.get(eventId);
    if (isOwnerChatEvent(event)) { this.ownerMailSource(caseId, eventId); return 'owner-chat'; }
    if (event?.kind === 'growth.observation' && event.actor === 'system' && event.caseId === caseId
      && event.status === 'leased' && event.leaseUntil && Date.parse(event.leaseUntil) > Date.now()
      && this.researchSourceAllowed?.(event)) return 'source-review';
    if (event?.kind === 'task.execute' && event.caseId === caseId && this.taskSourceAllowed?.(event)) return 'approved-task';
    throw new RuntimeInputError(409, '连接器查询只接受本人当前明确的请求或仍有效的授权资料回顾，历史消息和外部指令不能授权。');
  }

  private ewsQueryConnection(id: string, caseId?: string) {
    this.assertOpen();
    const connection = this.connections().find(item => item.id === id && item.kind === 'ews' && (caseId === undefined || item.caseId === caseId));
    if (!connection) throw new RuntimeInputError(404, '当前场景没有这份 EWS 邮箱连接。');
    this.assertCase(connection.caseId);
    if (this.credentialUpdates.has(id)) throw new RuntimeInputError(409, '邮箱凭据正在更新，请稍后查询。');
    const raw = this.credential(id).get();
    if (!raw) throw new RuntimeInputError(409, '邮箱凭据不可用，请重新连接。');
    const token = JSON.parse(raw) as ConnectorToken;
    const credentials = ewsStoredCredentials.parse(token.ews);
    const checkpoint = this.checkpoint(connection);
    if (!checkpoint) throw new RuntimeInputError(409, '邮箱缺少收件箱信息，请重新连接。');
    const cursor = ewsCursor.parse(JSON.parse(checkpoint.cursor));
    return { connection, token, folderId: cursor.folderId, revision: credentials.revision };
  }

  queryEwsMessages(id: string, input: EwsQueryInput): Promise<EwsMessagePage> {
    return this.queryEwsMessagesInternal(id, ewsQueryInput.parse(input));
  }

  private mail(): EwsMail {
    return this.ewsMailService ??= new EwsMail({ store: this.store, inbox: this.inbox, directory: dirname(this.directory), transport: this.ewsTransport,
      select: (id, caseId) => { const selected = this.ewsQueryConnection(id, caseId); return { id, caseId: selected.connection.caseId,
        folderId: selected.folderId, revision: selected.revision, token: selected.token }; },
      assertSelection: (id, input, owner) => { this.assertEwsQuerySelection(id, input,
        owner ? { caseId: owner.caseId, eventId: owner.ownerEventId, signal: owner.signal } : undefined); },
      assertOwner: (caseId, eventId) => { this.ownerMailSource(caseId, eventId); },
      allowedEvidence: eventId => { const event = this.inbox.get(eventId); return Boolean(event && this.isEventAllowed(event)); },
      run: (selection, work, timeoutMs) => this.runForCase(selection.caseId, work, { connectionId: selection.id }, timeoutMs),
      changed: () => this.onChanges(), tasks: () => this.mailTasks() });
  }
  setMailTaskReader(read: () => readonly TaskRecord[]): void { this.mailTasks = read; }
  getEwsMessageContext(id: string, input: EwsSelectionInput) { return this.mail().context(id, ewsSelectionInput.parse(input)); }
  getEwsMessageContextForOwner(caseId: string, ownerEventId: string,
    input: { connectionId: string; messageId: string; queryId: string }, signal: AbortSignal) {
    this.ownerMailSource(caseId, ownerEventId);
    const { connectionId, ...selection } = input;
    return this.mail().context(connectionId, ewsSelectionInput.parse({ ...selection, readExistingInbox: true }), { caseId, ownerEventId, signal });
  }
  listEwsMessageAttachments(id: string, input: EwsSelectionInput) { return this.mail().attachments(id, ewsSelectionInput.parse(input)); }
  downloadEwsAttachment(id: string, input: EwsSelectionInput & { attachmentId: string }) { return this.mail().download(id, input); }
  uploadEwsMailAttachment(id: string, input: { name: string; contentType: string; bytes: Buffer }) { return this.mail().upload(id, input); }
  copyEwsMailAttachment(id: string, input: EwsSelectionInput & { attachmentId: string; allowProtectedSourcePlaintext?: true }) { return this.mail().uploadFromMessage(id, input); }
  removeEwsMailAttachment(id: string, uploadId: string) { this.mail().removeUpload(id, uploadId); }
  prepareMailTaskScope(caseId: string, input: MailTaskSpec, ownerEventId?: string) { return this.mail().prepareScope(caseId, input, ownerEventId); }
  assertEwsMailTaskScope(task: TaskRecord) { this.mail().validateTask(task); }
  getEwsMailTaskContext(task: TaskRecord) { return this.mail().taskContext(task); }
  operationForMailTask(taskId: string) { return this.mail().operationForTask(taskId); }
  executeEwsMailTask(task: TaskRecord, execution: { body?: string; signal: AbortSignal; guard(): void }) { return this.mail().execute(task, execution); }
  needsEwsSubmissionReceipt(task: TaskRecord) { return this.mail().needsSubmissionReceipt(task); }
  reconcileEwsSubmissionReceipt(task: TaskRecord, execution: { signal: AbortSignal; guard(): void }) { return this.mail().reconcileSubmissionReceipt(task, execution); }
  queryEwsMessagesForEvent(caseId: string, eventId: string,
    input: { connectionId: string; subject?: string; offset?: number; limit?: number }, signal: AbortSignal): Promise<EwsMessagePage> {
    this.connectorReadSource(caseId, eventId);
    this.ewsQueryConnection(input.connectionId, caseId);
    const { connectionId, ...selection } = input;
    return this.queryEwsMessagesInternal(connectionId, ewsQueryInput.parse({ ...selection,
      readExistingInbox: true }), { caseId, eventId, signal });
  }

  private queryEwsMessagesInternal(id: string, input: EwsQueryInput,
    request?: { caseId: string; eventId: string; signal: AbortSignal }): Promise<EwsMessagePage> {
    const selected = this.ewsQueryConnection(id, request?.caseId);
    const source = request ? this.connectorReadSource(request.caseId, request.eventId) : 'owner-ui';
    return this.runForCase(selected.connection.caseId, async operationSignal => {
      const signal = request ? AbortSignal.any([operationSignal, request.signal]) : operationSignal;
      signal.throwIfAborted(); if (request) this.connectorReadSource(request.caseId, request.eventId);
      if (!this.current(selected.connection)) throw new RuntimeInputError(409, '邮箱连接已停用。');
      const access = this.inbox.ingestProcessed({ sourceId: source, externalId: randomUUID(),
        kind: source === 'approved-task' ? 'connector.task_access' : source === 'source-review' ? 'connector.research_access' : 'owner.mail_access',
        actor: source === 'source-review' || source === 'approved-task' ? 'agent' : 'owner', operation: 'create', caseId: selected.connection.caseId, occurredAt: new Date().toISOString(),
        ...(request ? { causationId: request.eventId } : {}), payload: { connectionId: id, folderId: selected.folderId,
          operation: 'query', input, credentialRevision: selected.revision } });
      const page = await queryEwsInbox(selected.token, selected.folderId, input, signal, this.ewsTransport);
      signal.throwIfAborted(); this.assertOpen(); if (request) this.connectorReadSource(request.caseId, request.eventId);
      const current = this.ewsQueryConnection(id, request?.caseId);
      if (!this.current(selected.connection) || current.revision !== selected.revision || current.folderId !== selected.folderId) throw new RuntimeInputError(409, '邮箱授权已变化，请重新查询。');
      const receipt = this.inbox.ingestProcessed({ sourceId: this.sourceId(id), sourceGeneration: id, externalId: randomUUID(),
        kind: 'connector.mail_query', actor: 'external', operation: 'create', caseId: selected.connection.caseId,
        occurredAt: new Date().toISOString(), causationId: access.id, payload: { provider: 'ews', connectionId: id,
          folderId: selected.folderId, credentialRevision: selected.revision,
          ownerEventId: source === 'owner-chat' ? request!.eventId : null,
          ...(source === 'source-review' ? { reviewEventId: request!.eventId } : {}),
          ...(source === 'approved-task' ? { taskEventId: request!.eventId } : {}),
          accessSource: source, ...page } });
      return { ...page, queryId: receipt.id };
    }, { connectionId: id });
  }

  readEwsMessage(id: string, input: EwsReadInput): Promise<EwsMessageReadPage> {
    return this.readEwsMessageInternal(id, ewsReadInput.parse(input));
  }
  readEwsMessageForEvent(caseId: string, eventId: string,
    input: { connectionId: string; messageId: string; queryId: string; offset?: number; limit?: number }, signal: AbortSignal): Promise<EwsMessageReadPage> {
    this.connectorReadSource(caseId, eventId); this.ewsQueryConnection(input.connectionId, caseId);
    const { connectionId, ...selection } = input;
    return this.readEwsMessageInternal(connectionId, ewsReadInput.parse({ ...selection, readExistingInbox: true }), { caseId, eventId, signal });
  }

  private assertEwsQuerySelection(id: string, input: EwsSelectionInput,
    request?: { caseId: string; eventId: string; signal: AbortSignal }): void {
    const selected = this.ewsQueryConnection(id, request?.caseId);
    const source = request ? this.connectorReadSource(request.caseId, request.eventId) : 'owner-ui';
    const query = this.inbox.get(input.queryId);
    const messages = query?.payload.messages;
    const access = query?.causationId ? this.inbox.get(query.causationId) : undefined;
    if (!query || query.kind !== 'connector.mail_query' || query.actor !== 'external' || query.sourceId !== this.sourceId(id)
      || query.sourceGeneration !== id || query.caseId !== selected.connection.caseId || !this.isEventAllowed(query)
      || query.payload.folderId !== selected.folderId || query.payload.credentialRevision !== selected.revision
      || query.payload.ownerEventId !== (source === 'owner-chat' ? request!.eventId : null)
      || (query.payload.reviewEventId ?? null) !== (source === 'source-review' ? request!.eventId : null) || query.payload.accessSource !== source
      || (query.payload.taskEventId ?? null) !== (source === 'approved-task' ? request!.eventId : null)
      || !access || access.kind !== (source === 'approved-task' ? 'connector.task_access' : source === 'source-review' ? 'connector.research_access' : 'owner.mail_access')
      || access.actor !== (source === 'source-review' || source === 'approved-task' ? 'agent' : 'owner') || access.payload.operation !== 'query'
      || access.caseId !== selected.connection.caseId || access.payload.connectionId !== id || access.payload.folderId !== selected.folderId
      || access.causationId !== request?.eventId
      || Date.now() - Date.parse(query.receivedAt) > 15 * 60_000 || !Array.isArray(messages)
      || !messages.some(item => item && typeof item === 'object' && (item as Record<string, unknown>).id === input.messageId)) {
      throw new RuntimeInputError(409, '请重新查询邮件列表，再读取本次返回的邮件。');
    }
  }
  private readEwsMessageInternal(id: string, input: EwsReadInput,
    request?: { caseId: string; eventId: string; signal: AbortSignal }): Promise<EwsMessageReadPage> {
    this.assertEwsQuerySelection(id, input, request);
    const selected = this.ewsQueryConnection(id, request?.caseId);
    return this.runForCase(selected.connection.caseId, async operationSignal => {
      const signal = request ? AbortSignal.any([operationSignal, request.signal]) : operationSignal;
      signal.throwIfAborted(); if (request) this.connectorReadSource(request.caseId, request.eventId);
      if (!this.current(selected.connection)) throw new RuntimeInputError(409, '邮箱连接已停用。');
      const identity = createHash('sha256').update(JSON.stringify([input.queryId, input.messageId])).digest('hex');
      let receipt = this.inbox.get('mail-read-' + identity);
      if (!receipt) {
        let reading = this.ewsReadOperations.get(identity);
        if (!reading) {
          reading = Promise.resolve().then(async () => {
            signal.throwIfAborted();
            const source = request ? this.connectorReadSource(request.caseId, request.eventId) : 'owner-ui';
            const access = this.inbox.ingestProcessed({ sourceId: source, externalId: randomUUID(),
              kind: source === 'approved-task' ? 'connector.task_access' : source === 'source-review' ? 'connector.research_access' : 'owner.mail_access',
              actor: source === 'source-review' || source === 'approved-task' ? 'agent' : 'owner', operation: 'create', caseId: selected.connection.caseId, occurredAt: new Date().toISOString(),
              ...(request ? { causationId: request.eventId } : {}), payload: { connectionId: id, folderId: selected.folderId,
                operation: 'read', queryId: input.queryId, messageId: input.messageId, credentialRevision: selected.revision } });
            const mail = await readEwsInboxMessage(selected.token, selected.folderId, input.messageId, signal, this.ewsTransport);
            signal.throwIfAborted(); this.assertOpen(); if (request) this.connectorReadSource(request.caseId, request.eventId);
            const current = this.ewsQueryConnection(id, request?.caseId);
            if (!this.current(selected.connection) || current.revision !== selected.revision || current.folderId !== selected.folderId) throw new RuntimeInputError(409, '邮箱授权已变化。');
            return this.inbox.ingestProcessed({ id: 'mail-read-' + identity, sourceId: this.sourceId(id), sourceGeneration: id,
              externalId: identity, kind: 'connector.mail_read', actor: 'external', operation: 'create', caseId: selected.connection.caseId,
              occurredAt: new Date().toISOString(), causationId: access.id, payload: { provider: 'ews', connectionId: id, queryId: input.queryId,
                messageId: input.messageId, subject: mail.subject, receivedAt: mail.receivedAt, sender: mail.sender,
                content: mail.body, encryption: mail.encryption, bodyStatus: mail.bodyStatus, totalCharacters: mail.totalCharacters, truncated: mail.truncated } });
          }).finally(() => this.ewsReadOperations.delete(identity));
          this.ewsReadOperations.set(identity, reading);
        }
        receipt = await reading;
      }
      signal.throwIfAborted(); if (request) this.connectorReadSource(request.caseId, request.eventId);
      if (!this.current(selected.connection) || !this.isEventAllowed(receipt)) throw new RuntimeInputError(409, '邮箱连接已停用。');
      const payload = receipt.payload; const content = String(payload.content ?? '');
      if (receipt.kind !== 'connector.mail_read' || receipt.actor !== 'external' || receipt.sourceGeneration !== id
        || payload.queryId !== input.queryId || payload.messageId !== input.messageId) throw new RuntimeInputError(409, '邮件读取凭据无效，请重新查询。');
      const end = Math.min(input.offset + input.limit, content.length);
      return { connectionId: id, messageId: input.messageId, subject: String(payload.subject), receivedAt: String(payload.receivedAt),
        sender: String(payload.sender), encryption: String(payload.encryption), bodyStatus: String(payload.bodyStatus),
        content: content.slice(input.offset, end), totalCharacters: Number(payload.totalCharacters), nextOffset: end < content.length ? end : null,
        truncated: payload.truncated === true, evidenceId: receipt.id };
    }, { connectionId: id });
  }

  connectEws(input: EwsConnectInput): Promise<ConnectorConnection> {
    this.assertOpen(); this.assertCase(input.caseId); this.assertCapacity();
    const { caseId, scope, observeNewMailAndAnalyze: _observe, persistCredentials: _persist, ...credentials } = ewsConnectInput.parse(input);
    const provider = this.provider('ews');
    return this.runForCase(caseId, signal => this.activate('ews', { caseId, scope, redirectUri: '' },
      { accessToken: '', ews: { ...credentials, revision: 1 } }, provider, signal));
  }

  async updateEws(id: string, raw: EwsUpdateInput): Promise<ConnectorConnection> {
    this.assertOpen();
    const input = ewsUpdateInput.parse(raw);
    const connection = this.connections().find(item => item.id === id && item.kind === 'ews');
    if (!connection) throw new RuntimeInputError(404, 'EWS 连接不存在。');
    this.assertCase(connection.caseId);
    if (this.credentialUpdates.has(id)) throw new RuntimeInputError(409, 'EWS 凭据正在更新。');
    this.credentialUpdates.add(id);
    try {
      const active = [...this.caseOperations].filter(([, value]) => value.connectionId === id);
      for (const [controller] of active) controller.abort();
      await Promise.allSettled(active.map(([, value]) => value.work));
      return await this.runForCase(connection.caseId, async signal => {
        if (!this.current(connection)) throw new RuntimeInputError(409, '此 EWS 连接已停用。');
        const secret = this.credential(id); const previous = secret.get();
        if (!previous) throw new RuntimeInputError(409, 'EWS 凭据已移除，请重新连接。');
        const stored = ewsStoredCredentials.parse((JSON.parse(previous) as ConnectorToken).ews);
        if (stored.revision !== input.expectedRevision) throw new RuntimeInputError(409, 'EWS 凭据已变化，请刷新后重新修改。');
        const next = { ...stored, revision: stored.revision + 1,
          ...(input.password === undefined ? {} : { password: input.password }),
          ...(input.certificate === undefined ? {} : { certificate: input.certificate ?? undefined }) };
        const token: ConnectorToken = { accessToken: '', ews: next };
        const folder = await checkEwsCredentials(token, signal, this.ewsTransport);
        signal.throwIfAborted(); this.assertOpen();
        if (!this.current(connection)) throw new RuntimeInputError(409, '此 EWS 连接已停用。');
        const checkpoint = this.checkpoint(connection)!;
        if (folder.id !== ewsCursor.parse(JSON.parse(checkpoint.cursor)).folderId) throw new RuntimeInputError(409, '邮箱身份已变化，请建立新连接。');
        secret.set(JSON.stringify(token));
        this.inbox.ingestBatch([], { sourceId: this.sourceId(id), sourceGeneration: id,
          value: { ...checkpoint, error: undefined, needsAttention: false, nextAt: Date.now() } satisfies Checkpoint });
        return this.view(connection);
      }, { connectionId: id });
    } finally { this.credentialUpdates.delete(id); }
  }

  private canReadTencentWatch(connection: Connection): boolean {
    return connection.kind === 'tencent-docs' && Boolean(this.providers['tencent-docs']?.readDocument)
      && this.canObserve(connection.caseId) && connection.credentialId !== undefined
      && this.hasTencentDocsCredential(connection.credentialId) && Boolean(this.savedTencentDocsToken(connection.credentialId));
  }

  listTencentDocuments(caseId: string) {
    this.assertOpen();
    return this.connections().filter(connection => connection.caseId === caseId && this.canReadTencentWatch(connection))
      .slice(0, MAX_CONNECTIONS).map(connection => {
        const document = this.checkpoint(connection)?.document;
        return { connectionId: connection.id, scope: connection.scope,
          ...(document ? { title: document.title } : {}),
          ...(document?.type ? { type: document.type } : {}), ...(document?.url ? { url: document.url } : {}) };
      });
  }

  canReadTencentDocument(caseId: string, connectionId: string): boolean {
    return !this.shutdown.signal.aborted && this.connections().some(connection => connection.id === connectionId
      && connection.caseId === caseId && this.canReadTencentWatch(connection));
  }

  async readTencentDocument(caseId: string, connectionId: string, signal: AbortSignal) {
    signal.throwIfAborted(); this.assertOpen();
    const connection = this.connections().find(item => item.id === connectionId && item.caseId === caseId);
    const provider = this.providers['tencent-docs'];
    if (!connection || !provider?.readDocument || !this.canReadTencentWatch(connection)) {
      throw new RuntimeInputError(404, '当前主题没有这份可读取的腾讯文档。');
    }
    const read = provider.readDocument.bind(provider);
    return this.runForCase(caseId, async operationSignal => {
      const activeSignal = AbortSignal.any([signal, operationSignal]);
      activeSignal.throwIfAborted();
      if (!this.canReadTencentDocument(caseId, connectionId)) throw new RuntimeInputError(409, '这份腾讯文档连接已停用。');
      const result = await read({ scope: connection.scope, token: { accessToken: this.requireTencentDocsToken(connection.credentialId) }, signal: activeSignal });
      activeSignal.throwIfAborted(); this.assertOpen();
      if (!this.canReadTencentDocument(caseId, connectionId)) throw new RuntimeInputError(409, '这份腾讯文档连接已停用。');
      return result;
    }, { credentialId: connection.credentialId, connectionId });
  }
  recordDocumentRead(caseId: string, eventId: string, connectionId: string, page: Record<string, unknown>): string {
    this.connectorReadSource(caseId, eventId);
    if (!this.canReadTencentDocument(caseId, connectionId)) throw new RuntimeInputError(409, '这份腾讯文档连接已停用。');
    const content = typeof page.content === 'string' ? page.content : JSON.stringify(page);
    const id = createHash('sha256').update(JSON.stringify([eventId, connectionId, page])).digest('hex');
    return this.inbox.ingestProcessed({ id: `document-read-${id}`, sourceId: this.sourceId(connectionId), sourceGeneration: connectionId,
      externalId: id, kind: 'connector.document_read', actor: 'external', operation: 'create', caseId,
      occurredAt: new Date().toISOString(), causationId: eventId,
      payload: { provider: 'tencent-docs', connectionId, content, page } }).id;
  }

  async start(kind: ConnectorKind, input: Selection, origin: string): Promise<{ url: string; state: string }> {
    this.assertOpen(); this.assertCase(input.caseId);
    const provider = this.provider(kind);
    if (kind === 'ews') throw new RuntimeInputError(409, '请在连接器面板填写 EWS 登录信息和证书。');
    if (provider.tokenGrantUrl) throw new RuntimeInputError(409, '此平台通过令牌授权。');
    const scope = provider.validateScope(input.scope);
    const reconnect = input.connectionId ? this.connections().find(value => value.id === input.connectionId) : undefined;
    if (input.connectionId && (!reconnect || !['gmail', 'outlook'].includes(kind) || reconnect.kind !== kind
      || reconnect.caseId !== input.caseId || reconnect.scope !== scope)) throw new RuntimeInputError(409, '重新授权必须沿用原连接的场景和范围。');
    if (!reconnect) this.assertCapacity();
    if (this.credentialUpdates.has('oauth-app-' + kind)) throw new RuntimeInputError(409, '应用配置正在更新，请稍后登录。');
    const now = Date.now();
    for (const [key, pending] of this.authorizations) if (pending.expiresAt <= now) this.authorizations.delete(key);
    if (this.authorizations.size >= 32) throw new RuntimeInputError(409, '待完成的授权过多，请稍后重试。');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = new URL('/connector-callback/' + kind, origin).href;
    return this.runForCase(input.caseId, async signal => {
      const url = await provider.authorize({ scope, state, challenge, redirectUri }, signal);
      signal.throwIfAborted(); this.assertOpen(); this.assertCase(input.caseId);
      if (!reconnect) this.assertCapacity();
      if (reconnect && !this.current(reconnect)) throw new RuntimeInputError(409, '原连接已停用。');
      if (this.providers[kind] !== provider) throw new RuntimeInputError(409, '应用配置已变化，请重新登录。');
      if (this.authorizations.size >= 32) throw new RuntimeInputError(409, '待完成的授权过多，请稍后重试。');
      this.authorizations.set(state, { kind, caseId: input.caseId, scope, redirectUri, verifier, expiresAt: Date.now() + AUTH_TTL,
        ...(reconnect ? { connectionId: reconnect.id } : {}) });
      return { url: url.href, state };
    }, reconnect ? { connectionId: reconnect.id } : {});
  }
  complete(kind: ConnectorKind, state: string, code: string, origin: string): Promise<ConnectorConnection> {
    this.assertOpen();
    const pending = this.authorizations.get(state);
    if (!pending || pending.kind !== kind || pending.expiresAt <= Date.now() || new URL(pending.redirectUri).origin !== origin) {
      throw new RuntimeInputError(409, '授权已失效，请从连接器设置重新登录。');
    }
    this.authorizations.delete(state);
    this.assertCase(pending.caseId);
    if (!pending.connectionId) this.assertCapacity();
    const provider = this.provider(kind);
    return this.runForCase(pending.caseId, async signal => {
      const token = await provider.exchange({ code, redirectUri: pending.redirectUri, verifier: pending.verifier }, signal);
      if (this.providers[kind] !== provider) throw new RuntimeInputError(409, '应用配置已变化，请重新登录。');
      if (pending.connectionId) return this.reauthorizeOAuth(kind, pending, token, provider, signal);
      return this.activate(kind, pending, token, provider, signal);
    }, pending.connectionId ? { connectionId: pending.connectionId, credentialMutation: true } : {});
  }
  private async reauthorizeOAuth(kind: ConnectorKind, pending: PendingAuthorization, token: ConnectorToken,
    provider: ConnectorProvider, signal: AbortSignal): Promise<ConnectorConnection> {
    const id = pending.connectionId!;
    const connection = this.connections().find(value => value.id === id && value.kind === kind);
    if (!connection || !this.current(connection) || connection.caseId !== pending.caseId || connection.scope !== pending.scope) {
      throw new RuntimeInputError(409, '原连接已停用或范围发生变化。');
    }
    if (this.credentialUpdates.has(id)) throw new RuntimeInputError(409, '连接凭据正在更新。');
    if (!provider.validateReauthorization) throw new RuntimeInputError(409, '此连接需断开后重新添加，历史资料仍会保留。');
    this.credentialUpdates.add(id);
    try {
      const active = [...this.caseOperations].filter(([, use]) => use.connectionId === id && !use.credentialMutation);
      for (const [controller] of active) controller.abort();
      await Promise.allSettled(active.map(([, use]) => use.work));
      signal.throwIfAborted(); this.assertOpen(); this.assertCase(connection.caseId);
      const secret = this.credential(id); const previous = secret.get(); const checkpoint = this.checkpoint(connection);
      if (!previous || !checkpoint) throw new RuntimeInputError(409, '原连接凭据或观察位置不可用。');
      await provider.validateReauthorization({ previousToken: JSON.parse(previous) as ConnectorToken, nextToken: token,
        scope: connection.scope, cursor: checkpoint.cursor }, signal);
      signal.throwIfAborted(); this.assertOpen();
      if (!this.current(connection) || this.providers[kind] !== provider) throw new RuntimeInputError(409, '连接或应用配置已变化。');
      secret.set(JSON.stringify(token));
      this.inbox.ingestBatch([], { sourceId: this.sourceId(id), sourceGeneration: id,
        value: { ...checkpoint, error: undefined, needsAttention: false, rateLimited: false, nextAt: Date.now() } satisfies Checkpoint });
      return this.view(connection);
    } finally { this.credentialUpdates.delete(id); }
  }
  saveTencentDocsCredential(input: string): TencentDocsCredential {
    this.assertOpen(); this.provider('tencent-docs');
    const token = input.trim();
    if (!tencentDocsTokenPattern.test(token)) throw new RuntimeInputError(400, '请输入腾讯文档授权页提供的个人 Token。');
    const credentials = this.tencentDocsCredentials();
    const existing = credentials.find(credential => this.savedTencentDocsToken(credential.id) === token);
    if (existing) return existing;
    const credential = { id: randomUUID(), createdAt: new Date().toISOString() };
    const slot = TENCENT_DOCS_SECRET_PREFIX + credential.id;
    const secret = this.credential(slot);
    secret.set(JSON.stringify({ accessToken: token }));
    try { this.store.setMeta(TENCENT_DOCS_CREDENTIALS, [...credentials, credential]); }
    catch (error) { this.credentials.delete(slot); secret.set(undefined); throw error; }
    return credential;
  }

  removeTencentDocsCredential(id: string): { id: string; removed: true } {
    this.assertOpen();
    const credentials = this.tencentDocsCredentials();
    if (!credentials.some(credential => credential.id === id)) throw new RuntimeInputError(404, '腾讯文档授权不存在。');
    if (this.connections().some(connection => connection.kind === 'tencent-docs' && connection.credentialId === id)
      || [...this.caseOperations.values()].some(operation => operation.credentialId === id)) {
      throw new RuntimeInputError(409, '这份授权仍有文档连接或正在读取，请先断开文档并等待同步结束。');
    }
    this.store.setMeta(TENCENT_DOCS_CREDENTIALS, credentials.filter(credential => credential.id !== id));
    const slot = TENCENT_DOCS_SECRET_PREFIX + id;
    this.credentials.delete(slot);
    rmSync(join(this.directory, slot + '.json'), { force: true });
    return { id, removed: true };
  }

  connectTencentDocument(input: TencentDocumentSelection): Promise<ConnectorConnection> {
    this.assertOpen(); this.assertCase(input.caseId); this.assertCapacity();
    const provider = this.provider('tencent-docs');
    const selection = { caseId: input.caseId, scope: provider.validateScope(input.scope), redirectUri: '', credentialId: input.credentialId };
    return this.runForCase(input.caseId, signal => this.activate('tencent-docs', selection,
      { accessToken: this.requireTencentDocsToken(input.credentialId) }, provider, signal), { credentialId: input.credentialId });
  }

  previewTencentDocument(input: TencentDocumentSelection): Promise<ConnectorDocumentMetadata> {
    this.assertOpen(); this.assertCase(input.caseId);
    const provider = this.provider('tencent-docs');
    const scope = provider.validateScope(input.scope);
    const preview = provider.previewDocument?.bind(provider);
    if (!preview) throw new RuntimeInputError(409, '当前连接器无法预览腾讯文档。');
    return this.runForCase(input.caseId, async signal => {
      const document = await preview({ scope, token: { accessToken: this.requireTencentDocsToken(input.credentialId) }, signal });
      signal.throwIfAborted(); this.assertOpen(); this.assertCase(input.caseId);
      return document;
    }, { credentialId: input.credentialId });
  }

  private async activate(kind: ConnectorKind, selection: ConnectionSelection, token: ConnectorToken,
    provider: ConnectorProvider, signal: AbortSignal): Promise<ConnectorConnection> {
    const accountConnection = kind === 'github' && selection.github?.kind === 'account';
    signal.throwIfAborted(); this.assertOpen(); if (!accountConnection) this.assertCase(selection.caseId);
    const baseline = await provider.scan({ scope: selection.scope, token, signal });
    signal.throwIfAborted();
    this.assertOpen(); if (!accountConnection) this.assertCase(selection.caseId); this.assertCapacity();
    if (kind === 'tencent-docs' && !this.hasTencentDocsCredential(selection.credentialId)) {
      throw new RuntimeInputError(409, '腾讯文档授权已移除。');
    }
    if (baseline.changes.length) throw new Error('A new connection cannot replay history');
    if (kind === 'github' && selection.github) {
      const cursor = JSON.parse(baseline.cursor) as { repositoryId?: number; accountId?: number };
      if (selection.github.kind === 'account') {
        if (cursor.accountId !== selection.github.accountId) throw new RuntimeInputError(409, '账号身份在连接期间发生变化，请重试。');
        const existing = this.connections().find(value => value.github?.kind === 'account' && value.github.accountId === cursor.accountId
          && (() => { const saved = this.credential(value.id).get(); return Boolean(saved && (JSON.parse(saved) as ConnectorToken).accessToken === token.accessToken); })());
        if (existing) return this.view(existing);
      } else if (cursor.repositoryId !== selection.github.repositoryId) throw new RuntimeInputError(409, '仓库身份在连接期间发生变化。');
    }
    if (kind === 'ews') {
      const folderId = ewsCursor.parse(JSON.parse(baseline.cursor)).folderId;
      const endpoint = token.ews!.endpoint.toLowerCase();
      const duplicate = this.connections().some(existing => existing.kind === 'ews' && existing.caseId === selection.caseId
        && this.ewsDetails(existing)?.endpoint.toLowerCase() === endpoint
        && ewsCursor.parse(JSON.parse(this.checkpoint(existing)!.cursor)).folderId === folderId);
      if (duplicate) throw new RuntimeInputError(409, '这个邮箱在当前场景已有连接，请更新原连接的密码或证书。');
    }
    const connection: Connection = { id: randomUUID(), kind, caseId: selection.caseId, scope: selection.scope,
      redirectUri: selection.redirectUri, connectedAt: new Date().toISOString(),
      ...(selection.credentialId ? { credentialId: selection.credentialId } : {}) };
    if (selection.github) connection.github = selection.github;
    if (connection.github?.kind === 'account') connection.github.grantEventId = this.githubAccountGrant(connection).id;
    const secret = kind === 'tencent-docs' ? undefined : this.credential(connection.id);
    try {
      secret?.set(JSON.stringify(token));
      this.commit(connection, baseline);
      this.store.setMeta(RECORDS, [...this.connections(), connection]);
    } catch (error) {
      this.credentials.delete(connection.id); secret?.set(undefined);
      throw error;
    }
    return this.view(connection);
  }

  private commit(connection: Connection, result: ScanResult, previous?: Checkpoint): void {
    const now = Date.now();
    const date = new Date(now).toISOString();
    const sourceId = this.sourceId(connection.id);
    const notice = result.notice ?? previous?.notice;
    const document = result.document ?? previous?.document;
    const value: Checkpoint = { cursor: result.cursor, lastSyncedAt: date, ...nextScan(connection.kind, now, result.more),
      ...(previous?.documentEventId ? { documentEventId: previous.documentEventId } : {}),
      ...(notice ? { notice } : {}), ...(document ? { document } : {}) };
    if (connection.kind === 'tencent-docs' && previous && !value.documentEventId) {
      try {
        const cursor = JSON.parse(previous.cursor) as { revision?: number; digest?: string };
        if (typeof cursor.revision === 'number' && typeof cursor.digest === 'string') {
          value.documentEventId = this.inbox.documentVersion(sourceId, connection.id, `${cursor.revision}:${cursor.digest}`)?.id;
        }
      } catch { /* The provider validates old cursor formats; never invent an earlier body. */ }
    }
    if (connection.kind === 'tencent-docs' && result.documentSnapshot && !value.documentEventId && !result.changes.length) {
      const snapshot = result.documentSnapshot;
      value.documentEventId = this.inbox.ingestProcessed({ sourceId, sourceGeneration: connection.id, caseId: connection.caseId,
        externalId: 'baseline:' + snapshot.id, version: snapshot.revision, kind: 'connector.document_snapshot', actor: 'external', operation: 'create', occurredAt: date,
        payload: { provider: connection.kind, scope: connection.scope, title: snapshot.title, content: snapshot.content,
          totalCharacters: snapshot.totalCharacters ?? snapshot.content.length, truncated: snapshot.truncated === true } }).id;
    }
    const changes = result.changes.map(change => ({ id: connection.kind === 'tencent-docs'
      ? createHash('sha256').update(JSON.stringify([connection.id, change.id, change.revision])).digest('hex') : undefined,
      sourceId, sourceGeneration: connection.id, caseId: connection.caseId,
      externalId: change.id, version: change.revision, kind: 'connector.change', actor: 'external', operation: 'update',
      occurredAt: date, payload: { provider: connection.kind, scope: connection.scope, title: change.title.slice(0, 300),
        content: change.content.slice(0, connection.kind === 'tencent-docs' ? 200_000 : connection.kind === 'ews' ? 65_536 : 4000),
        totalCharacters: change.totalCharacters ?? change.content.length,
        truncated: change.truncated === true || change.content.length > (connection.kind === 'tencent-docs' ? 200_000 : connection.kind === 'ews' ? 65_536 : 4000),
        ...(connection.kind === 'tencent-docs' ? { previousEventId: value.documentEventId ?? null } : {}),
        ...(change.mailThread ? { mailThread: change.mailThread } : {}),
        ...(change.url ? { url: change.url } : {}) } } as const));
    if (connection.kind === 'tencent-docs' && changes.length) value.documentEventId = changes.at(-1)!.id;
    this.inbox.ingestBatch(changes, { sourceId, sourceGeneration: connection.id, value });
    if (result.changes.length) this.onChanges();
  }
  private current(connection: Connection): boolean {
    return (connection.github?.kind === 'account' || this.canObserve(connection.caseId)) && this.connections().some(record => record.id === connection.id)
      && (connection.kind !== 'tencent-docs' || this.hasTencentDocsCredential(connection.credentialId));
  }
  private async poll(connection: Connection, signal: AbortSignal): Promise<ConnectorConnection> {
    const provider = this.provider(connection.kind);
    const checkpoint = this.checkpoint(connection);
    if (!checkpoint) throw new RuntimeInputError(409, '此连接缺少观察基线，请重新连接。');
    try {
      const secret = connection.kind === 'tencent-docs' ? undefined : this.credential(connection.id);
      const saved = secret?.get();
      if (secret && !saved) throw new ConnectorProviderError('连接凭据不可用，请重新连接。');
      let token: ConnectorToken = saved ? JSON.parse(saved) as ConnectorToken
        : { accessToken: this.requireTencentDocsToken(connection.credentialId) };
      const refresh = async () => {
        if (!secret) throw new RuntimeInputError(409, '腾讯文档授权需要重新保存。');
        token = await provider.refresh(token, connection.redirectUri, signal);
        signal.throwIfAborted(); this.assertOpen();
        if (!this.current(connection)) throw new RuntimeInputError(409, '此连接已停用。');
        secret.set(JSON.stringify(token));
      };
      let refreshed = false;
      const canRefresh = () => provider.canRefresh?.(token) ?? Boolean(token.refreshToken);
      if (token.expiresAt && token.expiresAt < Date.now() + 60_000 && canRefresh()) {
        await refresh(); refreshed = true;
      }
      const scan = () => provider.scan({ token, scope: connection.scope, cursor: checkpoint.cursor, signal });
      let result: ScanResult;
      try { result = await scan(); }
      catch (error) {
        if (!(error instanceof ConnectorProviderError) || error.status !== 401 || !canRefresh() || refreshed) throw error;
        await refresh(); result = await scan();
      }
      signal.throwIfAborted(); this.assertOpen();
      if (this.current(connection)) this.commit(connection, result, checkpoint);
    } catch (error) {
      if ((!signal.aborted || signal.reason?.name === 'TimeoutError') && !this.shutdown.signal.aborted && this.current(connection)) {
        this.assertActive();
        const message = error instanceof ConnectorProviderError ? error.message : '同步未完成，已保留上次同步位置。';
        const retryAt = error instanceof ConnectorProviderError ? error.retryAt : undefined;
        const needsAttention = error instanceof ConnectorProviderError && (error.needsAttention
          || [401, 403].includes(error.status) || connection.kind === 'ews' && [400, 409].includes(error.status));
        this.inbox.ingestBatch([], { sourceId: this.sourceId(connection.id), sourceGeneration: connection.id,
          value: { ...checkpoint, error: message, ...nextScan(connection.kind, Date.now()),
            ...(retryAt !== undefined ? { nextAt: Math.max(Date.now() + 1000, retryAt) } : {}),
            ...(error instanceof ConnectorProviderError && error.status === 429 ? { rateLimited: true } : {}),
            ...(needsAttention ? { needsAttention: true } : {}) } satisfies Checkpoint });
      }
    }
    return this.view(connection);
  }
  private scan(connection: Connection): Promise<ConnectorConnection> {
    const previous = this.scans.get(connection.id);
    if (previous) return previous;
    if (this.scans.size >= 2) throw new RuntimeInputError(409, '正在检查其他连接，请稍后重试。');
    const work = this.runForCase(connection.caseId, signal => this.poll(connection, signal),
      { credentialId: connection.credentialId, connectionId: connection.id, ...(connection.github?.kind === 'account' ? { accountOperation: true } : {}) })
      .finally(() => this.scans.delete(connection.id));
    this.scans.set(connection.id, work);
    return work;
  }
  sync(id: string): Promise<ConnectorConnection> {
    this.assertOpen();
    const connection = this.connections().find(record => record.id === id);
    if (!connection) throw new RuntimeInputError(404, '连接不存在。');
    this.assertCase(connection.caseId);
    if (this.credentialUpdates.has(id)) throw new RuntimeInputError(409, '连接凭据正在更新，请稍后同步。');
    if (this.credentialUpdates.has('oauth-app-' + connection.kind)) throw new RuntimeInputError(409, '应用配置正在更新，请稍后同步。');
    const checkpoint = this.checkpoint(connection);
    if (checkpoint?.rateLimited && checkpoint.nextAt > Date.now()) return Promise.resolve(this.view(connection));
    if (connection.kind === 'tencent-docs' && !this.hasTencentDocsCredential(connection.credentialId)) return Promise.resolve(this.view(connection));
    return this.scan(connection);
  }
  tick(): void {
    if (this.shutdown.signal.aborted || this.scans.size >= 2) return;
    const now = Date.now();
    for (const connection of this.connections()) {
      // An account connection enables on-demand access; it is not an instruction to crawl every repository.
      if (connection.kind === 'github') continue;
      if (this.scans.has(connection.id) || this.credentialUpdates.has(connection.id) || !this.providers[connection.kind] || !this.canObserve(connection.caseId)) continue;
      if (this.credentialUpdates.has('oauth-app-' + connection.kind)) continue;
      if (connection.kind === 'tencent-docs' && !this.hasTencentDocsCredential(connection.credentialId)) continue;
      const checkpoint = this.checkpoint(connection);
      if (checkpoint?.needsAttention) continue;
      if (checkpoint && checkpoint.nextAt <= now) {
        void this.scan(connection).catch(() => undefined);
        if (this.scans.size >= 2) break;
      }
    }
  }
  async disconnect(id: string, drainCase: (caseId: string) => Promise<unknown>): Promise<{ id: string; disconnected: true }> {
    this.assertOpen();
    const records = this.connections();
    const connection = records.find(record => record.id === id);
    if (!connection) throw new RuntimeInputError(404, '连接不存在。');
    this.store.setMeta(RECORDS, records.filter(record => record.id !== id));
    const uses = [...this.caseOperations].filter(([, value]) => value.connectionId === id);
    for (const [controller] of uses) controller.abort();
    const settledUses = Promise.allSettled(uses.map(([, value]) => value.work));
    try { await Promise.all([settledUses, drainCase(connection.caseId)]); }
    finally {
      await settledUses;
      this.credentials.delete(id);
      rmSync(join(this.directory, id + '.json'), { force: true });
    }
    return { id, disconnected: true };
  }
  isEventAllowed(event: InboxEvent): boolean {
    if (!event.sourceGeneration || event.sourceId !== this.sourceId(event.sourceGeneration)) return false;
    if (event.kind === 'connector.github_read') {
      const { connectionId, repositoryId, accountId, credentialRevision } = event.payload;
      return event.payload.provider === 'github' && connectionId === event.sourceGeneration && typeof event.caseId === 'string'
        && (typeof repositoryId === 'number' || typeof accountId === 'number') && typeof credentialRevision === 'number'
        && this.canReadGitHubConnection(event.caseId, connectionId, { ...(typeof repositoryId === 'number' ? { repositoryId } : {}),
          ...(typeof accountId === 'number' ? { accountId } : {}), credentialRevision });
    }
    if (['connector.mail_query', 'connector.mail_read', 'connector.mail_context'].includes(event.kind)) {
      const connection = this.connections().find(value => value.id === event.sourceGeneration && value.kind === 'ews' && value.caseId === event.caseId);
      if (!connection || this.credentialUpdates.has(connection.id) || !this.canReadEwsMailbox(connection.caseId, connection.id)) return false;
      const query = event.kind === 'connector.mail_read' && typeof event.payload.queryId === 'string' ? this.inbox.get(event.payload.queryId) : undefined;
      if (event.kind === 'connector.mail_read' && (!query || query.kind !== 'connector.mail_query'
        || query.caseId !== event.caseId || query.sourceGeneration !== event.sourceGeneration)) return false;
      const revision = query?.payload.credentialRevision ?? event.payload.credentialRevision;
      return typeof revision === 'number' && revision === this.ewsDetails(connection)?.credentialRevision;
    }
    const local = this.localWeChatGrant(event.sourceGeneration);
    if (local) return event.caseId === local.caseId && this.localWeChatEligible(local);
    return this.connections().some(connection => connection.id === event.sourceGeneration && connection.caseId === event.caseId
      && (connection.kind !== 'tencent-docs' || this.hasTencentDocsCredential(connection.credentialId))
      && this.canObserve(connection.caseId));
  }
  async close(): Promise<void> {
    this.shutdown.abort(); this.authorizations.clear();
    await Promise.allSettled([...this.operations]);
    this.credentials.clear();
  }
}
