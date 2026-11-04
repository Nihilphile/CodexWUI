// Loaded before app.js. The panel owns its DOM and per-project reading state;
// chat stream renders never replace the focused directory or raw-text viewer.
window.CodexFilePanel = class {
  constructor(root, { api, notify, getUploadLimit = () => 100 * 1024 * 1024, onReload = null }) {
    this.root = root; this.api = api; this.notify = notify; this.projects = new Map(); this.project = null;
    this.getUploadLimit = getUploadLimit; this.uploadBatch = null;
    this.uploadAvailable = true; this.onReload = onReload;
    this.uploadReloadMessage = '当前后端尚未加载工作区上传接口，请在本轮结束后执行 /reload，再重新选择文件。';
    this.expandMode = 'panel'; this.expanded = false; root.dataset.expandMode = 'panel';
    root.innerHTML = `
      <div class="file-tabs" role="tablist" aria-label="打开的文件" aria-orientation="horizontal"></div>
      <input type="file" data-file-upload-input aria-label="选择要上传到工作区的文件" multiple hidden>
      <div class="file-upload-note" role="status" hidden><span></span><button type="button" data-file-upload-cancel hidden>取消上传</button><button type="button" data-file-upload-reload title="保存草稿并重载服务；运行中的任务将停止" hidden>重载服务</button></div>
      <div class="file-directory-pane" role="tabpanel" id="file-directory-pane" aria-labelledby="file-directory-tab">
        <div class="file-navigation"><button type="button" data-file-up aria-label="返回上级目录" title="返回上级 · ←">↑</button><nav class="file-breadcrumbs" aria-label="当前目录"></nav><button type="button" data-file-refresh-dir aria-label="刷新目录">↻</button></div>
        <div class="file-directory-note" role="status"></div>
        <div class="file-directory-list" role="listbox" aria-label="项目文件目录" tabindex="0"></div>
        <div class="file-key-hint">↑ ↓ 选择 · → / Enter 打开 · ← 上级</div>
      </div>
      <div class="file-text-pane" role="tabpanel" id="file-text-pane" hidden>
        <div class="file-toolbar"><button type="button" data-file-directory>← 目录</button><button type="button" data-file-expand aria-expanded="false" aria-controls="file-text-pane" title="填满工作区面板">展开</button><button type="button" data-file-render data-file-card-source aria-pressed="false" hidden>渲染</button><button type="button" data-file-wrap aria-pressed="true">自动换行</button><button type="button" data-file-copy>复制全文</button><a data-file-browser target="_blank" rel="noopener noreferrer" hidden>浏览器打开 ↗</a><a data-file-download download hidden>下载</a><button type="button" data-file-refresh-text aria-label="刷新文件">↻</button></div>
        <div class="file-path"></div><div class="file-info"></div><div class="file-text-note" role="status"></div>
        <pre class="file-raw wrap" tabindex="0" role="region" aria-label="只读原始文本"></pre>
        <div class="file-markdown prose" tabindex="0" role="region" aria-label="Markdown 预览" hidden></div>
        <iframe class="file-card-preview" title="HTML 预览" sandbox="allow-scripts" referrerpolicy="no-referrer" hidden></iframe>
        <iframe class="file-pdf-preview" title="PDF 阅读器" referrerpolicy="no-referrer" hidden></iframe>
        <img class="file-image-preview" alt="" hidden>
        <div class="file-key-hint" data-file-reading-hint>只读原文 · Shift+Tab 返回标签栏</div>
      </div>`;
    this.tabs = root.querySelector('.file-tabs'); this.list = root.querySelector('.file-directory-list'); this.raw = root.querySelector('.file-raw');
    const input = root.querySelector('[data-file-upload-input]');
    input.onchange = () => {
      const files = [...input.files], target = this.uploadTarget;
      input.value = ''; this.uploadTarget = null;
      if (files.length && target) void this.uploadFiles(files, target);
    };
    this.tabs.addEventListener('keydown', event => this.tabKey(event));
    this.tabs.addEventListener('focusin', event => {
      if (event.target.matches('[data-file-tab]')) this.setTabFocus(event.target.dataset.fileTab, false);
    });
    this.list.addEventListener('keydown', event => this.directoryKey(event));
    this.list.addEventListener('scroll', () => { if (this.current) this.directory().scroll = this.list.scrollTop; });
    this.raw.addEventListener('scroll', () => {
      const file = this.current?.files.get(this.current.active);
      if (file) { file.top = this.raw.scrollTop; file.left = this.raw.scrollLeft; }
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Tab' && event.shiftKey && !this.expanded && !this.tabs.contains(event.target)) {
        event.preventDefault(); this.setTabFocus(this.current?.active || '', true);
      }
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button?.disabled) return;
      if (button?.hasAttribute('data-file-upload-reload')) { void this.onReload?.(); return; }
      if (button?.hasAttribute('data-file-upload')) {
        this.uploadTarget = { project: this.project, model: this.current, directory: this.current.dir };
        input.value = ''; input.click(); return;
      }
      if (button?.hasAttribute('data-file-upload-cancel')) {
        this.uploadBatch.cancelled = true; this.uploadRequest?.abort(); this.renderUpload(); return;
      }
      if (button?.hasAttribute('data-file-close')) { this.closeFile(button.dataset.fileClose); return; }
      if (button?.hasAttribute('data-file-tab')) { this.activateTab(button.dataset.fileTab); return; }
      if (button?.hasAttribute('data-file-up')) { this.up(); return; }
      if (button?.hasAttribute('data-file-crumb')) { this.navigate(button.dataset.fileCrumb); return; }
      if (button?.hasAttribute('data-file-refresh-dir')) { this.navigate(this.current.dir); return; }
      if (button?.hasAttribute('data-file-directory')) { this.activateTab('', true); return; }
      if (button?.hasAttribute('data-file-expand')) { this.expand(!this.expanded); return; }
      if (button?.hasAttribute('data-file-refresh-text')) { this.openFile(this.current.active, { refresh: true }); return; }
      if (button?.hasAttribute('data-file-render')) {
        this.savePosition();
        const file = this.current.files.get(this.current.active); file.render = !file.render; this.renderFile(); return;
      }
      if (button?.hasAttribute('data-file-wrap')) {
        const file = this.current.files.get(this.current.active); file.wrap = !file.wrap; this.renderFile(); return;
      }
      if (button?.hasAttribute('data-file-copy')) { void this.copy(); return; }
      const row = event.target.closest('[data-file-entry]');
      if (row) { this.selectEntry(row.dataset.fileEntry); this.openSelected(); }
    });
    root.ownerDocument.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.expanded || root.ownerDocument.querySelector('dialog[open]')) return;
      event.preventDefault(); this.expand(false); root.querySelector('[data-file-expand]').focus();
    });
  }
  setUploadAvailable(available) { this.uploadAvailable = Boolean(available); this.renderUpload(); }
  renderUpload() {
    const limit = this.getUploadLimit(), batch = this.uploadBatch;
    const button = this.root.querySelector('[data-file-upload]');
    if (button) {
      button.disabled = !this.uploadAvailable || !this.current || this.current.loading || Boolean(batch?.busy) || !limit;
      button.title = !this.uploadAvailable ? this.uploadReloadMessage : this.project ? `上传到 ${this.project.name || '项目'}/${this.current.dir || ''} · 单个最多 ${limit / (1024 * 1024)} MiB` : '请先选择项目';
    }
    const note = this.root.querySelector('.file-upload-note'); note.hidden = !batch && this.uploadAvailable;
    if (note.hidden) return;
    if (batch) {
      const target = `${batch.target.project.name || '项目'}/${batch.target.directory}`;
      const progress = batch.percent === null ? '' : ` · ${batch.percent}%`;
      note.querySelector('span').textContent = batch.busy
        ? `${batch.cancelled ? '正在取消' : '上传至'} ${target} · ${batch.index}/${batch.total} · ${batch.name}${progress}`
        : `${target} · 已上传 ${batch.completed.length} 个文件${batch.cancelled ? ' · 已取消后续上传' : ''}${batch.errors.length ? ` · ${batch.errors.join('；')}` : ''}`;
    } else note.querySelector('span').textContent = this.uploadReloadMessage;
    const cancel = note.querySelector('[data-file-upload-cancel]'); cancel.hidden = !batch?.busy; cancel.disabled = Boolean(batch?.cancelled);
    note.querySelector('[data-file-upload-reload]').hidden = this.uploadAvailable || !this.onReload;
    note.classList.toggle('failed', !this.uploadAvailable || Boolean(batch?.errors.length));
  }
  sendUpload(file, target, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest(); this.uploadRequest = xhr;
      xhr.open('POST', `/api/files/upload?${new URLSearchParams({ project: target.project.id, path: target.directory })}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.upload.onprogress = event => progress(event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null);
      xhr.onload = () => {
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('上传失败，服务器响应无效')); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else if (xhr.status === 404 && result.error === '接口不存在') {
          reject(Object.assign(new Error(this.uploadReloadMessage), { code: 'UPLOAD_RELOAD_REQUIRED' }));
        } else reject(new Error(result.error || `上传失败 (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('上传失败，请检查连接后重试'));
      xhr.onabort = () => reject(new Error('已取消上传'));
      xhr.onloadend = () => { if (this.uploadRequest === xhr) this.uploadRequest = null; };
      xhr.send(file);
    });
  }
  async uploadFiles(files, target) {
    if (this.uploadBatch?.busy) return;
    if (!this.uploadAvailable) { this.notify(this.uploadReloadMessage); return; }
    const batch = { target, total: files.length, index: 0, name: '', percent: null, completed: [], errors: [], busy: true, cancelled: false };
    this.uploadBatch = batch; this.renderUpload();
    try {
      for (const file of files) {
        if (batch.cancelled) break;
        batch.index++; batch.name = file.name; batch.percent = null; this.renderUpload();
        const limit = this.getUploadLimit();
        if (!limit || file.size > limit) { batch.errors.push(`${file.name}：${limit ? `超过 ${limit / (1024 * 1024)} MiB 上限` : '未读取到上传限制，请重试'}`); continue; }
        try {
          const result = await this.sendUpload(file, target, percent => { batch.percent = percent; this.renderUpload(); });
          batch.completed.push(result);
        } catch (error) {
          if (!batch.cancelled) batch.errors.push(`${file.name}：${error.message}`);
          if (error.code === 'UPLOAD_RELOAD_REQUIRED') { this.setUploadAvailable(false); break; }
        }
      }
    } finally {
      batch.busy = false; this.renderUpload();
      if (batch.index) {
        const directory = target.model.dirs.get(target.directory);
        if (directory) directory.entries = null;
        if (this.current === target.model && this.current.dir === target.directory && !this.current.active) {
          await this.navigate(target.directory, { select: batch.completed.at(-1)?.path || null });
        }
      }
      const renamed = batch.completed.filter(file => file.renamed).map(file => file.name);
      this.notify(`已上传 ${batch.completed.length} 个文件至 ${target.project.name || '项目'}/${target.directory}${renamed.length ? ` · 同名文件保存为 ${renamed.join('、')}` : ''}${batch.errors.length ? ` · ${batch.errors.join('；')}` : batch.cancelled ? ' · 已取消后续上传' : ''}`);
    }
  }
  setExpandMode(mode) {
    this.expandMode = mode === 'fullscreen' ? 'fullscreen' : 'panel';
    this.root.dataset.expandMode = this.expandMode;
    this.expand(this.expanded);
  }
  expand(expanded) {
    this.expanded = Boolean(expanded && this.current?.active);
    this.root.classList.toggle('file-expanded', this.expanded);
    this.root.closest('.inspector')?.classList.toggle('file-fullscreen-host', this.expanded && this.expandMode === 'fullscreen');
    const button = this.root.querySelector('[data-file-expand]');
    button.textContent = this.expanded ? '收起' : '展开';
    button.setAttribute('aria-expanded', String(this.expanded));
    button.title = this.expanded ? '恢复文件视图 · Esc' : this.expandMode === 'fullscreen' ? '全屏展开' : '填满工作区面板';
  }
  escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  get current() { return this.project ? this.projects.get(this.project.id) : null; }
  setProject(project) {
    if (project?.id === this.project?.id) return;
    this.expand(false);
    this.savePosition(); this.project = project || null;
    if (project && !this.projects.has(project.id)) this.projects.set(project.id, { dir: '', dirs: new Map(), files: new Map(), active: '', focusTab: '', navigation: 0, loading: false, error: '' });
    this.render();
  }
  directory(model = this.current, location = model.dir) {
    if (!model.dirs.has(location)) model.dirs.set(location, { entries: null, selected: null, scroll: 0 });
    return model.dirs.get(location);
  }
  savePosition() {
    const m = this.current; if (!m) return;
    if (!m.active) this.directory().scroll = this.list.scrollTop;
    else {
      const f = m.files.get(m.active);
      if (f) {
        if (!this.raw.hidden) { f.top = this.raw.scrollTop; f.left = this.raw.scrollLeft; }
        if (!this.root.querySelector('.file-markdown').hidden) f.renderTop = this.root.querySelector('.file-markdown').scrollTop;
      }
    }
  }
  readingTarget() {
    return [...this.root.querySelectorAll('.file-raw,.file-markdown,iframe')].find(element => !element.hidden) || this.raw;
  }
  show() {
    if (!this.current) { this.render(); return; }
    if (!this.current.active && !this.directory().entries) return this.navigate(this.current.dir);
    this.render();
  }
  rows() {
    if (!this.current) return [];
    return [...(this.current.dir ? [{ name: '..', path: '..', type: 'parent' }] : []), ...(this.directory().entries || [])];
  }
  async navigate(location, { focus = false, select = null } = {}) {
    const m = this.current; const project = this.project; if (!m) return;
    this.savePosition(); m.dir = location; m.active = ''; m.focusTab = ''; m.loading = true; m.error = '';
    const dir = this.directory(); if (select !== null) dir.selected = select;
    const version = ++m.navigation; this.render(); if (focus) this.list.focus();
    try {
      const result = await this.api(`/api/files/list?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(location)}`);
      if (version !== m.navigation) return;
      dir.entries = result.entries; dir.truncated = result.truncated; dir.limit = result.limit;
      const rows = [...(location ? [{ path: '..' }] : []), ...dir.entries];
      if (!rows.some(row => row.path === dir.selected)) dir.selected = rows[0]?.path || null;
    } catch (error) { if (version === m.navigation) m.error = error.message; }
    finally {
      if (version === m.navigation) {
        m.loading = false;
        if (this.current === m && !m.active) this.renderDirectory();
      }
    }
  }
  up() {
    if (!this.current?.dir) return;
    const child = this.current.dir; const parent = child.split('/').slice(0, -1).join('/');
    return this.navigate(parent, { focus: true, select: child });
  }
  selectEntry(location) {
    if (!this.current) return;
    this.directory().selected = location;
    for (const row of this.list.querySelectorAll('[data-file-entry]')) {
      const selected = row.dataset.fileEntry === location;
      row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
      if (selected) { this.list.setAttribute('aria-activedescendant', row.id); row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
    }
  }
  openSelected() {
    if (!this.current || this.current.loading) return;
    const row = this.rows().find(r => r.path === this.directory().selected); if (!row) return;
    if (row.blocked) { this.notify(row.reason); return; }
    if (row.type === 'parent') this.up();
    else if (row.type === 'directory') this.navigate(row.path, { focus: true });
    else this.openFile(row.path, { focus: true });
  }
  directoryKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End'].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowLeft') { this.up(); return; }
    if (!this.current || this.current.loading) return;
    if (['ArrowRight', 'Enter'].includes(event.key)) { this.openSelected(); return; }
    const rows = this.rows(); if (!rows.length) return;
    const index = Math.max(0, rows.findIndex(row => row.path === this.directory().selected));
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : event.key === 'ArrowUp' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
    if (next !== null) this.selectEntry(rows[next].path);
  }
  async openFile(location, { focus = false, refresh = false } = {}) {
    const m = this.current; const project = this.project; if (!m) return;
    this.savePosition();
    if (!m.files.has(location)) m.files.set(location, { data: null, error: '', loading: false, wrap: true, top: 0, left: 0, version: 0 });
    const file = m.files.get(location);
    m.active = location; m.focusTab = location; this.render();
    if (focus) this.readingTarget().focus({ preventScroll: true });
    if (!refresh && (file.data || file.loading)) return;
    file.loading = true; file.error = ''; const version = ++file.version; this.renderFile();
    try {
      const result = await this.api(`/api/files/preview?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(location)}`);
      if (file.version === version) {
        file.data = result;
        file.render ??= ['html', 'studycard'].includes(result.kind);
      }
    } catch (error) { if (file.version === version) { file.error = error.message; file.data = null; } }
    finally {
      if (file.version === version) {
        file.loading = false;
        if (this.current === m && m.active === location && m.files.get(location) === file) {
          const reading = this.root.ownerDocument.activeElement === this.raw;
          this.renderFile();
          if (reading) this.readingTarget().focus({ preventScroll: true });
        }
      }
    }
  }
  activateTab(location, enter = false) {
    const m = this.current; if (!m || (location && !m.files.has(location))) return;
    this.savePosition(); m.active = location; m.focusTab = location;
    this.render();
    if (enter) (location ? this.readingTarget() : this.list).focus({ preventScroll: true });
    else this.setTabFocus(location, true);
    if (!location && !this.directory().entries && !m.loading) this.navigate(m.dir, { focus: enter });
  }
  setTabFocus(location, focus) {
    if (!this.current) return;
    this.current.focusTab = location;
    for (const tab of this.tabs.querySelectorAll('[data-file-tab]')) {
      const selected = tab.dataset.fileTab === location; tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) { tab.focus({ preventScroll: true }); tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
    }
  }
  tabKey(event) {
    const tab = event.target.closest('[data-file-tab]'); if (!tab || !this.current) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const keys = ['', ...this.current.files.keys()]; const index = keys.indexOf(tab.dataset.fileTab);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      this.setTabFocus(keys[Math.max(0, Math.min(keys.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))], true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); this.activateTab(tab.dataset.fileTab, true);
    } else if (event.key === 'Delete' && tab.dataset.fileTab) { event.preventDefault(); this.closeFile(tab.dataset.fileTab); }
  }
  closeFile(location) {
    const m = this.current; if (!m) return;
    this.savePosition(); const keys = ['', ...m.files.keys()]; const index = keys.indexOf(location);
    m.files.delete(location);
    if (m.active === location) m.active = keys[Math.max(0, index - 1)];
    if (m.focusTab === location) m.focusTab = m.active;
    this.render(); this.setTabFocus(m.focusTab, true);
  }
  render() {
    const m = this.current; const active = m?.active || ''; const escape = value => this.escape(value);
    if (!active) this.expand(false);
    this.tabs.innerHTML = `<button type="button" id="file-directory-tab" role="tab" aria-controls="file-directory-pane" aria-selected="${!active}" tabindex="${!m?.focusTab ? 0 : -1}" data-file-tab="">目录</button><button type="button" class="file-upload-button" data-file-upload>↑ 上传文件</button>` + [...(m?.files.keys() || [])].map((location, i) => `<span class="file-tab-group"><button type="button" id="file-open-tab-${i}" role="tab" aria-controls="file-text-pane" aria-selected="${active === location}" tabindex="${m.focusTab === location ? 0 : -1}" data-file-tab="${escape(location)}" title="${escape(location)}">${escape(location.split('/').at(-1))}</button><button type="button" class="file-tab-close" tabindex="-1" data-file-close="${escape(location)}" aria-label="关闭 ${escape(location)}">×</button></span>`).join('');
    this.root.querySelector('.file-directory-pane').hidden = Boolean(active);
    this.root.querySelector('.file-text-pane').hidden = !active;
    if (!active) for (const frame of this.root.querySelectorAll('iframe')) frame.removeAttribute('src');
    const activeTab = [...this.tabs.querySelectorAll('[data-file-tab]')].find(tab => tab.dataset.fileTab === active);
    if (activeTab && active) this.root.querySelector('.file-text-pane').setAttribute('aria-labelledby', activeTab.id);
    if (active) this.renderFile(); else this.renderDirectory();
    activeTab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.renderUpload();
  }
  renderDirectory() {
    const m = this.current; if (m?.active) return;
    const escape = value => this.escape(value);
    const parts = m?.dir.split('/').filter(Boolean) || [];
    this.root.querySelector('.file-breadcrumbs').innerHTML = `<button type="button" data-file-crumb="">${escape(this.project?.name || '项目')}</button>` + parts.map((name, i) => `<span>/</span><button type="button" data-file-crumb="${escape(parts.slice(0, i + 1).join('/'))}">${escape(name)}</button>`).join('');
    this.root.querySelector('[data-file-up]').disabled = !m?.dir;
    this.root.querySelector('[data-file-refresh-dir]').disabled = !m || m.loading;
    const note = this.root.querySelector('.file-directory-note');
    note.textContent = !m ? '请先选择项目' : m.error || (m.loading ? '正在读取目录…' : this.directory().truncated ? `目录条目过多，仅显示 ${this.directory().limit} 项` : '');
    this.list.setAttribute('aria-busy', String(Boolean(m?.loading)));
    const rows = this.rows();
    const icons = {
      directory: '<svg viewBox="0 0 24 24" role="img" aria-label="文件夹" class="file-folder-icon"><path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/></svg>',
      file: '<svg viewBox="0 0 24 24" role="img" aria-label="文件"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
      parent: '<svg viewBox="0 0 24 24" role="img" aria-label="上级目录"><path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 6 6v5"/></svg>',
    };
    this.list.innerHTML = rows.map((entry, index) => `<div id="file-entry-${index}" class="file-entry ${m && this.directory().selected === entry.path ? 'selected' : ''} ${entry.blocked ? 'blocked' : ''}" role="option" aria-selected="${m && this.directory().selected === entry.path}" ${entry.blocked ? 'aria-disabled="true"' : ''} data-file-entry="${escape(entry.path)}" title="${escape(entry.reason || entry.name)}"><span class="file-entry-icon">${icons[entry.type] || icons.file}</span><span class="file-entry-name">${escape(entry.name)}</span>${entry.symlink ? '<span class="file-entry-badge">链接</span>' : ''}${entry.blocked ? '<span class="file-entry-badge">不可访问</span>' : ''}</div>`).join('') || (!m?.loading && !m?.error ? '<div class="empty-state">这个目录为空</div>' : '');
    const selected = this.list.querySelector('[aria-selected="true"]');
    if (selected) this.list.setAttribute('aria-activedescendant', selected.id); else this.list.removeAttribute('aria-activedescendant');
    this.list.scrollTop = m ? this.directory().scroll : 0;
    this.renderUpload();
  }
  renderFile() {
    const m = this.current; const file = m?.files.get(m.active); if (!file) return;
    const data = file.data;
    const text = typeof data?.text === 'string';
    const html = ['html', 'studycard'].includes(data?.kind);
    const markdown = data?.kind === 'markdown';
    const pdf = data?.kind === 'pdf';
    const image = data?.kind === 'image';
    const rendered = Boolean(file.render && (html || markdown));
    const params = new URLSearchParams({ project: this.project.id, path: m.active });
    const original = `/api/files/content?${params}`;
    const frame = this.root.querySelector('.file-card-preview');
    frame.hidden = !(html && rendered); this.raw.hidden = rendered || pdf || image;
    if (html && rendered) {
      const source = `/api/files/${data.kind === 'studycard' ? 'studycard' : 'html'}?${params}&v=${file.version}`;
      if (frame.getAttribute('src') !== source) frame.setAttribute('src', source);
    } else frame.removeAttribute('src');
    const prose = this.root.querySelector('.file-markdown'); prose.hidden = !(markdown && rendered);
    if (markdown && rendered) {
      const key = JSON.stringify([this.project.id, m.active, file.version]);
      if (prose.fileKey !== key || prose.fileData !== data) {
        prose.innerHTML = window.CodexMarkdown(data.text, { project: this.project.id, directory: m.active.split('/').slice(0, -1).join('/') });
        prose.fileKey = key;
        prose.fileData = data;
      }
      prose.scrollTop = file.renderTop || 0;
    }
    const pdfFrame = this.root.querySelector('.file-pdf-preview'); pdfFrame.hidden = !pdf;
    if (pdf) {
      const src = `/pdf-viewer.html?${params}&v=${file.version}`;
      if (pdfFrame.getAttribute('src') !== src) pdfFrame.setAttribute('src', src);
    } else pdfFrame.removeAttribute('src');
    const img = this.root.querySelector('.file-image-preview'); img.hidden = !image;
    if (image) { img.src = original; img.alt = m.active; } else img.removeAttribute('src');
    const browser = this.root.querySelector('[data-file-browser]'); browser.hidden = !pdf;
    if (pdf) browser.href = window.CodexFileLinks.browser(original + '&browser=1'); else browser.removeAttribute('href');
    const download = this.root.querySelector('[data-file-download]'); download.hidden = !data;
    if (data) download.href = original + '&download=1'; else download.removeAttribute('href');
    const toggle = this.root.querySelector('[data-file-render]'); toggle.hidden = !(html || markdown); toggle.disabled = file.loading;
    toggle.setAttribute('aria-pressed', String(rendered));
    this.root.querySelector('.file-path').textContent = m.active;
    this.root.querySelector('.file-info').textContent = data ? `${data.size.toLocaleString()} 字节 · ${new Date(data.modifiedAt).toLocaleString()}${text ? ' · UTF-8' : ''}` : '';
    this.root.querySelector('.file-text-note').textContent = file.loading ? '正在读取文件…' : file.error || data?.reason || (data?.truncated ? (html && rendered ? '原文超过 1 MiB，复制仅包含开头部分；HTML 预览加载完整文件。' : '文件超过 1 MiB，仅显示开头部分；复制也仅包含预览内容。') : html && rendered ? '预览支持自包含 HTML；外部脚本、样式和相对资源不会加载。' : '');
    this.raw.textContent = text ? data.text : '';
    this.raw.classList.toggle('wrap', file.wrap); this.raw.scrollTop = file.top; this.raw.scrollLeft = file.left;
    this.raw.setAttribute('aria-busy', String(file.loading));
    const wrap = this.root.querySelector('[data-file-wrap]'); wrap.setAttribute('aria-pressed', String(file.wrap)); wrap.disabled = !text || rendered; wrap.hidden = pdf || image;
    const copy = this.root.querySelector('[data-file-copy]'); copy.disabled = file.loading || !text; copy.hidden = pdf || image; copy.textContent = data?.truncated ? '复制预览' : '复制全文';
    this.root.querySelector('[data-file-reading-hint]').textContent = pdf ? 'PDF 阅读 · 可用“浏览器打开”交给浏览器查看' : rendered ? '只读预览 · 关闭“渲染”查看原文' : '只读原文 · Shift+Tab 返回标签栏';
    this.root.querySelector('[data-file-refresh-text]').disabled = file.loading;
  }
  async copy() {
    const data = this.current?.files.get(this.current.active)?.data;
    if (typeof data?.text !== 'string') return;
    try { await navigator.clipboard.writeText(data.text); this.notify(data.truncated ? '已复制预览内容' : '已复制全文'); }
    catch { this.notify('浏览器未允许复制，请在文本区域选择后复制'); }
  }
};
