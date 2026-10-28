import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readProcess } from './processes.mjs';

const helper = fileURLToPath(new URL('../scripts/reload.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../scripts/launch.mjs', import.meta.url));

// The helper is a child of the Web owner, outside Codex's supervised process
// tree. It waits for this exact process identity to exit before launching again.
export async function prepareReload({ dataDir, port, close, launchPath = launcher }) {
  const identity = readProcess(process.pid);
  if (!identity) throw new Error('无法确认服务进程身份，未执行重启');
  const log = await open(path.join(dataDir, 'server.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [helper, JSON.stringify({ pid: process.pid, start: identity.start, launchPath })], {
      cwd: process.cwd(), env: { ...process.env, DATA_DIR: path.resolve(dataDir), PORT: String(port) },
      detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('重启助手未就绪，服务保持运行')); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('重启助手提前退出，服务保持运行')); });
      child.once('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(); } });
    });
  } finally { await log.close(); }
  let committed = false;
  return () => {
    if (committed) return;
    committed = true;
    child.send({ type: 'restart' }, error => {
      if (error) { console.error('无法启动重启流程：', error.message); return; }
      child.disconnect(); child.unref();
      setTimeout(async () => {
        try {
          const result = await close();
          if (result?.error) { console.error('后台清理失败，取消重启：', result.error); return; }
          process.exit(0);
        } catch (error) { console.error('后台清理失败，取消重启：', error.message); }
      }, 100);
    });
  };
}
