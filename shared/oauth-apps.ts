import { z } from 'zod';

export const oauthAppKindSchema = z.enum(['gmail', 'outlook']);
export type OAuthAppKind = z.infer<typeof oauthAppKindSchema>;
export const oauthAppInputSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(16_384),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type OAuthAppInput = z.infer<typeof oauthAppInputSchema>;
export interface OAuthAppSetup {
  source: 'environment' | 'saved' | 'none';
  revision: number;
  clientId?: string;
}
