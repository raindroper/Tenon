import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Settings } from '../../shared/types.js';
import { modelBindingSchema, modelConnectionInputSchema, modelContextWindowSchema, modelPreferenceSchema, modelSelectionSchema,
  type ModelBinding, type ModelCatalogEntry, type ModelConnection, type ModelConnectionInput, type ModelConnectionStatus,
  type ModelDefaults, type ModelDirectory, type ModelIdentity, type ModelPreference, type ModelPurpose, type ModelConnectionReferences, type ModelConnectionDiagnostic,
  type ModelSelection, type OAuthRegistration, type SceneModelPreference } from '../../shared/model-connections.js';
import { SecretStore } from '../secrets.js';

export interface OAuthCredentials {
  kind: 'siwc'; accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number; scope: string;
  clientId: string; issuer: string; subject: string; accountId?: string;
  pendingRefresh?: { accessToken: string; refreshToken?: string; expiresAt: number; scope: string; idToken?: string; receivedAt: number };
}
export type ModelCredential = { kind: 'api-key'; apiKey: string } | OAuthCredentials;
export interface CredentialExpectation { expectedCredentialVersion: number; expectedIdentityRevision?: number; expectedEditRevision?: number }
export interface DiagnosticExpectation { expectedIdentityRevision: number; expectedBindingRevision?: number }
interface MetadataStore {
  getMeta<T>(key: string, fallback: T): T; setMeta(key: string, value: unknown): void; atomic<T>(work: () => T): T;
  getSettings(): Settings; getApiKey(): string | undefined;
  list(name: 'runs'): Array<{ id: string; status: string; modelBinding?: ModelBinding | null }>;
}
interface SavedConnection extends ModelConnection { credentialRef?: string }
interface HubConnection { apiBaseUrl: string; model: string; credentialRef?: string; environment?: true }
interface SavedModels { version: 1; connections: SavedConnection[]; defaults: ModelDefaults; scenes: SceneModelPreference[]; hub: HubConnection }
const metadataKey = 'models.connections.v1';
export const LEGACY_MODEL_CONNECTION_ID = 'legacy-model';
export class ModelConnectionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ModelConnectionError'; }
}
const expectationSchema = z.object({ expectedCredentialVersion: z.number().int().nonnegative(),
  expectedIdentityRevision: z.number().int().nonnegative().optional(), expectedEditRevision: z.number().int().nonnegative().optional() }).strict();
const tokenFields = { accessToken: z.string().min(1).max(100_000), refreshToken: z.string().min(1).max(100_000).optional(),
  idToken: z.string().min(1).max(100_000).optional(), expiresAt: z.number().finite().positive(), scope: z.string().max(10_000) };
const oauthCredentialSchema = z.object({ kind: z.literal('siwc'), ...tokenFields, clientId: z.string().min(1).max(1000),
  issuer: z.string().url().max(500), subject: z.string().min(1).max(1000), accountId: z.string().min(1).max(1000).optional(),
  pendingRefresh: z.object({ ...tokenFields, receivedAt: z.number().finite().positive() }).strict().optional() }).strict();
const registrationSchema = z.object({ issuer: z.string().url().max(500), clientId: z.string().min(1).max(1000) }).strict();

function clearProviderWindows(connection: SavedConnection): void {
  if (connection.models) connection.models = connection.models.map(({ contextWindow: _window, ...entry }) => entry);
}

/** One connection registry. Secret files are immutable versions; SQLite publishes their references. */
export class ModelConnections {
  private readonly secretStores = new Map<string, SecretStore>();
  private activeTaskBindings: () => Array<{ id: string; modelBinding?: ModelBinding | null }> = () => [];
  constructor(private readonly store: MetadataStore, private readonly dataDir: string) {}

  private secret(reference: string): SecretStore {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(reference)) throw new ModelConnectionError(409, '模型凭据引用无效，请核对完整备份。');
    let secret = this.secretStores.get(reference);
    if (!secret) { secret = new SecretStore(join(this.dataDir, 'model-credentials'), reference); this.secretStores.set(reference, secret); }
    return secret;
  }
  private writeSecret(value: ModelCredential): string {
    const reference = randomUUID() + '.json'; this.secret(reference).set(JSON.stringify(value)); return reference;
  }
  private dropSecret(reference?: string): void {
    if (!reference) return;
    try { this.secret(reference).set(undefined); this.secretStores.delete(reference); } catch { /* Unreferenced encrypted file cannot authorize a request. */ }
  }
  private save(state: SavedModels): void { this.store.setMeta(metadataKey, state); }
  private state(): SavedModels {
    const saved = this.store.getMeta<SavedModels | null>(metadataKey, null);
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.connections) || !saved.defaults || !Array.isArray(saved.scenes) || !saved.hub) {
        throw new ModelConnectionError(409, '模型连接数据版本无效，未重置已有配置。');
      }
      return saved;
    }
    return this.migrateLegacy();
  }
  private migrateLegacy(): SavedModels {
    const settings = this.store.getSettings(); const key = this.store.getApiKey();
    const environment = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
    const references: string[] = [];
    try {
      const credentialRef = key && !environment ? this.writeSecret({ kind: 'api-key', apiKey: key }) : undefined;
      if (credentialRef) references.push(credentialRef);
      // Hub retains its own reference so deleting a model connection cannot remove service credentials.
      const hubReference = key && !environment ? this.writeSecret({ kind: 'api-key', apiKey: key }) : undefined;
      if (hubReference) references.push(hubReference);
      const connection: SavedConnection = { id: LEGACY_MODEL_CONNECTION_ID, name: '原模型连接', kind: 'api-key', protocol: 'deepseek',
        endpoint: settings.apiBaseUrl.replace(/\/+$/, ''), enabled: true, status: key ? 'ready' : 'needs-login',
        credentialConfigured: Boolean(key), editRevision: 1, bindingRevision: 1, identityRevision: 1, credentialVersion: key ? 1 : 0,
        ...(credentialRef ? { credentialRef } : {}), credentialSource: environment ? 'environment' : 'saved' };
      const state: SavedModels = { version: 1, connections: [connection], defaults: { global: this.legacySelection(settings),
        background: { mode: 'inherit-global' }, revision: 1 }, scenes: [], hub: {
        apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ''), model: settings.model,
        ...(hubReference ? { credentialRef: hubReference } : {}), ...(environment ? { environment: true as const } : {}) } };
      this.store.atomic(() => {
        if (this.store.getMeta(metadataKey, null)) throw new ModelConnectionError(409, '模型连接已迁移，请重新读取。');
        this.save(state);
      });
      return state;
    } catch (error) { references.forEach(reference => this.dropSecret(reference)); throw error; }
  }
  private legacySelection(settings: Settings): ModelSelection {
    return { connectionId: LEGACY_MODEL_CONNECTION_ID, modelId: settings.model, reasoning: settings.reasoningEffort, maxOutputTokens: settings.maxOutputTokens };
  }
  private found(state: SavedModels, id: string): SavedConnection {
    const connection = state.connections.find(item => item.id === id);
    if (!connection) throw new ModelConnectionError(404, '模型连接不存在。');
    return connection;
  }
  private public(connection: SavedConnection): ModelConnection {
    const { credentialRef: _reference, ...value } = connection;
    const configured = connection.credentialSource === 'environment'
      ? Boolean(process.env.DEEPSEEK_API_KEY?.trim()) : Boolean(connection.credentialRef);
    return { ...value, credentialConfigured: configured,
      status: !connection.enabled ? 'disabled' : !configured && connection.status !== 'scope-required' ? 'needs-login' : connection.status };
  }
  private checkCredential(connection: SavedConnection, raw: CredentialExpectation): void {
    const expected = expectationSchema.parse(raw);
    if (connection.credentialVersion !== expected.expectedCredentialVersion ||
      expected.expectedIdentityRevision !== undefined && connection.identityRevision !== expected.expectedIdentityRevision ||
      expected.expectedEditRevision !== undefined && connection.editRevision !== expected.expectedEditRevision) {
      throw new ModelConnectionError(409, '模型凭据或登录状态已经改变，未覆盖新的状态。');
    }
  }
  directory(): ModelDirectory {
    const state = this.state(); return { connections: state.connections.map(connection => this.public(connection)),
      defaults: state.defaults, scenes: state.scenes, hub: { configured: Boolean(state.hub.credentialRef || state.hub.environment && process.env.DEEPSEEK_API_KEY?.trim()) } };
  }
  get(id: string): ModelConnection | undefined { const value = this.state().connections.find(item => item.id === id); return value ? this.public(value) : undefined; }
  upsert(raw: ModelConnectionInput): ModelConnection {
    const input = modelConnectionInputSchema.parse(raw); const state = this.state();
    const existing = input.id ? this.found(state, input.id) : undefined;
    if (existing && input.expectedRevision !== existing.editRevision) throw new ModelConnectionError(409, '模型连接已被修改，请重新打开后保存。');
    if (existing && (existing.kind !== input.kind || existing.protocol !== input.protocol)) {
      throw new ModelConnectionError(409, '认证类型和通信协议不可就地更换，请添加独立连接。');
    }
    if (existing?.credentialSource === 'environment' && (input.apiKey || input.clearApiKey)) throw new ModelConnectionError(409, '此连接凭据由部署环境管理。');
    const endpoint = input.kind === 'siwc' ? 'https://api.openai.com/v1' : input.endpoint!.replace(/\/+$/, '');
    const endpointChanged = Boolean(existing && existing.endpoint !== endpoint);
    if (endpointChanged && existing?.credentialSource === 'environment') throw new ModelConnectionError(409, '环境凭据绑定原地址，请添加独立连接。');
    const oldReference = existing?.credentialRef;
    const clear = Boolean(input.clearApiKey || endpointChanged && !input.apiKey);
    let newReference: string | undefined;
    try {
      if (input.apiKey) newReference = this.writeSecret({ kind: 'api-key', apiKey: input.apiKey });
      const changedCredential = Boolean(input.apiKey || clear);
      const credentialRef = newReference ?? (clear ? undefined : oldReference);
      const enabled = input.enabled ?? existing?.enabled ?? true;
      const contextWindows = input.contextWindows ?? (endpointChanged ? undefined : existing?.contextWindows);
      const connection: SavedConnection = { ...existing, id: existing?.id ?? randomUUID(), name: input.name, kind: input.kind,
        protocol: input.protocol, endpoint, enabled, credentialConfigured: Boolean(credentialRef || existing?.credentialSource === 'environment'),
        status: !changedCredential && existing?.status && existing.status !== 'disabled' ? existing.status
          : credentialRef || existing?.credentialSource === 'environment' ? 'ready' : 'needs-login',
        editRevision: (existing?.editRevision ?? 0) + 1, bindingRevision: (existing?.bindingRevision ?? 0) + (!existing || endpointChanged ? 1 : 0),
        identityRevision: (existing?.identityRevision ?? (input.kind === 'api-key' ? 1 : 0)) + (input.apiKey && existing && existing.credentialVersion > 0 ? 1 : 0),
        credentialVersion: (existing?.credentialVersion ?? 0) + (changedCredential || existing && enabled !== existing.enabled ? 1 : 0), credentialSource: existing?.credentialSource ?? 'saved',
        ...(credentialRef ? { credentialRef } : {}) };
      if (!credentialRef) delete connection.credentialRef;
      if (contextWindows?.length) connection.contextWindows = contextWindows;
      else delete connection.contextWindows;
      if (endpointChanged || changedCredential) clearProviderWindows(connection);
      if (existing) state.connections[state.connections.findIndex(item => item.id === existing.id)] = connection;
      else state.connections.push(connection);
      this.store.atomic(() => this.save(state));
      if (changedCredential) this.dropSecret(oldReference);
      return this.public(connection);
    } catch (error) { this.dropSecret(newReference); throw error; }
  }
  getDefaults(): ModelDefaults { return this.state().defaults; }
  setDefaults(raw: { global?: ModelSelection | null; background?: ModelPreference; expectedRevision: number }): ModelDefaults {
    const input = z.object({ global: modelSelectionSchema.nullable().optional(), background: modelPreferenceSchema.optional(), expectedRevision: z.number().int().nonnegative() }).strict().parse(raw);
    const state = this.state();
    if (input.expectedRevision !== state.defaults.revision) throw new ModelConnectionError(409, '模型默认设置已改变，请重新打开后保存。');
    if (input.global) this.validateSelection(state, input.global);
    if (input.background?.mode === 'explicit') this.validateSelection(state, input.background.selection);
    state.defaults = { global: input.global === undefined ? state.defaults.global : input.global,
      background: input.background ?? state.defaults.background, revision: state.defaults.revision + 1 };
    this.store.atomic(() => this.save(state)); return state.defaults;
  }
  getScene(caseId: string): SceneModelPreference { return this.state().scenes.find(item => item.caseId === caseId) ?? { caseId, preference: { mode: 'inherit-global' }, revision: 0 }; }
  setScene(caseId: string, raw: { preference: ModelPreference; expectedRevision: number }): SceneModelPreference {
    z.string().min(1).max(200).parse(caseId);
    const input = z.object({ preference: modelPreferenceSchema, expectedRevision: z.number().int().nonnegative() }).strict().parse(raw);
    const state = this.state(); const index = state.scenes.findIndex(item => item.caseId === caseId); const current = index >= 0 ? state.scenes[index] : undefined;
    if (input.expectedRevision !== (current?.revision ?? 0)) throw new ModelConnectionError(409, '场景模型设置已改变，请重新打开后保存。');
    if (input.preference.mode === 'explicit') this.validateSelection(state, input.preference.selection);
    const value: SceneModelPreference = { caseId, preference: input.preference, revision: (current?.revision ?? 0) + 1 };
    if (index >= 0) state.scenes[index] = value; else state.scenes.push(value);
    this.store.atomic(() => this.save(state)); return value;
  }
  private validateSelection(state: SavedModels, raw: ModelSelection): ModelSelection {
    const selection = modelSelectionSchema.parse(raw); const connection = this.found(state, selection.connectionId);
    if (connection.kind === 'siwc' && selection.maxOutputTokens !== null) throw new ModelConnectionError(400, 'ChatGPT 连接不支持自定义输出 token 上限。');
    return selection;
  }
  /** Capture an accepted selection even while paused or signed out. Dispatch checks availability separately. */
  resolve(input: { caseId?: string; purpose: ModelPurpose; selection?: ModelSelection }): ModelBinding | undefined {
    const state = this.state(); let selection = input.selection; let source: ModelBinding['source'] = 'explicit';
    if (!selection && input.purpose === 'background' && state.defaults.background.mode === 'explicit') {
      selection = state.defaults.background.selection; source = 'background';
    }
    if (!selection && input.purpose !== 'background' && input.caseId) {
      const scene = state.scenes.find(item => item.caseId === input.caseId);
      if (scene?.preference.mode === 'explicit') { selection = scene.preference.selection; source = 'scene'; }
    }
    if (!selection) { selection = state.defaults.global ?? undefined; source = 'global'; }
    if (!selection) return undefined;
    selection = this.validateSelection(state, selection); const connection = this.found(state, selection.connectionId);
    const contextWindow = connection.contextWindows?.find(entry => entry.modelId === selection.modelId)?.contextWindow
      ?? connection.models?.find(entry => entry.id === selection.modelId)?.contextWindow;
    return { selection, source, purpose: input.purpose, bindingRevision: connection.bindingRevision, identityRevision: connection.identityRevision,
      protocol: connection.protocol, endpoint: connection.endpoint, adapterVersion: 1, resolvedAt: new Date().toISOString(),
      ...(contextWindow === undefined ? {} : { contextWindow }) };
  }
  assertBinding(raw: ModelBinding): ModelConnection {
    const binding = modelBindingSchema.parse(raw); const connection = this.get(binding.selection.connectionId);
    if (!connection) throw new ModelConnectionError(409, '此运行绑定的模型连接不存在。');
    if (connection.bindingRevision !== binding.bindingRevision || connection.identityRevision !== binding.identityRevision ||
      connection.protocol !== binding.protocol || connection.endpoint !== binding.endpoint) throw new ModelConnectionError(409, '模型连接身份或地址已改变，此运行未发送资料。');
    if (!connection.enabled || connection.status !== 'ready' || !connection.credentialConfigured) throw new ModelConnectionError(409, '模型连接不可用，请修复原连接后继续。');
    return connection;
  }
  getCredential(id: string): ModelCredential | undefined {
    const connection = this.found(this.state(), id);
    if (connection.credentialSource === 'environment') {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim(); return apiKey ? { kind: 'api-key', apiKey } : undefined;
    }
    if (!connection.credentialRef) return undefined;
    const value = this.secret(connection.credentialRef).get();
    if (!value) return undefined;
    const parsed: unknown = JSON.parse(value);
    return connection.kind === 'siwc' ? oauthCredentialSchema.parse(parsed) : z.object({ kind: z.literal('api-key'), apiKey: z.string().min(1) }).strict().parse(parsed);
  }
  getOAuthRegistration(id: string): OAuthRegistration | undefined { return this.get(id)?.oauthRegistration; }
  setOAuthRegistration(id: string, raw: OAuthRegistration, expected: CredentialExpectation): ModelConnection {
    const registration = registrationSchema.parse(raw); const state = this.state(); const connection = this.found(state, id);
    this.checkCredential(connection, expected);
    if (connection.kind !== 'siwc') throw new ModelConnectionError(400, '此连接不是 ChatGPT 登录连接。');
    if (connection.oauthRegistration && (connection.oauthRegistration.clientId !== registration.clientId || connection.oauthRegistration.issuer !== registration.issuer)) {
      throw new ModelConnectionError(409, '已有注册不可替换，请添加独立 ChatGPT 连接。');
    }
    connection.oauthRegistration = registration; connection.editRevision++; this.store.atomic(() => this.save(state)); return this.public(connection);
  }
  setOAuthCredentials(id: string, raw: OAuthCredentials, expected: CredentialExpectation): ModelConnection {
    const credential = oauthCredentialSchema.parse(raw); const state = this.state(); const connection = this.found(state, id);
    this.checkCredential(connection, expected);
    if (connection.kind !== 'siwc' || !connection.enabled) throw new ModelConnectionError(409, 'ChatGPT 连接已停用或类型不符。');
    const identity: ModelIdentity = { issuer: credential.issuer, clientId: credential.clientId, subject: credential.subject,
      ...(credential.accountId ? { accountId: credential.accountId } : {}) };
    if (connection.oauthRegistration && (connection.oauthRegistration.clientId !== identity.clientId || connection.oauthRegistration.issuer !== identity.issuer)) {
      throw new ModelConnectionError(409, '登录返回的注册不匹配。');
    }
    if (connection.identity && (connection.identity.issuer !== identity.issuer || connection.identity.clientId !== identity.clientId ||
      connection.identity.subject !== identity.subject || connection.identity.accountId !== identity.accountId)) throw new ModelConnectionError(409, '登录账号与原连接不符，请添加独立连接。');
    const oldReference = connection.credentialRef; const newReference = this.writeSecret(credential);
    try {
      if (!connection.identity) { connection.identityRevision++; connection.bindingRevision++; }
      connection.identity = identity; connection.oauthRegistration = { issuer: identity.issuer, clientId: identity.clientId };
      connection.credentialRef = newReference; connection.credentialVersion++; connection.credentialConfigured = true;
      connection.status = credential.scope.split(/\s+/).includes('chatgpt.tokens.use.direct') ? 'ready' : 'scope-required';
      this.store.atomic(() => this.save(state));
    } catch (error) { this.dropSecret(newReference); throw error; }
    this.dropSecret(oldReference); return this.public(connection);
  }
  /** An ID token can establish identity without granting model-inference scope or returning an access token. */
  setOAuthIdentity(id: string, raw: ModelIdentity, expected: CredentialExpectation): ModelConnection {
    const identity = registrationSchema.extend({ subject: z.string().min(1).max(1000), accountId: z.string().min(1).max(1000).optional(), label: z.string().max(300).optional() }).strict().parse(raw);
    const state = this.state(); const connection = this.found(state, id); this.checkCredential(connection, expected);
    if (connection.kind !== 'siwc' || !connection.enabled) throw new ModelConnectionError(409, 'ChatGPT 连接已停用或类型不符。');
    if (connection.oauthRegistration && (connection.oauthRegistration.clientId !== identity.clientId || connection.oauthRegistration.issuer !== identity.issuer)) {
      throw new ModelConnectionError(409, '登录返回的注册不匹配。');
    }
    if (connection.identity && (connection.identity.issuer !== identity.issuer || connection.identity.clientId !== identity.clientId ||
      connection.identity.subject !== identity.subject || connection.identity.accountId !== identity.accountId)) throw new ModelConnectionError(409, '登录账号与原连接不符，请添加独立连接。');
    if (!connection.identity) { connection.identityRevision++; connection.bindingRevision++; }
    const oldReference = connection.credentialRef; delete connection.credentialRef;
    connection.identity = identity; connection.oauthRegistration = { issuer: identity.issuer, clientId: identity.clientId };
    connection.credentialVersion++; connection.credentialConfigured = false; connection.status = 'scope-required';
    this.store.atomic(() => this.save(state)); this.dropSecret(oldReference); return this.public(connection);
  }
  clearCredential(id: string, expected: CredentialExpectation): ModelConnection {
    const state = this.state(); const connection = this.found(state, id); this.checkCredential(connection, expected);
    if (connection.credentialSource === 'environment') throw new ModelConnectionError(409, '环境凭据需在部署环境移除。');
    const reference = connection.credentialRef; delete connection.credentialRef;
    connection.credentialVersion++; connection.editRevision++; connection.credentialConfigured = false;
    connection.status = 'needs-login'; this.store.atomic(() => this.save(state));
    this.dropSecret(reference); return this.public(connection);
  }
  setAuthState(id: string, status: ModelConnectionStatus, expected?: CredentialExpectation): ModelConnection {
    z.enum(['ready', 'needs-login', 'disabled', 'reauth-required', 'scope-required']).parse(status);
    const state = this.state(); const connection = this.found(state, id); if (expected) this.checkCredential(connection, expected);
    connection.status = status; this.store.atomic(() => this.save(state)); return this.public(connection);
  }
  setCatalog(id: string, raw: ModelCatalogEntry[], expected: { expectedIdentityRevision?: number;
    expectedCredentialVersion?: number; expectedBindingRevision?: number } = {}): ModelConnection {
    const entries = z.array(z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(300),
      reasoning: z.array(z.string().min(1).max(80)).max(30).optional(), inputModalities: z.array(z.string().max(50)).max(20).optional(),
      contextWindow: modelContextWindowSchema.optional(), source: z.enum(['provider', 'manual']),
      updatedAt: z.string().datetime().optional() }).strict()).max(1000).parse(raw);
    const state = this.state(); const connection = this.found(state, id);
    if (expected.expectedIdentityRevision !== undefined && expected.expectedIdentityRevision !== connection.identityRevision ||
      expected.expectedBindingRevision !== undefined && expected.expectedBindingRevision !== connection.bindingRevision ||
      expected.expectedCredentialVersion !== undefined && expected.expectedCredentialVersion !== connection.credentialVersion) throw new ModelConnectionError(409, '模型目录所属登录已改变。');
    connection.models = entries; this.store.atomic(() => this.save(state)); return this.public(connection);
  }
  recordDiagnostic(id: string, raw: ModelConnectionDiagnostic, expected: DiagnosticExpectation): boolean {
    const value = z.object({ category: z.enum(['quota', 'transport', 'model', 'permission', 'credential', 'protocol']),
      message: z.string().trim().min(1).max(500), code: z.string().min(1).max(120).optional(), status: z.number().int().min(100).max(599).optional(),
      at: z.string().datetime(), modelId: z.string().min(1).max(200).optional() }).strict().parse(raw);
    const state = this.state(); const connection = state.connections.find(item => item.id === id);
    if (!connection || connection.identityRevision !== expected.expectedIdentityRevision ||
      expected.expectedBindingRevision !== undefined && connection.bindingRevision !== expected.expectedBindingRevision) return false;
    connection.recentDiagnostic = { ...value, message: this.redact(value.message),
      ...(value.code ? { code: this.redact(value.code) } : {}), ...(value.modelId ? { modelId: this.redact(value.modelId) } : {}) };
    this.store.atomic(() => this.save(state)); return true;
  }
  clearDiagnostic(id: string, expected: DiagnosticExpectation): boolean {
    const state = this.state(); const connection = state.connections.find(item => item.id === id);
    if (!connection || connection.identityRevision !== expected.expectedIdentityRevision ||
      expected.expectedBindingRevision !== undefined && connection.bindingRevision !== expected.expectedBindingRevision) return false;
    if (!connection.recentDiagnostic) return true;
    delete connection.recentDiagnostic; this.store.atomic(() => this.save(state)); return true;
  }
  getOrCreateHostId(): string {
    return this.store.atomic(() => { const prior = this.store.getMeta<string | null>('models.hostId', null);
      const id = prior ? prior.startsWith('urn:uuid:') ? prior : 'urn:uuid:' + prior : 'urn:uuid:' + randomUUID();
      if (id !== prior) this.store.setMeta('models.hostId', id); return id; });
  }
  listCatalog(id: string): ModelCatalogEntry[] { return this.get(id)?.models ?? []; }
  setActiveTaskBindingReader(reader: () => Array<{ id: string; modelBinding?: ModelBinding | null }>): void { this.activeTaskBindings = reader; }
  references(id: string): ModelConnectionReferences {
    const state = this.state(); this.found(state, id);
    return { global: state.defaults.global?.connectionId === id,
      background: state.defaults.background.mode === 'explicit' && state.defaults.background.selection.connectionId === id,
      scenes: state.scenes.filter(scene => scene.preference.mode === 'explicit' && scene.preference.selection.connectionId === id).map(scene => scene.caseId),
      activeRuns: this.store.list('runs').filter(run => run.status === 'running' && run.modelBinding?.selection.connectionId === id).map(run => run.id),
      activeTasks: this.activeTaskBindings().filter(task => task.modelBinding?.selection.connectionId === id).map(task => task.id) };
  }
  archive(id: string, expectedRevision: number): ModelConnection {
    const state = this.state(); const connection = this.found(state, id);
    if (connection.editRevision !== expectedRevision) throw new ModelConnectionError(409, '模型连接已改变，请重新打开后操作。');
    connection.archived = true; connection.enabled = false; connection.editRevision++; connection.credentialVersion++;
    this.store.atomic(() => this.save(state)); return this.public(connection);
  }
  /** Keep a tombstone for historical attribution. References must be resolved explicitly first. */
  remove(id: string, expectedRevision: number): ModelConnection {
    if (this.get(id)?.credentialSource === 'environment') throw new ModelConnectionError(409, '环境凭据连接只能停用，不能在应用中删除其凭据。');
    const refs = this.references(id);
    if (refs.global || refs.background || refs.scenes.length || refs.activeRuns.length || refs.activeTasks.length) {
      throw new ModelConnectionError(409, '该连接仍被默认配置、场景或运行引用，请先处理引用；也可停用连接。');
    }
    const connection = this.archive(id, expectedRevision);
    return this.clearCredential(id, { expectedCredentialVersion: connection.credentialVersion });
  }
  hubSettings(): { apiBaseUrl: string; model: string; apiKey?: string } {
    const hub = this.state().hub; let apiKey = hub.environment ? process.env.DEEPSEEK_API_KEY?.trim() : undefined;
    if (hub.credentialRef) { const value = this.secret(hub.credentialRef).get(); if (value) apiKey = (JSON.parse(value) as { apiKey: string }).apiKey; }
    return { apiBaseUrl: hub.apiBaseUrl, model: hub.model, ...(apiKey ? { apiKey } : {}) };
  }
  /** Redact current credential material without exposing a credential-enumeration API to callers. */
  redact(value: string, jsonEncoded = false): string {
    const state = this.state(); const secrets = new Set<string>();
    const collect = (credential: ModelCredential | undefined) => {
      if (!credential) return;
      if (credential.kind === 'api-key') { secrets.add(credential.apiKey); return; }
      for (const token of [credential.accessToken, credential.refreshToken, credential.idToken,
        credential.pendingRefresh?.accessToken, credential.pendingRefresh?.refreshToken, credential.pendingRefresh?.idToken]) if (token) secrets.add(token);
    };
    for (const connection of state.connections) collect(this.getCredential(connection.id));
    const hubKey = this.hubSettings().apiKey; if (hubKey) secrets.add(hubKey);
    const legacyKey = this.store.getApiKey(); if (legacyKey) secrets.add(legacyKey);
    const patterns = [...secrets].map(secret => jsonEncoded ? JSON.stringify(secret).slice(1, -1) : secret);
    for (const secret of patterns.sort((a, b) => b.length - a.length)) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  /** Transitional Settings writer only updates the migrated connection, never a new active connection. */
  syncLegacySettings(settings: Settings, credentialChanged: boolean): void {
    const state = this.store.getMeta<SavedModels | null>(metadataKey, null); if (!state) return;
    const connection = state.connections.find(item => item.id === LEGACY_MODEL_CONNECTION_ID); if (!connection) return;
    const endpoint = settings.apiBaseUrl.replace(/\/+$/, '');
    const endpointChanged = connection.endpoint !== endpoint; const oldReference = connection.credentialRef;
    let newReference: string | undefined;
    try {
      if (credentialChanged && connection.credentialSource !== 'environment') { const key = this.store.getApiKey(); if (key) newReference = this.writeSecret({ kind: 'api-key', apiKey: key }); }
      if (endpointChanged) {
        connection.endpoint = endpoint; connection.bindingRevision++; connection.credentialSource = 'saved';
        delete connection.contextWindows;
      }
      if (credentialChanged || endpointChanged) {
        if (credentialChanged && connection.credentialVersion > 0) connection.identityRevision++;
        connection.credentialRef = newReference; connection.credentialVersion++;
        connection.credentialConfigured = Boolean(newReference); connection.status = newReference ? 'ready' : 'needs-login';
        clearProviderWindows(connection);
      }
      connection.editRevision++;
      if (state.defaults.global?.connectionId === LEGACY_MODEL_CONNECTION_ID) {
        state.defaults.global = this.legacySelection(settings); state.defaults.revision++;
      }
      this.store.atomic(() => this.save(state));
      if (credentialChanged || endpointChanged) this.dropSecret(oldReference);
    } catch (error) { this.dropSecret(newReference); throw error; }
  }
}
