import { spawn } from 'node:child_process';
import { ProcessInventory, readProcess, reapProcesses } from './processes.mjs';
import { loadSubreaper } from './subreaper.mjs';
import { validateResourceLimits } from './limits.mjs';

// A separate process survives an abrupt Web-owner exit. RPC bytes pass through
// unchanged; resource and shutdown messages use an independent IPC channel.
const [binary, ...args] = process.argv.slice(2);
const limits = JSON.parse(process.env.CODEXWEB_SUPERVISOR_LIMITS);
delete process.env.CODEXWEB_SUPERVISOR_LIMITS;
const owner = readProcess(process.ppid);
const native = loadSubreaper();
const adopting = native?.enable() || false;
const child = spawn(binary, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
let inventory, monitor, stopping, fault, sampling = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function tell(message) { if (process.connected) { try { process.send(message, () => {}); } catch {} } }
function reportFault(message) { fault ||= message; tell({ type: 'fault', message: fault }); }

function sample() {
  const values = inventory.scan();
  const rssKb = values.reduce((sum, value) => sum + value.rssKb, 0) +
    (readProcess(process.pid)?.rssKb || 0) +
    (owner && readProcess(owner.pid)?.start === owner.start ? readProcess(owner.pid)?.rssKb || 0 : 0);
  tell({ type: 'resources', processes: values.length, rssMb: Math.ceil(rssKb / 1024),
    maxProcesses: limits.maxProcesses, maxRssMb: limits.maxRssMb, orphanProtection: adopting, sampledAt: Date.now() });
  tell({ type: 'inventory', root: inventory.root, adopter: inventory.adopter, values: values.map(({ pid, start }) => ({ pid, start })) });
  return { values, rssKb };
}

function shutdown(message) {
  if (stopping) return stopping;
  if (message) reportFault(message);
  clearInterval(monitor);
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  if (!inventory && child.pid && adopting) {
    inventory = new ProcessInventory(child.pid, undefined, { adopter: readProcess(process.pid), reap: native.reap });
  }
  stopping = (async () => {
    if (inventory) {
      // Graceful EOF, then TERM, then KILL. Keep sampling during every stage so
      // descendants created during shutdown are included in the next sweep.
      const remaining = await reapProcesses(inventory);
      if (remaining.length) reportFault(`Codex 清理后仍有 ${remaining.length} 个进程未退出`);
      // A zombie has no RSS but still needs libuv to consume its exit status.
      // Yield before exiting the guardian rather than orphaning that zombie.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(700)]);
      }
      inventory.scan();
    } else if (child.pid && child.exitCode === null) {
      // Failed identity acquisition: this ChildProcess handle still refers to
      // our immediate child; never guess identities of other processes.
      child.kill('SIGKILL');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(700)]);
    }
    tell({ type: 'stopped', error: fault || null });
    process.exit(fault ? 1 : 0);
  })().catch(() => {
    reportFault('Codex 进程清理失败，请检查 Termux 进程状态');
    try { child.kill('SIGKILL'); } catch {}
    tell({ type: 'stopped', error: fault }); process.exit(1);
  });
  return stopping;
}

child.on('spawn', () => {
  if (stopping) return;
  try {
    inventory = new ProcessInventory(child.pid, undefined, {
      adopter: adopting ? readProcess(process.pid) : null, reap: adopting ? native.reap : null,
    });
    monitor = setInterval(() => {
      if (sampling || stopping) return;
      sampling = true;
      try {
        if (!owner || readProcess(owner.pid)?.start !== owner.start) {
          shutdown('Web 服务已退出，正在回收 Codex 子进程'); return;
        }
        const { values, rssKb } = sample();
        if (values.length > limits.maxProcesses) shutdown(`进程数量超过 ${limits.maxProcesses} 个，已停止 Codex 以保护平板`);
        else if (rssKb > limits.maxRssMb * 1024) shutdown(`内存占用超过 ${limits.maxRssMb} MiB，已停止 Codex 以保护平板`);
      } catch { shutdown('无法监测 Codex 进程，已停止后端'); }
      finally { sampling = false; }
    }, limits.pollIntervalMs || 500);
    sample();
  } catch (error) { shutdown(error.message); }
});
child.on('error', error => shutdown(`Codex 启动失败：${error.code || '未知错误'}`));
child.on('exit', (code, signal) => { if (!stopping) shutdown(`Codex 进程已退出 (${signal || code})`); });
child.stdin.on('error', () => { if (!stopping) shutdown('Codex 输入连接已关闭'); });
process.stdout.on('error', () => shutdown());
process.stderr.on('error', () => {});
process.stdin.on('error', () => shutdown());
process.stdin.on('end', () => shutdown());
process.on('disconnect', () => shutdown());
process.on('message', message => {
  if (message?.type === 'close') shutdown();
  if (message?.type !== 'limits/update') return;
  try {
    if (stopping || !inventory) throw new Error('Codex 守护进程尚未就绪或正在关闭');
    const next = validateResourceLimits(message.limits);
    const { values, rssKb } = sample();
    if (next.maxProcesses < limits.maxProcesses && values.length > next.maxProcesses) throw new Error(`进程上限低于当前用量 ${values.length}，请先清理任务`);
    if (next.maxRssMb < limits.maxRssMb && rssKb > next.maxRssMb * 1024) throw new Error(`RAM 上限低于当前用量 ${Math.ceil(rssKb / 1024)} MiB，请先清理任务`);
    Object.assign(limits, next);
    tell({ type: 'limits/updated', id: message.id, limits: next });
    sample();
  } catch (error) { tell({ type: 'limits/updated', id: message.id, error: error.message }); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
process.stdin.pipe(child.stdin, { end: false });
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
