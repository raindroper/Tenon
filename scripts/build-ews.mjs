import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'mcr.microsoft.com/dotnet/sdk:10.0.403@sha256:212fe4cb74627d5adf9817a4088906ae3edff1bd853bb27565d4b46731efe61e';
const rid = process.argv[2] ?? `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
if (!['win-x64', 'linux-x64'].includes(rid)) throw new Error('EWS adapter supports win-x64 and linux-x64.');
const output = path.join(root, '.local', 'ews-runtime', rid);
const packages = path.join(root, '.local', 'ews-nuget');
await mkdir(output, { recursive: true }); await mkdir(packages, { recursive: true });
const project = 'server/connectors/ews-native/AnotherRae.Ews.csproj';
const installed = spawnSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true });
const available = installed.status === 0 && Number(installed.stdout.trim().split('.')[0]) >= 10;
const locked = existsSync(path.join(root, 'server/connectors/ews-native/packages.lock.json'));
const publish = ['publish', project, '-c', 'Release', '-r', rid, '--self-contained', 'true', ...(locked ? ['-p:RestoreLockedMode=true'] : [])];
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', NUGET_PACKAGES: packages };
const command = available ? 'dotnet' : 'docker';
const args = available ? [...publish, '-o', output] : ['run', '--rm', '--mount', `type=bind,source=${root},target=/src`,
  '--workdir', '/src', '-e', 'DOTNET_CLI_TELEMETRY_OPTOUT=1', '-e', 'DOTNET_NOLOGO=1', '-e', 'NUGET_PACKAGES=/src/.local/ews-nuget',
  image, 'dotnet', ...publish, '-o', `/src/.local/ews-runtime/${rid}`];
const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
const code = await new Promise(resolve => {
  child.once('error', () => { console.error('EWS 构建需要 .NET SDK 10 或可运行的 Docker。'); resolve(1); });
  child.once('exit', code => resolve(code ?? 1));
});
process.exitCode = code;
if (code === 0) {
  const runtime = path.join(packages, `microsoft.netcore.app.runtime.${rid}`, '10.0.14');
  await mkdir(path.join(output, 'licenses'), { recursive: true });
  await cp(path.join(runtime, 'LICENSE.TXT'), path.join(output, 'licenses', 'DotNet-LICENSE.txt'));
  await cp(path.join(runtime, 'THIRD-PARTY-NOTICES.TXT'), path.join(output, 'licenses', 'DotNet-THIRD-PARTY-NOTICES.txt'));
  console.log(`EWS adapter prepared: ${output}`);
}
