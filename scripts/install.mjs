import { mkdir, lstat, readlink, symlink, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { buildSubreaper } from './build-subreaper.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : path.join(os.homedir(), '.local/bin');
async function link(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await lstat(destination);
    if (!existing.isSymbolicLink() || await readlink(destination) !== source) throw new Error(`已有 ${destination}，没有覆盖。`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(source, destination);
  }
}
for (const name of ['CodexWeb', 'agentctl']) {
  const source = path.join(root, 'bin', name);
  await chmod(source, 0o755);
  await link(source, path.join(directory, name));
  console.log(`已安装命令：${path.join(directory, name)}`);
}
const skill = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills/agent-chat');
await link(path.join(root, 'skills/agent-chat'), skill);
console.log(`已安装技能：${skill}`);
if (!(process.env.PATH || '').split(path.delimiter).includes(directory)) console.log(`请将 ${directory} 加入 PATH。`);
try {
  if (await buildSubreaper()) console.log('已启用孤儿进程回收模块');
} catch (error) { console.warn(`孤儿进程回收模块未编译：${error.message}。仍可启动，使用扫描回收模式。`); }
