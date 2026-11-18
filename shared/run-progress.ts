/** Display-only projection of real runtime activity. It grants no permission
 * and cannot certify delivery; native operation receipts retain that ownership. */
export type RunProgressPhase = 'preparing' | 'model' | 'tool' | 'reply' | 'settling';

export interface RunProgressOperation {
  /** The native tool call / operation identity, scoped to its parent run. */
  id: string;
  /** Controlled public text; never raw arguments, output, or exception text. */
  label: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  startedAt: string;
  endedAt?: string;
  summary?: string;
}

export interface RunProgress {
  phase: RunProgressPhase;
  phaseStartedAt: string;
  /** Actual model/tool activity only. Transport heartbeats never advance this. */
  lastActivityAt: string;
  operations: RunProgressOperation[];
}
