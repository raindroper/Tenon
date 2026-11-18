import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fetch as proxyFetch, EnvHttpProxyAgent } from 'undici';
const downloadAgent = new EnvHttpProxyAgent();
const download = (url, options) => proxyFetch(url, { ...options, dispatcher: downloadAgent });

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function archive(url, hash, file) {
  try { if (await sha256(file) === hash) return; } catch {}
  const response = await download(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Cannot download pinned project runtime: ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Project runtime archive checksum mismatch.');
  await writeFile(file, bytes);
}
async function license(url, destination) {
  const cache = path.join(path.dirname(path.dirname(destination)), '..', 'project-runtime-licenses',
    createHash('sha256').update(url).digest('hex').slice(0, 16) + '-' + path.basename(destination));
  try { await cp(cache, destination); return; } catch {}
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await download(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Cannot bundle upstream license ' + url + ': ' + response.status);
      const text = await response.text(); await mkdir(path.dirname(cache), { recursive: true });
      await writeFile(cache, text); await writeFile(destination, text); return;
    } catch (error) { last = error; }
  }
  throw last;
}

async function removeDirectoryChild(parent, name) {
  const absoluteParent = path.resolve(parent);
  const target = path.resolve(absoluteParent, name);
  if (path.dirname(target) !== absoluteParent || path.basename(target) !== name) throw new Error('Refused unsafe runtime cleanup.');
  // Resolve the existing parent before deleting its direct child; rm does not follow a child symlink.
  const resolvedParent = await realpath(absoluteParent);
  await rm(path.join(resolvedParent, name), { recursive: true, force: true });
}
/** Build-time acquisition only. The installed client never downloads a harness or Node. */
export async function bundleProjectRuntime(root, output) {
  try {
  const { CODEX_RUNTIME: pinned } = await import(pathToFileURL(path.join(output, 'shared/codex-runtime.js')).href);
  const cache = path.join(root, '.local', 'project-runtime-' + pinned.version);
  const vendor = path.join(output, 'vendor'); await mkdir(cache, { recursive: true }); await mkdir(vendor, { recursive: true });
  const codexArchive = path.join(cache, 'codex.tar.gz');
  await archive(pinned.archiveUrl, pinned.archiveSha256, codexArchive);
  const codex = path.join(cache, 'codex');
  const valid = async directory => (await Promise.all(Object.entries(pinned.requiredFiles).map(async ([file, hash]) =>
    await sha256(path.join(directory, file)).catch(() => '') === hash))).every(Boolean);
  if (!await valid(codex)) {
    await removeDirectoryChild(cache, 'codex');
    await mkdir(codex, { recursive: true });
    execFileSync('tar.exe', ['-xzf', codexArchive, '-C', codex], { windowsHide: true });
  }
  if (!await valid(codex)) throw new Error('Extracted Codex distribution checksum mismatch.');
  const nodeCache = path.join(root, '.local', 'node-runtime-' + pinned.nodeVersion);
  await mkdir(nodeCache, { recursive: true });
  const nodeArchive = path.join(nodeCache, 'node.zip');
  if (await sha256(nodeArchive).catch(() => '') !== pinned.nodeArchiveSha256) {
    // Migrate a verified archive from an older Codex cache without trusting its name.
    const local = path.join(root, '.local');
    for (const entry of await readdir(local, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('project-runtime-')) continue;
      const candidate = path.join(local, entry.name, 'node.zip');
      if (await sha256(candidate).catch(() => '') === pinned.nodeArchiveSha256) { await cp(candidate, nodeArchive); break; }
    }
  }
  await archive('https://nodejs.org/dist/v' + pinned.nodeVersion + '/node-v' + pinned.nodeVersion + '-win-x64.zip', pinned.nodeArchiveSha256, nodeArchive);
  const node = path.join(nodeCache, 'node', 'node-v' + pinned.nodeVersion + '-win-x64');
  try { await access(path.join(node, 'node.exe')); }
  catch { await mkdir(path.dirname(node), { recursive: true }); execFileSync('tar.exe', ['-xf', nodeArchive, '-C', path.dirname(node)], { windowsHide: true }); }
  await removeDirectoryChild(vendor, 'codex');
  await Promise.all(['codex-app-server.exe', 'rg.exe'].map(file => rm(path.join(vendor, file), { force: true })));
  await cp(codex, path.join(vendor, 'codex'), { recursive: true });
  await cp(node, path.join(vendor, 'node'), { recursive: true });
  await Promise.all([
    license('https://raw.githubusercontent.com/openai/codex/rust-v' + pinned.version + '/LICENSE', path.join(vendor, 'CODEX-LICENSE.txt')),
    license('https://raw.githubusercontent.com/openai/codex/rust-v' + pinned.version + '/NOTICE', path.join(vendor, 'CODEX-NOTICE.txt')),
    license('https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/COPYING', path.join(vendor, 'RIPGREP-COPYING.txt')),
    license('https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/LICENSE-MIT', path.join(vendor, 'RIPGREP-LICENSE-MIT.txt')),
    license('https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/UNLICENSE', path.join(vendor, 'RIPGREP-UNLICENSE.txt')),
    license('https://raw.githubusercontent.com/PCRE2Project/pcre2/pcre2-10.45/LICENCE.md', path.join(vendor, 'RIPGREP-PCRE2-LICENSE.txt')),
  ]);
  await writeFile(path.join(vendor, 'runtime.json'), JSON.stringify(pinned, null, 2));
  const { CUA_DRIVER_RUNTIME: desktop } = await import(pathToFileURL(path.join(output, 'desktop/desktop-automation.js')).href);
  const desktopCache = path.join(root, '.local', 'cua-driver-' + desktop.version);
  await mkdir(desktopCache, { recursive: true });
  const desktopArchive = path.join(desktopCache, 'windows-x64.zip');
  await archive(desktop.url, desktop.archiveSha256, desktopArchive);
  const desktopDriver = path.join(desktopCache, 'cua-driver.exe');
  if (await sha256(desktopDriver).catch(() => '') !== desktop.executableSha256) {
    execFileSync('tar.exe', ['-xf', desktopArchive, '-C', desktopCache, 'cua-driver.exe'], { windowsHide: true });
  }
  if (await sha256(desktopDriver) !== desktop.executableSha256) throw new Error('Extracted Cua Driver checksum mismatch.');
  const desktopOutput = path.join(vendor, 'cua-driver');
  await mkdir(desktopOutput, { recursive: true });
  await Promise.all([cp(desktopDriver, path.join(desktopOutput, 'cua-driver.exe')),
    license(desktop.licenseUrl, path.join(vendor, 'CUA-DRIVER-LICENSE.txt'))]);
  const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc, ['/nologo', '/codepage:65001', '/platform:x64', '/target:exe',
    '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/out:' + path.join(desktopOutput, 'window-guard.exe'),
    path.join(root, 'desktop', 'desktop-window-guard.cs')], { cwd: root, stdio: 'inherit', windowsHide: true });
  } finally { await downloadAgent.close(); }
}
