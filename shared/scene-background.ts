import { z } from 'zod';

/** Attribution for an editable background snapshot, never a second memory store. */
export const sceneBackgroundSourceSchema = z.object({
  messageId: z.string().min(1).max(200), eventId: z.string().min(1).max(300),
  caseId: z.string().min(1).max(200), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
}).strict();
export const sceneBackgroundSourcesSchema = z.array(sceneBackgroundSourceSchema).min(1).max(16);
export type SceneBackgroundSource = z.infer<typeof sceneBackgroundSourceSchema>;
