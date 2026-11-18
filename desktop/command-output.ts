import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import iconv from 'iconv-lite';

let nativeEncoding: string | undefined;
function commandEncoding(): string {
  if (nativeEncoding) return nativeEncoding;
  nativeEncoding = 'utf8';
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (process.platform !== 'win32' || !systemRoot) return nativeEncoding;
  try {
    // Fixed OS metadata query, never an owner command. No inherited secrets,
    // AutoRun, profile, code-page mutation, or access to an owner's directory.
    const page = execFileSync(path.win32.join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'chcp'], {
      windowsHide: true, timeout: 2000, maxBuffer: 4096, cwd: systemRoot,
      env: { SystemRoot: systemRoot }, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('ascii').match(/(\d+)\s*$/)?.[1];
    if (page && iconv.encodingExists(`cp${page}`)) nativeEncoding = `cp${page}`;
  } catch { /* BOM/UTF-8 detection still works if the OS query is unavailable. */ }
  return nativeEncoding;
}

/** Decode after drain so split multibyte characters never become lost bytes. */
export function decodeCommandOutput(bytes: Buffer, fallback?: string, truncated = false): string {
  if (!bytes.length) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes, 'utf16-le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes, 'utf16-be');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return iconv.decode(bytes, 'utf8');
  if (isUtf8(bytes)) return bytes.toString('utf8');
  if (truncated) {
    try {
      // A byte limit can cut only the final UTF-8 character; keep the valid
      // prefix in its original encoding rather than treating it as OEM text.
      new TextDecoder('utf8', { fatal: true }).decode(bytes, { stream: true });
      return bytes.toString('utf8');
    } catch { /* The stream is genuinely non-UTF-8. */ }
  }
  return iconv.decode(bytes, fallback ?? commandEncoding());
}
