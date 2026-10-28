import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolveCodexBinary } from './runtime.mjs';
import { fileURLToPath } from 'node:url';
import { resourceLimits, validateResourceLimits } from './limits.mjs';
import { ProcessInventory, reapProcesses } from './processes.mjs';

const supervisor = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));

// A single reader owns stdout. Requests may finish in any order, and each
// notification keeps its thread/turn identity all the way to the browser.
export class CodexConnection extends EventEmitter {
  constructor({ binary = resolveCodexBinary(), timeout = 90000, spawnProcess = spawn, limits = resourceLimits() } = {}) {
    super();
    this.binary = binary;
    this.timeout = timeout;
    this.spawnProcess = spawnProcess;
    this.limits = limits;
    this.pending = new Map();
    this.limitUpdates = new Map();
    this.approvals = new Map();
    this.sequence = 0;
    this.ready = false;
    this.closing = false;
  }

  async start() {
    if (this.process || this.closing) throw new Error('此 Codex 连接已启动或已关闭');
    this.process = this.spawnProcess(process.execPath, [supervisor, this.binary, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], detached: true,
      env: { ...process.env, CODEXWEB_SUPERVISOR_LIMITS: JSON.stringify(this.limits) },
    });
    this.exited = new Promise(resolve => {
      this.process.once('exit', () => resolve());
      this.process.once('error', () => resolve());
    });
    this.process.on('message', message => {
      if (message.type === 'limits/updated') {
        const pending = this.limitUpdates.get(message.id);
        if (pending) {
          this.limitUpdates.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(Object.assign(new Error(message.error), { status: 409 }));
          else pending.resolve(message.limits);
        }
      }
      if (message.type === 'resources') { this.resources = message; this.emit('resources', message); }
      if (message.type === 'inventory') {
        this.inventory ||= new ProcessInventory(message.root.pid, message.root, { adopter: message.adopter });
        this.inventory.known = new Map(message.values.map(value => [value.pid, value.start]));
      }
      if (message.type === 'fault') { this.lastError = message.message; this.fail(new Error(message.message)); }
      if (message.type === 'stopped') this.cleanupError = message.error;
    });
    this.process.on('error', error => { this.fail(error); void this.close(); });
    this.process.on('exit', (code, signal) => {
      this.fail(new Error(this.lastError || `Codex 进程已退出 (${signal || code})`));
      void this.close();
    });
    this.process.stdin.on('error', error => { this.fail(error); void this.close(); });
    this.process.stderr.on('data', () => {}); // Drain without logging account or prompt data.
    let frameBytes = 0;
    // Register before readline so an oversized frame is rejected before JSON
    // parsing and before it can reach the browser or the live-output cache.
    this.process.stdout.on('data', chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        frameBytes += end - offset;
        if (frameBytes > 8 * 1024 * 1024) {
          this.fail(new Error('Codex 单条输出消息超过 8 MiB，已停止后端以保护平板'));
          void this.close(); this.process.stdout.destroy(); return;
        }
        if (newline < 0) break;
        frameBytes = 0; offset = newline + 1;
      }
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', line => {
      if (this.closing) return;
      try { this.receive(JSON.parse(line)); }
      catch { this.emit('warning', 'Codex 返回了无法解析的消息'); }
    });
    try {
      this.info = await this.request('initialize', {
        clientInfo: { name: 'termux_codex_web', title: 'Termux Codex Web', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.send({ method: 'initialized', params: {} });
      this.ready = true;
      this.emit('connection', { connected: true });
      return this.info;
    } catch (error) { await this.close(); throw error; }
  }

  async updateLimits(value) {
    const limits = validateResourceLimits(value);
    if (!this.ready || !this.process?.connected || this.closing) throw Object.assign(new Error('Codex 未连接，无法确认资源配置已生效'), { status: 503 });
    const id = ++this.sequence;
    const applied = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.limitUpdates.delete(id);
        const error = new Error('资源配置确认超时，已回收后端；旧配置保留，请重启服务');
        reject(error); this.fail(error); void this.close();
      }, 5000);
      this.limitUpdates.set(id, { resolve, reject, timer });
      try { this.process.send({ type: 'limits/update', id, limits }, error => {
        if (!error) return;
        this.limitUpdates.delete(id); clearTimeout(timer); reject(error);
        this.fail(error); void this.close();
      }); } catch (error) { this.limitUpdates.delete(id); clearTimeout(timer); reject(error); }
    });
    Object.assign(this.limits, applied);
  }

  send(message) {
    if (this.closing || !this.process || this.process.stdin.destroyed || this.process.exitCode !== null) {
      throw new Error('Codex 未连接，请重启 Web 服务');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, { timeout = this.timeout } = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = Object.assign(new Error(`${method} 超时；操作结果待确认，请勿重复发送`), { rpcTimeout: true });
        reject(error);
        this.emit('timeout', { method, params });
        if (['turn/start', 'thread/start', 'thread/resume'].includes(method)) {
          this.fail(new Error(`${method} 超时，已回收后端以防止任务重复启动；请重启 Web 服务`));
          void this.close();
        }
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.method && message.id !== undefined) {
      if (message.method === 'item/tool/call' && this.dynamicToolHandler) {
        void Promise.resolve().then(() => this.dynamicToolHandler(message.params)).catch(error => ({ success: false, contentItems: [{ type: 'inputText', text: error.message }] })).then(result => {
          if (!this.closing) this.send({ id: message.id, result });
        }).catch(() => {});
        return;
      }
      const supported = [
        'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
        'item/tool/requestUserInput', 'item/permissions/requestApproval',
      ];
      if (!supported.includes(message.method)) {
        this.send({ id: message.id, error: { code: -32601, message: '此客户端暂不支持该交互' } });
        this.emit('notification', { method: 'web/unsupportedRequest', params: { ...message.params, requestMethod: message.method } });
        return;
      }
      this.approvals.set(String(message.id), message);
      this.emit('notification', { method: 'web/approval', params: message });
    } else if (message.method) {
      if (message.method === 'serverRequest/resolved') {
        this.approvals.delete(String(message.params?.requestId));
      }
      this.emit('notification', message);
    } else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || JSON.stringify(message.error)), { rpcRejected: true }));
      else pending.resolve(message.result);
    }
  }

  respond(id, result) {
    const request = this.approvals.get(String(id));
    if (!request) throw new Error('这个请求已处理或已过期');
    this.send({ id: request.id, result });
    this.approvals.delete(String(id));
    this.emit('notification', { method: 'serverRequest/resolved', params: { threadId: request.params.threadId, requestId: request.id } });
  }

  fail(error) {
    const wasReady = this.ready;
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    for (const { reject, timer } of this.limitUpdates.values()) { clearTimeout(timer); reject(error); }
    this.limitUpdates.clear();
    this.approvals.clear();
    if (wasReady && !this.closing) this.emit('connection', { connected: false, error: error.message });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.fail(new Error('服务正在关闭'));
    this.lines?.close();
    const proc = this.process;
    if (proc?.connected) { try { proc.send({ type: 'close' }, () => {}); } catch {} }
    proc?.stdin.end();
    // The referenced wait keeps shutdown alive until the guardian has reaped
    // descendants. It is idempotent even when HTTP close and signals overlap.
    this.closePromise = (this.exited || Promise.resolve()).then(async () => {
      // If the guardian itself crashed, the live Web owner can still reap its
      // last observed identities plus same-session survivors.
      if (this.inventory) {
        try {
          const remaining = await reapProcesses(this.inventory);
          if (remaining.length) this.cleanupError ||= `清理后仍有 ${remaining.length} 个进程未退出`;
        } catch { this.cleanupError ||= '无法完成 Codex 子进程回收'; }
      }
      return { error: this.cleanupError || null };
    });
    return this.closePromise;
  }
}
