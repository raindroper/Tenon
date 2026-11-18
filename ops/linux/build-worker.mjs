import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fetch, EnvHttpProxyAgent } from 'undici';

const [output, dockerSeccomp] = process.argv.slice(2);
if (!output || !dockerSeccomp) throw new Error('Usage: node ops/linux/build-worker.mjs <context-directory> <Moby-seccomp-v0.2.4.json>');

const profile = await readFile(dockerSeccomp);
if (createHash('sha256').update(profile).digest('hex') !== '785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334') {
  throw new Error('The Moby default seccomp profile digest does not match Docker 29.9.3.');
}
const seccomp = JSON.parse(profile.toString('utf8'));
// The worker runs without host capabilities. These calls support the two nested user/mount namespaces.
seccomp.syscalls.push({ action: 'SCMP_ACT_ALLOW', names: ['unshare', 'clone', 'mount', 'umount2', 'pivot_root', 'sethostname', 'setdomainname'] });

await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(path.join(output, 'seccomp.json'), JSON.stringify(seccomp, null, 2) + '\n'),
  build({ entryPoints: ['worker/linux-project-worker.ts'], outfile: path.join(output, 'linux-project-worker.mjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', external: ['undici'] }),
  build({ entryPoints: ['desktop/project-hook.ts'], outfile: path.join(output, 'project-hook.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs' }),
]);

// Acquire one immutable official distribution; verify every runtime component even on cache reuse.
const { LINUX_CODEX_RUNTIME: codex } = await import('../../shared/codex-runtime.ts');
const cache = path.resolve('.local', 'project-runtime-linux-' + codex.archiveSha256);
await mkdir(cache, { recursive: true });
const archive = path.join(cache, 'codex.tar.gz');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
if (await digest(archive).catch(() => '') !== codex.archiveSha256) {
  const dispatcher = new EnvHttpProxyAgent();
  try {
    const response = await fetch(codex.archiveUrl, { dispatcher, signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error('Cannot download pinned Linux Codex distribution: ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== codex.archiveSha256) throw new Error('Linux Codex archive checksum mismatch.');
    await writeFile(archive, bytes);
  } finally { await dispatcher.close(); }
}
async function removeDirectoryChild(parent, name) {
  const absoluteParent = path.resolve(parent);
  const target = path.resolve(absoluteParent, name);
  if (path.dirname(target) !== absoluteParent || path.basename(target) !== name) throw new Error('Refused unsafe runtime cleanup.');
  const resolvedParent = await realpath(absoluteParent);
  await rm(path.join(resolvedParent, name), { recursive: true, force: true });
}
const extracted = path.join(cache, 'codex');
const valid = async dir => (await Promise.all(Object.entries(codex.requiredFiles).map(async ([file, hash]) =>
  await digest(path.join(dir, file)).catch(() => '') === hash))).every(Boolean);
if (!await valid(extracted)) {
  await removeDirectoryChild(cache, 'codex');
  await mkdir(extracted, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
}
if (!await valid(extracted)) throw new Error('Extracted Linux Codex distribution checksum mismatch.');
await removeDirectoryChild(output, 'codex');
await rm(path.join(output, 'codex-app-server'), { force: true });
await cp(extracted, path.join(output, 'codex'), { recursive: true });

// Preserve notices for the bundled Codex and ripgrep distribution.
const notices = {
  'CODEX-LICENSE.txt': `https://raw.githubusercontent.com/openai/codex/rust-v${(await import('../../shared/codex-runtime.ts')).CODEX_RUNTIME.version}/LICENSE`,
  'CODEX-NOTICE.txt': `https://raw.githubusercontent.com/openai/codex/rust-v${(await import('../../shared/codex-runtime.ts')).CODEX_RUNTIME.version}/NOTICE`,
  'BUBBLEWRAP-COPYING.txt': 'https://raw.githubusercontent.com/containers/bubblewrap/main/COPYING',
  'RIPGREP-COPYING.txt': 'https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/COPYING',
  'RIPGREP-LICENSE-MIT.txt': 'https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/LICENSE-MIT',
  'RIPGREP-UNLICENSE.txt': 'https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/UNLICENSE',
  'RIPGREP-PCRE2-LICENSE.txt': 'https://raw.githubusercontent.com/PCRE2Project/pcre2/pcre2-10.45/LICENCE.md',
};
const noticeDir = path.join(output, 'codex-notices');
await mkdir(noticeDir, { recursive: true });
const dispatcher = new EnvHttpProxyAgent();
try {
  await Promise.all(Object.entries(notices).map(async ([name, url]) => {
    const cached = path.join(cache, name);
    let bytes = await readFile(cached).catch(() => undefined);
    if (!bytes) {
      const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Cannot download upstream notice: ' + url);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(cached, bytes);
    }
    await writeFile(path.join(noticeDir, name), bytes);
  }));
} finally { await dispatcher.close(); }
