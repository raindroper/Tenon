import { z } from 'zod';

export const MAX_WECHAT_OBSERVATIONS_PER_DEVICE = 5;
export const weChatObservationId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const label = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const weChatObservationSelection = z.object({
  deviceId: weChatObservationId, windowId: weChatObservationId, caseId: weChatObservationId,
  title: label.optional(), chatType: z.enum(['group', 'private']).optional(),
  historySince: z.string().datetime({ offset: true }).optional(),
  historyUntil: z.string().datetime({ offset: true }).optional(),
  analysisIntervalMinutes: z.number().int().min(1).max(60).optional(),
}).strict();
export const weChatObservationBinding = z.object({ grantId: weChatObservationId, windowId: weChatObservationId }).strict();

const encoder = new TextEncoder();
const row = z.object({
  id: weChatObservationId,
  messageId: weChatObservationId.optional(),
  text: z.string().min(1).max(4000).refine(value => !value.includes('\0')),
  senderName: label.optional(), isSelf: z.boolean().optional(), sentAt: z.string().datetime({ offset: true }).optional(),
  messageType: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
  partIndex: z.number().int().min(0).max(4095).optional(), partCount: z.number().int().min(1).max(4096).optional(),
}).strict().refine(value => Boolean(value.text.trim()) || (value.partCount ?? 0) > 1)
  .refine(value => value.partIndex === undefined && value.partCount === undefined ||
    value.partIndex !== undefined && value.partCount !== undefined && value.partIndex < value.partCount);

export const weChatObservationBatch = weChatObservationBinding.extend({ rows: z.array(row).max(20) }).strict()
  .refine(batch => batch.rows.reduce((bytes, item) => bytes + encoder.encode(item.text).byteLength, 0) <= 24 * 1024);

export type WeChatObservationSelection = z.infer<typeof weChatObservationSelection>;
export type WeChatObservationBinding = z.infer<typeof weChatObservationBinding>;
export type WeChatObservationBatch = z.infer<typeof weChatObservationBatch>;
export interface WeChatObservationGrant extends WeChatObservationSelection { id: string; createdAt: string; expiresAt: string; stoppedAt?: string }
export interface WeChatObservationReceipt { accepted: number; duplicates: number }
export interface WeChatObservationRevocation { id: string; revoked: true }
export interface WeChatObservationStop { id: string; stopped: true }
export interface WeChatMessageView {
  id: string; messageId: string; content: string; title: string | null; sentAt: string | null; receivedAt: string;
  senderName: string | null; isSelf: boolean | null; messageType: string;
  partIndex: number | null; partCount: number | null;
}
export interface WeChatConversationStatus {
  conversationId: string; grantId: string; caseId: string; title: string | null; chatType: 'group' | 'private' | null;
  previousTitles: string[];
  transport: 'collecting' | 'reconnecting' | 'stopped'; coverageStartAt: string;
  historyUntil: string | null; liveSince: string;
  analysisIntervalMinutes: number; totalRows: number; totalMessages: number; lastReceivedAt: string | null;
  earliestMessageAt: string | null; latestMessageAt: string | null;
  analysis: { pendingCount: number; processingCount: number; failedCount: number; analyzedCount: number; lastAnalyzedAt: string | null };
  recent: WeChatMessageView[];
}
