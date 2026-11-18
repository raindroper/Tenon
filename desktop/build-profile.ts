import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { secureBaseUrl } from './security.js';

export interface DesktopBuildProfile {
  readonly appId: string;
  readonly baseUrl: string;
  readonly updates: { readonly baseUrl: string; readonly publicKey: string } | null;
}

const origin = z.string().refine(value => {
  if (!value) return true;
  try { return secureBaseUrl(value) === value; } catch { return false; }
}, 'Desktop baseUrl must be empty or a canonical HTTPS origin.');
const updateUrl = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && url.href === value && url.pathname.endsWith('/');
  } catch { return false; }
}, 'Desktop updates require a canonical HTTPS base URL ending in /.');
const publicKey = z.string().refine(value => {
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && key.export({ type: 'spki', format: 'der' }).toString('base64') === value;
  } catch { return false; }
}, 'Desktop updates require a canonical Ed25519 public key.');
const schema = z.object({
  appId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)+$/),
  baseUrl: origin,
  updates: z.object({ baseUrl: updateUrl, publicKey }).strict().nullable(),
}).strict();

/** Publication settings are validated at build time and never taken from runtime environment variables. */
export function parseDesktopBuildProfile(input: unknown): DesktopBuildProfile {
  const profile = schema.parse(input);
  return Object.freeze({ ...profile, updates: profile.updates ? Object.freeze(profile.updates) : null });
}

/** The build replaces only the compiled profile module; private values never enter source files. */
export function desktopBuildProfileModule(input: unknown): string {
  const profile = parseDesktopBuildProfile(input);
  return `const profile = ${JSON.stringify(profile)};\nexport const desktopProfile = Object.freeze({ ...profile, updates: profile.updates ? Object.freeze(profile.updates) : null });\n`;
}
