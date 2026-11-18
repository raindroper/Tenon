import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { desktopBuildProfileModule, parseDesktopBuildProfile } from '../desktop/build-profile.js';
import { desktopProfile } from '../desktop/publisher-profile.js';
import { windowsDesktopDownload } from '../client/lib/desktop-download.js';

const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const configured = { appId: 'org.example.rae', baseUrl: 'https://rae.example.com',
  updates: { baseUrl: 'https://updates.example.com/windows/', publicKey: key } };

test('generic source builds have no publisher service or update trust root', () => {
  assert.deepEqual(parseDesktopBuildProfile(desktopProfile), { appId: 'org.anotherrae.desktop', baseUrl: '', updates: null });
  assert.ok(Object.isFrozen(desktopProfile));
  assert.ok(windowsDesktopDownload.startsWith('/desktop-updates/'));
  assert.equal(new URL(windowsDesktopDownload, 'https://first.example/').origin, 'https://first.example');
  assert.equal(new URL(windowsDesktopDownload, 'https://second.example/').origin, 'https://second.example');
});

test('explicit desktop profiles require complete HTTPS settings and a valid Ed25519 verification key', () => {
  assert.deepEqual(parseDesktopBuildProfile(configured), configured);
  for (const invalid of [
    { ...configured, baseUrl: 'http://127.0.0.1:4317' },
    { ...configured, baseUrl: 'https://rae.example.com/private' },
    { ...configured, baseUrl: 'https://owner:password@rae.example.com' },
    { ...configured, updates: { baseUrl: configured.updates.baseUrl } },
    { ...configured, updates: { publicKey: key } },
    { ...configured, updates: { ...configured.updates, baseUrl: 'http://updates.example.com/' } },
    { ...configured, updates: { ...configured.updates, baseUrl: 'https://updates.example.com/?token=value' } },
    { ...configured, updates: { ...configured.updates, publicKey: 'invalid' } },
    { ...configured, updates: { ...configured.updates, publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } },
    { ...configured, apiKey: 'never embed credentials' },
  ]) assert.throws(() => parseDesktopBuildProfile(invalid));
});

test('built publisher values are an immutable module independent of the input file and runtime environment', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rae-publisher-'));
  const input = path.join(directory, 'private.json');
  const output = path.join(directory, 'publisher-profile.mjs');
  await writeFile(input, JSON.stringify(configured));
  await writeFile(output, desktopBuildProfileModule(JSON.parse(await readFile(input, 'utf8'))));
  await writeFile(input, JSON.stringify({ appId: 'org.changed.rae', baseUrl: '', updates: null }));
  const previousProfile = process.env.RAE_DESKTOP_PROFILE_FILE;
  process.env.RAE_DESKTOP_PROFILE_FILE = input;
  t.after(() => { if (previousProfile === undefined) delete process.env.RAE_DESKTOP_PROFILE_FILE; else process.env.RAE_DESKTOP_PROFILE_FILE = previousProfile; });
  const built = await import(pathToFileURL(output).href) as { desktopProfile: typeof configured };
  assert.deepEqual(built.desktopProfile, configured);
  assert.ok(Object.isFrozen(built.desktopProfile));
  assert.ok(Object.isFrozen(built.desktopProfile.updates));
  assert.throws(() => { built.desktopProfile.updates.publicKey = 'replaced'; }, TypeError);
  assert.equal(desktopProfile.baseUrl, '', 'Building a profile must not mutate generic source defaults');
});
