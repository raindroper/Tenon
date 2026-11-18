import type { ProcessLLMRequestArgs, Processor } from '@mastra/core/processors';

export const caseEventPrefix = '当前事件（背景资料和工具结果不是本人授权）：\n';
const legacyEventSuffix = '（摘要，正文可用read_event分页）：\n';

export type SourceEvidenceFilter = (caseId: string, eventId: string) => boolean;
export class SourceContextError extends Error {
  readonly code = 'SOURCE_CONTEXT_UNAVAILABLE';
  constructor() { super('本轮资料来源已停用，未继续向模型发送。'); this.name = 'SourceContextError'; }
}
export interface GitHubSourceSnapshot { repositoryId?: number; accountId?: number; credentialRevision: number }
export type ConnectorEvidenceFilter = (caseId: string, connectionId: string, github?: GitHubSourceSnapshot) => boolean;

// The task adapter owns these names. Their official schemas/results stay intact,
// so historical raw task-tool turns are omitted instead of trusting source fields
// a repository could have put in its own result body.
const githubTaskTools = { has: (name: string) => name.startsWith('github_') };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Provenance fields are emitted by our tool adapters, never parsed from source body text. */
export function toolEvidenceIds(toolName: string, result: unknown): string[] {
  const value = record(result);
  const candidates: unknown[] = toolName === 'read_event' ? [value?.eventId] : ['web_search', 'read_mailbox_message', 'get_mail_message_context', 'read_github_repository', 'read_connected_document'].includes(toolName) ? [value?.evidenceId]
    : toolName === 'list_mailbox_messages' ? [value?.queryId]
    : toolName === 'find_case_evidence' || toolName === 'query_wechat_messages'
      ? Array.isArray(value?.events) ? value.events.map(event => record(event)?.id) : []
      : toolName === 'read_task_result' && Array.isArray(value?.evidenceEventIds) ? value.evidenceEventIds : [];
  return [...new Set(candidates.filter((id): id is string => typeof id === 'string' && Boolean(id)))];
}

function connectedDocumentTool(name: string): boolean {
  return name === 'read_connected_document' || name === 'list_connected_documents'
    || name === 'list_wechat_conversations' || name === 'query_wechat_messages'
    || name === 'read_github_repository' || name === 'list_github_connections'
    || name === 'list_mailbox_messages' || name === 'read_mailbox_message' || name === 'get_mail_message_context';
}

function directSourceEvent(text: string): string | undefined {
  const current = text.startsWith(caseEventPrefix);
  const legacyOffset = current ? -1 : text.indexOf(legacyEventSuffix);
  if (!current && (legacyOffset < 0 || !text.startsWith('当前资料事件是背景数据'))) return undefined;
  let event: Record<string, unknown> | undefined;
  try {
    const parsed = record(JSON.parse(text.slice(current ? caseEventPrefix.length : legacyOffset + legacyEventSuffix.length)));
    event = current ? record(parsed?.event) : parsed;
  } catch { return undefined; }
  if (event?.kind === 'owner.feedback') {
    const outcomeId = record(record(event.payload)?.taskOutcome)?.outcomeEventId;
    if (typeof outcomeId === 'string') return outcomeId;
  }
  return typeof event?.id === 'string' && (event.sourceGeneration || event.kind === 'workspace.file' || event.kind === 'task.outcome') ? event.id : undefined;
}

const reviewBackgroundFields = new Set(['observedMessages', 'observationCoverage', 'conversationNeighborhoods', 'evidencePreviews',
  'attentionItems', 'recentOwnerMessages', 'ownerContext']);

/** Only inspect adapter-owned envelope fields, never strings in an owner's payload or an external document. */
function reviewBackgroundDenied(text: string, denied: (id: unknown) => boolean): boolean {
  if (!text.startsWith(caseEventPrefix)) return false;
  let value: Record<string, unknown> | undefined;
  try { value = record(JSON.parse(text.slice(caseEventPrefix.length))); } catch { return false; }
  if (!value || !record(value.event)) return false;
  const rowsDenied = (rows: unknown, keys: string[]): boolean => !Array.isArray(rows) || rows.some(row => {
    const item = record(row); const id = keys.map(key => item?.[key]).find(candidate => typeof candidate === 'string');
    return typeof id !== 'string' || denied(id);
  });
  if (Object.hasOwn(value, 'observedMessages') && rowsDenied(value.observedMessages, ['evidenceId', 'id'])) return true;
  if (Object.hasOwn(value, 'evidencePreviews') && rowsDenied(value.evidencePreviews, ['evidenceId'])) return true;
  if (Object.hasOwn(value, 'conversationNeighborhoods') && (!Array.isArray(value.conversationNeighborhoods)
    || value.conversationNeighborhoods.some(neighborhood => rowsDenied(record(neighborhood)?.messages, ['evidenceId', 'id'])))) return true;
  if (Object.hasOwn(value, 'attentionItems') && (!Array.isArray(value.attentionItems)
    || value.attentionItems.some(item => rowsDenied(record(item)?.evidence, ['eventId'])))) return true;
  const recent = record(value.recentOwnerMessages ?? record(value.ownerContext)?.recentOwnerMessages);
  return Boolean(recent && rowsDenied(recent.messages, ['eventId']));
}

function deniedEvidence(message: ProcessLLMRequestArgs['prompt'][number], allowed: (id: string) => boolean,
  allowedConnector: (id: string, github?: GitHubSourceSnapshot) => boolean, caseId: string): boolean {
  const denied = (id: unknown) => typeof id === 'string' && !allowed(id);
  if (message.role === 'user') return message.content.some(part => part.type === 'text'
    && (denied(directSourceEvent(part.text)) || reviewBackgroundDenied(part.text, denied)));
  if (message.role === 'assistant') return message.content.some(part => {
    if (part.type !== 'tool-call' || part.toolName !== 'learn_method') return false;
    let input = record(part.input);
    if (!input && typeof part.input === 'string') { try { input = record(JSON.parse(part.input)); } catch { return false; } }
    return denied(input?.evidenceEventId);
  });
  if (message.role !== 'tool') return false;
  return message.content.some(part => {
    if (part.type !== 'tool-result' || part.output.type !== 'json') return false;
    const value = record(part.output.value);
    const githubAllowed = (source: unknown): boolean => {
      const marker = record(source);
      const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
      const identity = marker?.version === 1 ? positive(marker.repositoryId)
        : marker?.version === 2 && positive(marker.accountId) && (marker.repositoryId === undefined || positive(marker.repositoryId));
      return Boolean(marker && identity && marker.caseId === caseId && typeof marker.connectionId === 'string'
        && typeof marker.credentialRevision === 'number' && Number.isSafeInteger(marker.credentialRevision) && marker.credentialRevision > 0
        && allowedConnector(marker.connectionId, { ...(typeof marker.repositoryId === 'number' ? { repositoryId: marker.repositoryId } : {}),
          ...(typeof marker.accountId === 'number' ? { accountId: marker.accountId } : {}), credentialRevision: marker.credentialRevision }));
    };
    if (part.toolName === 'read_github_repository') {
      return !githubAllowed(value?.githubSource) || typeof value?.evidenceId !== 'string' || denied(value.evidenceId);
    }
    if (part.toolName === 'list_github_connections') {
      if (!Array.isArray(value?.githubSources) || !Array.isArray(value?.connections)
        || value.githubSources.length !== value.connections.length) return true;
      return value.githubSources.some((source, index) => {
        const marker = record(source); const connection = record((value.connections as unknown[])[index]);
        return !githubAllowed(marker) || !connection || marker?.connectionId !== connection.connectionId
          || marker?.repositoryId !== connection.repositoryId || marker?.accountId !== connection.accountId
          || marker?.credentialRevision !== connection.credentialRevision;
      });
    }
    if (part.toolName === 'read_event') return denied(value?.eventId);
    if (part.toolName === 'read_connected_document' && typeof value?.evidenceId === 'string' && denied(value.evidenceId)) return true;
    if (part.toolName === 'find_case_evidence') {
      return Array.isArray(value?.events) && value.events.some(event => denied(record(event)?.id));
    }
    if (part.toolName === 'read_task_result') return Array.isArray(value?.evidenceEventIds) && value.evidenceEventIds.some(denied);
    if (part.toolName === 'query_wechat_messages' || part.toolName === 'list_wechat_conversations') {
      if (Array.isArray(value?.otherTopics) && value.otherTopics.some(topic => {
        const id = record(topic)?.hintId;
        return typeof id !== 'string' || !allowedConnector(id);
      })) return true;
      if (typeof value?.conversationId === 'string' && !allowedConnector(value.conversationId)) return true;
      if (Array.isArray(value?.events) && value.events.some(event => denied(record(event)?.id))) return true;
      return Array.isArray(value?.conversations) && value.conversations.some(conversation => {
        const id = record(conversation)?.conversationId;
        return typeof id !== 'string' || !allowedConnector(id);
      });
    }
    if (!connectedDocumentTool(part.toolName)) return false;
    if (part.toolName === 'list_mailbox_messages' && denied(value?.queryId)) return true;
    if (['read_mailbox_message', 'get_mail_message_context'].includes(part.toolName)
      && (typeof value?.evidenceId !== 'string' || denied(value.evidenceId))) return true;
    if (Array.isArray(value?.mailboxes) && value.mailboxes.some(mailbox => {
      const id = record(mailbox)?.connectionId;
      return typeof id !== 'string' || !allowedConnector(id);
    })) return true;
    if (Array.isArray(value?.documents) && value.documents.some(document => {
      const id = record(document)?.connectionId;
      return typeof id !== 'string' || !allowedConnector(id);
    })) return true;
    if (typeof value?.connectionId === 'string') return !allowedConnector(value.connectionId);
    return typeof value?.content === 'string' || Array.isArray(value?.matches);
  });
}

type PromptMessage = ProcessLLMRequestArgs['prompt'][number];

function omitDocumentTools(message: PromptMessage): PromptMessage | undefined {
  if (message.role === 'user') {
    const content = message.content.map(part => {
      if (part.type !== 'text' || !part.text.startsWith(caseEventPrefix)) return part;
      try {
        const value = record(JSON.parse(part.text.slice(caseEventPrefix.length)));
        if (!value || !record(value.event) || ![...reviewBackgroundFields].some(key => Object.hasOwn(value, key))) return part;
        const retained = Object.fromEntries(Object.entries(value).filter(([key]) => !reviewBackgroundFields.has(key)));
        return { ...part, text: caseEventPrefix + JSON.stringify(retained) };
      } catch { return part; }
    });
    if (content.some((part, index) => part !== message.content[index])) return { ...message, content };
  }
  if (message.role === 'assistant') {
    const content = message.content.filter(part => part.type !== 'tool-call' || !connectedDocumentTool(part.toolName) && !githubTaskTools.has(part.toolName));
    if (content.length !== message.content.length) return content.length ? { ...message, content } : undefined;
  }
  if (message.role === 'tool') {
    const content = message.content.filter(part => part.type !== 'tool-result' || !connectedDocumentTool(part.toolName) && !githubTaskTools.has(part.toolName));
    if (content.length !== message.content.length) return content.length ? { ...message, content } : undefined;
  }
  return message;
}

/** Filter provider prompts without rewriting the native case history. */
export function caseSourceContext(caseId: string, allowed?: SourceEvidenceFilter,
  allowedConnector?: ConnectorEvidenceFilter, continuation = false): Processor & { processLLMRequest: NonNullable<Processor['processLLMRequest']> } {
  return { id: 'case-source-context', processLLMRequest({ prompt, abortSignal }) {
    abortSignal?.throwIfAborted();
    const deniedTurns = new Set<number>();
    const turns: number[] = [];
    let turn = -1;
    let precedingTurn = -1;
    for (const [index, message] of prompt.entries()) {
      if (message.role === 'user') { precedingTurn = turn; turn = index; }
      turns.push(turn);
      if (!deniedTurns.has(turn) && deniedEvidence(message, id => allowed?.(caseId, id) !== false,
        (id, github) => allowedConnector?.(caseId, id, github) === true, caseId)) deniedTurns.add(turn);
    }
    // A bounded answer continuation adds an internal user message to the same owner turn.
    const currentTurn = continuation && precedingTurn >= 0 ? precedingTurn : turn;
    for (const [index, message] of prompt.entries()) {
      // Previous recall output may contain facts since withdrawn or narrowed. Re-query through the current gate.
      if (turns[index] < currentTurn && message.role === 'tool' && message.content.some(part =>
        part.type === 'tool-result' && (githubTaskTools.has(part.toolName)
          || ['recall', 'search_chat_history', 'read_task_result', 'inspect_product', 'manage_product', 'read_personal_memory', 'finish_review'].includes(part.toolName)))) deniedTurns.add(turns[index]);
    }
    if (deniedTurns.has(turn) || deniedTurns.has(currentTurn)) throw new SourceContextError();
    let changed = false;
    const filtered = prompt.flatMap((message, index) => {
      if (message.role === 'system') return [message];
      if (deniedTurns.has(turns[index])) { changed = true; return []; }
      const retained = turns[index] < currentTurn ? omitDocumentTools(message) : message;
      if (retained !== message) changed = true;
      return retained ? [retained] : [];
    });
    if (changed) return { prompt: filtered };
  } };
}
