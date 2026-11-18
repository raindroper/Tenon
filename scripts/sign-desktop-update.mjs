import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopUpdatePublicKey, installerName, manifestPayload, verifyManifest } from '../.local/desktop-build/desktop/update-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.local', 'desktop-artifacts');
if (!desktopUpdatePublicKey) throw new Error('Build with an explicit signed-update desktop profile before signing a release.');
const { version } = JSON.parse(await readFile(path.join(root, '.local', 'desktop-build', 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable desktop release version.');
const keyFile = process.env.RAE_DESKTOP_UPDATE_KEY_FILE;
if (!keyFile || !path.isAbsolute(keyFile)) throw new Error('Set RAE_DESKTOP_UPDATE_KEY_FILE to the absolute release signing key path.');
const privateKey = createPrivateKey(await readFile(keyFile));
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
if (publicKey !== desktopUpdatePublicKey) throw new Error('The release key does not match the public key embedded in the client.');

const filename = installerName(version);
const installer = path.join(output, filename);
const { size } = await stat(installer);
const hash = createHash('sha512');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const sha512 = hash.digest('base64');
const latest = await readFile(path.join(output, 'latest.yml'), 'utf8');
if (!latest.includes(`version: ${version}\n`) || !latest.includes(`- url: ${filename}\n`)
  || !latest.includes(`sha512: ${sha512}\n`) || !latest.includes(`size: ${size}\n`)) {
  throw new Error('latest.yml does not describe this installer. Rebuild the release before signing.');
}
const info = { version, size, sha512 };
const manifest = verifyManifest({ ...info, signature: sign(null, Buffer.from(manifestPayload(info)), privateKey).toString('base64') });
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
process.stdout.write(`Signed update manifest for ${filename}\n`);
