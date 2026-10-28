window.CodexServiceReload = class {
  constructor({ fetch, refresh, status, save, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 120000 }) {
    Object.assign(this, { fetch, refresh, status, save, sleep, timeout });
    this.running = false;
  }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      this.save();
      this.status('正在请求重启后端…');
      const response = await this.fetch('/api/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '重启请求失败');
      if (!result.serverInstance) throw new Error('服务未返回重启标识');
      this.status('正在重启后端，运行中的任务将停止；恢复后自动刷新…');
      const deadline = Date.now() + this.timeout;
      while (Date.now() < deadline) {
        await this.sleep(750);
        try {
          const check = await this.fetch('/api/bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
          if (!check.ok) continue;
          const next = await check.json();
          if (next.app !== 'termux-codex-web' || !next.serverInstance || next.serverInstance === result.serverInstance) continue;
          if (!next.connected && !next.error) { this.status('新服务已启动，正在连接 Codex…'); continue; }
          this.status('后端已恢复，正在刷新…');
          this.refresh(); return;
        } catch { /* The port is expected to be unavailable during shutdown. */ }
      }
      throw new Error('重启等待超时，草稿已保留。请稍后刷新；若服务未恢复，请在 Termux 运行 CodexWeb --no-open。');
    } catch (error) {
      this.running = false;
      this.status(error.message, true);
    }
  }
};
