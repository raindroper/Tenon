import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { desktopOutput } from './build-desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.local', 'desktop-artifacts');
const { devDependencies, productName } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electronVersion = devDependencies.electron;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
if ((await readFile(path.join(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '') !== electronVersion) {
  throw new Error('Installed Electron does not match the pinned project version. Run npm ci before packaging.');
}
const { desktopProfile } = await import(pathToFileURL(path.join(desktopOutput, 'desktop', 'publisher-profile.js')).href);
await mkdir(output, { recursive: true });
const config = path.join(root, '.local', 'desktop-builder.json');
const target = process.argv.includes('--dir') ? ['dir'] : ['nsis'];
await writeFile(config, JSON.stringify({ appId: desktopProfile.appId, productName, electronVersion, electronDist,
  directories: { app: path.join(root, '.local', 'desktop-build'), output },
  // MXC's supported executable discovery rejects even .asar.unpacked paths.
  // Ship one ordinary resource tree so the maintained SDK can load its native
  // DLLs/executables without private API patches or environment overrides.
  files: ['desktop/**', 'shared/**', 'package.json', 'node_modules/**'], asar: false,
  // Node's own node_modules/npm is a runtime distribution, not an app dependency
  // for electron-builder to prune. Copy that verified tree as an explicit resource.
  extraResources: [{ from: path.join(desktopOutput, 'vendor'), to: 'vendor', filter: ['**/*'] }],
  npmRebuild: false, publish: desktopProfile.updates ? { provider: 'generic', url: desktopProfile.updates.baseUrl } : null,
  win: { target: target.map(name => ({ target: name, arch: ['x64'] })), requestedExecutionLevel: 'asInvoker', signExecutable: false,
    // Existing taskbar pins and custom shortcuts still target this executable.
    executableName: 'Another Rae',
    icon: path.join(root, '.local', 'desktop-icon.ico'),
    artifactName: 'Another-Rae-${version}-Setup.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false,
    createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: productName },
}, null, 2));
const builder = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const child = spawn(process.execPath, [builder, '--config', config, '--win', '--publish', 'never'], { cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
if (code !== 0) process.exitCode = code;
else {
  const vendor = path.join(output, 'win-unpacked/resources/vendor');
  const node = path.join(vendor, 'node/node.exe');
  const npm = path.join(vendor, 'node/node_modules/npm/bin/npm-cli.js');
  const { CODEX_RUNTIME } = await import(pathToFileURL(path.join(desktopOutput, 'shared/codex-runtime.js')).href);
  await Promise.all(Object.keys(CODEX_RUNTIME.requiredFiles).map(file => access(path.join(vendor, 'codex', file))));
  await access(npm);
  const npmVersion = execFileSync(node, [npm, '--version'], { encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(node) + ';' + path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') } }).trim();
  if (!/^\d+\.\d+\.\d+/.test(npmVersion)) throw new Error('Packaged npm did not execute.');
  process.stdout.write('Packaged standalone npm verified: ' + npmVersion + '\n');
}
