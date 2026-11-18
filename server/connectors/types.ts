import type { ConnectorDocumentMetadata } from '../../shared/connectors.js';
import type { EwsStoredCredentials } from '../../shared/ews.js';
import type { MailThreadEvidence } from '../../shared/task-flow.js';

export interface ConnectorToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** MSAL owns refresh-token rotation; its serialized cache is encrypted by SecretStore. */
  msalCache?: string;
  msalAccountId?: string;
  /** EWS uses password/certificate credentials; accessToken is empty for this provider. */
  ews?: EwsStoredCredentials;
}

export interface OAuthStart {
  scope: string;
  state: string;
  redirectUri: string;
  challenge: string;
}

export interface OAuthCallback {
  code: string;
  redirectUri: string;
  verifier: string;
}

export interface ScanInput {
  token: ConnectorToken;
  scope: string;
  cursor?: string;
  signal: AbortSignal;
}

export interface ConnectorChange {
  id: string;
  revision: string;
  title: string;
  content: string;
  totalCharacters?: number;
  truncated?: boolean;
  url?: string;
  mailThread?: MailThreadEvidence;
}

export interface ScanResult {
  cursor: string;
  changes: ConnectorChange[];
  document?: ConnectorDocumentMetadata;
  more?: boolean;
  notice?: string;
  /** Current authorized content; used to seed a missing baseline without replaying history. */
  documentSnapshot?: ConnectorChange;
}

export interface ConnectorProvider {
  tokenGrantUrl?: string;
  previewDocument?(input: Omit<ScanInput, 'cursor'>): Promise<ConnectorDocumentMetadata>;
  readDocument?(input: Omit<ScanInput, 'cursor'>): Promise<{ content: string; document?: ConnectorDocumentMetadata }>;
  validateScope(scope: string): string;
  authorize(input: OAuthStart, signal?: AbortSignal): URL | Promise<URL>;
  exchange(input: OAuthCallback, signal: AbortSignal): Promise<ConnectorToken>;
  refresh(token: ConnectorToken, redirectUri: string, signal: AbortSignal): Promise<ConnectorToken>;
  canRefresh?(token: ConnectorToken): boolean;
  validateReauthorization?(input: { previousToken: ConnectorToken; nextToken: ConnectorToken; scope: string; cursor: string }, signal: AbortSignal): Promise<void>;
  scan(input: ScanInput): Promise<ScanResult>;
}

export class ConnectorProviderError extends Error {
  readonly needsAttention: boolean;
  readonly retryAt?: number;
  constructor(message: string, readonly status = 502, recovery: { needsAttention?: boolean; retryAt?: number } = {}) {
    super(message); this.needsAttention = recovery.needsAttention ?? false; this.retryAt = recovery.retryAt;
  }
}
