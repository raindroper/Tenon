import type { EwsConnectionDetails } from './ews.js';
import type { GitHubConnectionDetails } from './github.js';
import type { OAuthAppSetup } from './oauth-apps.js';

export const connectorKinds = ['tencent-docs', 'github', 'gmail', 'outlook', 'ews'] as const;
export type ConnectorKind = typeof connectorKinds[number];

export interface ConnectorOption {
  kind: ConnectorKind;
  configured: boolean;
  authorization: 'oauth' | 'token' | 'credentials';
  grantUrl?: string;
  setup?: OAuthAppSetup;
}

export interface ConnectorConnection {
  id: string;
  kind: ConnectorKind;
  caseId: string;
  scope: string;
  connectedAt: string;
  lastSyncedAt: string | null;
  status: 'watching' | 'error';
  message?: string;
  credentialId?: string;
  document?: ConnectorDocumentMetadata;
  ews?: EwsConnectionDetails;
  github?: GitHubConnectionDetails;
  needsAttention?: boolean;
  nextSyncAt?: string;
}

export interface ConnectorDocumentMetadata {
  title: string;
  type?: string;
  url?: string;
}

export interface TencentDocsCredential {
  id: string;
  createdAt: string;
}

export interface ConnectorDirectory {
  providers: ConnectorOption[];
  connections: ConnectorConnection[];
  tencentDocsCredentials: TencentDocsCredential[];
}
