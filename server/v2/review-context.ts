import type { ConnectorService } from '../connectors/service.js';
import { evidenceTime } from '../../shared/time.js';
import type { EventInbox, InboxEvent, StoredEvent } from './events.js';

type WeChatContextAccess = Pick<ConnectorService, 'listWeChatConversations' | 'localWeChatGenerations' | 'weChatMessageView'>;
export function weChatReviewContext(options: { event: StoredEvent; inbox: EventInbox; connectors: WeChatContextAccess;
  isAllowed(event: InboxEvent): boolean; timezone: string; precedingMessages?: number }) {
  const { event, inbox, connectors, isAllowed, timezone } = options;
  if (event.kind !== 'growth.observation' || event.payload.provider !== 'wechat-desktop' || !event.caseId || !event.sourceGeneration) return undefined;
  const conversation = connectors.listWeChatConversations(event.caseId).find(value =>
    connectors.localWeChatGenerations(value.grantId).sourceGenerations.includes(event.sourceGeneration!));
  if (!conversation) throw new Error('本批微信会话已撤回或无法核对。');
  const scope = connectors.localWeChatGenerations(conversation.grantId);
  const newIds = Array.isArray(event.payload.eventIds) ? event.payload.eventIds.filter((id): id is string => typeof id === 'string') : [];
  if (!newIds.length) throw new Error('本批没有可核对的新消息。');
  for (const id of newIds) {
    const row = inbox.get(id);
    if (!row || row.sourceId !== event.sourceId || row.sourceGeneration !== event.sourceGeneration || !isAllowed(row)) throw new Error('本批部分消息已失效。');
  }
  const window = inbox.weChatNeighborhood(event.caseId, scope.sourceGenerations, newIds, isAllowed, options.precedingMessages ?? 20);
  const messages = window.events.map(source => ({ ...connectors.weChatMessageView(source), evidenceId: source.id,
    conversationId: conversation.conversationId, sourceId: source.sourceId, sourceGeneration: source.sourceGeneration,
    actor: source.actor, occurredAt: source.occurredAt, temporal: evidenceTime(source, timezone),
    newInBatch: newIds.includes(source.id), readWith: { tool: 'read_event', eventId: source.id, offset: 0 } }));
  const fragments = new Map<string, { messageId: string; expected: number; received: number[] }>();
  for (const message of messages) if (message.partCount !== null && message.partIndex !== null) {
    const partial = fragments.get(message.messageId) ?? { messageId: message.messageId, expected: message.partCount, received: [] };
    if (partial.expected !== message.partCount) throw new Error('同一逻辑消息的分片声明不一致。');
    partial.received.push(message.partIndex); fragments.set(message.messageId, partial);
  }
  const incompleteMessages = [...fragments.values()].filter(value => new Set(value.received).size !== value.expected)
    .map(value => ({ ...value, received: [...new Set(value.received)].sort((a, b) => a - b) }));
  return { conversationId: conversation.conversationId, exposedEventIds: messages.map(value => value.id),
    observedMessages: messages.filter(value => value.newInBatch), conversationNeighborhoods: [{ conversationId: conversation.conversationId,
      title: conversation.title, messages, coverage: { newEventIds: newIds, contextEventIds: messages.filter(value => !value.newInBatch).map(value => value.id),
        precedingWindowTruncated: window.truncated, incompleteMessages, originalSendTimeUnknown: messages.filter(value => value.sentAt === null).map(value => value.id),
        continuousHistoryProven: false, order: 'oldest_first', orderBasis: 'sentAt_or_receivedAt_when_send_time_unknown',
        readEarlier: messages[0] ? { tool: 'query_wechat_messages', conversation: conversation.conversationId, before: messages[0].id, limit: 20 } : null,
        meaning: '上下文消息只用于理解，不推进新增消息分析游标；时间相邻不是已证实回复。未解析的附件、原生引用和缺失分片保持未知。' } }] };
}
