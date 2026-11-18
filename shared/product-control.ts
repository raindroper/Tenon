import { z } from 'zod';
import { connectorKinds } from './connectors.js';
import type { SceneBackgroundSource } from './scene-background.js';

const id = z.string().trim().min(1).max(200);
const background = z.object({ summary: z.string().trim().max(8000), sourceMessageIds: z.array(id).max(16) }).strict();
export const productCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scene.create'), title: id, background: background.optional() }).strict(),
  z.object({ action: z.literal('scene.update'), caseId: id, title: id.optional(), background: background.optional() }).strict(),
  z.object({ action: z.literal('scene.archive'), caseId: id }).strict(),
  z.object({ action: z.literal('scene.restore'), caseId: id }).strict(),
  z.object({ action: z.literal('memory.set'), key: id, value: z.string().trim().min(1).max(2000),
    kind: z.enum(['fact', 'preference', 'habit', 'experience']).optional(),
    purpose: z.enum(['identity', 'interaction', 'context']).optional(),
    identity: z.object({ kind: z.enum(['name', 'alias']), value: id, platform: id.optional(), conversationId: id.optional() }).strict().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    scope: z.enum(['case', 'domain', 'global']).optional(), caseIds: z.array(id).min(1).max(20).optional(),
    domains: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
    expiresAt: z.string().datetime().nullable().optional() }).strict(),
  z.object({ action: z.literal('memory.retract'), key: id, expectedRevision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('memory.restore'), key: id, revision: z.number().int().positive(), expectedRevision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('connector.connect'), kind: z.enum(connectorKinds), caseId: id,
    scope: z.string().trim().min(1).max(1000).optional(), credentialId: id.optional() }).strict()
    .refine(value => value.kind === 'github' || Boolean(value.scope), '此平台须指定观察范围。'),
  z.object({ action: z.literal('connector.sync'), connectionId: id }).strict(),
  z.object({ action: z.literal('connector.disconnect'), connectionId: id }).strict(),
]);
export type ProductCommand = z.infer<typeof productCommandSchema>;
export interface ProductOperation {
  command: ProductCommand;
  creationId?: string;
  backgroundSources?: SceneBackgroundSource[];
  state: 'accepted' | 'applying' | 'completed' | 'needs_owner' | 'failed' | 'unknown';
  receipt?: string;
}
/** Durable current-owner intent and native receipts, attached to the originating run. */
export interface ProductControl {
  sourceEventId: string; ownerMessageId: string; acceptedAt: string;
  operations: ProductOperation[];
}
