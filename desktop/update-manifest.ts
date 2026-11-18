import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { desktopProfile } from './publisher-profile.js';

export const desktopUpdateBaseUrl = desktopProfile.updates?.baseUrl;
export const desktopUpdatePublicKey = desktopProfile.updates?.publicKey;
const stableVersion = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const base64Bytes64 = /^[A-Za-z0-9+/]{86}==$/;
const manifestSchema = z.object({
  version: z.string().regex(stableVersion),
  size: z.number().int().min(1).max(1024 * 1024 * 1024),
  sha512: z.string().regex(base64Bytes64),
  signature: z.string().regex(base64Bytes64),
}).strict();

export type DesktopUpdateManifest = z.infer<typeof manifestSchema>;
export type DesktopUpdateInfo = Pick<DesktopUpdateManifest, 'version' | 'size'>;

export function installerName(version: string): string {
  return `Another-Rae-${version}-Setup.exe`;
}

export function manifestPayload(info: Omit<DesktopUpdateManifest, 'signature'>): string {
  return `another-rae/desktop/win-x64/v1\n${info.version}\n${info.size}\n${info.sha512}`;
}

export function verifyManifest(value: unknown, publicKey = desktopUpdatePublicKey): DesktopUpdateManifest {
  if (!publicKey) throw new Error('此安装包尚未配置签名更新。');
  const manifest = manifestSchema.safeParse(value);
  if (!manifest.success) throw new Error('更新清单格式无效。');
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  const { signature, ...info } = manifest.data;
  if (!verify(null, Buffer.from(manifestPayload(info)), key, Buffer.from(signature, 'base64'))) throw new Error('更新清单签名无效。');
  return manifest.data;
}

export function newerVersion(candidate: string, installed: string): boolean {
  if (!stableVersion.test(candidate) || !stableVersion.test(installed)) return false;
  const current = installed.split('.').map(Number);
  for (const [index, value] of candidate.split('.').map(Number).entries()) {
    if (value !== current[index]) return value > current[index];
  }
  return false;
}

export function assertInstallerMetadata(manifest: DesktopUpdateManifest, update: {
  version: string; files: ReadonlyArray<{ url: string; sha512: string; size?: number }>; path?: string; sha512?: string; packages?: unknown;
}): void {
  const [file] = update.files ?? [];
  const filename = installerName(manifest.version);
  if (update.version !== manifest.version || update.files?.length !== 1 || !file || file.url !== filename
    || file.sha512 !== manifest.sha512 || file.size !== manifest.size || update.packages != null
    || (update.path !== undefined && update.path !== filename) || (update.sha512 !== undefined && update.sha512 !== manifest.sha512)) {
    throw new Error('安装包信息与已验证的更新清单不一致，请重新检查更新。');
  }
}

export async function assertInstallerFile(path: string, manifest: DesktopUpdateManifest): Promise<void> {
  const file = await lstat(path);
  if (!file.isFile() || file.size !== manifest.size) throw new Error('安装包大小校验失败，请重新下载。');
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > manifest.size) throw new Error('安装包大小校验失败，请重新下载。');
    hash.update(chunk);
  }
  if (size !== manifest.size || hash.digest('base64') !== manifest.sha512) throw new Error('安装包完整性校验失败，请重新下载。');
}
