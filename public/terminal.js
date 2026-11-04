window.CodexTerminalPanel = class {
  constructor(root, { api, notify }) {
    this.root = root; this.api = api; this.notify = notify;
    this.projects = new Map(); this.models = new Map(); this.project = null;
    this.modelUse = 0;
    this.visible = false; this.expanded = false; this.keysExpanded = false; this.available = true;
    this.modifiers = { ctrl: false, alt: false }; this.disposed = false;
    root.classList.add('terminal-view');
    root.innerHTML = `
      <div class="terminal-heading">
        <select data-terminal-select aria-label="项目终端"></select>
        <button type="button" data-terminal-new title="在当前项目中新建终端">＋ 新建</button>
        <button type="button" data-terminal-refresh aria-label="刷新终端列表" title="刷新终端列表">↻</button>
        <button type="button" data-terminal-expand aria-expanded="false" title="全屏展开终端">展开</button>
        <button type="button" data-terminal-close title="结束终端及其启动的进程">结束</button>
      </div>
      <div class="terminal-location" title="终端的启动目录"></div>
      <div class="terminal-notice" role="status" aria-live="polite"></div>
      <div class="terminal-stage"><div class="terminal-empty">在当前项目中新建终端。切换面板后命令继续运行，停止 CodexWUI 服务时终端结束。</div></div>
      <div class="terminal-footer">
        <div class="terminal-footer-actions"><button type="button" data-terminal-keys aria-expanded="false">快捷键 ▴</button><button type="button" data-terminal-copy title="复制选中的内容 · Ctrl+Shift+C">复制选中</button><span class="terminal-connection"></span></div>
        <div class="terminal-keys" role="group" aria-label="终端快捷键" hidden>
          <button type="button" data-terminal-key="esc">Esc</button><button type="button" data-terminal-key="tab">Tab</button>
          <button type="button" data-terminal-modifier="ctrl" aria-pressed="false">Ctrl</button><button type="button" data-terminal-modifier="alt" aria-pressed="false">Alt</button>
          <button type="button" data-terminal-key="up" aria-label="上方向键">↑</button><button type="button" data-terminal-key="down" aria-label="下方向键">↓</button><button type="button" data-terminal-key="left" aria-label="左方向键">←</button><button type="button" data-terminal-key="right" aria-label="右方向键">→</button>
          <button type="button" data-terminal-key="interrupt" title="中断前台命令">Ctrl+C</button>
        </div>
      </div>
      <dialog class="terminal-paste-dialog" aria-labelledby="terminal-paste-title">
        <h2 id="terminal-paste-title">检查多行粘贴</h2><p>多行内容可能执行命令，请检查后确认。</p><pre data-terminal-paste-preview></pre>
        <form method="dialog"><button value="cancel" type="submit">取消</button><button value="paste" type="submit" class="primary-button">确认粘贴</button></form>
      </dialog>`;
    this.select = root.querySelector('[data-terminal-select]');
    this.stage = root.querySelector('.terminal-stage');
    this.empty = root.querySelector('.terminal-empty');
    this.pasteDialog = root.querySelector('.terminal-paste-dialog');
    root.addEventListener('click', event => this.click(event));
    root.addEventListener('pointerdown', event => {
      if (event.target.closest('[data-terminal-key], [data-terminal-modifier], [data-terminal-keys], [data-terminal-copy]')) event.preventDefault();
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && event.target.closest('.terminal-screen')) event.stopPropagation();
    });
    root.addEventListener('focusout', event => {
      if (!root.contains(event.relatedTarget)) this.clearModifiers();
    });
    root.addEventListener('paste', event => this.paste(event), true);
    root.addEventListener('contextmenu', event => {
      const model = this.active;
      if (!event.target.closest('.terminal-screen') || !model?.term?.hasSelection() || !navigator.clipboard?.writeText) return;
      event.preventDefault(); void this.copy();
    });
    this.select.addEventListener('change', () => this.activate(this.select.value));
    this.pasteDialog.addEventListener('close', () => {
      const pending = this.pendingPaste; this.pendingPaste = null;
      if (pending && this.pasteDialog.returnValue === 'paste' && this.active === pending.model && pending.model.connected) {
        this.clearModifiers(); pending.model.term.paste(pending.text);
      }
      if (pending && this.active === pending.model) this.focus();
    });
    this.onViewport = () => this.fit();
    this.onBlur = () => this.clearModifiers();
    this.onVisibility = () => { if (!document.hidden) { this.checkConnection(); this.fit(); } };
    window.addEventListener('resize', this.onViewport);
    window.addEventListener('blur', this.onBlur);
    window.visualViewport?.addEventListener('resize', this.onViewport);
    window.visualViewport?.addEventListener('scroll', this.onViewport);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.connectionTimer = setInterval(() => this.checkConnection(), 5000);
    this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(this.onViewport) : null;
    this.observer?.observe(this.stage);
    this.render();
  }
  get current() { return this.project ? this.projects.get(this.project.id) : null; }
  get active() { return this.models.get(this.current?.active); }
  setAvailable(available) {
    const previous = this.available; this.available = Boolean(available);
    if (!this.available) this.disconnect(this.active);
    this.render();
    if (!previous && this.available && this.visible) void this.refresh();
  }
  ensureLibraries() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    const Panel = window.CodexTerminalPanel;
    Panel.libraries ||= (async () => {
      for (const [src, loaded] of [['/vendor/xterm/xterm.js', () => window.Terminal], ['/vendor/xterm/addon-fit.js', () => window.FitAddon]]) {
        if (loaded()) continue;
        await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = src;
          const timer = setTimeout(() => finish(new Error('终端组件加载超时，请重试')), 15000);
          const finish = error => {
            clearTimeout(timer); script.onload = null; script.onerror = null;
            if (error) { script.remove(); reject(error); } else resolve();
          };
          script.onload = () => finish(loaded() ? null : new Error('终端组件未正确加载，请刷新页面'));
          script.onerror = () => finish(new Error('终端组件加载失败，请重试'));
          document.head.append(script);
        });
      }
    })().catch(error => { Panel.libraries = null; throw error; });
    return Panel.libraries;
  }
  setProject(project) {
    if (this.project?.id === project?.id) return;
    this.disconnect(this.active); this.expand(false); this.clearModifiers(); this.cancelPaste();
    this.project = project || null;
    if (project && !this.projects.has(project.id)) this.projects.set(project.id, { ids: [], active: '', loaded: false, loading: false, creating: false, error: '' });
    this.render();
    if (this.visible) void this.refresh();
  }
  show() {
    if (this.disposed) return;
    this.visible = true; this.render(); this.mount(); this.fit();
    void this.refresh();
  }
  hide() {
    this.visible = false; this.disconnect(this.active); this.expand(false); this.clearModifiers(); this.cancelPaste();
  }
  async request(route, data, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await this.api(route, data, { signal: controller.signal }); }
    catch (error) { if (controller.signal.aborted) throw new Error('终端请求超时，请刷新列表检查状态'); throw error; }
    finally { clearTimeout(timer); }
  }
  async refresh() {
    const project = this.project, state = this.current;
    if (!state || state.loading || this.disposed || !this.available) return;
    state.loading = true; state.error = ''; this.render();
    try {
      const result = await this.request(`/api/terminals?${new URLSearchParams({ project: project.id })}`);
      if (this.disposed) return;
      const ids = result.terminals.map(item => item.id);
      for (const id of state.ids) if (!ids.includes(id)) this.drop(this.models.get(id));
      for (const item of result.terminals) this.record(item);
      state.ids = ids; state.loaded = true;
      if (!ids.includes(state.active)) state.active = ids[0] || '';
    } catch (error) { state.error = error.message; }
    finally {
      state.loading = false;
      if (!this.disposed && this.current === state) { this.render(); if (this.visible) this.mount(); }
    }
  }
  record(meta) {
    let model = this.models.get(meta.id);
    if (!model) {
      model = { meta, sequence: 0, receivedSequence: 0, connected: false, source: null, output: [], outputBytes: 0, writing: false, input: [], inputBytes: 0, inputTask: null, generation: 0, reconnect: null, notice: '', dropped: false };
      this.models.set(meta.id, model);
    } else if (!(model.meta.status === 'exited' && meta.status === 'running')) model.meta = meta;
    model.lastUsed = ++this.modelUse; this.trimModels(meta.id);
    return model;
  }
  trimModels(incomingId) {
    while (this.models.size > 16) {
      const candidates = [...this.models.values()].filter(model => model !== this.active && model.meta.id !== incomingId && !model.source && !model.connected && !model.closing);
      const oldest = candidates.sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) return;
      const id = oldest.meta.id; this.drop(oldest);
      for (const state of this.projects.values()) {
        state.ids = state.ids.filter(value => value !== id);
        if (state.active === id) state.active = state.ids[0] || '';
      }
    }
  }
  async create() {
    const project = this.project, state = this.current;
    if (!state || state.creating || this.disposed || !this.available) return;
    state.creating = true; state.error = ''; this.render();
    try {
      const result = await this.request('/api/terminals', { project: project.id, cols: 80, rows: 24 }, 25000);
      if (this.disposed) return;
      this.record(result.terminal);
      if (!state.ids.includes(result.terminal.id)) state.ids.push(result.terminal.id);
      if (this.current === state) {
        this.activate(result.terminal.id); this.focus();
      } else state.active = result.terminal.id;
    } catch (error) { state.error = error.message; this.notify(error.message); }
    finally { state.creating = false; if (this.current === state && !this.disposed) this.render(); }
  }
  activate(id) {
    const state = this.current;
    if (!state?.ids.includes(id)) return;
    if (state.active !== id) { this.disconnect(this.active); this.clearModifiers(); this.cancelPaste(); state.active = id; }
    this.models.get(id).lastUsed = ++this.modelUse;
    this.render(); if (this.visible) this.mount(); this.fit();
  }
  mount() {
    const model = this.active;
    if (!model || !this.visible || this.disposed || !this.available) return;
    if (!window.Terminal || !window.FitAddon) {
      if (model.loadingLibraries) return;
      model.loadingLibraries = true; model.notice = '正在加载终端组件…'; this.renderStatus();
      this.ensureLibraries().then(() => {
        model.loadingLibraries = false;
        if (this.active === model && this.visible && !this.disposed && this.available) this.mount();
      }).catch(error => {
        model.loadingLibraries = false; model.notice = error.message;
        if (this.active === model && !this.disposed) this.renderStatus();
      });
      return;
    }
    if (!model.term) {
      const host = document.createElement('div'); host.className = 'terminal-screen'; this.stage.append(host); model.host = host;
      const nonce = document.querySelector('meta[name="terminal-style-nonce"]')?.content;
      const terminalDocument = nonce ? new Proxy(document, { get(target, key) {
        if (key === 'createElement') return (...args) => {
          const element = target.createElement(...args);
          if (String(args[0]).toLowerCase() === 'style') element.nonce = nonce;
          return element;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) : document;
      const term = new window.Terminal({ documentOverride: terminalDocument, cursorBlink: true, scrollback: 3000, fontSize: 13, lineHeight: 1.2, fontFamily: 'ui-monospace, "Cascadia Code", "DejaVu Sans Mono", monospace', disableStdin: true, allowProposedApi: false, theme: { background: '#111712', foreground: '#e5eae4', cursor: '#b5df9d', selectionBackground: '#52654e' } });
      model.term = term; model.fitter = new window.FitAddon.FitAddon(); term.loadAddon(model.fitter); term.open(host);
      term.onData(data => this.input(model, this.withModifiers(data)));
      term.onBinary(data => this.inputBytes(model, Uint8Array.from(data, char => char.charCodeAt(0))));
      term.attachCustomKeyEventHandler(event => {
        if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
        if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
          if (event.type === 'keydown') { event.preventDefault(); event.stopPropagation(); void this.copy(); }
          return false;
        }
        return true;
      });
      this.root.querySelector('[data-terminal-copy]').disabled = false;
    }
    for (const other of this.models.values()) if (other.host) other.host.hidden = other !== model;
    this.fit();
    if (!model.source && !model.reconnect && !model.writing && !model.output.length && !model.dropped && !model.endedLoaded && !model.closing) this.connect(model);
  }
  connect(model) {
    if (!this.visible || this.active !== model || model.dropped || this.disposed || model.endedLoaded || model.closing || !this.available) return;
    model.receivedSequence = model.sequence;
    const source = new EventSource(`/api/terminals/${encodeURIComponent(model.meta.id)}/events?${new URLSearchParams({ project: model.meta.project, after: model.sequence })}`);
    model.source = source; model.connected = false; model.lastEventAt = Date.now(); model.term.options.disableStdin = true;
    model.notice = '正在连接终端…'; this.renderStatus();
    source.addEventListener('ready', event => {
      if (model.source !== source) return;
      model.lastEventAt = Date.now();
      const data = JSON.parse(event.data); model.meta = data.terminal; model.connected = data.terminal.status === 'running';
      model.term.options.disableStdin = !model.connected;
      model.notice = data.truncated ? '较早的输出已清理，正在显示保留的终端记录。' : '';
      if (data.reset) { model.receivedSequence = 0; model.output.push({ reset: true }); this.drain(model); }
      this.render(); this.fit();
    });
    source.addEventListener('output', event => {
      if (model.source !== source) return;
      model.lastEventAt = Date.now();
      const data = JSON.parse(event.data);
      if (data.sequence <= model.receivedSequence) return;
      const bytes = this.decode(data.data);
      if (model.outputBytes + bytes.length > 256 * 1024) { this.reconnect(model, '输出较多，正在同步终端…', 0); return; }
      model.receivedSequence = data.sequence;
      model.output.push({ sequence: data.sequence, bytes }); model.outputBytes += bytes.length; this.drain(model);
    });
    source.addEventListener('exit', event => {
      if (model.source !== source) return;
      model.meta = JSON.parse(event.data).terminal; model.notice = ''; model.endedLoaded = true; this.disconnect(model); this.render();
    });
    source.addEventListener('missing', event => {
      if (model.source !== source) return;
      model.meta.status = 'exited'; model.endedLoaded = true; model.notice = JSON.parse(event.data).error || '终端已结束，请新建终端'; this.disconnect(model); this.render();
    });
    source.addEventListener('heartbeat', () => { if (model.source === source) model.lastEventAt = Date.now(); });
    source.onerror = () => {
      if (model.source === source) this.reconnect(model, '连接已断开，正在重连；未发送的输入已丢弃。', 1000);
    };
  }
  checkConnection() {
    const model = this.active;
    if (this.visible && model?.source && Date.now() - model.lastEventAt > 45000) this.reconnect(model, '连接暂时无响应，正在重连…', 0);
  }
  reconnect(model, notice, delay) {
    this.disconnect(model); model.notice = notice;
    model.reconnect = { ready: false };
    const pending = model.reconnect;
    pending.timer = setTimeout(() => { pending.ready = true; this.resume(model); }, delay);
    this.renderStatus();
  }
  resume(model) {
    if (!model.reconnect?.ready || model.writing || model.output.length) return;
    clearTimeout(model.reconnect.timer); model.reconnect = null;
    if (this.visible && this.active === model) this.connect(model);
  }
  drain(model) {
    if (model.writing || model.dropped) return;
    const chunk = model.output.shift();
    if (!chunk) {
      this.resume(model);
      if (!model.source && !model.reconnect && this.active === model && this.visible && !model.endedLoaded && !model.closing) this.connect(model);
      return;
    }
    if (chunk.reset) {
      model.term.reset(); model.sequence = 0; this.drain(model); return;
    }
    model.writing = true;
    model.term.write(chunk.bytes, () => {
      if (model.dropped) return;
      model.outputBytes -= chunk.bytes.length; model.sequence = chunk.sequence; model.writing = false; this.drain(model);
    });
  }
  disconnect(model) {
    if (!model) return;
    model.source?.close(); model.source = null; model.connected = false;
    if (model.reconnect) clearTimeout(model.reconnect.timer);
    model.reconnect = null; model.generation++;
    model.inputTask?.controller.abort(); model.inputTask = null; model.input = []; model.inputBytes = 0;
    if (model.term) model.term.options.disableStdin = true;
    if (this.active === model) this.clearModifiers();
  }
  input(model, data) { this.inputBytes(model, new TextEncoder().encode(data)); }
  inputBytes(model, bytes) {
    if (!bytes.length || this.active !== model || !this.visible || !model.connected || model.meta.status !== 'running') return;
    if (model.inputBytes + bytes.length > 64 * 1024) { this.notify('输入超过 64 KiB，请分段粘贴。'); return; }
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) model.input.push(bytes.slice(offset, offset + 16 * 1024));
    model.inputBytes += bytes.length; this.sendInput(model);
  }
  async sendInput(model) {
    if (model.inputTask || !model.connected || !model.input.length) return;
    const bytes = model.input.shift(), generation = model.generation;
    const task = { controller: new AbortController() }; model.inputTask = task;
    const timeout = setTimeout(() => task.controller.abort(), 10000);
    try {
      await this.api(`/api/terminals/${encodeURIComponent(model.meta.id)}/input`, { project: model.meta.project, data: this.encode(bytes) }, { signal: task.controller.signal });
      if (model.generation === generation) model.inputBytes -= bytes.length;
    } catch (error) {
      if (model.generation === generation) {
        this.notify(task.controller.signal.aborted ? '输入发送超时，请检查终端；该输入不会自动重发。' : `输入发送失败：${error.message}。请检查终端，该输入不会自动重发。`);
        this.reconnect(model, '输入连接中断，未发送的输入已丢弃。', 1000);
      }
    } finally {
      clearTimeout(timeout);
      if (model.inputTask === task) { model.inputTask = null; if (model.generation === generation) this.sendInput(model); }
    }
  }
  encode(bytes) {
    let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw);
  }
  decode(data) { return Uint8Array.from(atob(data), char => char.charCodeAt(0)); }
  withModifiers(data) {
    if (data.startsWith('\x1b') && data.length > 1 && !/^\x1b(?:.|[O\[][A-DFHP-S]|\[[0-9;]*[~A-DFH])$/.test(data)) return data;
    const { ctrl, alt } = this.modifiers; this.clearModifiers();
    if (!ctrl && !alt) return data;
    if (/^\x1b(?:\[|O)[ABCD]$/.test(data)) return `\x1b[1;${1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${data.at(-1)}`;
    if (ctrl && data.length === 1) {
      const code = data.charCodeAt(0);
      if (data === '?' || data === '8') data = '\x7f';
      else if (data === ' ' || data === '2') data = '\0';
      else if (/^[3-7]$/.test(data)) data = String.fromCharCode(Number(data) + 24);
      else if (code >= 64 && code <= 127) data = String.fromCharCode(code & 31);
    }
    return alt ? '\x1b' + data : data;
  }
  clearModifiers() {
    this.modifiers.ctrl = false; this.modifiers.alt = false;
    this.root.querySelectorAll('[data-terminal-modifier]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  }
  paste(event) {
    if (!event.target.closest('.terminal-screen')) return;
    const text = event.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const model = this.active;
    if (!model?.connected) return;
    if (new TextEncoder().encode(text).length > 64 * 1024) { this.notify('粘贴超过 64 KiB，请分段粘贴。'); return; }
    if (/[\r\n]/.test(text)) {
      this.pendingPaste = { model, text };
      this.root.querySelector('[data-terminal-paste-preview]').textContent = text;
      this.pasteDialog.returnValue = 'cancel'; this.pasteDialog.showModal();
    } else { this.clearModifiers(); model.term.paste(text); }
  }
  cancelPaste() {
    this.pendingPaste = null;
    if (this.pasteDialog.open) this.pasteDialog.close('cancel');
  }
  async copy() {
    const text = this.active?.term?.getSelection();
    if (!text) { this.notify('请先选择要复制的终端内容'); return; }
    try { await navigator.clipboard.writeText(text); this.notify('已复制选中内容'); }
    catch { this.notify('浏览器未允许复制，请使用系统的复制菜单'); }
  }
  async closeTerminal() {
    const model = this.active, state = this.current;
    if (!model || model.closing) return;
    if (model.meta.status === 'running' && !window.confirm('结束此终端及其启动的进程？')) return;
    model.closing = true; this.disconnect(model); this.cancelPaste(); this.render();
    try {
      await this.request(`/api/terminals/${encodeURIComponent(model.meta.id)}/close`, { project: model.meta.project });
      state.ids = state.ids.filter(id => id !== model.meta.id);
      if (state.active === model.meta.id) state.active = state.ids[0] || '';
      this.drop(model);
    } catch (error) { model.notice = error.message; this.notify(error.message); }
    finally {
      model.closing = false;
      if (this.current === state && !this.disposed) { this.render(); if (this.visible) this.mount(); }
    }
  }
  click(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-terminal-new')) void this.create();
    else if (button.hasAttribute('data-terminal-refresh')) void this.refresh();
    else if (button.hasAttribute('data-terminal-close')) void this.closeTerminal();
    else if (button.hasAttribute('data-terminal-expand')) this.expand(!this.expanded);
    else if (button.hasAttribute('data-terminal-copy')) void this.copy();
    else if (button.hasAttribute('data-terminal-keys')) {
      this.keysExpanded = !this.keysExpanded;
      button.setAttribute('aria-expanded', String(this.keysExpanded)); button.textContent = this.keysExpanded ? '快捷键 ▾' : '快捷键 ▴';
      this.root.querySelector('.terminal-keys').hidden = !this.keysExpanded; this.fit();
    } else if (button.dataset.terminalModifier) {
      const key = button.dataset.terminalModifier; this.modifiers[key] = !this.modifiers[key]; button.setAttribute('aria-pressed', String(this.modifiers[key])); this.focus();
    } else if (button.dataset.terminalKey) {
      const keys = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', interrupt: '\x03' };
      const model = this.active;
      if (model) {
        let data = keys[button.dataset.terminalKey];
        if (model.term.modes?.applicationCursorKeysMode && /^\x1b\[[ABCD]$/.test(data)) data = data.replace('[', 'O');
        this.input(model, this.withModifiers(data));
      }
      this.focus();
    }
  }
  expand(value) {
    this.expanded = Boolean(value && this.active);
    this.root.classList.toggle('terminal-expanded', this.expanded);
    this.root.closest('.inspector')?.classList.toggle('terminal-fullscreen-host', this.expanded);
    const button = this.root.querySelector('[data-terminal-expand]');
    button.setAttribute('aria-expanded', String(this.expanded)); button.textContent = this.expanded ? '收起' : '展开';
    button.title = this.expanded ? '恢复面板大小' : '全屏展开终端'; this.fit();
  }
  fit() {
    if (this.fitFrame || this.disposed || !this.visible) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      const viewport = window.visualViewport;
      if (viewport) {
        this.root.style.setProperty('--terminal-viewport-top', `${viewport.offsetTop}px`);
        this.root.style.setProperty('--terminal-viewport-left', `${viewport.offsetLeft}px`);
        this.root.style.setProperty('--terminal-viewport-width', `${viewport.width}px`);
        this.root.style.setProperty('--terminal-viewport-height', `${viewport.height}px`);
        this.root.style.setProperty('--terminal-available-height', `${Math.max(80, viewport.offsetTop + viewport.height - this.root.getBoundingClientRect().top)}px`);
      }
      const model = this.active;
      if (!this.visible || !model?.term || model.host.hidden || !model.host.clientWidth || !model.host.clientHeight) return;
      const size = model.fitter.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      const cols = Math.min(500, Math.max(2, size.cols)), rows = Math.min(200, Math.max(1, size.rows));
      if (model.term.cols !== cols || model.term.rows !== rows) model.term.resize(cols, rows);
      if (model.connected && (model.meta.cols !== cols || model.meta.rows !== rows)) {
        model.resize = { cols, rows }; this.sendResize(model);
      }
    });
  }
  async sendResize(model) {
    if (!model.resize || model.resizing || !model.connected) return;
    const size = model.resize; model.resize = null; model.resizing = true;
    try {
      const result = await this.request(`/api/terminals/${encodeURIComponent(model.meta.id)}/resize`, { project: model.meta.project, ...size });
      if (!model.dropped) Object.assign(model.meta, result.terminal || size);
    } catch (error) { if (model.connected && !model.dropped) { model.notice = `终端尺寸同步失败：${error.message}`; this.renderStatus(); } }
    finally { model.resizing = false; if (!model.dropped) this.sendResize(model); }
  }
  render() {
    const state = this.current, model = this.active;
    this.select.replaceChildren();
    const items = state?.ids || [];
    for (const id of items) {
      const item = this.models.get(id); if (!item) continue;
      const option = document.createElement('option'); option.value = id; option.textContent = `${item.meta.name}${item.meta.status === 'exited' ? ' · 已结束' : ''}`; this.select.append(option);
    }
    if (!items.length) { const option = document.createElement('option'); option.textContent = state?.loading ? '正在读取…' : '暂无终端'; this.select.append(option); }
    this.select.value = state?.active || ''; this.select.disabled = !items.length;
    this.root.querySelector('[data-terminal-new]').disabled = !state || state.creating || !this.available;
    this.root.querySelector('[data-terminal-new]').textContent = state?.creating ? '正在新建…' : '＋ 新建';
    this.root.querySelector('[data-terminal-refresh]').disabled = !state || state.loading || !this.available;
    this.root.querySelector('[data-terminal-close]').disabled = !model || model.closing;
    this.root.querySelector('[data-terminal-expand]').disabled = !model;
    this.root.querySelector('[data-terminal-copy]').disabled = !model?.term;
    this.root.querySelector('.terminal-location').textContent = model ? `启动目录：${model.meta.cwd}` : this.project?.path || '';
    this.empty.hidden = Boolean(model);
    for (const item of this.models.values()) if (item.host) item.host.hidden = item !== model;
    if (!model && this.expanded) this.expand(false);
    this.renderStatus();
  }
  renderStatus() {
    const model = this.active;
    this.root.querySelector('.terminal-notice').textContent = !this.available ? '终端接口尚未加载，请在本轮结束后执行 /reload。' : this.current?.error || model?.meta.error || model?.notice || '';
    this.root.querySelector('.terminal-connection').textContent = !model ? '' : model.meta.status === 'exited' ? `已结束${model.meta.signal ? ` · ${model.meta.signal}` : model.meta.exitCode != null ? ` · ${model.meta.exitCode}` : ''}` : model.connected ? '已连接' : this.visible ? '连接中' : '未连接';
    for (const button of this.root.querySelectorAll('[data-terminal-key], [data-terminal-modifier]')) button.disabled = !model?.connected;
  }
  focus() { if (this.visible) this.active?.term?.focus(); }
  drop(model) {
    if (!model) return;
    this.disconnect(model); model.dropped = true; model.output = []; model.term?.dispose(); model.host?.remove(); this.models.delete(model.meta.id);
  }
  dispose() {
    this.hide(); this.disposed = true;
    for (const model of [...this.models.values()]) this.drop(model);
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.observer?.disconnect();
    clearInterval(this.connectionTimer); document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onViewport); window.removeEventListener('blur', this.onBlur);
    window.visualViewport?.removeEventListener('resize', this.onViewport); window.visualViewport?.removeEventListener('scroll', this.onViewport);
  }
};
