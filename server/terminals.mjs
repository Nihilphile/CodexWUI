import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ensureTerminalHelper } from '../scripts/build-terminal.mjs';
import { ProcessInventory, reapProcesses } from './processes.mjs';

const MAX_HISTORY = 512 * 1024;
const MAX_PENDING = 256 * 1024;
const MAX_INPUT = 16 * 1024;
const LIMITS = Object.freeze({ maxTerminals: 8, maxPerProject: 4 });
const fail = (status, message) => Object.assign(new Error(message), { status });

export function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200) {
    throw fail(400, '终端尺寸无效，列数需为 2–500，行数需为 1–200');
  }
  return { cols, rows };
}

function inputBytes(data) {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(MAX_INPUT / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw fail(400, '终端输入必须是至多 16 KiB 的 base64 字节');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_INPUT || bytes.toString('base64') !== data) throw fail(400, '终端输入无效或超过 16 KiB');
  return bytes;
}

function metadata(session) {
  return Object.fromEntries(['id', 'project', 'name', 'cwd', 'shell', 'status', 'cols', 'rows', 'exitCode', 'signal', 'error', 'sequence'].map(key => [key, session[key]]));
}

export class ProjectTerminals {
  constructor() {
    this.sessions = new Map();
    this.counter = 0;
    this.closed = false;
  }

  list(project) {
    return { terminals: [...this.sessions.values()].filter(session => session.project === project.id && session.status !== 'starting' && !session.removing).map(metadata), limits: LIMITS };
  }

  session(project, id) {
    const session = this.sessions.get(id);
    if (!session || session.project !== project.id || session.removing) throw fail(404, '终端不存在或已结束');
    return session;
  }

  async create(project, size) {
    terminalSize(size.cols, size.rows);
    if (this.closed) throw fail(503, '服务正在关闭');
    const running = [...this.sessions.values()].filter(session => session.status !== 'exited');
    if (running.length >= LIMITS.maxTerminals || running.filter(session => session.project === project.id).length >= LIMITS.maxPerProject) {
      throw fail(429, '终端数量已达上限：每个项目 4 个，全局 8 个；请先结束不用的终端');
    }
    for (const [id, previous] of this.sessions) {
      if (this.sessions.size < 16) break;
      if (previous.status === 'exited') this.sessions.delete(id);
    }
    const shell = process.env.SHELL || (process.env.PREFIX ? path.join(process.env.PREFIX, 'bin/bash') : '/bin/sh');
    const session = {
      id: randomUUID(), project: project.id, name: `终端 ${++this.counter}`, cwd: project.path, shell,
      status: 'starting', ...size, exitCode: null, signal: null, error: null, sequence: 0,
      history: [], historyBytes: 0, clients: new Set(), child: null, removing: false,
    };
    this.sessions.set(session.id, session);
    session.starting = this.start(session);
    try {
      await session.starting;
      return metadata(session);
    } catch (error) {
      if (session.child) await this.stop(session);
      this.sessions.delete(session.id);
      throw error;
    }
  }

  async start(session) {
    await access(session.shell, constants.X_OK).catch(() => { throw fail(503, '找不到可执行的本机 shell，请检查 SHELL 环境变量'); });
    const helper = await ensureTerminalHelper().catch(error => {
      throw fail(503, `终端模块不可用：${error.message}。Termux 请确认已安装 clang，然后重新新建终端。`);
    });
    if (this.closed || session.removing) throw fail(503, '服务或终端正在关闭');
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PWD: session.cwd };
    for (const key of ['TMUX', 'STY', 'CODEXWUI_SUPERVISOR_LIMITS', 'CODEXWEB_SUPERVISOR_LIMITS']) delete env[key];
    const child = session.child = spawn(helper, [session.shell, String(session.cols), String(session.rows)], {
      cwd: session.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let accept, reject;
    const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    const timeout = setTimeout(() => reject(fail(503, '终端启动超时')), 8000);
    let statusBuffer = '', diagnostic = '';
    session.done = new Promise(resolve => {
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        reject(fail(503, diagnostic.trim() || '终端在启动前已退出'));
        session.status = 'exited';
        session.helperCode = code;
        if (code !== 0 || signal) session.error ||= diagnostic.trim() || `终端辅助进程异常退出：${signal || code}`;
        session.exitCode ??= code;
        session.signal ??= signal;
        this.send(session, 'exit', { terminal: metadata(session) });
        for (const client of [...session.clients]) client.end();
        resolve();
      });
    });
    child.once('spawn', () => {
      try { session.inventory = new ProcessInventory(child.pid); } catch {}
    });
    child.once('error', error => reject(fail(503, `终端启动失败：${error.message}`)));
    child.stdout.on('data', bytes => this.output(session, bytes));
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    child.stdin.on('error', () => {});
    child.stdio[3].on('error', () => {});
    child.stdio[4].on('data', bytes => {
      statusBuffer += bytes.toString();
      if (statusBuffer.length > 16384) { reject(fail(503, '终端状态协议超限')); child.kill('SIGTERM'); return; }
      let boundary;
      while ((boundary = statusBuffer.indexOf('\n')) >= 0) {
        const line = statusBuffer.slice(0, boundary); statusBuffer = statusBuffer.slice(boundary + 1);
        let event;
        try { event = JSON.parse(line); }
        catch { reject(fail(503, '终端状态协议无效')); child.kill('SIGTERM'); return; }
        if (event.type === 'ready') {
          session.status = 'running'; session.shellPid = event.pid; session.inventory?.scan(); clearTimeout(timeout); accept();
        } else if (event.type === 'exit') {
          session.exitCode = event.code; session.signal = event.signal;
        } else if (event.type === 'error') {
          session.error = event.message || '终端辅助进程出错';
          reject(fail(503, session.error));
        }
      }
    });
    await ready;
  }

  output(session, bytes) {
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      const chunk = bytes.subarray(offset, offset + 16384);
      const event = { sequence: ++session.sequence, data: chunk.toString('base64') };
      const entry = { ...event, bytes: chunk.length };
      session.history.push(entry); session.historyBytes += entry.bytes;
      while (session.historyBytes > MAX_HISTORY || session.history.length > 2048) session.historyBytes -= session.history.shift().bytes;
      this.send(session, 'output', event, event.sequence);
    }
  }

  send(session, type, data, sequence) {
    const wire = `${sequence === undefined ? '' : `id: ${sequence}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of session.clients) {
      if (client.destroyed || client.writableLength > MAX_PENDING) client.destroy();
      else client.write(wire);
    }
  }

  stream(project, id, req, res, after) {
    if (!Number.isSafeInteger(after) || after < 0) throw fail(400, '终端输出位置无效');
    let session;
    try { session = this.session(project, id); }
    catch (error) {
      if (error.status !== 404) throw error;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.end(`event: missing\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      return;
    }
    if (session.clients.size >= 4) throw fail(429, '终端连接过多');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const first = session.history[0]?.sequence || session.sequence + 1;
    const reset = after === 0 || after < first - 1 || after > session.sequence;
    const truncated = first > 1 && reset;
    res.write(`event: ready\ndata: ${JSON.stringify({ terminal: metadata(session), reset, truncated })}\n\n`);
    for (const entry of session.history) {
      if (reset || entry.sequence > after) res.write(`id: ${entry.sequence}\nevent: output\ndata: ${JSON.stringify({ sequence: entry.sequence, data: entry.data })}\n\n`);
    }
    if (session.status === 'exited') {
      res.end(`event: exit\ndata: ${JSON.stringify({ terminal: metadata(session) })}\n\n`);
      return;
    }
    session.clients.add(res);
    const heartbeat = setInterval(() => {
      if (res.writableLength > MAX_PENDING) res.destroy();
      else res.write('event: heartbeat\ndata: {}\n\n');
    }, 10000);
    const detach = () => { clearInterval(heartbeat); session.clients.delete(res); };
    res.once('close', detach);
    req.once('aborted', () => res.destroy());
  }

  async input(project, id, data) {
    const bytes = inputBytes(data);
    const session = this.session(project, id);
    if (session.status !== 'running' || session.child.stdin.destroyed) throw fail(409, '终端已结束或尚未就绪');
    if (session.child.stdin.writableLength > 65536) throw fail(429, '终端输入过快，请稍后继续');
    await new Promise((resolve, reject) => session.child.stdin.write(bytes, error => error ? reject(fail(409, '终端输入失败，请检查会话状态')) : resolve()));
    return { ok: true };
  }

  resize(project, id, cols, rows) {
    const size = terminalSize(cols, rows);
    const session = this.session(project, id);
    if (session.status !== 'running' || session.child.stdio[3].destroyed) throw fail(409, '终端已结束或尚未就绪');
    if (session.child.stdio[3].writableLength > 8192) throw fail(429, '终端尺寸更新过快，请稍后继续');
    session.child.stdio[3].write(`resize ${cols} ${rows}\n`);
    Object.assign(session, size);
    return { terminal: metadata(session) };
  }

  async stop(session) {
    if (!session.child) return;
    if (!session.stopping) {
      session.stopping = (async () => {
        if (session.status === 'exited') return;
        session.inventory?.scan();
        // A shell can suspend its helper. Resume it so close/EOF is processed.
        session.child.kill('SIGCONT');
        session.child.stdio[3].end('close\n');
        session.child.stdin.end();
        let timeout;
        const finished = await Promise.race([
          session.done.then(() => true),
          new Promise(resolve => { timeout = setTimeout(() => resolve(false), 3000); }),
        ]);
        clearTimeout(timeout);
        if (!finished) {
          if (!session.inventory) throw fail(500, '无法确认终端进程归属，请检查 Termux 进程状态');
          const leftovers = await reapProcesses(session.inventory);
          if (leftovers.length) throw fail(500, `终端清理后仍有 ${leftovers.length} 个进程未退出`);
          for (const channel of session.child.stdio) channel?.destroy();
          await session.done;
        } else if (session.helperCode !== 0) throw fail(500, session.error || '终端清理失败，请检查 Termux 进程状态');
      })();
    }
    await session.stopping;
  }

  async remove(project, id) {
    const session = this.session(project, id);
    session.removing = true;
    await session.starting.catch(() => {});
    await this.stop(session);
    this.sessions.delete(id);
    return { terminal: metadata(session) };
  }

  resources() {
    let processes = 0, rssKb = 0;
    for (const session of this.sessions.values()) {
      if (!session.inventory || session.status === 'exited') continue;
      const values = session.inventory.scan();
      processes += values.length;
      rssKb += values.reduce((sum, value) => sum + value.rssKb, 0);
    }
    return { terminals: [...this.sessions.values()].filter(session => session.status !== 'exited').length, processes, rssMb: Math.ceil(rssKb / 1024) };
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.all([...this.sessions.values()].map(async session => {
        session.removing = true;
        await session.starting.catch(() => {});
        await this.stop(session);
      })).then(() => this.sessions.clear());
    }
    return this.closing;
  }
}
