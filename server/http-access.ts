import type { IncomingHttpHeaders } from 'node:http';

/** Host/origin allowlist only; the HTTP server independently enforces configured user sessions. */
export function publicOrigin(value: string | undefined): URL | undefined {
  if (value === undefined || value === '') return undefined;
  const invalid = () => new Error('RAE_PUBLIC_ORIGIN 必须是单个规范 HTTP(S) origin，例如 https://rae.example.com；不能包含凭据、路径、查询、片段或通配符。');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || value.includes('*') || value !== url.origin) throw invalid();
  return url;
}

export function createRequestAccess(configuredOrigin?: string) {
  const configured = publicOrigin(configuredOrigin);
  return (headers: Pick<IncomingHttpHeaders, 'host' | 'origin'>, port: number): boolean => {
    const hosts = new Set([...new Set([4317, 5173, port])].flatMap(value => ['127.0.0.1:' + value, 'localhost:' + value]));
    const origins = new Set([...hosts].map(host => 'http://' + host));
    if (configured) { hosts.add(configured.host); origins.add(configured.origin); }
    if (typeof headers.host !== 'string' || !hosts.has(headers.host)) return false;
    return headers.origin === undefined || typeof headers.origin === 'string' && origins.has(headers.origin);
  };
}
