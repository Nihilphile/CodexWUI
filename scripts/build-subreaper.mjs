import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, rename, unlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { subreaperPath } from '../server/subreaper.mjs';

export async function buildSubreaper() {
  if (!['android', 'linux'].includes(process.platform)) return false;
  const includes = [path.resolve(path.dirname(process.execPath), '../include/node'), '/usr/include/node', '/usr/local/include/node'];
  let include;
  for (const directory of includes) {
    try { await access(path.join(directory, 'node_api.h')); include = directory; break; } catch {}
  }
  if (!include) throw new Error('未找到 Node 的 C 头文件');
  await mkdir(path.dirname(subreaperPath), { recursive: true, mode: 0o700 });
  const output = `${subreaperPath}.${process.pid}.tmp`;
  try {
    await promisify(execFile)(process.env.CC || 'cc', ['-shared', '-fPIC', '-O2', '-DNAPI_VERSION=8',
      '-I', include, fileURLToPath(new URL('../server/native/subreaper.c', import.meta.url)), '-o', output],
    { timeout: 15000, maxBuffer: 65536 });
    await rename(output, subreaperPath);
    return true;
  } finally { await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildSubreaper(); console.log('已编译孤儿进程回收模块');
}
