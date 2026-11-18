import type { ModelBinding } from './model-connections.js';
import type { UsageStatus } from './types.js';

/** One durable request receipt. Credentials and provider response bodies never belong here. */
export interface ModelCall {
  id: string;
  runId: string;
  taskId?: string;
  caseId?: string;
  createdAt: string;
  settledAt?: string;
  status: 'pending' | 'settled';
  binding?: ModelBinding;
  service?: 'hub';
  inputTokens: number;
  outputTokens: number;
  usageStatus: UsageStatus;
}
