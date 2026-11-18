import { createHash } from 'node:crypto';

/** Per-run feedback only. Original evidence and committed effects retain their own durable owners. */
export class ReviewProgress {
  outcome?: 'complete' | 'needs_input';
  decisionId?: string;
  stalled = false;
  private lastAttempt?: { key: string; result: string; count: number };

  finish(decisionId: string, outcome: 'silent' | 'observe' | 'notify' | 'needs_input' | 'propose'): void {
    if (this.decisionId && this.decisionId !== decisionId) throw new Error('本轮回顾已经提交其他决定。');
    this.decisionId = decisionId;
    this.outcome = outcome === 'needs_input' ? 'needs_input' : 'complete';
  }

  record(tool: string, input: unknown, result: unknown, failed = false): void {
    if (tool === 'finish_review') return;
    const key = createHash('sha256').update(JSON.stringify([tool, input])).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([failed, result]) ?? '').digest('hex');
    const previous = this.lastAttempt;
    const count = previous?.key === key && previous.result === fingerprint ? previous.count + 1 : 1;
    this.lastAttempt = { key, result: fingerprint, count };
    if (count >= 3) this.stalled = true;
  }

  get stopped(): boolean { return this.stalled || this.outcome !== undefined; }
}
