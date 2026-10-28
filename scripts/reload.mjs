import { spawn } from 'node:child_process';
import { readProcess } from '../server/processes.mjs';

const { pid, start, launchPath } = JSON.parse(process.argv[2]);
if (!Number.isSafeInteger(pid) || !start || !launchPath || !process.send) throw new Error('无效重启请求');
const timeout = setTimeout(() => process.exit(1), 10000);
let committed = false;
process.on('disconnect', () => { if (!committed) process.exit(1); });
process.once('message', async message => {
  if (message.type !== 'restart') process.exit(1);
  committed = true; clearTimeout(timeout);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const old = readProcess(pid);
    if (!old || old.start !== start || ['Z', 'X'].includes(old.state)) {
      const next = spawn(process.execPath, [launchPath, '--no-open'], { stdio: 'inherit', env: process.env });
      next.once('error', error => { console.error('重启失败：', error.message); process.exit(1); });
      next.once('exit', code => process.exit(code || 0));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.error('旧服务未完成退出，已取消启动新服务；请检查 server.log。');
  process.exit(1);
});
process.send({ type: 'ready' });
