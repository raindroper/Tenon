import { lstat, readFile, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { ProjectHand } from '../desktop/project-hand.js';
import { ProjectJournal } from '../desktop/project-journal.js';
import { consumeEvents, DeviceHttpError } from '../desktop/transport.js';
import { CODEX_RUNTIME } from '../shared/codex-runtime.js';
import { createWorkerDeviceFetch } from './device-api.js';
import { assertLinuxProjectScope, linuxProjectResources } from './linux-project-sandbox.js';

function setting(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error('缺少执行端设置 ' + key + '。');
  return value;
}

async function run(): Promise<void> {
  const deviceId = setting('RAE_WORKER_DEVICE_ID');
  const credentialFile = setting('RAE_WORKER_CREDENTIAL_FILE');
  const stateDirectory = setting('RAE_WORKER_STATE_DIR');
  const workDirectory = setting('RAE_WORKER_WORK_DIR');
  const [state, credentialInfo] = await Promise.all([lstat(stateDirectory), lstat(credentialFile)]);
  if (!state.isDirectory() || (state.mode & 0o077) !== 0 || !credentialInfo.isFile() || (credentialInfo.mode & 0o077) !== 0) {
    throw new Error('执行端状态或设备凭据的文件权限不安全。');
  }
  const engine = await realpath(setting('RAE_WORKER_CODEX'));
  const hook = await realpath(setting('RAE_WORKER_HOOK'));
  const node = await realpath(process.execPath);
  const socket = setting('RAE_WORKER_API_SOCKET');
  const canonicalState = await realpath(stateDirectory);
  const canonicalCredential = await realpath(credentialFile);
  for (const privatePath of [canonicalState, canonicalCredential, socket]) {
    if (!path.isAbsolute(privatePath) || [workDirectory, '/usr', '/bin', '/sbin', '/lib', '/lib64', '/tmp', engine, hook, node]
      .some(root => privatePath === root || privatePath.startsWith(root + '/'))) throw new Error('执行端私有资料不能位于任务沙箱可读范围。');
  }
  const credential = (await readFile(canonicalCredential, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(credential)) throw new Error('执行端设备凭据无效。');
  const baseUrl = 'http://127.0.0.1';
  const request = createWorkerDeviceFetch(socket);
  const resources = linuxProjectResources(workDirectory, engine, node, hook);
  const status = (message: string) => process.stderr.write(message + '\n');
  await resources.sandbox.verify();
  const hand = new ProjectHand({ deviceId, baseUrl, credential, resources, journal: new ProjectJournal(path.join(canonicalState, 'projects')),
    request, status, post: async events => {
      const response = await request(baseUrl, '/api/device/projectevents', credential, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(events), signal: AbortSignal.timeout(15000),
      });
      return response.json() as Promise<{ sequence: number }>;
    } });
  await hand.recover();
  const capabilities = await hand.capabilities();
  if (!capabilities.length) throw new Error('服务端项目执行隔离未就绪。');
  const lifecycle = new AbortController();
  const stop = () => lifecycle.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    let backoff = 1000;
    while (!lifecycle.signal.aborted) {
      let pulse: ReturnType<typeof setInterval> | undefined;
      let flush: Promise<void> | undefined;
      try {
        await hand.flush();
        const response = await request(baseUrl, '/api/device/status', credential, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grants: [], capabilities, version: CODEX_RUNTIME.version }),
          signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(15000)]),
        });
        await response.body?.cancel();
        const events = await request(baseUrl, '/api/device/events', credential, { headers: { Accept: 'text/event-stream' }, signal: lifecycle.signal });
        status('服务端执行设备已连接。');
        backoff = 1000;
        pulse = setInterval(() => { flush = hand.flush(); }, 30000);
        await consumeEvents(events, message => {
          if (message.kind === 'project-execute') assertLinuxProjectScope(message.input.spec);
          hand.accept(message);
        }, lifecycle.signal);
      } catch (error) {
        if (!lifecycle.signal.aborted) {
          if (error instanceof DeviceHttpError && error.status === 401) throw error;
          status('服务端执行设备连接中断：' + (error instanceof Error ? error.message : String(error)));
        }
      } finally {
        clearInterval(pulse);
        await hand.pause('服务端执行设备连接中断，正在排空任务环境。');
        await flush;
      }
      if (!lifecycle.signal.aborted) {
        await delay(backoff, undefined, { signal: lifecycle.signal }).catch(error => { if (!lifecycle.signal.aborted) throw error; });
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await hand.stop();
  }
}

process.umask(0o077);
void run().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
