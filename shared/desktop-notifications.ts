import { z } from 'zod';

export const desktopNoticeSchema = z.object({
  key: z.string().min(1).max(300), title: z.string().min(1).max(120), body: z.string().max(240),
  caseId: z.string().min(1).max(200),
}).strict();
export const desktopBadgeCountSchema = z.number().int().nonnegative();
export type DesktopNotice = z.infer<typeof desktopNoticeSchema>;
export interface NotificationBridge {
  show(notice: DesktopNotice): Promise<void>;
  clear(): Promise<void>;
  setBadge?(count: number): Promise<void>;
  onOpen(listener: (caseId: string) => void): () => void;
}
