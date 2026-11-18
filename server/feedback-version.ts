import { createHash } from 'node:crypto';

/** Hash the full target body, even when the saved evidence excerpt is bounded. */
export function feedbackVersion(content: string): string {
  return createHash('sha256').update(content, 'utf16le').digest('hex');
}
