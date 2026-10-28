(() => {
  const FIELDS = [
    ['maxActiveTurns', '最大同时运行会话数', '主会话和 BTW 共享额度。降低后已有任务继续，新任务按新上限准入。'],
    ['maxRssMb', 'RAM 保护阈值 · MiB', '全部后端及工具进程的合计 RSS，超过会回收 Codex 后端；不是系统内存分配硬限制。'],
    ['maxProcesses', '最大后台进程数', 'Codex 及其被跟踪的派生进程，不含 Web 与守护进程。'],
    ['idleMinutes', '空闲清理等待 · 分钟', '下一次检查使用新值；清理后台终端并取消会话订阅。'],
    ['maxFileMb', '普通附件上限 · MiB', '上传中的文件沿用开始时上限；新上传和发送校验使用新值。超过新上限的已上传附件不能发送。'],
  ];
  const SOURCES = { default: '内置默认', environment: '启动环境', saved: '已保存' };
  class CodexConfigPanel {
    constructor({ api, notify, changed }) {
      Object.assign(this, { api, notify, changed });
      this.dialog = document.createElement('dialog'); this.dialog.id = 'config-dialog';
      this.dialog.setAttribute('aria-labelledby', 'config-title');
      this.dialog.innerHTML = `<form id="config-form">
        <div class="dialog-heading"><h2 id="config-title">全局设置</h2><button type="button" class="icon-button" data-config-close aria-label="关闭全局设置">×</button></div>
        <p class="muted">作用于这个 CodexWeb 服务，保存后动态生效。默认模型与强度用于新建主会话，已有会话保留自己的设置。</p>
        <div class="config-fields">${FIELDS.map(([key, label, hint]) => `<div class="config-field"><label for="config-${key}">${label} <small data-config-source="${key}"></small></label><input id="config-${key}" name="${key}" type="number" min="${key === 'idleMinutes' || key === 'maxFileMb' ? '0.000001' : '1'}" step="${key === 'idleMinutes' || key === 'maxFileMb' ? 'any' : '1'}" required><p class="muted">${hint}</p></div>`).join('')}</div>
        <label for="config-defaultModel">默认模型 <small data-config-source="defaultModel"></small></label><select id="config-defaultModel" name="defaultModel"></select>
        <label for="config-defaultEffort">默认推理强度 <small data-config-source="defaultEffort"></small></label><select id="config-defaultEffort" name="defaultEffort"></select>
        <p data-config-model-note class="muted"></p>
        <p class="muted">配置保存在数据目录的 config.json，优先于启动环境变量。Codex 已退出时保存资源设置，需重启服务才能恢复后端。</p>
        <p data-config-error class="error-text" role="alert"></p><p data-config-status class="muted" role="status"></p>
        <div class="config-actions"><button type="button" class="secondary-button" data-config-refresh>重新读取</button><button type="submit" class="primary-button" data-config-save>保存设置</button></div>
      </form>`;
      document.body.append(this.dialog);
      this.form = this.dialog.querySelector('form');
      this.models = [];
      this.dialog.querySelector('[data-config-close]').onclick = () => this.dialog.close();
      this.dialog.querySelector('[data-config-refresh]').onclick = () => { void this.open(); };
      this.field('defaultModel').onchange = () => { this.renderEfforts(null); };
      this.form.onsubmit = event => { event.preventDefault(); void this.save(); };
    }
    field(key) { return this.form.elements.namedItem(key); }
    showError(message) { this.dialog.querySelector('[data-config-error]').textContent = message; }
    sync(snapshot) {
      if (!snapshot) return;
      if (this.current?.instance === snapshot.instance && snapshot.revision < this.current.revision) { this.changed(this.current); return; }
      const newer = this.current && (snapshot.instance !== this.current.instance || snapshot.revision !== this.current.revision);
      this.current = snapshot; this.changed(snapshot);
      if (this.dialog.open && newer && !this.saving) this.dialog.querySelector('[data-config-status]').textContent = '设置已在其他页面更新。请点“重新读取”后再保存。';
    }
    renderEfforts(preferred) {
      const select = this.field('defaultEffort'), model = this.models.find(model => model.model === this.field('defaultModel').value);
      select.replaceChildren(new Option('沿用本机推理设置', ''));
      for (const option of model?.supportedReasoningEfforts || []) select.add(new Option(option.reasoningEffort, option.reasoningEffort));
      if (preferred && ![...select.options].some(option => option.value === preferred)) select.add(new Option(`${preferred}（已保存）`, preferred));
      select.value = preferred || ''; select.disabled = !this.field('defaultModel').value || !model;
    }
    async open() {
      if (this.saving || this.loading) return;
      this.loading = true; this.showError('');
      this.dialog.querySelector('[data-config-save]').disabled = true;
      try {
        const snapshot = await this.api('/api/config'); this.sync(snapshot);
        this.editRevision = snapshot.revision;
        this.editInstance = snapshot.instance;
        for (const [key] of FIELDS) this.field(key).value = snapshot.settings[key];
        for (const key of Object.keys(snapshot.sources)) {
          const label = this.dialog.querySelector(`[data-config-source="${key}"]`);
          if (label) label.textContent = SOURCES[snapshot.sources[key]] || '';
        }
        if (!this.dialog.open) this.dialog.showModal();
        this.dialog.querySelector('[data-config-status]').textContent = '';
        this.dialog.querySelector('[data-config-model-note]').textContent = '正在读取模型目录…';
        this.models = [];
        try { this.models = (await this.api('/api/models')).models; }
        catch { this.dialog.querySelector('[data-config-model-note]').textContent = '模型目录暂不可用；仍可修改资源设置或清除默认模型。'; }
        if (this.models.length) this.dialog.querySelector('[data-config-model-note]').textContent = '当前会话使用 /model 单独设置；这里的默认值不覆盖历史会话。';
        const modelSelect = this.field('defaultModel');
        modelSelect.replaceChildren(new Option('沿用本机 Codex 配置', ''));
        for (const model of this.models) modelSelect.add(new Option(model.displayName && model.displayName !== model.model ? `${model.displayName} (${model.model})` : model.model, model.model));
        if (snapshot.settings.defaultModel && !this.models.some(model => model.model === snapshot.settings.defaultModel)) modelSelect.add(new Option(`${snapshot.settings.defaultModel}（已保存）`, snapshot.settings.defaultModel));
        modelSelect.value = snapshot.settings.defaultModel || '';
        this.renderEfforts(snapshot.settings.defaultEffort);
      } catch (error) { this.showError(error.message); this.notify(error.message); }
      finally { this.loading = false; this.dialog.querySelector('[data-config-save]').disabled = false; }
    }
    async save() {
      if (this.saving || this.loading) return;
      this.saving = true; this.showError('');
      const controls = [...this.form.querySelectorAll('input, select, button')];
      const disabled = controls.map(control => control.disabled);
      const settings = Object.fromEntries(FIELDS.map(([key]) => [key, Number(this.field(key).value)]));
      settings.defaultModel = this.field('defaultModel').value || null;
      settings.defaultEffort = settings.defaultModel ? this.field('defaultEffort').value || null : null;
      controls.forEach(control => { control.disabled = true; });
      try {
        const snapshot = await this.api('/api/config', { settings, revision: this.editRevision, instance: this.editInstance });
        this.sync(snapshot); this.editRevision = snapshot.revision; this.editInstance = snapshot.instance;
        this.dialog.querySelector('[data-config-status]').textContent = '已保存并应用。默认模型与强度从新建主会话起使用。';
        for (const label of this.dialog.querySelectorAll('[data-config-source]')) label.textContent = '已保存';
      } catch (error) { this.showError(error.message); }
      finally { this.saving = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); }
    }
  }
  window.CodexConfigPanel = CodexConfigPanel;
})();
