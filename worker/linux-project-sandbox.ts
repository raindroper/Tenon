import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { CodexRpc } from '../desktop/codex-rpc.js';
import { configureProject, verifyProjectResources, type LinuxProjectResources } from '../desktop/project-configuration.js';
import { serverProjectResources, expectedServerProjectResources, type LocalProjectSpec } from '../shared/local-project.js';
import { LINUX_CODEX_RUNTIME } from '../shared/codex-runtime.js';

const TMPFS_MAGIC = 0x01021994;
const bubblewrap = '/usr/bin/bwrap';
const systemRoots = ['/usr', '/bin', '/sbin', '/lib', '/lib64'] as const;
const systemFiles = ['/etc/ld.so.cache', '/etc/resolv.conf', '/etc/nsswitch.conf', '/etc/ssl/certs'] as const;

async function enforceLimits(root: string): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 || process.ppid !== 1) {
    throw new Error('服务端项目需要专用的 Linux x64 非 root 执行用户。');
  }
  if (!path.isAbsolute(root) || root === '/' || await realpath(root) !== root) throw new Error('服务端临时空间路径不可用。');
  const [mount, cgroup, cpu, memory, processes] = await Promise.all([
    statfs(root), readFile('/proc/self/cgroup', 'utf8'), readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
    readFile('/sys/fs/cgroup/memory.max', 'utf8'), readFile('/sys/fs/cgroup/pids.max', 'utf8'),
  ]);
  const limits = serverProjectResources(false);
  if (mount.type !== TMPFS_MAGIC || mount.bsize * mount.blocks > limits.diskMiB * 1024 ** 2) {
    throw new Error('服务端临时空间缺少已声明的磁盘上限。');
  }
  const [quota, period] = cpu.trim().split(/\s+/).map(Number);
  const within = (value: number, ceiling: number) => Number.isFinite(value) && value > 0 && value <= ceiling;
  if (cgroup.trim() !== '0::/' || !within(quota * 1000 / period, limits.cpuMillis)
    || !within(Number(memory.trim()), limits.memoryMiB * 1024 ** 2)
    || !within(Number(processes.trim()), limits.maxProcesses)) throw new Error('服务端进程缺少已声明的 cgroup 资源上限。');
}

/** The job sees a fresh PID namespace, system dependencies and its bounded scratch directory. */
export function linuxProjectResources(root: string, engine: string, node: string, hook: string): LinuxProjectResources {
  const runtimeRoot = path.dirname(path.dirname(engine));
  const runtimeFiles = Object.keys(LINUX_CODEX_RUNTIME.requiredFiles).map(file => path.join(runtimeRoot, file));
  const directory = (operationId: string) => path.join(root, createHash('sha256').update(operationId).digest('hex'));
  const command = (work: string, args: string[]) => ({
    executable: bubblewrap,
    args: ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
      ...systemRoots.flatMap(file => ['--ro-bind-try', file, file]),
      ...systemFiles.flatMap(file => ['--ro-bind-try', file, file]),
      ...[...runtimeFiles, node, hook].filter(file => !systemRoots.some(system => file.startsWith(system + '/')))
        .flatMap(file => ['--ro-bind', file, file]),
      '--dev', '/dev', '--proc', '/proc', '--remount-ro', '/dev', '--bind', work, work,
      '--ro-bind', path.join(work, 'inputs'), path.join(work, 'inputs'),
      '--bind', path.join(work, 'temporary'), '/tmp', '--remount-ro', '/', '--', engine, ...args],
  });
  const clean = async (work: string) => {
    if (path.dirname(work) !== root || !/^[0-9a-f]{64}$/.test(path.basename(work))) throw new Error('临时目录超出已授权空间。');
    const entry = await lstat(work).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    if (!entry) return;
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(work) !== work) throw new Error('临时目录身份改变，等待核对。');
    await rm(work, { recursive: true });
  };
  let verified: Promise<void> | undefined;
  const resources: LinuxProjectResources = { platform: 'linux', engine, node, hook, sandbox: {
    directory, command, clean, verify: () => verified ??= verifySandbox(root, resources),
    discarded: async work => {
      try { await lstat(work); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    },
  } };
  return resources;
}

async function verifySandbox(root: string, resources: LinuxProjectResources): Promise<void> {
  await enforceLimits(root);
  await verifyProjectResources(resources);
  const workspace = await mkdtemp(path.join(root, 'check-'));
  const listener = createServer(socket => socket.end());
  try {
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('沙箱测试入口不可用。');
    const gate = 'http://127.0.0.1:' + address.port;
    const work = path.join(workspace, 'workspace');
    await mkdir(work, { mode: 0o700 });
    for (const network of [false, true]) {
      const input = { spec: { access: 'read-write', readAccess: 'project', network, serverResources: serverProjectResources(network) },
        model: { model: 'isolation-check' } } as const;
      const entry = { realPath: work, input };
      const configuration = await configureProject(entry, workspace, resources, gate, 'rae-isolation-probe');
      const marker = path.join(work, 'result');
      await writeFile(marker, '');
      let nativeError: Error | undefined;
      let diagnostics = '';
      const rpc = new CodexRpc({ ...resources.sandbox.command(workspace, configuration.args), cwd: work, env: configuration.environment,
        onFailure: error => { nativeError = error; }, onNotification: () => {}, onRequest: async () => { throw new Error('Unexpected sandbox check request.'); },
        onStderr: chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); },
        requestTimeoutMs: 12000 });
      try {
        await rpc.request('initialize', { clientInfo: { name: 'another_rae_isolation_check', version: '1' }, capabilities: { experimentalApi: true } });
        rpc.notify('initialized');
        const code = `
import fs from 'node:fs';
import net from 'node:net';
const [config, destination, port, network] = process.argv.slice(1);
if (process.env.RAE_PROJECT_TOKEN || process.env.RAE_PROJECT_GATE || fs.existsSync(config)) process.exit(11);
for (const pid of fs.readdirSync('/proc').filter(x => /^\\d+$/.test(x))) {
  try { if (fs.readFileSync('/proc/' + pid + '/environ', 'utf8').includes('rae-isolation-probe')) process.exit(12); }
  catch {}
}
for (const file of ['/rae-probe', '/tmp/rae-probe', '/dev/rae-probe', '/usr/rae-probe', '/etc/rae-probe']) {
  try { fs.writeFileSync(file, 'leak'); process.exit(13); } catch {}
}
const connected = await new Promise(resolve => {
  const socket = net.connect(Number(port), '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
if (connected !== (network === 'true')) process.exit(14);
fs.writeFileSync(destination, 'ok');`;
        const result = await rpc.request<{ exitCode: number; stderr: string }>('command/exec', { command: [resources.node, '--input-type=module', '-e', code,
          path.join(configuration.home, 'config.toml'), marker, String(address.port), String(network)], cwd: work,
          permissionProfile: configuration.permissions, timeoutMs: 6000, outputBytesCap: 4096 });
        if (nativeError || result.exitCode !== 0 || await readFile(marker, 'utf8') !== 'ok') {
          throw new Error('Linux 沙箱没有通过文件、进程或网络隔离检查（' + result.exitCode + '）。' + result.stderr.slice(-1000));
        }
      } catch (error) {
        await rpc.close().catch(() => {});
        throw new Error(String(error) + (diagnostics.trim() ? '\n' + diagnostics.trim() : ''), { cause: error });
      }
      await rpc.close();
    }
  } finally {
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
}

export function assertLinuxProjectScope(spec: LocalProjectSpec): void {
  if (spec.root !== 'task-temporary' || spec.create || spec.readAccess !== 'project' || !spec.serverResources
    || !isDeepStrictEqual(spec.serverResources, expectedServerProjectResources(spec.network, spec.serverResources))) {
    throw new Error('服务端任务许可与临时工作区和资源上限不匹配。');
  }
}
