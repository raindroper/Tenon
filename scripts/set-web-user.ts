import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { hashWebPassword } from '../server/web-auth.js';

/** Operator-only provisioning: credentials arrive on stdin, never in argv or application state. */
async function main() {
  if (process.argv.length !== 3) throw new Error('请指定私有凭据文件路径，并通过标准输入提供用户名和密码 JSON。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > 4096) throw new Error('凭据输入过长。');
    chunks.push(data);
  }
  const input = z.object({ username: z.string().min(1).max(80).regex(/^[^\s:\x00-\x1f\x7f]+$/), password: z.string().min(12).max(1024) }).strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
  const credentials = { version: 1, username: input.username, password: await hashWebPassword(input.password) };
  const target = resolve(process.argv[2]); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temp, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temp, target);
  console.info('内置用户凭据已保存；重启应用后生效，原会话将失效。');
}

void main().catch(() => { console.error('无法设置内置用户。请检查私有路径、权限及标准输入 JSON（username、至少12位的password）。'); process.exitCode = 1; });
