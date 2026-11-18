import { modelContextWindowSchema, type ModelCatalogEntry, type ModelConnection, type ModelConnectionInput, type ModelDefaults,
  type ModelDirectory, type ModelPreference, type ModelSelection, type SceneModelPreference } from '../../shared/model-connections.js';
import { ModelConnectionError, type ModelConnections } from './connections.js';
import type { SiwcAuthService, SiwcLoginStart, SiwcLoginStatus } from './siwc.js';

export interface RuntimeModelCommands {
  list(): Promise<ModelDirectory>;
  save(input: ModelConnectionInput): Promise<ModelConnection>;
  remove(id: string, expectedRevision: number): Promise<ModelDirectory>;
  defaults(input: { global?: ModelSelection | null; background?: ModelPreference; expectedRevision: number }): Promise<ModelDefaults>;
  scene(id: string, input: { preference: ModelPreference; expectedRevision: number }): Promise<SceneModelPreference>;
  catalog(id: string): Promise<ModelCatalogEntry[]>;
  test(selection: ModelSelection): Promise<{ ok: boolean; message: string; model?: string }>;
  login(input: { connectionId?: string; name?: string; redirectUri?: string; reconsent?: boolean }): Promise<SiwcLoginStart>;
  loginStatus(id: string): Promise<SiwcLoginStatus>;
  completeLogin(id: string, callbackUrl: string): Promise<SiwcLoginStatus>;
  cancelLogin(id: string): Promise<void>;
  logout(id: string): Promise<{ remoteRevoked: boolean; message?: string }>;
}

interface Options {
  connections: ModelConnections; auth: SiwcAuthService;
  initialize(): Promise<void>;
  mutate<T>(work: () => Promise<T>): Promise<T>;
  stopConnection(id: string): Promise<void>;
  withConnectionStopped<T>(id: string, work: () => Promise<T>): Promise<T>;
  requireScene(id: string): Promise<unknown>;
  test(selection: ModelSelection): Promise<{ ok: boolean; message: string; model?: string }>;
}

/** Owner commands use the existing runtime lifecycle. No connection command enables inference. */
export function modelCommands(options: Options): RuntimeModelCommands {
  const { connections, auth } = options;
  const mutation = <T>(work: () => Promise<T>) => options.mutate(async () => { await options.initialize(); return work(); });
  return {
    list: async () => { await options.initialize(); return connections.directory(); },
    save: input => mutation(async () => {
      const before = input.id ? connections.get(input.id) : undefined;
      const saved = connections.upsert(input);
      if (before && (!saved.enabled || before.bindingRevision !== saved.bindingRevision || before.identityRevision !== saved.identityRevision)) {
        await options.stopConnection(saved.id);
      }
      return saved;
    }),
    remove: (id, revision) => mutation(async () => { connections.remove(id, revision); return connections.directory(); }),
    defaults: input => mutation(async () => connections.setDefaults(input)),
    scene: (id, input) => mutation(async () => { await options.requireScene(id); return connections.setScene(id, input); }),
    catalog: id => mutation(async () => {
      const connection = connections.get(id);
      if (!connection) throw new ModelConnectionError(404, '模型连接不存在。');
      if (connection.kind === 'siwc') return auth.listModels(id);
      const credential = connections.getCredential(id);
      if (!connection.enabled || credential?.kind !== 'api-key') throw new ModelConnectionError(409, '请先配置此连接的密钥。');
      const version = connection.credentialVersion;
      const response = await fetch(connection.endpoint.replace(/\/+$/, '') + '/models', {
        headers: { Authorization: `Bearer ${credential.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new ModelConnectionError(409, `模型目录返回 ${response.status}，也可以手动填写模型 ID。`); }
      const value: unknown = await response.json();
      const entries = value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
        ? (value as { data: unknown[] }).data : [];
      const catalog: ModelCatalogEntry[] = entries.slice(0, 1000).flatMap(item => {
        if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') return [];
        const { id: model, context_window } = item as { id: string; context_window?: unknown };
        const window = modelContextWindowSchema.safeParse(context_window);
        return model && model.length <= 200 ? [{ id: model, name: model, source: 'provider' as const,
          updatedAt: new Date().toISOString(), ...(window.success ? { contextWindow: window.data } : {}) }] : [];
      });
      connections.setCatalog(id, catalog, { expectedIdentityRevision: connection.identityRevision,
        expectedCredentialVersion: version, expectedBindingRevision: connection.bindingRevision });
      return catalog;
    }),
    test: selection => options.test(selection),
    login: input => mutation(() => auth.start(input)),
    loginStatus: async id => { await options.initialize(); return auth.status(id); },
    completeLogin: (id, callbackUrl) => mutation(() => auth.complete(id, callbackUrl)),
    cancelLogin: id => mutation(() => auth.cancel(id)),
    logout: id => mutation(() => options.withConnectionStopped(id, () => auth.logout(id))),
  };
}
