import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readProcess, ProcessInventory, reapProcesses } from '../server/processes.mjs';
import { installShutdownHandlers } from '../server/runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, '.data');
const port = Number(process.env.PORT || 4310);
const url = `http://localhost:${port}`;
const args = new Set(process.argv.slice(2));
const pidFile = path.join(dataDir, 'server.pid');
const entry = path.join(root, 'server/index.mjs');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
if (args.has('--help')) {
  console.log('CodexWeb             后台启动并打开手机浏览器\nCodexWeb --no-open   后台启动，不打开浏览器\nCodexWeb --status    查看状态\nCodexWeb --stop      停止服务及其 Codex 进程\nCodexWeb --foreground 前台运行\n可用 PORT 设置端口，默认 4310。');
  process.exit();
}
async function probe() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(1200) });
    const data = await response.json();
    return data.app === 'termux-codex-web' && data.root === root ? data : null;
  } catch { return null; }
}
async function savedProcess() {
  try {
    const record = JSON.parse(await readFile(pidFile, 'utf8'));
    if (!Number.isSafeInteger(record.pid) || record.pid < 2) return null;
    if (record.start && readProcess(record.pid)?.start !== record.start) return null;
    const cmdline = await readFile(`/proc/${record.pid}/cmdline`, 'utf8');
    return cmdline.split('\0').includes(entry) ? record : null;
  } catch { return null; }
}
async function savePid(pid) {
  const temporary = `${pidFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid, start: readProcess(pid)?.start, port }), { mode: 0o600 });
  await rename(temporary, pidFile);
}
if (args.has('--stop')) {
  const record = await savedProcess();
  if (!record) { console.log('没有找到由 CodexWeb 启动的后台服务。'); process.exit(); }
  const inventory = new ProcessInventory(record.pid);
  inventory.scan();
  const identity = inventory.root.start;
  if (readProcess(record.pid)?.start === identity) process.kill(record.pid, 'SIGTERM');
  console.log('正在停止 CodexWeb 并回收后台进程…');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = readProcess(record.pid);
    inventory.scan();
    if (!value || value.start !== identity || ['Z', 'X'].includes(value.state)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const remaining = readProcess(record.pid);
  if (remaining && remaining.start === identity && !['Z', 'X'].includes(remaining.state)) {
    console.log('服务未及时退出，正在强制回收本次服务的进程…');
  }
  const leftovers = await reapProcesses(inventory);
  if (leftovers.length) { console.error(`停止未完成：仍有 ${leftovers.length} 个进程未退出。请检查 Termux 进程状态。`); process.exit(1); }
  console.log('CodexWeb 已停止，后续消息已保留为未发出。');
  process.exit();
}
if (args.has('--status')) {
  const info = await probe();
  console.log(info ? `运行中：${url} · Codex ${info.connected ? '已连接' : '未连接'}` : `未运行：${url}`);
  if (info?.resources) {
    const usage = info.resources;
    console.log(`运行会话 ${usage.activeTurns}/${usage.limits.maxActiveTurns} · 后台进程 ${usage.processes ?? '未采样'}/${usage.limits.maxProcesses} · 内存 ${usage.rssMb ?? '未采样'}/${usage.limits.maxRssMb} MiB`);
    console.log(`孤儿进程回收：${usage.orphanProtection ? '已启用' : '未启用，可运行 npm run setup'}`);
  }
  if (info?.error) console.log(info.error);
  process.exit(info ? 0 : 1);
}
if (args.has('--foreground')) {
  process.chdir(root);
  await import('../server/index.mjs').then(async ({ createApp }) => {
    const app = await createApp({ dataDir });
    app.server.on('error', error => { console.error(error.message); void app.close(); process.exitCode = 1; });
    app.server.listen(port, '127.0.0.1', () => console.log(`CodexWeb：${url}（Ctrl+C 停止）`));
    installShutdownHandlers(app);
  });
} else {
  let running = await probe();
  if (!running) {
    if (await savedProcess()) {
      console.error('已有 CodexWeb 服务仍在运行但暂未响应；不会重复启动。请用 CodexWeb --stop 等待清理后再启动。'); process.exit(1);
    }
    const log = await open(path.join(dataDir, 'server.log'), 'a', 0o600);
    const child = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) }, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', error => console.error(`启动失败：${error.message}`));
    child.unref();
    await savePid(child.pid);
    await log.close();
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      running = await probe();
      if (running) break;
    }
    if (!running) { console.error(`启动失败，请查看 ${path.join(dataDir, 'server.log')}，或用 CodexWeb --foreground 查看错误。`); process.exit(1); }
    // Concurrent launches may race for the port. The loser is reaped by its
    // server error handler; always record the process actually serving HTTP.
    if (running.serverPid) await savePid(running.serverPid);
  }
  console.log(`CodexWeb：${url}\n后台运行中。停止：CodexWeb --stop`);
  if (!args.has('--no-open')) {
    const browser = spawn('termux-open-url', [url], { stdio: 'ignore', detached: true });
    browser.on('error', () => console.log(`请在浏览器打开 ${url}`));
    browser.unref();
  }
}
