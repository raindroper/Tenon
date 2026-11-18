import { z } from 'zod';

export const EWS_MAX_PFX_BYTES = 1024 * 1024;
export const EWS_MAX_BODY_CHARS = 60_000;
export const ewsEndpoint = z.string().trim().max(2048).url().refine(value => {
  if (/[\\\x00-\x20\x7f]/.test(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password
    && !url.search && !url.hash && url.pathname.toLowerCase() === '/ews/exchange.asmx';
}, '请填写 HTTPS EWS 地址（/EWS/Exchange.asmx，443 端口）。').transform(value => new URL(value).href);
const password = z.string().min(1).max(1024).refine(value => !value.includes('\0'));
export const ewsCertificate = z.object({
  pkcs12Base64: z.string().min(4).max(1_398_104).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value =>
    value.length % 4 === 0 && value.length * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <= EWS_MAX_PFX_BYTES),
  password: z.string().max(1024).refine(value => !value.includes('\0')),
}).strict();
export const ewsCredentials = z.object({
  endpoint: ewsEndpoint,
  username: z.string().trim().min(1).max(320).refine(value => !/[\x00-\x1f\x7f:]/.test(value)),
  password,
  certificate: ewsCertificate.optional(),
}).strict();
export const ewsStoredCredentials = ewsCredentials.extend({ revision: z.number().int().positive() });
export type EwsCredentials = z.infer<typeof ewsCredentials>;
export type EwsStoredCredentials = z.infer<typeof ewsStoredCredentials>;
export const ewsConnectInput = ewsCredentials.extend({
  caseId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  scope: z.literal('inbox'), observeNewMailAndAnalyze: z.literal(true), persistCredentials: z.literal(true),
}).strict();
export type EwsConnectInput = z.infer<typeof ewsConnectInput>;
export const ewsUpdateInput = z.object({ expectedRevision: z.number().int().positive(),
  password: password.optional(), certificate: ewsCertificate.nullable().optional(),
}).strict().refine(value => value.password !== undefined || value.certificate !== undefined);
export type EwsUpdateInput = z.infer<typeof ewsUpdateInput>;
export interface EwsConnectionDetails {
  endpoint: string; hasCertificate: boolean; credentialRevision: number; observingSince: string; establishingBaseline: boolean;
}

export const ewsQueryInput = z.object({ readExistingInbox: z.literal(true),
  subject: z.string().trim().min(1).max(240).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(25).default(25),
}).strict();
const ewsMessageId = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const ewsReadInput = z.object({ readExistingInbox: z.literal(true), messageId: ewsMessageId,
  queryId: z.string().min(1).max(300), offset: z.number().int().min(0).max(EWS_MAX_BODY_CHARS).default(0),
  limit: z.number().int().min(1).max(4000).default(4000),
}).strict();
export type EwsQueryInput = z.infer<typeof ewsQueryInput>;
export type EwsReadInput = z.infer<typeof ewsReadInput>;
export interface EwsMessageSummary {
  id: string; revision: string; subject: string; receivedAt: string; sender: string; encryptionHint: string; isRead: boolean;
}
export interface EwsMessagePage {
  messages: EwsMessageSummary[]; nextOffset: number | null; totalItems: number; queryId: string;
}
export interface EwsMessageReadPage {
  connectionId: string; messageId: string; subject: string; receivedAt: string; sender: string;
  encryption: string; bodyStatus: string; content: string; totalCharacters: number; nextOffset: number | null; truncated: boolean;
  evidenceId?: string;
}

export const ewsSelectionInput = ewsReadInput.pick({ readExistingInbox: true, messageId: true, queryId: true });
export type EwsSelectionInput = z.infer<typeof ewsSelectionInput>;
export const ewsAttachmentInput = ewsSelectionInput.extend({ attachmentId: z.uuid() }).strict();
export interface EwsMailSourceRef { messageId: string; revision: string; contextId: string }
export interface EwsMessageContext {
  evidenceId?: string;
  source: EwsMailSourceRef; credentialRevision: number; subject: string; from: string; to: string[]; cc: string[];
  replyTo?: string[]; selfAddress?: string; encryption: string; bodyStatus: string; body: string;
  totalCharacters: number; truncated: boolean;
}
export interface EwsAttachmentSummary {
  id: string; name: string; contentType: string; size: number; isInline: boolean; sourceProtected: boolean; supported: boolean;
}
export interface EwsAttachmentPage { attachments: EwsAttachmentSummary[]; sourceRef: EwsMailSourceRef }
export const EWS_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const EWS_MAX_OUTGOING_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const EWS_MAX_OUTGOING_ATTACHMENTS = 10;
export interface EwsMailUpload {
  id: string; name: string; contentType: string; size: number; sha256: string;
}
