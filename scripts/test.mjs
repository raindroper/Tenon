import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Test workers own all native clients. Clean only this run's disposable directory,
// after worker exit has released Windows libSQL handles.
const temporaryRoot = await realpath(tmpdir());
const directory = await realpath(await mkdtemp(join(temporaryRoot, 'another-rae-tests-')));
const environment = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory, RAE_OFFLINE_TESTS: '1' };
delete environment.DEEPSEEK_API_KEY;
delete environment.RAE_HUB_SEARCH_URL;
delete environment.RAE_HUB_MEDIA_URL;
delete environment.RAE_AUTH_FILE;
delete environment.RAE_PUBLIC_ORIGIN;
delete environment.RAE_SERVER_WORKER_ID;
delete environment.RAE_SERVER_WORKER_NAME;
delete environment.RAE_SERVER_WORKER_CREDENTIAL_HASH;
let code = 1;
try {
  const files = process.argv.slice(2);
  const child = spawn(process.execPath, ['--import', './scripts/test-network-guard.mjs', '--import', 'tsx', '--test', ...(files.length ? files : ['tests/*.test.ts'])], {
    stdio: 'inherit', env: environment, windowsHide: true,
  });
  code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', status => accept(status ?? 1)); });
} finally {
  const target = resolve(directory);
  if (target !== directory || dirname(target) !== temporaryRoot) throw new Error('Refused cleanup outside the test run directory.');
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
process.exitCode = code;
