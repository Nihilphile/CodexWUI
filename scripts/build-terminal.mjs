import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const source = fileURLToPath(new URL('../server/native/terminal.c', import.meta.url));
export const terminalHelperPath = fileURLToPath(new URL(`../.data/runtime/terminal-${process.platform}-${process.arch}`, import.meta.url));
let pendingBuild;

export async function buildTerminal() {
  if (!['android', 'linux'].includes(process.platform)) throw new Error('当前系统暂不支持工作区终端');
  if (pendingBuild) return pendingBuild;
  pendingBuild = (async () => {
    await mkdir(path.dirname(terminalHelperPath), { recursive: true, mode: 0o700 });
    const output = `${terminalHelperPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await promisify(execFile)(process.env.CC || 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output],
        { timeout: 15000, maxBuffer: 65536 });
      await chmod(output, 0o700);
      await rename(output, terminalHelperPath);
      return terminalHelperPath;
    } finally {
      await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  })();
  try { return await pendingBuild; } finally { pendingBuild = undefined; }
}

export async function ensureTerminalHelper() {
  if (!['android', 'linux'].includes(process.platform)) throw new Error('当前系统暂不支持工作区终端');
  try {
    const [binary, code] = await Promise.all([stat(terminalHelperPath), stat(source)]);
    await access(terminalHelperPath, constants.X_OK);
    if (binary.isFile() && binary.mtimeMs >= code.mtimeMs) return terminalHelperPath;
  } catch (error) {
    if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
  }
  return buildTerminal();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildTerminal();
  console.log('已编译工作区终端模块');
}
