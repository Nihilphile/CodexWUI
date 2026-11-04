(() => {
  // A single isolated renderer serves every message; old diagrams reuse images.
  let frame, ready, sequence = 0;
  const pending = new Map(), cache = new Map();
  let weight = 0;
  function renderer() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      frame = document.createElement('iframe');
      frame.className = 'mermaid-renderer'; frame.title = 'Mermaid 渲染器';
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
      const timer = setTimeout(() => reject(new Error('renderer timeout')), 20000);
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow || event.data?.codexMermaid !== 1) return;
        const data = event.data;
        if (data.ready) { clearTimeout(timer); resolve(frame); return; }
        const task = pending.get(data.id);
        if (!task) return;
        pending.delete(data.id);
        if (typeof data.svg === 'string') task.resolve('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.svg));
        else task.reject(new Error('invalid diagram'));
      });
      frame.src = '/mermaid-renderer.html'; document.body.append(frame);
    });
    return ready;
  }
  async function draw(source) {
    if (source.length > 50000) throw new Error('diagram too large');
    if (cache.has(source)) return cache.get(source).promise;
    const result = (async () => {
      const target = await renderer();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('diagram timeout')); }, 20000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        target.contentWindow.postMessage({ codexMermaid: 1, id, source }, '*');
      });
    })();
    const entry = { promise: result, weight: source.length };
    cache.set(source, entry);
    // Count the rendered SVG as well as the definition, and retain failures so
    // streaming another paragraph does not repeatedly parse a broken diagram.
    void result.then(value => {
      if (cache.get(source) !== entry) return;
      entry.weight += value.length; weight += value.length;
      trim();
    }, () => {});
    weight += source.length; trim();
    return result;
  }
  function trim() {
    while (cache.size && (cache.size > 100 || weight > 2 * 1024 * 1024)) {
      const key = cache.keys().next().value;
      weight -= cache.get(key).weight; cache.delete(key);
    }
  }

  customElements.define('codex-mermaid', class extends HTMLElement {
    connectedCallback() {
      queueMicrotask(async () => {
        if (!this.isConnected || this.started) return;
        this.started = true;
        const source = this.querySelector('code')?.textContent || '';
        const output = this.querySelector('.mermaid-output');
        if (!output) return;
        try {
          const url = await draw(source);
          const image = document.createElement('img');
          image.alt = 'Mermaid 图表，源码见下方'; image.src = url;
          image.onerror = () => this.fail(output);
          output.replaceChildren(image);
        } catch { this.fail(output); }
      });
    }
    fail(output) {
      output.querySelector('img')?.remove();
      output.textContent = '图表未能渲染，请查看源码。';
      this.querySelector('details').open = true;
    }
  });
})();
