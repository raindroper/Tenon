import { z } from 'zod';
import { MAX_WECHAT_OBSERVATIONS_PER_DEVICE, weChatObservationId } from '../shared/wechat-observation.js';
import type { WeChatTopic } from './wechat-transport.js';
import { weChatChatSchema, type WeChatChat } from './wechat-database.js';

type Selection = { id: string; topic: WeChatTopic; addedAt?: string; paused?: boolean; historySince?: string; historyUntil?: string; analysisIntervalMinutes?: number };
export type SavedWeChatSelection = Selection & ({ chat: WeChatChat } | { legacyTitle: string });
export type SavedWeChatSettings = { autoStart: boolean; entries: SavedWeChatSelection[] };

const settingsSchema = z.object({
  autoStart: z.boolean(),
  entries: z.array(z.unknown()).max(MAX_WECHAT_OBSERVATIONS_PER_DEVICE),
}).strict();
const baseSelection = z.object({
  id: weChatObservationId,
  paused: z.boolean().optional(),
  addedAt: z.string().datetime().optional(),
  historySince: z.string().datetime().optional(),
  historyUntil: z.string().datetime().optional(),
  analysisIntervalMinutes: z.number().int().min(1).max(60).optional(),
  topic: z.object({ id: weChatObservationId, title: z.string().min(1).max(200)
    .refine(value => Boolean(value.trim()) && !value.includes('\0')) }).strict(),
});
const oldTitle = z.string().min(1).max(200).refine(value => Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value));
const selectionSchema = z.union([
  baseSelection.extend({ chat: weChatChatSchema }).strict(),
  baseSelection.extend({ legacyTitle: oldTitle }).strict(),
  baseSelection.extend({ window: z.object({ title: oldTitle }) }).strict()
    .transform(({ id, topic, window }) => ({ id, topic, legacyTitle: window.title })),
]);

export function sameWeChatChat(left: WeChatChat, right: WeChatChat): boolean {
  return left.accountId === right.accountId && left.chatId === right.chatId;
}

export function readSavedWeChatSettings(value: unknown): SavedWeChatSettings {
  const settings = settingsSchema.safeParse(value);
  if (!settings.success) return { autoStart: false, entries: [] };
  const valid = settings.data.entries.flatMap(value => {
    const entry = selectionSchema.safeParse(value);
    return entry.success ? [entry.data] : [];
  });
  // A selected chat must map to exactly one topic for this device.
  const entries = valid.filter((entry, index) => !valid.some((other, otherIndex) => otherIndex !== index && (
    entry.id === other.id || 'chat' in entry && 'chat' in other && sameWeChatChat(entry.chat, other.chat)
  )));
  const autoStart = settings.data.autoStart && entries.some(entry => 'chat' in entry) && entries.length === settings.data.entries.length;
  return { autoStart, entries };
}
