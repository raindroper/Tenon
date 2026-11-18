import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supported = version => {
  const [major, minor, patch] = version.replace(/^v/, '').trim().split('.').map(Number);
  return major > 24 || (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)));
};
const local = resolve(root, '.local/runtime/node.exe');
let runtime = process.execPath;
if (!supported(process.version)) {
  if (!existsSync(local) || !supported(execFileSync(local, ['--version'], { encoding: 'utf8', windowsHide: true }))) {
    console.error('此版本需要 Node.js 24.22.1+。可安装受支持版本，或按 docs/runtime-v2.md 配置项目本地运行时。');
    process.exit(1);
  }
  runtime = local;
}
const args = process.argv.slice(2);
if (!args.length) { console.error('缺少运行入口。'); process.exit(1); }
const child = spawn(runtime, args, { cwd: root, stdio: 'inherit', windowsHide: true });
process.on('SIGINT', () => { if (process.platform !== 'win32') child.kill('SIGINT'); });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', () => { console.error('无法启动项目运行时。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
