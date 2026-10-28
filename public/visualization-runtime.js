// Runs before generated code, inside an opaque-origin iframe. No host APIs.
(() => {
  const channel = location.hash.slice(1);
  const send = (method, value) => parent.postMessage({ codexVisualization: 1, channel, method, value }, '*');
  let state = null, initialized = false, pendingState = false, height = 0, frame;
  window.codexVisualize = Object.freeze({
    getState: () => state,
    setState: value => {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || new TextEncoder().encode(serialized).length > 65536) throw new Error('组件状态最多 64 KiB');
      state = JSON.parse(serialized);
      if (initialized) send('state', state); else pendingState = true;
    },
    sendMessage: text => { if (typeof text === 'string' && text.trim() && text.length <= 10000) send('message', text); },
  });
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || !data || data.codexVisualization !== 1 || data.channel !== channel) return;
    if (data.method === 'init') {
      if (initialized) return;
      if (!pendingState) state = data.value.state;
      initialized = true;
      if (pendingState) send('state', state);
      document.documentElement.dataset.theme = data.value.theme;
      dispatchEvent(new Event('codexvisualizeready'));
    }
    if (data.method === 'visibility') {
      dispatchEvent(new CustomEvent('codexvisualizevisibility', { detail: data.value }));
    }
  });
  const measure = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const next = Math.ceil(Math.max(document.body?.scrollHeight || 0, document.body?.getBoundingClientRect().height || 0));
      if (next !== height) { height = next; send('height', height); }
    });
  };
  addEventListener('DOMContentLoaded', () => {
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(document.body || document.documentElement);
    measure(); send('ready');
  }, { once: true });
  addEventListener('load', measure);
  addEventListener('error', () => send('error', '组件脚本运行失败，可重新运行或让 Codex 修正。'));
  addEventListener('unhandledrejection', () => send('error', '组件脚本运行失败，可重新运行或让 Codex 修正。'));
})();
