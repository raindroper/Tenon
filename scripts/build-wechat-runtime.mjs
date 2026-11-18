import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronRequire = createRequire(require.resolve('electron/package.json'));

const python = {
  name: 'python-3.14.10-embed-amd64.zip',
  url: 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip',
  bytes: 12619664,
  // The SHA-256 message digest in Python.org's Sigstore bundle for this file.
  sha256: '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159',
};
const sqlcipher = {
  name: 'sqlcipher3-0.6.5-cp314-cp314-win_amd64.whl',
  url: 'https://files.pythonhosted.org/packages/94/5a/c0671928484bd390efe15da1552ad2c9656a6bda09221f0982b6d0a6917b/sqlcipher3-0.6.5-cp314-cp314-win_amd64.whl',
  bytes: 2647090,
  sha256: '3e59cf9a4b197e82e96de0f88ae402e9c19c61f649d2f581eb8fbbb42e08a9ef',
};

function verifyArtifact(artifact, bytes) {
  if (bytes.byteLength !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error(`Desktop runtime artifact integrity check failed: ${artifact.name}`);
  }
}

async function cachedArtifact(cache, artifact) {
  const destination = path.join(cache, artifact.name);
  try {
    const cached = await stat(destination);
    if (!cached.isFile() || cached.size !== artifact.bytes) throw new Error(`Invalid desktop runtime cache file: ${destination}`);
    verifyArtifact(artifact, await readFile(destination));
    return destination;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const response = await fetch(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  const length = response.headers.get('content-length');
  if (!response.ok || (length !== null && Number(length) !== artifact.bytes)) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Could not download pinned desktop runtime artifact: ${artifact.name}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArtifact(artifact, bytes);
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  return destination;
}

export async function bundleWeChatRuntime(root, output) {
  const source = path.join(root, 'desktop', 'wechat-db');
  const destination = path.join(output, 'desktop', 'wechat-db');
  const runtime = path.join(destination, 'runtime');
  const sitePackages = path.join(runtime, 'site-packages');
  const cache = path.join(root, '.local', 'desktop-dependencies', 'wechat-db');
  if (!(await lstat(source)).isDirectory()) throw new Error('Expected a regular WeChat reader source directory.');
  await mkdir(cache, { recursive: true });
  await mkdir(sitePackages, { recursive: true });
  const [pythonArchive, wheel] = await Promise.all([cachedArtifact(cache, python), cachedArtifact(cache, sqlcipher)]);
  // Use the same ZIP extractor that the installed Electron build uses.
  const { extract } = electronRequire('@electron-internal/extract-zip');
  await extract(pythonArchive, { dir: runtime });
  await extract(wheel, { dir: sitePackages });
  // The embedded interpreter ignores PATH/PYTHONPATH and global site packages.
  await writeFile(path.join(runtime, 'python314._pth'), 'python314.zip\n.\nsite-packages\n..\n');
  for (const name of ['reader.py', 'scanner.py', 'THIRD_PARTY_NOTICES.md', 'LICENSE-APACHE-2.0.txt',
    'LICENSE-WCDB-MIT.txt', 'LICENSE-SQLCIPHER.txt', 'LICENSE-OPENSSL.txt']) {
    const file = path.join(source, name);
    if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular WeChat reader resource: ${name}`);
    await cp(file, path.join(destination, name));
  }

  if (process.platform === 'win32' && process.arch === 'x64') {
    execFileSync(path.join(runtime, 'python.exe'), ['-I', '-B', '-u', '-X', 'utf8', '-c', [
      'import struct, sys',
      'import reader, scanner',
      'from sqlcipher3 import dbapi2 as sqlite',
      'assert sys.version_info[:3] == (3, 14, 10) and struct.calcsize("P") == 8',
      'with sqlite.connect(":memory:") as db:',
      '    assert db.execute("PRAGMA cipher_version").fetchone() == ("4.20.0 community",)',
    ].join('\n')], { cwd: runtime, stdio: 'inherit', windowsHide: true });
  }
}
