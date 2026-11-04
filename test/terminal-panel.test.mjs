import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../public/terminal.js', import.meta.url), 'utf8');
const until = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Terminal panel did not settle');
};
const metadata = (id, project = 'a') => ({ id, project, name: `终端 ${id}`, cwd: `/project/${project}`, shell: '/bin/bash', status: 'running', cols: 80, rows: 24, sequence: 0 });

async function fixture(t, { terminalList = [metadata('one')], input = async () => ({}), nonce = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><head>${nonce ? `<meta name="terminal-style-nonce" content="${nonce}">` : ''}</head><aside class="inspector"><section id="terminal"></section></aside>`, { url: 'http://localhost:4310', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom, { document } = window;
  window.TextEncoder = TextEncoder; window.confirm = () => true;
  const terminals = [], streams = [], calls = [], notifications = [], list = [...terminalList];
  class FakeTerminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.writes = []; this.writeCallbacks = []; this.autoWrite = true; this.focusCount = 0; this.resetCount = 0; this.selection = ''; terminals.push(this); }
    open(host) { this.host = host; this.textarea = document.createElement('textarea'); host.append(this.textarea); }
    loadAddon(addon) { addon.terminal = this; }
    onData(listener) { this.dataListener = listener; }
    onBinary(listener) { this.binaryListener = listener; }
    attachCustomKeyEventHandler(listener) { this.keyListener = listener; }
    write(bytes, callback) { this.writes.push(Buffer.from(bytes)); if (this.autoWrite) callback(); else this.writeCallbacks.push(callback); }
    flush() { this.writeCallbacks.shift()?.(); }
    reset() { this.resetCount++; this.writes = []; }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    focus() { this.focusCount++; this.textarea.focus(); }
    hasSelection() { return Boolean(this.selection); }
    getSelection() { return this.selection; }
    paste(text) { this.pasted = text; this.dataListener(text); }
    dispose() { this.disposed = true; }
  }
  class FakeSource extends window.EventTarget {
    constructor(url) { super(); this.url = url; streams.push(this); }
    emit(name, data) { this.dispatchEvent(new window.MessageEvent(name, { data: JSON.stringify(data) })); }
    fail() { this.onerror?.(); }
    close() { this.closed = true; }
  }
  window.Terminal = FakeTerminal;
  window.FitAddon = { FitAddon: class { proposeDimensions() { return { cols: 90, rows: 28 }; } } };
  window.EventSource = FakeSource;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function (value) { this.returnValue = value; this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.eval(source);
  const root = document.getElementById('terminal');
  const api = async (route, data, options) => {
    calls.push({ route, data, options });
    if (route.startsWith('/api/terminals?')) { const project = new URL(route, window.location).searchParams.get('project'); return { terminals: list.filter(item => item.project === project) }; }
    if (route === '/api/terminals') { const terminal = metadata(`new-${list.length}`, data.project); list.push(terminal); return { terminal }; }
    if (route.endsWith('/input')) return input(route, data, options);
    if (route.endsWith('/close')) { const id = route.split('/')[3], index = list.findIndex(item => item.id === id); const [terminal] = list.splice(index, 1); return { terminal: { ...terminal, status: 'exited' } }; }
    if (route.endsWith('/resize')) return { terminal: { ...list.find(item => route.includes(`/${item.id}/`)), cols: data.cols, rows: data.rows } };
    throw new Error(`Unexpected route ${route}`);
  };
  const panel = new window.CodexTerminalPanel(root, { api, notify: value => notifications.push(value) });
  panel.setProject({ id: 'a', path: '/project/a', name: 'A' });
  t.after(() => { panel.dispose(); window.close(); });
  const show = async () => { panel.show(); await until(() => streams.length > 0); return streams.at(-1); };
  const ready = (stream = streams.at(-1), terminal = list.find(item => stream.url.includes(`/${item.id}/`))) => stream.emit('ready', { terminal, reset: true, truncated: false });
  return { window, document, root, panel, terminals, streams, calls, list, notifications, show, ready };
}

test('terminal panel creates only on request, preserves project shells and keeps shortcuts collapsed by default', async t => {
  const f = await fixture(t, { terminalList: [] });
  f.panel.show(); await until(() => f.calls.length > 0 && !f.panel.current.loading);
  assert.equal(f.terminals.length, 0); assert.equal(f.streams.length, 0);
  assert.equal(f.root.querySelector('.terminal-keys').hidden, true);
  f.root.querySelector('[data-terminal-new]').click();
  await until(() => f.terminals.length === 1 && !f.panel.current.creating);
  f.ready(); const first = f.streams[0], firstTerm = f.terminals[0];
  f.root.querySelector('[data-terminal-keys]').click(); assert.equal(f.root.querySelector('.terminal-keys').hidden, false);
  f.panel.hide(); assert.equal(first.closed, true); assert.equal(firstTerm.disposed, undefined);
  assert.equal(f.calls.some(call => call.route.endsWith('/close')), false);
  f.panel.setProject({ id: 'b', path: '/project/b' }); f.panel.show();
  await until(() => !f.panel.current.loading);
  assert.equal(f.root.querySelector('.terminal-keys').hidden, false);
  f.root.querySelector('[data-terminal-new]').click(); await until(() => f.terminals.length === 2); f.ready();
  f.panel.setProject({ id: 'a', path: '/project/a' });
  await until(() => f.streams.length === 3);
  assert.equal(f.panel.active.term, firstTerm); assert.equal(f.terminals.length, 2);
  assert.equal(f.calls.filter(call => call.route === '/api/terminals').length, 2);
});

test('terminal hardware input, one-shot Ctrl and software Escape reach PTY without hijacking copy', async t => {
  const f = await fixture(t); await f.show(); f.ready();
  const term = f.terminals[0];
  term.dataListener('echo 你好\r'); await until(() => f.calls.some(call => call.route.endsWith('/input')));
  const inputs = () => f.calls.filter(call => call.route.endsWith('/input')).map(call => Buffer.from(call.data.data, 'base64').toString());
  assert.equal(inputs()[0], 'echo 你好\r');
  f.root.querySelector('[data-terminal-keys]').click(); f.root.querySelector('[data-terminal-modifier=ctrl]').click();
  assert.equal(f.root.querySelector('[data-terminal-modifier=ctrl]').getAttribute('aria-pressed'), 'true');
  term.dataListener('\x1b[1;1R');
  assert.equal(f.root.querySelector('[data-terminal-modifier=ctrl]').getAttribute('aria-pressed'), 'true');
  term.dataListener('c'); term.dataListener('c');
  f.root.querySelector('[data-terminal-key=esc]').click(); f.root.querySelector('[data-terminal-key=interrupt]').click();
  await until(() => inputs().length === 6);
  assert.deepEqual(inputs().slice(1), ['\x1b[1;1R', '\x03', 'c', '\x1b', '\x03']);
  assert.equal(f.root.querySelector('[data-terminal-modifier=ctrl]').getAttribute('aria-pressed'), 'false');
  let copied; Object.defineProperty(f.window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  term.selection = 'selected output';
  const copyEvent = new f.window.KeyboardEvent('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true, cancelable: true });
  assert.equal(term.keyListener(copyEvent), false); await until(() => copied === term.selection);
  assert.equal(inputs().length, 6);
  let escaped = false; f.document.addEventListener('keydown', () => { escaped = true; });
  term.textarea.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(escaped, false);
});

test('output replay advances only after rendering and reconnect waits for pending parser writes', async t => {
  const f = await fixture(t); const stream = await f.show(); f.ready();
  const term = f.terminals[0]; term.autoWrite = false;
  stream.emit('output', { sequence: 1, data: Buffer.from('你好').toString('base64') });
  stream.emit('output', { sequence: 2, data: Buffer.from('\r\n$ ').toString('base64') });
  assert.equal(f.panel.active.sequence, 0); stream.fail(); assert.equal(stream.closed, true);
  await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(f.streams.length, 1);
  term.flush(); assert.equal(f.panel.active.sequence, 1); term.flush();
  await until(() => f.streams.length === 2);
  assert.match(f.streams[1].url, /after=2/); assert.equal(term.focusCount, 0);
  const before = term.resetCount; f.streams[1].emit('ready', { terminal: metadata('one'), reset: true, truncated: true });
  assert.equal(f.panel.active.sequence, 0); assert.equal(term.resetCount, before + 1);
  assert.match(f.root.querySelector('.terminal-notice').textContent, /较早的输出已清理/);
});

test('ambiguous failed input is discarded with later queued keys and never resent', async t => {
  let rejectInput;
  const f = await fixture(t, { input: () => new Promise((resolve, reject) => { rejectInput = reject; }) });
  await f.show(); f.ready(); const term = f.terminals[0];
  term.dataListener('first'); term.dataListener('second');
  assert.equal(f.calls.filter(call => call.route.endsWith('/input')).length, 1);
  rejectInput(new Error('network lost'));
  await until(() => !f.panel.active.connected);
  assert.equal(f.panel.active.inputBytes, 0); assert.equal(f.panel.active.input.length, 0);
  await until(() => f.streams.length === 2); f.ready();
  assert.equal(f.calls.filter(call => call.route.endsWith('/input')).length, 1);
  assert.match(f.notifications.join('\n'), /不会自动重发/);
});

test('multiline paste waits for review, preserves exact content, and cancels when switching terminals', async t => {
  const f = await fixture(t, { terminalList: [metadata('one'), metadata('two')] });
  await f.show(); f.ready(); const term = f.terminals[0], dialog = f.root.querySelector('dialog');
  const text = 'echo first\necho second\n';
  const paste = () => {
    const event = new f.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } }); term.textarea.dispatchEvent(event); return event;
  };
  assert.equal(paste().defaultPrevented, true); assert.equal(dialog.open, true); assert.equal(term.pasted, undefined);
  assert.equal(f.calls.filter(call => call.route.endsWith('/input')).length, 0);
  dialog.close('cancel'); assert.equal(term.pasted, undefined);
  paste(); dialog.close('paste'); assert.equal(term.pasted, text);
  await until(() => f.calls.filter(call => call.route.endsWith('/input')).length === 1);
  paste(); f.panel.activate('two'); assert.equal(dialog.open, false);
  assert.equal(f.calls.filter(call => call.route.endsWith('/input')).length, 1);
});

test('exited terminal history remains readable and its exit does not start a reconnect loop', async t => {
  const exited = { ...metadata('one'), status: 'exited', exitCode: 0, error: 'PTY helper exited unexpectedly' };
  const f = await fixture(t, { terminalList: [exited] }); const stream = await f.show(); f.ready(stream, exited);
  stream.emit('output', { sequence: 1, data: Buffer.from('finished\r\n').toString('base64') });
  stream.emit('exit', { terminal: exited });
  assert.equal(Buffer.concat(f.terminals[0].writes).toString(), 'finished\r\n');
  assert.equal(f.terminals[0].options.disableStdin, true); assert.equal(stream.closed, true);
  stream.fail(); f.panel.hide(); f.panel.show(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.streams.length, 1); assert.match(f.root.querySelector('.terminal-connection').textContent, /已结束/);
  assert.match(f.root.querySelector('.terminal-notice').textContent, /PTY helper exited unexpectedly/);
});

test('terminal styles receive the HTML CSP nonce without changing document style creation globally', async t => {
  const f = await fixture(t, { nonce: 'test-terminal-nonce' }); await f.show();
  const doc = f.terminals[0].options.documentOverride;
  assert.equal(doc instanceof f.window.Document, true);
  assert.equal(doc.createElement('style').nonce, 'test-terminal-nonce');
  assert.equal(doc.createElement('div').nonce, '');
  assert.equal(f.document.createElement('style').nonce, '');
});

test('unavailable backend stays idle and terminal libraries load only when opening an existing terminal', async t => {
  const f = await fixture(t);
  f.panel.setAvailable(false); f.panel.show();
  assert.equal(f.calls.length, 0); assert.equal(f.document.querySelectorAll('script').length, 0);
  assert.equal(f.root.querySelector('[data-terminal-new]').disabled, true);
  assert.match(f.root.querySelector('.terminal-notice').textContent, /\/reload/);
  const Terminal = f.window.Terminal, FitAddon = f.window.FitAddon;
  delete f.window.Terminal; delete f.window.FitAddon;
  f.panel.setAvailable(true);
  await until(() => f.document.querySelector('script[src="/vendor/xterm/xterm.js"]'));
  assert.equal(f.terminals.length, 0);
  f.panel.mount();
  assert.equal(f.document.querySelectorAll('script').length, 1);
  f.window.Terminal = Terminal;
  f.document.querySelector('script').dispatchEvent(new f.window.Event('load'));
  await until(() => f.document.querySelector('script[src="/vendor/xterm/addon-fit.js"]'));
  f.window.FitAddon = FitAddon;
  f.document.querySelector('script[src="/vendor/xterm/addon-fit.js"]').dispatchEvent(new f.window.Event('load'));
  await until(() => f.terminals.length === 1 && f.streams.length === 1);
  assert.equal(f.calls.some(call => call.route === '/api/terminals'), false);
});

test('old disconnected terminal screens are bounded and returning to an evicted project reconnects its existing shell', async t => {
  const f = await fixture(t, { terminalList: [metadata('one'), ...Array.from({ length: 16 }, (_, i) => metadata(`terminal-${i}`, `project-${i}`))] });
  const firstStream = await f.show(); f.ready();
  const firstTerm = f.terminals[0]; firstTerm.autoWrite = false;
  firstStream.emit('output', { sequence: 1, data: Buffer.from('pending output').toString('base64') });
  for (let i = 0; i < 16; i++) {
    f.panel.setProject({ id: `project-${i}`, path: `/project/${i}` });
    await until(() => f.panel.current.loaded && f.panel.active?.term);
    f.ready();
    assert.ok(f.panel.models.size <= 16);
  }
  assert.equal(firstTerm.disposed, true);
  assert.equal(f.panel.models.has('one'), false);
  assert.deepEqual([...f.panel.projects.get('a').ids], []);
  assert.equal(f.calls.some(call => call.route.endsWith('/close')), false);
  firstTerm.flush();
  assert.equal(f.panel.active.meta.id, 'terminal-15');
  f.panel.setProject({ id: 'a', path: '/project/a' });
  await until(() => f.panel.current.loaded && f.panel.active?.term);
  assert.equal(f.panel.active.meta.id, 'one'); assert.notEqual(f.panel.active.term, firstTerm);
  assert.ok(f.panel.models.size <= 16);
  assert.equal(f.calls.some(call => call.route === '/api/terminals'), false);
  assert.match(f.streams.at(-1).url, /\/one\/events/);
});
