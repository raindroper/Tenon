import { spawn } from 'node:child_process';
import electronUpdater, { type NsisUpdater } from 'electron-updater';
import {
  assertInstallerFile, assertInstallerMetadata, desktopUpdateBaseUrl, newerVersion, verifyManifest,
  type DesktopUpdateInfo, type DesktopUpdateManifest,
} from './update-manifest.js';

export type { DesktopUpdateInfo } from './update-manifest.js';

async function fetchManifest(): Promise<DesktopUpdateManifest> {
  if (!desktopUpdateBaseUrl) throw new Error('此安装包尚未配置签名更新。');
  const response = await fetch(`${desktopUpdateBaseUrl}manifest.json`, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error('暂时无法获取 Windows 更新，请稍后重试。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new Error('更新清单超过大小限制。');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return verifyManifest(JSON.parse(body));
}

export function createDesktopUpdater({ currentVersion, enabled }: { currentVersion: string; enabled: boolean }) {
  let candidate: { client: NsisUpdater; manifest: DesktopUpdateManifest; path?: string } | undefined;
  return {
    async check(): Promise<DesktopUpdateInfo | undefined> {
      if (!enabled) throw new Error('请在已安装的 Windows x64 客户端中检查更新。');
      if (!desktopUpdateBaseUrl) throw new Error('此安装包尚未配置签名更新。');
      candidate = undefined;
      let manifest: DesktopUpdateManifest;
      try { manifest = await fetchManifest(); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('更新清单')) throw error;
        throw new Error('暂时无法检查更新，请检查网络后重试。', { cause: error });
      }
      if (!newerVersion(manifest.version, currentVersion)) return undefined;
      const client = new electronUpdater.NsisUpdater({ provider: 'generic', url: desktopUpdateBaseUrl });
      client.autoDownload = false;
      client.autoInstallOnAppQuit = false;
      client.allowPrerelease = false;
      client.allowDowngrade = false;
      client.disableWebInstaller = true;
      client.disableDifferentialDownload = true;
      const result = await client.checkForUpdates();
      if (!result?.isUpdateAvailable) throw new Error('更新正在发布，请稍后重新检查。');
      assertInstallerMetadata(manifest, result.updateInfo);
      candidate = { client, manifest };
      return { version: manifest.version, size: manifest.size };
    },

    async download(info: DesktopUpdateInfo, onProgress?: (percent: number) => void): Promise<void> {
      const update = candidate;
      if (!update || info.version !== update.manifest.version || info.size !== update.manifest.size) throw new Error('请先检查当前可用的更新。');
      update.path = undefined;
      const progress = ({ percent }: { percent: number }) => onProgress?.(Math.max(0, Math.min(100, percent)));
      update.client.on('download-progress', progress);
      try {
        const [path] = await update.client.downloadUpdate();
        if (!path || candidate !== update) throw new Error('请重新检查更新。');
        await assertInstallerFile(path, update.manifest);
        update.path = path;
      } finally { update.client.removeListener('download-progress', progress); }
    },

    async install(): Promise<void> {
      const update = candidate;
      if (!update?.path) throw new Error('请先下载并校验更新安装包。');
      await assertInstallerFile(update.path, update.manifest);
      if (candidate !== update) throw new Error('更新已变化，请重新检查。');
      // Wait for a confirmed spawn before the main process closes the app.
      const installer = spawn(update.path, ['--updated', '--force-run'], { detached: true, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => { installer.once('spawn', resolve); installer.once('error', reject); });
      installer.unref();
    },
  };
}
