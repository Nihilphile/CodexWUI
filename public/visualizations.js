(() => {
  const own = item => item?.type === 'mcpToolCall' && item.server === 'codexweb_visualize' && item.tool === 'visualize';
  const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  const sizeOf = value => new Blob([JSON.stringify(value)]).size;
  class CodexVisualizations {
    constructor({ api, markdown, bringBack }) {
      Object.assign(this, { api, markdown, bringBack });
      this.views = new Map(); this.signatures = new WeakMap();
      window.addEventListener('message', event => this.receive(event));
      document.addEventListener('visibilitychange', () => {
        for (const view of this.views.values()) this.send(view, 'visibility', !document.hidden);
      });
      window.addEventListener('pagehide', () => {
        for (const view of this.views.values()) if (view.saveTimer) {
          clearTimeout(view.saveTimer); view.saveTimer = null;
          // Flush the last drag when navigating away; keepalive is bounded by
          // browser limits, so normal debounced saves remain the primary path.
          void fetch(`/api/visualizations/${view.artifactId}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: view.savedState }), keepalive: true }).catch(() => {});
        }
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') for (const view of this.views.values()) this.expand(view, false);
      });
    }
    static matches(item) { return own(item); }
    // Reconcile individual message nodes in place. Do not detach/reattach an
    // existing iframe on text deltas, polling, or older-history insertion.
    render(container, entries, context) {
      const wanted = new Set(entries.map(entry => entry.key));
      for (const child of [...container.children]) if (!wanted.has(child.dataset.messageKey)) {
        this.dispose(child); child.remove();
      }
      const nodes = new Map([...container.children].map(child => [child.dataset.messageKey, child]));
      let cursor = container.firstChild;
      for (const entry of entries) {
        let node = nodes.get(entry.key);
        if (entry.item && own(entry.item)) {
          if (!node) node = this.create(entry.key, context);
          this.update(this.views.get(entry.key), entry.item);
        } else if (!node || this.signatures.get(node) !== entry.html) {
          const template = document.createElement('template'); template.innerHTML = entry.html;
          const replacement = template.content.firstElementChild;
          if (!replacement) continue;
          this.signatures.set(replacement, entry.html);
          if (node) { const atCursor = node === cursor; this.dispose(node); node.replaceWith(replacement); if (atCursor) cursor = replacement; }
          node = replacement;
        }
        node.dataset.messageKey = entry.key;
        if (node !== cursor) container.insertBefore(node, cursor);
        cursor = node.nextSibling;
      }
    }
    create(key, context) {
      const node = document.createElement('article'); node.className = 'visualization-card';
      node.innerHTML = '<header class="visualization-header"><strong></strong><div class="visualization-actions"><button type="button" data-visual-action="rerun">重新运行</button><button type="button" data-visual-action="expand" aria-expanded="false">展开</button></div></header><div class="visualization-status" role="status"></div><div class="visualization-content"></div>';
      const view = { key, node, context, title: node.querySelector('strong'), status: node.querySelector('[role=status]'), content: node.querySelector('.visualization-content'), queue: Promise.resolve(), disposed: false };
      this.views.set(key, view);
      node.querySelector('[data-visual-action=expand]').onclick = () => this.expand(view, !node.classList.contains('expanded'));
      node.querySelector('[data-visual-action=rerun]').onclick = () => { if (view.record?.type === 'html') this.mountFrame(view); else if (view.artifactId) this.load(view); };
      return node;
    }
    expand(view, expanded) {
      view.node.classList.toggle('expanded', expanded);
      const button = view.node.querySelector('[data-visual-action=expand]');
      button.textContent = expanded ? '收起' : '展开'; button.setAttribute('aria-expanded', String(expanded));
    }
    update(view, item) {
      view.title.textContent ||= item.arguments?.title || '可视化';
      const result = item.result;
      let artifact = result?.structuredContent;
      if (!artifact) {
        try { artifact = JSON.parse(result?.content?.find(block => block.type === 'text')?.text || 'null'); } catch {}
      }
      if (idPattern.test(artifact?.artifactId || '')) {
        if (view.artifactId !== artifact.artifactId) {
          view.artifactId = artifact.artifactId; void this.load(view);
        }
      } else if (['failed', 'declined'].includes(item.status) || item.error || item.status === 'completed') {
        this.status(view, item.error?.message || result?.content?.find(block => block.type === 'text')?.text || '内容发布失败，请让 Codex 重试。', true);
      } else if (!view.record) this.status(view, '正在准备内容…');
    }
    status(view, message, failed = false) {
      if (view.disposed) return;
      view.status.textContent = message; view.status.hidden = !message;
      view.status.classList.toggle('failed', failed);
    }
    async load(view) {
      const id = view.artifactId;
      this.status(view, '正在加载…');
      try {
        const record = await this.api(`/api/visualizations/${id}`);
        if (view.disposed || view.artifactId !== id) return;
        view.record = record; view.savedState = record.state; view.title.textContent = record.title;
        view.content.replaceChildren();
        const rerun = view.node.querySelector('[data-visual-action=rerun]');
        rerun.textContent = record.type === 'html' ? '重新运行' : '重新加载';
        if (record.type === 'html') this.mountFrame(view);
        else if (record.type === 'markdown') {
          const prose = document.createElement('div'); prose.className = 'prose';
          prose.innerHTML = this.markdown(record.content, { project: record.project, directory: record.directory });
          view.content.append(prose); this.status(view, '');
        } else if (record.type === 'image') {
          const link = document.createElement('a'); link.href = `/api/visualizations/${id}/content`;
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          const img = document.createElement('img'); img.src = link.href; img.alt = record.title; img.loading = 'lazy';
          img.onerror = () => this.status(view, '图片加载失败，可重新加载。', true);
          link.append(img); view.content.append(link); this.status(view, '');
        } else throw new Error('不支持的展示类型');
      } catch (error) { this.status(view, error.message || '内容加载失败，可重新加载。', true); }
    }
    mountFrame(view) {
      if (view.disposed) return;
      clearTimeout(view.loadTimer);
      const iframe = document.createElement('iframe');
      view.channel = crypto.randomUUID();
      iframe.title = view.record.title; iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.referrerPolicy = 'no-referrer'; iframe.height = '420';
      iframe.src = `/api/visualizations/${view.artifactId}/render#${view.channel}`;
      view.frame = iframe; view.content.replaceChildren(iframe);
      this.status(view, '正在加载交互内容…');
      view.loadTimer = setTimeout(() => this.status(view, '组件未能完成加载，可重新运行或让 Codex 修正。', true), 15000);
    }
    send(view, method, value) {
      view.frame?.contentWindow?.postMessage({ codexVisualization: 1, channel: view.channel, method, value }, '*');
    }
    receive(event) {
      const data = event.data;
      if (!data || data.codexVisualization !== 1 || typeof data.channel !== 'string') return;
      const view = [...this.views.values()].find(view => view.channel === data.channel && event.source === view.frame?.contentWindow);
      if (!view || view.disposed) return;
      if (data.method === 'ready') {
        clearTimeout(view.loadTimer);
        this.send(view, 'init', { state: view.savedState ?? null, theme: document.documentElement.style.colorScheme || 'dark' });
        this.status(view, '');
      } else if (data.method === 'height' && Number.isFinite(data.value)) {
        view.frame.height = String(Math.max(160, Math.min(900, Math.ceil(data.value))));
      } else if (data.method === 'error') {
        clearTimeout(view.loadTimer); this.status(view, '组件脚本运行失败，可重新运行或让 Codex 修正。', true);
      } else if (data.method === 'message' && typeof data.value === 'string' && data.value.trim() && data.value.length <= 10000) {
        this.bringBack(view.context, data.value);
      } else if (data.method === 'state') {
        let value;
        try { if (sizeOf(data.value) > 65536) return; value = JSON.parse(JSON.stringify(data.value)); } catch { return; }
        view.savedState = value;
        clearTimeout(view.saveTimer);
        view.saveTimer = setTimeout(() => { view.saveTimer = null; this.save(view, value); }, 350);
      }
    }
    save(view, state) {
      view.queue = view.queue.catch(() => {}).then(() => this.api(`/api/visualizations/${view.artifactId}/state`, { state })).catch(error => this.status(view, `参数保存失败：${error.message}`, true));
    }
    dispose(node) {
      const view = this.views.get(node.dataset.messageKey);
      if (!view) return;
      if (view.saveTimer) { clearTimeout(view.saveTimer); this.save(view, view.savedState); }
      clearTimeout(view.loadTimer); view.disposed = true;
      this.views.delete(view.key);
    }
  }
  window.CodexVisualizations = CodexVisualizations;
})();
