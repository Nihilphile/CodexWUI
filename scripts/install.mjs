import { mkdir, lstat, readlink, symlink, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { buildSubreaper } from './build-subreaper.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'bin/CodexWeb');
const directory = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : path.join(os.homedir(), '.local/bin');
const destination = path.join(directory, 'CodexWeb');
await mkdir(directory, { recursive: true });
await chmod(source, 0o755);
try {
  const existing = await lstat(destination);
  if (!existing.isSymbolicLink() || await readlink(destination) !== source) throw new Error(`已有 ${destination}，没有覆盖。`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await symlink(source, destination);
}
console.log(`已安装命令：${destination}\n运行 CodexWeb 即可打开本地界面。`);
if (!(process.env.PATH || '').split(path.delimiter).includes(directory)) console.log(`请将 ${directory} 加入 PATH。`);
try {
  if (await buildSubreaper()) console.log('已启用孤儿进程回收模块');
} catch (error) { console.warn(`孤儿进程回收模块未编译：${error.message}。仍可启动，使用扫描回收模式。`); }
