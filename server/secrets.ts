import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

// The command is constant: secret material only travels through stdin and stdout.
const DPAPI_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($request.value)
if ($request.action -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} elseif ($request.action -eq 'unprotect') {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else { throw 'Unsupported operation' }
[Console]::Out.Write([Convert]::ToBase64String($result))`;

function dpapi(action: 'protect' | 'unprotect', value: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', DPAPI_SCRIPT], {
    input: JSON.stringify({ action, value }), encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  const output = result.stdout?.trim();
  if (result.error || result.status !== 0 || !output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
    throw new Error('系统密钥保护服务不可用，未保存明文密钥。');
  }
  return output;
}

export class SecretStore {
  private readonly path: string;
  private value: string | undefined;
  constructor(private readonly dataDir: string, filename = 'credentials.json') {
    this.path = join(dataDir, filename);
    if (!existsSync(this.path)) return;
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { format?: string; value?: string };
      if (typeof saved.value !== 'string') throw new Error();
      if (process.platform === 'win32' && saved.format === 'dpapi-current-user-v1') {
        this.value = Buffer.from(dpapi('unprotect', saved.value), 'base64').toString('utf8');
      } else if (process.platform !== 'win32' && saved.format === 'owner-file-v1') {
        chmodSync(this.path, 0o600);
        this.value = saved.value;
        // Atomic replacement preserves the original if encryption cannot complete.
        this.set(saved.value);
      } else if (process.platform !== 'win32' && saved.format === 'aes-gcm-owner-key-v1') {
        const payload = Buffer.from(saved.value, 'base64');
        if (payload.length < 28) throw new Error();
        const key = this.ownerKey(false);
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
          decipher.setAuthTag(payload.subarray(12, 28));
          decipher.setAAD(Buffer.from(basename(this.path), 'utf8'));
          this.value = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
          chmodSync(this.path, 0o600);
        } finally { key.fill(0); }
      } else throw new Error();
    } catch {
      throw new Error('无法读取已保存的密钥，请使用原系统账户或恢复完整私有凭据目录后重试。');
    }
  }
  private ownerKey(create: boolean): Buffer {
    const path = join(this.dataDir, '.secret-key');
    if (create && !existsSync(path)) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      chmodSync(this.dataDir, 0o700);
      for (const name of readdirSync(this.dataDir).filter(name => name.endsWith('.json'))) {
        const file = join(this.dataDir, name);
        if (!lstatSync(file).isFile()) continue;
        let existing: { format?: unknown };
        try { existing = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown }; } catch { continue; }
        if (existing?.format === 'aes-gcm-owner-key-v1') throw new Error('Existing encrypted credentials require the original owner key.');
      }
      const generated = randomBytes(32);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, 'wx', 0o600);
        writeSync(descriptor, generated); fsyncSync(descriptor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally { if (descriptor !== undefined) closeSync(descriptor); generated.fill(0); }
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error('Invalid owner key');
    chmodSync(path, 0o600);
    return readFileSync(path);
  }
  get(): string | undefined { return this.value; }
  set(value: string | undefined): void {
    if (!value) {
      rmSync(this.path, { force: true });
      this.value = undefined;
      return;
    }
    let saved: { format: string; value: string };
    if (process.platform === 'win32') {
      saved = { format: 'dpapi-current-user-v1', value: dpapi('protect', Buffer.from(value, 'utf8').toString('base64')) };
    } else {
      const key = this.ownerKey(true); const nonce = randomBytes(12);
      try {
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(basename(this.path), 'utf8'));
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        saved = { format: 'aes-gcm-owner-key-v1', value: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64') };
      } finally { key.fill(0); }
    }
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') chmodSync(this.path, 0o600);
      this.value = value;
    } finally { rmSync(temporary, { force: true }); }
  }
}
