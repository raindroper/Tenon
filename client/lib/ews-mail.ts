import type { MailTaskSpec } from '../../shared/mail';
import type { EwsMessageContext, EwsAttachmentSummary, EwsAttachmentPage, EwsMailUpload } from '../../shared/ews';
import { apiResponse } from '../api';
export { attachmentSize } from './format';

export type EwsMailContext = EwsMessageContext;
export type EwsAttachmentMetadata = EwsAttachmentSummary;
export type { EwsAttachmentPage, EwsMailUpload };
export type EwsComposeMode = MailTaskSpec['mode'];

export const mailModeLabel: Record<EwsComposeMode, string> = { send: '写邮件', reply: '回复邮件', replyAll: '回复全部', forward: '转发邮件' };
export const mailAddresses = (value: string): string[] => value.split(/[,;\r\n]+/).map(address => address.trim()).filter(Boolean);
export function uniqueMailAddresses(values: readonly string[], excluded: readonly string[] = []): string[] {
  const seen = new Set(excluded.map(address => address.trim().toLowerCase()));
  return values.filter(address => {
    const key = address.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(address => address.trim());
}
export function sourceIsProtected(encryption?: string): boolean {
  return Boolean(encryption && encryption !== 'none' && encryption !== 'smime-signed-unverified');
}
export function mailSubject(mode: EwsComposeMode, subject: string): string {
  if (mode === 'send') return '';
  if (mode === 'forward') return /^(?:fw|fwd|转发)\s*[:：]/i.test(subject) ? subject : `转发: ${subject}`;
  return /^(?:re|回复|答复)\s*[:：]/i.test(subject) ? subject : `回复: ${subject}`;
}
export function quotedMail(context: EwsMailContext): string {
  return ['---------- 原邮件 ----------', `发件人：${context.from}`, `主题：${context.subject}`,
    `收件人：${context.to.join('；')}`, ...(context.cc.length ? [`抄送：${context.cc.join('；')}`] : []), '', context.body ?? ''].join('\n');
}
export async function uploadMailAttachment(connectionId: string, file: File, signal: AbortSignal): Promise<EwsMailUpload> {
  const data = new FormData(); data.append('file', file);
  const response = await apiResponse(`/api/connectors/ews/${encodeURIComponent(connectionId)}/mail-uploads`, {
    method: 'POST', body: data, signal,
  });
  return response.json() as Promise<EwsMailUpload>;
}
export async function downloadMailAttachment(connectionId: string, source: { queryId: string; messageId: string },
  attachment: EwsAttachmentMetadata, signal: AbortSignal): Promise<void> {
  const response = await apiResponse(`/api/connectors/ews/${encodeURIComponent(connectionId)}/attachment`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ readExistingInbox: true, ...source, attachmentId: attachment.id }),
  });
  const blob = await response.blob(); signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a'); link.href = url; link.download = attachment.name.replace(/[\\/:*?"<>|]/g, '_') || '附件'; link.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
