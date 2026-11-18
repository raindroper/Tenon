import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertInstallerFile, assertInstallerMetadata, installerName, manifestPayload, newerVersion, verifyManifest } from '../desktop/update-manifest.js';

const installer = Buffer.from('MZ offline fixture');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const info = { version: '0.1.4', size: installer.length, sha512: createHash('sha512').update(installer).digest('base64') };
const release = { ...info, signature: sign(null, Buffer.from(manifestPayload(info)), privateKey).toString('base64') };

test('only a newer signed Windows release can offer an update', () => {
  assert.deepEqual(verifyManifest(release, key), release);
  assert.throws(() => verifyManifest({ ...release, version: '0.1.5' }, key), /签名无效/);
  assert.throws(() => verifyManifest({ ...release, size: release.size + 1 }, key), /签名无效/);
  assert.throws(() => verifyManifest(release), /未配置签名更新/);
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => verifyManifest(release, other), /签名无效/);
  assert.equal(newerVersion('0.1.4', '0.1.4'), false);
  assert.equal(newerVersion('0.1.3', '0.1.4'), false);
  assert.equal(newerVersion('0.1.10', '0.1.4'), true);
  assert.equal(newerVersion('0.2.0-beta', '0.1.4'), false);
});

test('updater metadata must resolve to the signed installer name, digest and size', () => {
  const file = { url: installerName(info.version), sha512: info.sha512, size: info.size };
  const metadata = { version: info.version, files: [file], path: file.url, sha512: info.sha512 };
  assert.doesNotThrow(() => assertInstallerMetadata(release, metadata));
  assert.throws(() => assertInstallerMetadata(release, { ...metadata, files: [{ ...file, url: 'https://elsewhere.invalid/payload.exe' }] }));
  assert.throws(() => assertInstallerMetadata(release, { ...metadata, files: [{ ...file, sha512: 'different' }] }));
  assert.throws(() => assertInstallerMetadata(release, { ...metadata, packages: {} }));
});

test('re-verification catches a corrupted cached installer before launch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-update-'));
  const file = path.join(directory, installerName(info.version));
  try {
    await writeFile(file, installer);
    await assertInstallerFile(file, release);
    const tampered = Buffer.from(installer);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(file, tampered);
    await assert.rejects(assertInstallerFile(file, release), /完整性校验失败/);
  } finally { await rm(file, { force: true }); await rmdir(directory); }
});
