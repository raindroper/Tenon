import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Use the same pinned interpreter/SQLCipher that the desktop package ships.
const python = resolve('.local/desktop-build/desktop/wechat-db/runtime/python.exe');
if (process.platform !== 'win32' || !existsSync(python)) {
  throw new Error('Run npm run desktop:build on Windows before npm run test:wechat.');
}
const source = [
  'import runpy, socket, sys',
  'def blocked(*args, **kwargs): raise RuntimeError("Offline reader tests forbid network access")',
  'socket.socket.connect = blocked',
  'socket.socket.connect_ex = blocked',
  'socket.create_connection = blocked',
  `sys.path.insert(0, ${JSON.stringify(resolve('desktop/wechat-db'))})`,
  `runpy.run_path(${JSON.stringify(resolve('desktop/wechat-db/test_reader.py'))}, run_name="__main__")`,
].join('\n');
const child = spawn(python, ['-I', '-B', '-u', '-X', 'utf8', '-c', source], { stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
