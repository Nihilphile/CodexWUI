(() => {
  const REASONS = { disabled_by_admin: '管理员已禁用', plan_not_eligible: '当前套餐不可用', required_app_unavailable: '所需应用不可用', unknown: '账号策略限制' };
  class CodexPluginPanel {
    constructor({ api, project }) {
      Object.assign(this, { api, project });
      this.dialog = document.createElement('dialog'); this.dialog.id = 'plugin-dialog';
      this.dialog.setAttribute('aria-labelledby', 'plugin-title');
      this.dialog.innerHTML = `<div class="dialog-heading"><h2 id="plugin-title">插件管理</h2><button type="button" class="icon-button" data-plugin-close aria-label="关闭插件管理">×</button></div>
        <p class="muted">开关保存到本机 Codex 全局配置，共用该配置的客户端也会受影响。新建会话使用新配置；已有会话可能保留已加载的技能和工具。BTW 侧聊禁用插件。</p>
        <div class="plugin-toolbar"><label class="sr-only" for="plugin-search">筛选已安装插件</label><input id="plugin-search" type="search" placeholder="筛选已安装插件…"><button type="button" class="secondary-button" data-plugin-refresh>重新读取</button></div>
        <p data-plugin-error class="error-text" role="alert"></p><p data-plugin-status class="muted" role="status"></p>
        <div data-plugin-list></div><p class="muted">安装和卸载使用终端中的 codex plugin 命令。</p>`;
      document.body.append(this.dialog);
      this.list = this.dialog.querySelector('[data-plugin-list]');
      this.status = this.dialog.querySelector('[data-plugin-status]');
      this.error = this.dialog.querySelector('[data-plugin-error]');
      this.search = this.dialog.querySelector('input');
      this.refresh = this.dialog.querySelector('[data-plugin-refresh]');
      this.dialog.querySelector('[data-plugin-close]').onclick = () => this.dialog.close();
      this.refresh.onclick = () => { void this.open(); };
      this.search.oninput = () => this.render();
      this.plugins = [];
    }
    busy(value) {
      this.pending = value; this.refresh.disabled = value;
      for (const button of this.list.querySelectorAll('button')) button.disabled = value || button.dataset.blocked === 'true';
    }
    render() {
      this.list.replaceChildren();
      const query = this.search.value.trim().toLowerCase();
      const plugins = this.plugins.filter(plugin => `${plugin.name} ${plugin.id} ${plugin.description} ${plugin.marketplace}`.toLowerCase().includes(query));
      if (!plugins.length) {
        const empty = document.createElement('p'); empty.className = 'empty-state';
        empty.textContent = this.plugins.length ? '没有匹配的插件' : '尚未发现已安装的插件'; this.list.append(empty);
      }
      for (const plugin of plugins) {
        const row = document.createElement('div'); row.className = 'plugin-row';
        const detail = document.createElement('div'); detail.className = 'plugin-detail';
        const name = document.createElement('strong'); name.textContent = plugin.name;
        const id = document.createElement('p'); id.className = 'muted'; id.textContent = `${plugin.id}${plugin.version ? ` · ${plugin.version}` : ''}`;
        const description = document.createElement('p'); description.className = 'muted'; description.textContent = plugin.description || plugin.marketplace;
        detail.append(name, id, description);
        if (plugin.blocked) { const reason = document.createElement('p'); reason.className = 'error-text'; reason.textContent = REASONS[plugin.disabledReason] || '受策略限制'; detail.append(reason); }
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'plugin-toggle';
        toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(plugin.enabled));
        toggle.setAttribute('aria-label', `${plugin.name} 插件开关`); toggle.textContent = plugin.enabled ? '已开启' : '已关闭';
        toggle.dataset.blocked = String(plugin.blocked); toggle.disabled = Boolean(this.pending || this.refreshRequired || plugin.blocked);
        toggle.onclick = () => { void this.toggle(plugin); };
        row.append(detail, toggle); this.list.append(row);
      }
    }
    async open() {
      if (this.pending) return;
      if (!this.dialog.open) this.dialog.showModal();
      this.error.textContent = ''; this.status.textContent = '正在读取已安装插件…'; this.busy(true);
      this.cwdProject = this.project();
      try {
        const result = await this.api(`/api/plugins?project=${encodeURIComponent(this.cwdProject)}`);
        this.plugins = result.plugins; this.version = result.version; this.refreshRequired = false;
        this.error.textContent = result.errors.join('\n'); this.status.textContent = `已安装 ${this.plugins.length} 个插件`;
      } catch (error) { this.error.textContent = error.message; this.status.textContent = ''; this.plugins = []; }
      finally { this.busy(false); this.render(); }
    }
    async toggle(plugin) {
      if (this.pending || this.refreshRequired) return;
      this.error.textContent = ''; this.status.textContent = '正在保存…'; this.busy(true);
      try {
        const result = await this.api('/api/plugins', { project: this.cwdProject, id: plugin.id, enabled: !plugin.enabled, version: this.version });
        this.plugins = result.plugins; this.version = result.version; this.refreshRequired = result.refreshRequired;
        this.error.textContent = result.errors.join('\n'); this.status.textContent = result.message;
      } catch (error) { this.error.textContent = error.message; this.status.textContent = ''; this.refreshRequired = true; }
      finally { this.busy(false); this.render(); }
    }
  }
  window.CodexPluginPanel = CodexPluginPanel;
})();
