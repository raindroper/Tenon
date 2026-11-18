import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import iconv from 'iconv-lite';
import type { MxcProcess } from '@microsoft/mxc-sdk/v1';
import { decodeCommandOutput } from '../desktop/command-output.js';
import { runSandbox, type MxcAdapter } from '../desktop/mxc.js';

test('command output preserves OEM Chinese, UTF-8, Unicode BOMs and western OEM text', () => {
  const chinese = '无法启动此 shell。初始化过程中出现故障：不允许所请求的注册表访问权。\r\n中文资料.txt';
  assert.equal(decodeCommandOutput(iconv.encode(chinese, 'cp936'), 'cp936'), chinese);
  assert.equal(decodeCommandOutput(Buffer.from(chinese + ' 🐈'), 'cp936'), chinese + ' 🐈');
  for (const encoding of ['utf16-le', 'utf16-be', 'utf8']) {
    assert.equal(decodeCommandOutput(iconv.encode(chinese, encoding, { addBOM: true }), 'cp437'), chinese);
  }
  assert.equal(decodeCommandOutput(iconv.encode('café', 'cp437'), 'cp437'), 'café');
});

test('a raw-byte output limit retains its prefix and drains split Unicode streams before returning', async () => {
  const stdout = new PassThrough(); const stderr = new PassThrough();
  let killCount = 0; let disposed = false;
  const expected = '中文'.repeat(22000);
  const raw = Buffer.from(expected);
  const adapter: MxcAdapter = { getPlatformSupport: () => ({ isSupported: true }), probe: () => ({ tier: 'base-container' }),
    spawn: async () => ({ standardOutput: stdout, standardError: stderr, kill() { killCount++; },
      wait: async () => {
        stdout.write(raw.subarray(0, 1)); stdout.write(raw.subarray(1, 10001)); stdout.end(raw.subarray(10001)); stderr.end();
        return { exitCode: -1, timedOut: false };
      }, dispose() { disposed = true; } } as unknown as MxcProcess) };
  const result = await runSandbox(adapter, { command: 'fixture' }, new AbortController().signal);
  assert.equal(result.outputLimited, true); assert.equal(killCount, 1); assert.equal(disposed, true);
  assert.equal(result.stdout, raw.subarray(0, 128 * 1024).toString('utf8'));
});
