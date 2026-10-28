import { resourceLimits } from './limits.mjs';

const conflict = message => Object.assign(new Error(message), { status: 409 });

// Browser connections do not own task lifetimes. OS ownership and forced
// reaping belong to the supervisor; session cleanup decisions belong here.
export class SessionLifecycle {
  constructor({ codex, live, starting, pause, limits = resourceLimits(), now = Date.now }) {
    Object.assign(this, { codex, live, starting, pause, limits, now });
    this.loaded = new Map(); this.cleaning = new Map(); this.closed = false;
    this.operations = new Map();
    this.timer = setInterval(() => { void this.sweep().catch(error => this.abort(error)); }, 30000);
    this.timer.unref();
  }
  markLoaded(id) { this.loaded.set(id, this.now()); }
  family(id) {
    const ids = new Set([id]);
    let changed;
    do {
      changed = false;
      for (const [child, value] of this.live.threads) {
        if (ids.has(value.metadata?.parentThreadId) && !ids.has(child)) { ids.add(child); changed = true; }
      }
    } while (changed);
    return [...ids];
  }
  busy(id) {
    const value = this.live.threads.get(id);
    return this.starting.has(id) || Boolean(value?.activeTurnId) || value?.status?.type === 'active';
  }
  reserve(id) {
    if (this.closed) throw conflict('服务正在关闭');
    if (this.cleaning.has(id)) throw conflict('这个会话正在清理后台进程，请稍后再发送');
    const active = new Set([...this.starting, ...[...this.live.threads].filter(([key, value]) =>
      !value.metadata?.parentThreadId && this.busy(key)).map(([key]) => key)]);
    if (active.size >= this.limits.maxActiveTurns) throw Object.assign(new Error(`平板最多同时运行 ${this.limits.maxActiveTurns} 个会话，请等待其他任务结束`), { status: 429 });
    this.starting.add(id);
  }
  ingest(message) {
    const p = message.params || {};
    const id = p.threadId || p.thread?.id;
    if (!id) return;
    if (message.method === 'thread/closed' || (message.method === 'thread/status/changed' && p.status?.type === 'notLoaded')) {
      this.loaded.delete(id); return;
    }
    if (['thread/started', 'turn/started', 'turn/completed'].includes(message.method)) this.markLoaded(id);
    if (p.thread?.parentThreadId && this.cleaning.has(p.thread.parentThreadId)) {
      const operation = this.operations.get(this.cleaning.get(p.thread.parentThreadId));
      if (operation && !operation.ids.includes(id)) {
        operation.ids.push(id); this.cleaning.set(id, operation.promise);
        if (operation.stop) this.pause(id);
      }
    }
    if (message.method === 'turn/completed' && p.turn.status !== 'completed' && !this.closed) {
      queueMicrotask(() => { void this.clean(id, { stop: true }).catch(error => { if (error.status !== 409) this.abort(error); }); });
    }
  }
  async discover(id, ids, promise, stop) {
    const { data } = await this.codex.request('thread/loaded/list', {}, { timeout: 10000 });
    // Subagent turns are not necessarily subscribed on the browser connection.
    // Read only unknown metadata to establish ownership before stopping them.
    for (const key of data) {
      if (this.live.threads.get(key)?.metadata?.cwd) continue;
      const { thread } = await this.codex.request('thread/read', { threadId: key, includeTurns: false }, { timeout: 10000 });
      const value = this.live.get(key); value.metadata = { ...thread, turns: [] }; value.status = thread.status;
    }
    for (const key of this.family(id)) {
      if (!ids.includes(key)) {
        if (this.cleaning.has(key) && this.cleaning.get(key) !== promise) throw conflict('关联会话正在清理');
        ids.push(key); this.cleaning.set(key, promise);
        if (stop) this.pause(key);
      }
      if (!data.includes(key)) { this.loaded.delete(key); continue; }
      if (!this.loaded.has(key)) this.markLoaded(key);
      const current = await this.codex.request('thread/read', { threadId: key, includeTurns: false }, { timeout: 10000 });
      this.live.get(key).status = current.thread.status;
      if (stop && this.busy(key) && !this.live.get(key).activeTurnId && !this.starting.has(key)) {
        const { thread } = await this.codex.request('thread/resume', { threadId: key, excludeTurns: true }, { timeout: 10000 });
        this.live.get(key).status = thread.status;
        const turns = await this.codex.request('thread/turns/list', { threadId: key, limit: 1, sortDirection: 'desc', itemsView: 'full' }, { timeout: 10000 });
        this.live.get(key).activeTurnId = turns.data.find(turn => turn.status === 'inProgress')?.id || null;
      }
    }
  }
  abort(error) {
    if (this.closed) return;
    this.codex.fail?.(new Error(`后台清理无法确认，已停止 Codex：${error.message}`));
    void this.codex.close();
  }
  waitIdle(ids) {
    if (ids.every(id => !this.busy(id))) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); this.codex.off('notification', check); this.codex.off('connection', connection);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (ids.every(id => !this.busy(id))) finish(); };
      const connection = state => { if (!state.connected) finish(new Error('Codex 连接已断开')); };
      const timer = setTimeout(() => finish(new Error('任务停止后未确认退出')), 10000);
      this.codex.on('notification', check); this.codex.on('connection', connection);
      check();
    });
  }
  clean(id, { stop = false, release = false } = {}) {
    if (this.cleaning.has(id)) return this.cleaning.get(id);
    if (this.closed || !this.codex.ready) return Promise.resolve();
    const ids = this.family(id);
    if (ids.some(key => this.cleaning.has(key))) throw conflict('关联会话正在清理，请稍后再试');
    if (!stop && ids.some(key => this.busy(key))) throw conflict('请先停止当前会话及其子代理，再清理后台');
    if (stop) for (const key of ids) this.pause(key);
    const promise = Promise.resolve().then(async () => {
      await this.discover(id, ids, promise, stop);
      if (!stop && ids.some(key => this.busy(key))) throw conflict('关联子代理仍在执行，暂不清理后台');
      if (stop) {
        for (const key of ids) {
          const turnId = this.live.threads.get(key)?.activeTurnId;
          if (turnId) await this.codex.request('turn/interrupt', { threadId: key, turnId }, { timeout: 10000 });
        }
        await this.waitIdle(ids);
      }
      const actual = new Set((await this.codex.request('thread/loaded/list', {}, { timeout: 10000 })).data);
      for (const key of [...ids].reverse()) {
        if (!this.loaded.has(key) || !actual.has(key)) { this.loaded.delete(key); continue; }
        await this.codex.request('thread/backgroundTerminals/clean', { threadId: key }, { timeout: 10000 });
        if (release) {
          await this.codex.request('thread/unsubscribe', { threadId: key }, { timeout: 10000 });
          this.loaded.delete(key);
          this.live.clearTurns(key);
        } else this.markLoaded(key);
      }
    }).catch(error => { if (error.status !== 409) this.abort(error); throw error; }).finally(() => {
      for (const key of ids) if (this.cleaning.get(key) === promise) this.cleaning.delete(key);
      this.operations.delete(promise);
    });
    this.operations.set(promise, { ids, promise, stop });
    for (const key of ids) this.cleaning.set(key, promise);
    return promise;
  }
  async sweep() {
    if (this.closed || !this.codex.ready) return;
    for (const [id, time] of this.loaded) {
      if (this.now() - time < this.limits.idleMs || this.cleaning.has(id)) continue;
      let root = id;
      const seen = new Set();
      while (this.live.threads.get(root)?.metadata?.parentThreadId && !seen.has(root)) {
        seen.add(root); root = this.live.threads.get(root).metadata.parentThreadId;
      }
      if (this.family(root).some(key => this.busy(key) || this.cleaning.has(key) ||
        (this.loaded.has(key) && this.now() - this.loaded.get(key) < this.limits.idleMs))) continue;
      try { await this.clean(root, { release: true }); }
      catch (error) { if (error.status !== 409) throw error; }
    }
  }
  disconnect() { this.loaded.clear(); }
  close() { this.closed = true; clearInterval(this.timer); }
}
