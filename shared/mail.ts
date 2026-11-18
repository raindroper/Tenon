import { z } from 'zod';

const reference = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const identifier = z.string().min(1).max(300).regex(/^[A-Za-z0-9_-]+$/);
const email = z.string().trim().min(3).max(254).email().refine(value => !/[\r\n]/.test(value));
const xmlText = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value) && !/\p{Cs}/u.test(value);
export const mailBodySchema = z.string().max(200_000).refine(xmlText);
export const mailAttachmentRefSchema = z.object({ id: identifier, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Exact approved recipients and immutable resources, never credentials or a transport instruction. */
export const mailTaskSpecSchema = z.object({
  connectionId: identifier,
  credentialRevision: z.number().int().positive(),
  mode: z.enum(['send', 'reply', 'replyAll', 'forward']),
  source: z.object({ messageId: reference, revision: reference, contextId: identifier }).strict().optional(),
  to: z.array(email).max(50), cc: z.array(email).max(50).default([]), bcc: z.array(email).max(50).default([]),
  subject: z.string().min(1).max(998).refine(value => xmlText(value) && !/[\r\n\t]/.test(value)),
  body: mailBodySchema.optional(),
  attachments: z.array(mailAttachmentRefSchema).max(10).default([]),
  protection: z.literal('plaintext'),
  allowProtectedSourcePlaintext: z.literal(true).optional(),
}).strict().refine(value => value.mode === 'send' ? !value.source : Boolean(value.source), '回复或转发须绑定已核验的原邮件，新邮件不附带原邮件引用。')
  .refine(value => value.to.length + value.cc.length + value.bcc.length > 0 && value.to.length + value.cc.length + value.bcc.length <= 50, '须指定一至五十个精确收件地址。')
  .refine(value => new Set([...value.to, ...value.cc, ...value.bcc].map(address => address.toLowerCase())).size === value.to.length + value.cc.length + value.bcc.length, '收件地址不能重复。')
  .refine(value => new Set(value.attachments.map(attachment => attachment.id)).size === value.attachments.length, '附件不能重复。');
export type MailTaskSpec = z.infer<typeof mailTaskSpecSchema>;
export type MailAttachmentRef = z.infer<typeof mailAttachmentRefSchema>;
export const EWS_MAIL_OPERATION_PREFIX = 'connectors.ews.mail-operation.';
export type EwsMailOperationState = 'prepared' | 'submitting' | 'submitted' | 'failed' | 'unknown';
/** Durable transport truth. A draft or prepared record never proves submission. */
export interface EwsMailOperation {
  id: string; taskId: string; caseId: string; approvalRevision: number; requirementsRevision: number;
  specHash: string; payloadHash?: string; connectionId: string; credentialRevision: number;
  state: EwsMailOperationState; createdAt: string; updatedAt: string; error?: string;
  phase?: string; body?: string; draftId?: string; draftChangeKey?: string; sentMessageId?: string;
  submittedAt?: string; attachmentCount?: number;
  internetMessageId?: string;
  replyTracking?: boolean;
  /** Bounded read-only follow-up; a missing sent-copy index never authorizes another send. */
  receiptLookup?: { attempts: number; state: 'pending' | 'found' | 'unavailable'; nextAt?: string;
    checkedAt?: string; reason?: 'not_indexed' | 'ambiguous' | 'read_failed' };
  attachmentsAdded?: { id: string; sha256: string; nativeId: string }[];
}
/** Public receipt omits retained body and transport-private identifiers. */
export interface MailTaskReceipt { operationId: string; state: EwsMailOperationState; updatedAt: string; error?: string; replyTracking?: boolean }
