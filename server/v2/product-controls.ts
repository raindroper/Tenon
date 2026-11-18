import { createHash, randomUUID } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { productCommandSchema, type ProductControl, type ProductOperation } from '../../shared/product-control.js';
import type { RuntimeApi } from '../runtime.js';
import type { PersonalMemoryMutationContext } from '../../shared/personal-memory.js';
import { RuntimeInputError } from '../runtime.js';
import type { Store } from '../store.js';
import type { EventInbox, StoredEvent } from './events.js';
import { isOwnerChatEvent } from './consent.js';
import type { createRecallSession } from './recall.js';
import type { SceneBackgrounds } from './scene-background.js';

const label = (value: string) => value.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const requestSchema = z.object({ operations: z.array(productCommandSchema).min(1).max(8) }).strict();
const inspectSchema = z.object({ resource: z.enum(['scenes', 'memories', 'connectors']),
  query: z.string().trim().max(200).optional(), key: z.string().trim().min(1).max(200).optional(),
  includeHistory: z.boolean().default(false), offset: z.number().int().min(0).max(100000).default(0) }).strict();

/** Chat is an adapter over RuntimeApi. No scene, memory or connector has a second writer. */
export class ProductControls {
  constructor(private readonly store: Store, private readonly runtime: RuntimeApi, private readonly backgrounds: SceneBackgrounds,
    private readonly inbox: EventInbox) {}

  previous(eventId: string): ProductControl | undefined {
    return this.store.list('runs').find(run => run.productControl?.sourceEventId === eventId)?.productControl;
  }

  tools(event: StoredEvent, recall: ReturnType<typeof createRecallSession>, guard: () => void,
    accept: (control: ProductControl) => void): Record<string, ReturnType<typeof createTool>> {
    const owner = this.store.get('messages', event.externalId);
    if (!isOwnerChatEvent(event) || owner?.role !== 'user' || owner.caseId !== event.caseId || owner.content !== event.payload.content) return {};
    const knownScenes = new Set([event.caseId!]);
    const knownMemories = new Set<string>();
    const knownVersions = new Map<string, Set<number>>();
    const knownConnections = new Set<string>();
    const knownCredentials = new Set<string>();
    let submitted: { input: string; result: Promise<{ accepted: true; completed: false; sourceEventId: string }> } | undefined;
    const requireScene = (id: string) => { if (!knownScenes.has(id)) throw new Error('请先用 inspect_product 找到具体场景，不能猜 ID。'); };
    return {
      inspect_product: createTool({ id: 'inspect_product',
        description: '查看产品内真实的场景、记忆或连接器，返回操作所需 ID。场景包括已归档项；query 可筛选，offset 分页。记忆只把有效版本作为现行理解；本人明确管理某条历史时才传 key 与 includeHistory=true。连接器返回已配置平台、连接范围及已保存凭证 ID，绝不返回密钥。先查明目标，重名或范围不明先澄清。',
        inputSchema: inspectSchema, execute: async ({ resource, query, key, includeHistory, offset }) => {
          guard(); const matches = (text: string) => !query || text.toLowerCase().includes(query.toLowerCase());
          if (resource === 'scenes') {
            const all = (await this.runtime.listCases()).filter(item => matches(item.title));
            const scenes = await Promise.all(all.slice(offset, offset + 20).map(async item => {
              knownScenes.add(item.id);
              return { caseId: item.id, sourceCaseId: item.id, title: item.title, status: item.status,
                objective: await this.backgrounds.context(item), backgroundSources: item.backgroundSources };
            }));
            guard(); return { scenes, nextOffset: offset + 20 < all.length ? offset + 20 : null };
          }
          if (resource === 'memories') {
            const all = (await this.runtime.listPersonalMemory()).filter(item => (!key || item.key === key)
              && matches(item.key + (item.effectiveStatus === 'active' ? item.value : '')));
            const memories = all.slice(offset, offset + 20).map(item => {
              knownMemories.add(item.key);
              knownVersions.set(item.key, new Set([item.revision, ...(key && includeHistory ? item.history.map(version => version.revision) : [])]));
              return { key: item.key, subject: item.subject, revision: item.revision, status: item.effectiveStatus,
                scope: item.scope, caseIds: item.caseIds, domains: item.domains, kind: item.kind,
                ...(item.effectiveStatus === 'active' ? { value: item.value } : {}),
                ...(key && includeHistory ? { history: [{ revision: item.revision, value: item.value, status: item.status },
                  ...item.history.map(version => ({ revision: version.revision, value: version.value, status: version.status }))],
                meaning: '这些是本人要求管理的历史版本，不能当作当前事实或自动恢复。' } : {}) };
            });
            guard(); return { memories, nextOffset: offset + 20 < all.length ? offset + 20 : null };
          }
          const directory = await this.runtime.connectorSettings?.list();
          guard();
          if (!directory) return { unavailable: true, reason: '当前未接入连接器管理。' };
          directory.connections.forEach(item => knownConnections.add(item.id));
          directory.tencentDocsCredentials.forEach(item => knownCredentials.add(item.id));
          return directory;
        } }),
      manage_product: createTool({ id: 'manage_product',
        description: '执行本人当前明确要求的产品内部操作。普通操作无需二次批准；能力询问、历史、转述、外部资料、自主建议都不授权。可一次提交最多8个已确定操作。创建场景默认结合相关本人原话整理背景，必要时先 recall；仅提取相关且已确认的信息，不把助手建议、猜测或整段历史填入。background 必须附当前消息或本轮 recall 得到的 sourceMessageIds；无资料时留空并说明。scene.archive 是移出活动列表、保留历史且可恢复，会停止该场景任务和提醒；restore 不恢复旧任务许可。记忆撤回保留版本；恢复须先核对具体版本。连接只限本人指定平台、场景和范围；OAuth 交给本人登录，Token 只能在连接器面板保存，不能索取或传入聊天。工具返回 accepted 仅表示指令已保存，之后由产品写回真实结果，不能提前宣称完成；提交后结束本轮，不再生成任务或调用写工具。',
        inputSchema: requestSchema, execute: async input => {
          guard(); const signature = JSON.stringify(input);
          if (submitted) {
            if (submitted.input !== signature) throw new Error('本条消息已有操作批次，请等待实际结果。');
            return submitted.result;
          }
          const result = (async () => {
            if (this.previous(event.id)) throw new Error('本条消息已有操作记录，不能重复执行。');
            const operations: ProductOperation[] = [];
            for (const command of input.operations) {
              if ('caseId' in command) requireScene(command.caseId);
              if (command.action === 'scene.update' && command.title === undefined && !command.background) throw new Error('请给出要修改的名称或背景。');
              if (command.action.startsWith('memory.')) {
                const memoryCommand = command as Extract<typeof command, { key: string }>;
                const existing = (await this.runtime.listPersonalMemory()).find(item => item.key === memoryCommand.key);
                if ((existing || command.action !== 'memory.set') && !knownMemories.has(memoryCommand.key)) throw new Error('请先查看要管理的记忆和版本。');
                if (existing && !knownVersions.get(memoryCommand.key)?.has(existing.revision)) throw new Error('记忆已在查看后发生变化，请重新核对现行版本。');
                if (memoryCommand.expectedRevision !== undefined && memoryCommand.expectedRevision !== (existing?.revision ?? 0)) throw new Error('记忆版本已变化。');
                memoryCommand.expectedRevision = existing?.revision ?? 0;
                if (command.action === 'memory.restore' && !knownVersions.get(command.key)?.has(command.revision)) throw new Error('请先查看并核对要恢复的历史版本。');
                if ('caseIds' in command) command.caseIds?.forEach(requireScene);
                if (command.action === 'memory.set' && !existing && (command.scope ?? 'case') === 'case' && !command.caseIds) command.caseIds = [event.caseId!];
              }
              if ('connectionId' in command && !knownConnections.has(command.connectionId)) throw new Error('请先查看具体连接。');
              if (command.action === 'connector.connect' && command.credentialId && !knownCredentials.has(command.credentialId)) throw new Error('请先查看已保存的凭证编号。');
              const background = 'background' in command ? command.background : undefined;
              if (background?.summary && !background.sourceMessageIds.length) throw new Error('自动整理的背景需要本人原话出处。');
              const sources = background?.summary ? await recall.references(background.sourceMessageIds) : undefined;
              guard(); operations.push({ command, state: 'accepted',
                ...(command.action === 'scene.create' ? { creationId: randomUUID() } : {}),
                ...(sources?.length ? { backgroundSources: sources } : {}) });
            }
            guard();
            accept({ sourceEventId: event.id, ownerMessageId: owner.id, acceptedAt: new Date().toISOString(), operations });
            return { accepted: true as const, completed: false as const, sourceEventId: event.id };
          })();
          submitted = { input: signature, result };
          try { return await result; } catch (error) { submitted = undefined; throw error; }
        } }),
    };
  }

  private async apply(operation: ProductOperation, control: ProductControl): Promise<string | { state: 'needs_owner'; receipt: string }> {
    const c = operation.command;
    const source = this.inbox.get(control.sourceEventId);
    const owner = this.store.get('messages', control.ownerMessageId);
    const mutation: PersonalMemoryMutationContext = {
      source: source && owner ? { kind: 'owner-message', eventId: source.id, caseId: source.caseId!, messageId: owner.id,
        contentHash: createHash('sha256').update(owner.content).digest('hex'), excerpt: owner.content.slice(0, 2000) } : { kind: 'legacy' },
      ...('expectedRevision' in c && c.expectedRevision !== undefined ? { expectedRevision: c.expectedRevision } : {}),
    };
    if (operation.backgroundSources && !await this.backgrounds.valid(operation.backgroundSources)) throw new RuntimeInputError(409, '背景来源已被纠正或撤回，请重新整理。');
    switch (c.action) {
      case 'scene.create': {
        const item = await this.runtime.createCase({ title: c.title, objective: c.background?.summary ?? '', domain: 'personal',
          requestId: operation.creationId, ...(operation.backgroundSources ? { backgroundSources: operation.backgroundSources } : {}) });
        return `已创建场景「${label(item.title)}」，可从顶部场景栏打开。` + (item.objective ? `已填入背景，引用 ${item.backgroundSources?.length ?? 0} 条本人原话；可在场景详情修改。` : '背景暂留空。');
      }
      case 'scene.update': {
        const item = await this.runtime.updateCase(c.caseId, { ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.background ? { objective: c.background.summary, backgroundSources: operation.backgroundSources } : {}) });
        return `已更新场景「${label(item.title)}」${c.background ? '的背景' : '的名称'}。`;
      }
      case 'scene.archive': {
        await this.runtime.cancelCase(c.caseId);
        const item = await this.runtime.getCase(c.caseId);
        return `已归档场景「${label(item?.title ?? c.caseId)}」。历史保留，可恢复；该场景的任务和提醒已停止。`;
      }
      case 'scene.restore': {
        const item = await this.runtime.updateCase(c.caseId, { status: 'active' });
        return `已恢复场景「${label(item.title)}」及其历史。旧任务和提醒不会自动重启。`;
      }
      case 'memory.set': {
        const { action: _action, key, ...input } = c;
        const existing = (await this.runtime.listPersonalMemory()).find(item => item.key === key);
        const scope = c.scope ?? existing?.scope ?? 'case';
        const entry = await this.runtime.correctPersonalMemory(key, { ...input, scope,
          ...(scope === 'case' ? { caseIds: c.caseIds ?? existing?.caseIds ?? [] } : {}) }, mutation);
        return `已保存记忆「${label(entry.key)}」（版本 ${entry.revision}）。`;
      }
      case 'memory.retract': {
        const entry = await this.runtime.retractPersonalMemory(c.key, mutation);
        return `已撤回记忆「${label(entry.key)}」，后续不再使用；历史版本保留，可恢复。`;
      }
      case 'memory.restore': {
        const entry = await this.runtime.restorePersonalMemory(c.key, c.revision, mutation);
        return `已将记忆「${label(entry.key)}」恢复到所选版本的内容和状态，保存为版本 ${entry.revision}（${entry.status === 'active' ? '有效' : '已撤回'}）。`;
      }
      case 'connector.connect': {
        const connectors = this.runtime.connectorSettings;
        if (!connectors) throw new RuntimeInputError(409, '当前未接入连接器管理。');
        const directory = await connectors.list();
        if (!directory.providers.find(provider => provider.kind === c.kind)?.configured) return { state: 'needs_owner', receipt: `${c.kind} 尚未配置，请在「更多 → 连接器」完成平台配置后连接。当前没有新增连接。` };
        const scope = c.kind === 'github' ? 'account' : c.scope;
        if (!scope) throw new RuntimeInputError(400, '请指定此平台的观察范围。');
        const existing = directory.connections.find(item => item.kind === c.kind && (item.kind === 'github' && item.github?.kind === 'account'
          || item.caseId === c.caseId && item.scope === scope)
          && (c.kind !== 'tencent-docs' || item.credentialId === c.credentialId));
        if (existing) return `该范围已有 ${c.kind} 连接，未重复添加。`;
        if (c.kind === 'ews') return { state: 'needs_owner', receipt: '请在「更多 → 连接器 → 企业 Exchange（EWS）」填写邮箱登录信息、选择证书并确认观察范围。当前没有新增连接；请勿在聊天中提供密码或私钥。' };
        if (c.kind === 'github') return { state: 'needs_owner', receipt: '请在「更多 → 连接器 → GitHub」连接你自己的账号，授权其实际可访问的全部仓库。接入后可在所有本人场景搜索和处理不同仓库，无需逐个添加；请勿在聊天中发送令牌。当前没有新增连接。' };
        if (c.kind === 'tencent-docs') {
          if (!c.credentialId) return { state: 'needs_owner', receipt: '请先在「更多 → 连接器 → 腾讯文档令牌」保存授权，再让我连接指定文档。请勿在聊天中发送 Token。当前没有新增连接。' };
          const connection = await connectors.connectTencentDocument({ caseId: c.caseId, scope, credentialId: c.credentialId });
          return `已连接腾讯文档「${label(connection.document?.title ?? connection.scope)}」，范围仅限这份文档。`;
        }
        // Trust deployment configuration, never a model-supplied callback origin.
        const origin = process.env.RAE_PUBLIC_ORIGIN;
        if (!origin) return { state: 'needs_owner', receipt: '请在「更多 → 连接器」完成此平台的登录授权，网页会沿用当前入口地址。当前尚未连接。' };
        const authorization = await connectors.start(c.kind, { caseId: c.caseId, scope }, new URL(origin).origin);
        return { state: 'needs_owner', receipt: `已准备 ${c.kind} 的授权入口（范围：${label(scope)}）。[继续登录并授权](<${authorization.url}>)。完成授权前尚未连接；链接失效时请从连接器面板重新发起。` };
      }
      case 'connector.sync': {
        const connection = await this.runtime.connectorSettings!.sync(c.connectionId);
        if (connection.status === 'error') throw new RuntimeInputError(409, '同步未成功，请在连接器面板查看原因。');
        return `已同步 ${connection.kind} 连接「${label(connection.document?.title ?? connection.scope)}」。`;
      }
      case 'connector.disconnect':
        await this.runtime.connectorSettings!.disconnect(c.connectionId);
        return '已断开指定连接，后续观察停止；历史记录保留。';
    }
  }

  /** Called only after the originating model queue item has settled. */
  async execute(runId: string): Promise<void> {
    const run = this.store.get('runs', runId); if (!run?.productControl) return;
    for (const operation of run.productControl.operations) {
      if (operation.state !== 'accepted') continue;
      const event = this.inbox.get(run.productControl.sourceEventId);
      const owner = this.store.get('messages', run.productControl.ownerMessageId);
      if (!event || !isOwnerChatEvent(event) || event.id !== run.eventId || event.caseId !== run.caseId
        || event.externalId !== owner?.id || owner.role !== 'user' || owner.caseId !== event.caseId || owner.content !== event.payload.content) {
        operation.state = 'failed'; operation.receipt = '原始本人指令无法核实，这项操作未执行。';
        this.save(runId, run.productControl); continue;
      }
      operation.state = 'applying'; this.save(runId, run.productControl);
      try {
        const result = await this.apply(operation, run.productControl);
        operation.receipt = typeof result === 'string' ? result : result.receipt;
        operation.state = typeof result === 'string' ? 'completed' : result.state;
      }
      catch (error) {
        // A native error can follow a partial effect; never pretend rollback or blindly retry.
        operation.state = 'unknown'; operation.receipt = `${operation.command.action} 未确认完成：${error instanceof RuntimeInputError ? error.message : '请查看对应功能的实际状态，未自动重试。'}`;
      }
      this.save(runId, run.productControl);
    }
    this.publish(runId);
  }
  private save(runId: string, control: ProductControl): void {
    const run = this.store.get('runs', runId); if (run) this.store.put('runs', { ...run, productControl: control });
  }
  private publish(runId: string): void {
    const run = this.store.get('runs', runId); const control = run?.productControl;
    if (!run || !control || control.operations.some(operation => ['accepted', 'applying'].includes(operation.state))) return;
    const id = createHash('sha256').update(`product-control:${control.sourceEventId}`).digest('hex');
    this.store.put('messages', { id, role: 'assistant', caseId: run.caseId, replyTo: control.ownerMessageId, runId,
      createdAt: this.store.get('messages', id)?.createdAt ?? new Date().toISOString(), outputState: 'complete',
      content: control.operations.map(operation => operation.receipt ?? '操作结果尚未确认。').join('\n\n') });
  }
  interrupt(runId: string): void {
    const run = this.store.get('runs', runId);
    if (run?.productControl) {
      for (const operation of run.productControl.operations) {
        if (operation.state === 'accepted') { operation.state = 'failed'; operation.receipt = '上次中断时这项操作尚未开始，请重新提出需要的操作。'; }
        else if (operation.state === 'applying') { operation.state = 'unknown'; operation.receipt = '上次执行中断，无法确认这项操作是否完成；请先查看实际状态，未自动重做。'; }
      }
      this.save(run.id, run.productControl); this.publish(run.id);
    }
  }
  recover(): void { for (const run of this.store.list('runs')) if (run.productControl) this.interrupt(run.id); }
}
