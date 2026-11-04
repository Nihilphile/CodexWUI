window.CodexAccountQuota = class {
  constructor({ api }) {
    this.api = api;
    this.connected = null;
    this.generation = 0;
    this.button = document.getElementById('account-quota');
    this.dialog = document.getElementById('quota-dialog');
    this.button.onclick = () => { this.dialog.showModal(); void this.refresh(); };
    document.getElementById('close-quota-dialog').onclick = () => this.dialog.close();
    document.getElementById('refresh-quota').onclick = () => { void this.refresh(true); };
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.dialog.close(); });
    this.render();
  }

  setConnected(connected) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.invalidate();
  }

  invalidate() {
    this.generation++;
    this.pending = null;
    this.value = null;
    this.error = '';
    this.render();
    if (this.connected) void this.refresh();
  }

  async refresh(force = false) {
    if (document.hidden || !this.connected || this.pending) return;
    const generation = this.generation;
    this.pending = true;
    this.render();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const value = await this.api(`/api/account/quota${force ? '?refresh=1' : ''}`, undefined, { signal: controller.signal });
      if (generation !== this.generation) return;
      this.value = value;
      this.error = '';
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error.name === 'AbortError' ? '读取额度超时，请稍后重试' : error.message;
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) { this.pending = null; this.render(); }
    }
  }

  render() {
    const valid = this.connected && !this.error && this.value && Date.now() - this.value.checkedAt < 120000;
    const available = window => valid && window && (!window.resetsAt || window.resetsAt * 1000 > Date.now());
    const preferred = this.value?.fiveHour || this.value?.weekly;
    const label = this.value?.fiveHour ? '5h' : '周';
    const percent = window => `${Number(window.remainingPercent.toFixed(1))}%`;
    this.button.textContent = available(preferred) ? `${label}剩余 ${percent(preferred)}` : '额度 --';
    this.button.title = available(preferred) ? `${label === '5h' ? '5 小时' : '每周'}额度剩余 ${percent(preferred)}，点击查看详情` : '点击查看账户额度';
    this.button.classList.toggle('quota-low', Boolean(available(preferred) && preferred.remainingPercent <= 10));
    document.getElementById('quota-plan').textContent = this.value?.planType ? `${this.value.planType.toUpperCase()} · Codex 账户额度` : 'Codex 账户额度';
    for (const [key, id] of [['fiveHour', 'five-hour'], ['weekly', 'weekly']]) {
      const window = this.value?.[key];
      document.getElementById(`quota-${id}-remaining`).textContent = available(window) ? `剩余 ${percent(window)}` : '—';
      const bar = document.getElementById(`quota-${id}-progress`);
      bar.value = available(window) ? window.remainingPercent : 0;
      bar.hidden = !available(window);
      document.getElementById(`quota-${id}-reset`).textContent = !this.value ? '等待额度数据' : !window ? '当前账户未提供此项额度' : !available(window) ? '等待刷新' : window.resetsAt ? `${new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { hour12: false })} 重置` : '未提供重置时间';
    }
    document.getElementById('quota-status').textContent = !this.connected ? 'Codex 未连接，暂时无法读取额度' : this.error || (this.pending ? '正在读取额度…' : this.value ? `更新于 ${new Date(this.value.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 每分钟自动刷新` : '等待额度数据');
    document.getElementById('refresh-quota').disabled = !this.connected || Boolean(this.pending);
  }
};
