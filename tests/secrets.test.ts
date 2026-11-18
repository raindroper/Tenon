import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore } from '../server/secrets.js';

function linux<T>(work: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try { Object.defineProperty(process, 'platform', { ...original, value: 'linux' }); return work(); }
  finally { Object.defineProperty(process, 'platform', original); }
}
test('owner-file credentials migrate atomically to authenticated encryption and survive reopening', () => linux(() => {
  const directory = mkdtempSync(join(tmpdir(), 'rae-encrypted-secrets-'));
  const secret = 'offline-private-material-'.repeat(40_000);
  const path = join(directory, 'mail.json');
  writeFileSync(path, JSON.stringify({ format: 'owner-file-v1', value: secret }));
  const store = new SecretStore(directory, 'mail.json'); assert.equal(store.get(), secret);
  const saved = readFileSync(path, 'utf8'); assert.match(saved, /aes-gcm-owner-key-v1/); assert.ok(!saved.includes('offline-private-material'));
  assert.equal(readFileSync(join(directory, '.secret-key')).length, 32);
  assert.equal(new SecretStore(directory, 'mail.json').get(), secret);
  store.set('rotated-fixture'); assert.equal(new SecretStore(directory, 'mail.json').get(), 'rotated-fixture');
  store.set(undefined); assert.equal(existsSync(path), false);
}));
test('encrypted secrets reject tampering, a substituted credential filename, and missing owner keys', () => linux(() => {
  const directory = mkdtempSync(join(tmpdir(), 'rae-secret-integrity-')); const path = join(directory, 'mail.json');
  const store = new SecretStore(directory, 'mail.json'); store.set('offline-fixture-secret');
  const original = readFileSync(path, 'utf8');
  writeFileSync(join(directory, 'other.json'), original);
  assert.throws(() => new SecretStore(directory, 'other.json'), /无法读取/);
  const edited = JSON.parse(original); const payload = Buffer.from(edited.value, 'base64'); payload[payload.length - 1] ^= 1;
  writeFileSync(path, JSON.stringify({ ...edited, value: payload.toString('base64') }));
  assert.throws(() => new SecretStore(directory, 'mail.json'), /无法读取/);
  writeFileSync(path, original); rmSync(join(directory, '.secret-key'));
  assert.throws(() => new SecretStore(directory, 'mail.json'), /无法读取/);
  assert.equal(existsSync(join(directory, '.secret-key')), false, 'Reading a missing key never silently replaces it');
  assert.throws(() => new SecretStore(directory, 'new.json').set('another-fixture'), /original owner key/);
  assert.equal(existsSync(join(directory, '.secret-key')), false, 'New credentials cannot hide a missing key for existing records');
}));
