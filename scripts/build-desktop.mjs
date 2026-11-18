import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import sharp from 'sharp';
import { bundleWeChatRuntime } from './build-wechat-runtime.mjs';
import { bundleProjectRuntime } from './build-project-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const desktopOutput = path.join(root, '.local', 'desktop-build');
if (path.dirname(desktopOutput) !== path.join(root, '.local') || path.basename(desktopOutput) !== 'desktop-build') throw new Error('Refused desktop output cleanup outside workspace.');
await rm(desktopOutput, { recursive: true, force: true });
await mkdir(desktopOutput, { recursive: true });
const configuration = path.join(root, '.local', 'desktop-tsconfig.json');
await writeFile(configuration, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  strict: true, skipLibCheck: true, esModuleInterop: true, rootDir: root, outDir: desktopOutput, noEmitOnError: true,
  declaration: false, sourceMap: false, types: ['node'] }, files: (await readdir(path.join(root, 'desktop'))).filter(file => file.endsWith('.ts')).map(file => path.join(root, 'desktop', file).replaceAll('\\', '/')) }, null, 2));
execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', configuration], { cwd: root, stdio: 'inherit', windowsHide: true });
const profileFile = process.env.RAE_DESKTOP_PROFILE_FILE;
if (profileFile) {
  if (!path.isAbsolute(profileFile)) throw new Error('RAE_DESKTOP_PROFILE_FILE must be an absolute private JSON path.');
  const { desktopBuildProfileModule } = await import(pathToFileURL(path.join(desktopOutput, 'desktop', 'build-profile.js')).href);
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  await writeFile(path.join(desktopOutput, 'desktop', 'publisher-profile.js'), desktopBuildProfileModule(profile));
}
for (const name of ['preload', 'chat-preload']) {
  const preload = (await transform(await readFile(path.join(root, 'desktop', `${name}.ts`), 'utf8'), { loader: 'ts', target: 'es2022', format: 'cjs' })).code;
  await writeFile(path.join(desktopOutput, 'desktop', `${name}.cjs`), preload);
  await rm(path.join(desktopOutput, 'desktop', `${name}.js`), { force: true });
}
for (const name of ['controller.html', 'controller.css', 'controller.js']) await cp(path.join(root, 'desktop', name), path.join(desktopOutput, 'desktop', name));
await bundleWeChatRuntime(root, desktopOutput);
await bundleProjectRuntime(root, desktopOutput);
const mark = path.join(root, 'client', 'assets', 'tenon-mark.svg');
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const iconImages = await Promise.all(iconSizes.map(size => sharp(mark)
  .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()));
await writeFile(path.join(desktopOutput, 'desktop', 'tray.png'), iconImages.at(-1));
const iconHeader = Buffer.alloc(6 + iconImages.length * 16); iconHeader.writeUInt16LE(1, 2); iconHeader.writeUInt16LE(iconImages.length, 4);
let iconOffset = iconHeader.length;
for (const [index, data] of iconImages.entries()) {
  const size = iconSizes[index]; const offset = 6 + index * 16;
  iconHeader[offset] = size === 256 ? 0 : size; iconHeader[offset + 1] = size === 256 ? 0 : size;
  iconHeader.writeUInt16LE(1, offset + 4); iconHeader.writeUInt16LE(32, offset + 6);
  iconHeader.writeUInt32LE(data.length, offset + 8); iconHeader.writeUInt32LE(iconOffset, offset + 12); iconOffset += data.length;
}
await writeFile(path.join(root, '.local', 'desktop-icon.ico'), Buffer.concat([iconHeader, ...iconImages]));

const copied = new Set();
async function packageDirectory(name, parentDirectory) {
  const resolver = createRequire(path.join(parentDirectory, 'package.json'));
  let entry;
  try { entry = resolver.resolve(`${name}/package.json`); } catch { entry = resolver.resolve(name); }
  let directory = path.dirname(entry);
  while (true) {
    try { const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); if (manifest.name === name) return { directory, manifest }; } catch {}
    const parent = path.dirname(directory); if (parent === directory) throw new Error(`Cannot locate dependency ${name}.`); directory = parent;
  }
}
async function copyDependency(name, parentDirectory = root) {
  const { directory, manifest } = await packageDirectory(name, parentDirectory);
  if (copied.has(name)) return; copied.add(name);
  await cp(directory, path.join(desktopOutput, 'node_modules', ...name.split('/')), { recursive: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyDependency(dependency, directory);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try { await copyDependency(dependency, directory); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
}
for (const dependency of ['@microsoft/mxc-sdk', '@playwright/mcp', 'electron-updater', 'iconv-lite', 'zod']) await copyDependency(dependency);
const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(desktopOutput, 'package.json'), JSON.stringify({ name: 'another-rae-desktop', productName: rootPackage.productName, version: rootPackage.version,
  description: 'Tenon local device companion', author: 'Tenon', private: true, type: 'module', main: 'desktop/main.js',
  dependencies: { '@microsoft/mxc-sdk': '1.0.1', '@playwright/mcp': rootPackage.dependencies['@playwright/mcp'], 'electron-updater': rootPackage.dependencies['electron-updater'], 'iconv-lite': rootPackage.dependencies['iconv-lite'], zod: rootPackage.dependencies.zod } }, null, 2));
process.stdout.write(`Desktop built: ${desktopOutput}\n`);
