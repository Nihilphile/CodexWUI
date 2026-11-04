import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/index.mjs';
import { FakeCodex } from './helpers.mjs';

const source = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Preview did not settle');
};
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexwui-preview-'));
  const codex = new FakeCodex(dir);
  const app = await createApp({ codex, initialProject: dir, dataDir: path.join(dir, 'data') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const project = (await (await fetch(base + '/api/bootstrap')).json()).projects[0];
  const url = (route, file, extra = {}) => base + route + '?' + new URLSearchParams({ project: project.id, path: file, ...extra });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, base, project, url };
}

test('ordinary HTML renders only in the isolated preview route and keeps raw/download access inert', async t => {
  const { dir, url } = await fixture(t);
  const html = '<!doctype html><style>p{color:red}</style><p>hello</p><script>window.parent.bad=1</script>';
  await writeFile(path.join(dir, 'page.htm'), html);
  const data = await (await fetch(url('/api/files/preview', 'page.htm'))).json();
  assert.equal(data.kind, 'html'); assert.equal(data.text, html);
  const preview = await fetch(url('/api/files/html', 'page.htm'));
  assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type'), /text\/html/);
  const csp = preview.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts;/); assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'none'/); assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.equal(await preview.text(), html);
  const raw = await fetch(url('/api/files/content', 'page.htm', { browser: '1' }));
  assert.match(raw.headers.get('content-type'), /text\/plain/); assert.match(raw.headers.get('content-security-policy'), /sandbox/);
  await writeFile(path.join(dir, 'plain.txt'), 'hello');
  assert.equal((await fetch(url('/api/files/html', 'plain.txt'))).status, 400);
  await symlink('/etc/passwd', path.join(dir, 'outside.html'));
  for (const file of ['../outside.html', '/etc/passwd', 'outside.html']) assert.equal((await fetch(url('/api/files/html', file))).status, 403);
  assert.equal((await fetch(url('/api/files/html', 'missing.html'))).status, 404);
});

test('PDF metadata, byte ranges and browser fallback preserve project checks and download isolation', async t => {
  const { dir, url, base } = await fixture(t);
  const bytes = Buffer.from('%PDF-1.7\n0123456789\n%%EOF');
  await writeFile(path.join(dir, '报告 #?.pdf'), bytes);
  const data = await (await fetch(url('/api/files/preview', '报告 #?.pdf'))).json();
  assert.equal(data.kind, 'pdf'); assert.equal(data.text, undefined);
  const original = url('/api/files/content', '报告 #?.pdf');
  const head = await fetch(original, { method: 'HEAD' });
  assert.equal(head.headers.get('accept-ranges'), 'bytes'); assert.equal(Number(head.headers.get('content-length')), bytes.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [header, expected, start, end] of [
    ['bytes=0-4', bytes.subarray(0, 5), 0, 4],
    ['bytes=10-', bytes.subarray(10), 10, bytes.length - 1],
    ['bytes=-5', bytes.subarray(-5), bytes.length - 5, bytes.length - 1],
    ['bytes=2-999', bytes.subarray(2), 2, bytes.length - 1],
  ]) {
    const response = await fetch(original, { headers: { Range: header } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-5', 'bytes=999999999999999999999-']) {
    const response = await fetch(original, { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  const browser = await fetch(original + '&browser=1');
  assert.equal(browser.headers.get('content-type'), 'application/pdf'); assert.doesNotMatch(browser.headers.get('content-security-policy'), /sandbox/);
  const download = await fetch(original + '&browser=1&download=1');
  assert.match(download.headers.get('content-security-policy'), /sandbox/); assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(url('/api/files/content', '../outside.pdf', { browser: '1' }))).status, 403);
  for (const file of ['/pdf-viewer.html', '/pdf-viewer.js', '/pdf-viewer.css', '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs', '/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', '/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf', '/vendor/pdfjs/wasm/openjpeg.wasm']) {
    const response = await fetch(base + file); assert.equal(response.status, 200, file);
    if (file.endsWith('.wasm')) assert.equal(response.headers.get('content-type'), 'application/wasm');
    if (file.endsWith('.mjs')) assert.match(response.headers.get('content-type'), /text\/javascript/);
  }
  const reader = await fetch(base + '/pdf-viewer.html');
  assert.equal(reader.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.match(reader.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.equal((await fetch(base + '/vendor/pdfjs/wasm/not-present.wasm')).status, 404);
});

test('file panel toggles Markdown and HTML, retains per-file modes, and embeds PDF without a render toggle', async t => {
  const { dir, url, base, project } = await fixture(t);
  const markdown = '# Report\n\n**hello** $x^2$\n\n[Related](other.md)\n\n<script>bad()</script>';
  await writeFile(path.join(dir, 'notes.md'), markdown);
  await writeFile(path.join(dir, 'page.html'), '<h1>HTML</h1><script>bad()</script>');
  await writeFile(path.join(dir, 'paper.pdf'), '%PDF-1.7\n%%EOF');
  const dom = new JSDOM('<!doctype html><section id="files"></section>', { url: base, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom; t.after(() => window.close());
  Object.defineProperty(window.navigator, 'userAgent', { value: 'Desktop browser' });
  for (const name of ['vendor/markdown-it.min.js', 'vendor/katex/katex.min.js', 'markdown.js', 'file-links.js', 'files.js']) window.eval(await source(name));
  let copied; Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  const root = window.document.getElementById('files');
  const panel = new window.CodexFilePanel(root, { api: async route => {
    const response = await fetch(base + route); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  }, notify: () => {} });
  const toggle = root.querySelector('[data-file-render]'); const prose = root.querySelector('.file-markdown');
  panel.setProject(project); await panel.openFile('notes.md');
  assert.equal(panel.raw.hidden, false); assert.equal(toggle.hidden, false); assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.click(); assert.equal(panel.raw.hidden, true); assert.equal(prose.querySelector('h1').textContent, 'Report');
  assert.ok(prose.querySelector('.katex')); assert.equal(prose.querySelector('script'), null);
  assert.match(prose.querySelector('a').href, /file-preview\.html/);
  root.querySelector('[data-file-copy]').click(); await until(() => copied === markdown);
  prose.scrollTop = 48;
  await panel.openFile('page.html'); const frame = root.querySelector('.file-card-preview');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal(frame.hidden, false);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts'); assert.match(frame.src, /\/api\/files\/html\?/);
  const firstSrc = frame.src; panel.render(); assert.equal(frame.src, firstSrc);
  toggle.click(); assert.equal(frame.hasAttribute('src'), false); assert.equal(panel.raw.hidden, false); assert.equal(panel.raw.querySelector('script'), null);
  assert.match(panel.raw.textContent, /<h1>HTML/);
  await panel.openFile('notes.md'); assert.equal(toggle.getAttribute('aria-pressed'), 'true'); assert.equal(prose.scrollTop, 48);
  await writeFile(path.join(dir, 'notes.md'), '# Updated'); await panel.openFile('notes.md', { refresh: true });
  assert.equal(prose.querySelector('h1').textContent, 'Updated');
  await panel.openFile('page.html'); assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  await panel.openFile('paper.pdf'); assert.equal(toggle.hidden, true);
  const pdf = root.querySelector('.file-pdf-preview'); assert.equal(pdf.hidden, false); assert.match(pdf.src, /\/pdf-viewer\.html\?/);
  assert.equal(root.querySelector('[data-file-browser]').href, url('/api/files/content', 'paper.pdf', { browser: '1' }));
  assert.equal(root.querySelector('[data-file-copy]').hidden, true);
  panel.activateTab(''); assert.equal(pdf.hasAttribute('src'), false);
});

test('Android browser links target Edge with an encoded native localhost PDF fallback', async t => {
  const dom = new JSDOM('', { url: 'http://localhost:8080/', runScripts: 'outside-only' });
  const { window } = dom; t.after(() => window.close()); window.eval(await source('file-links.js'));
  const local = window.CodexFileLinks.content('project', '报告 #?;.pdf', true);
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Android Chrome/140' });
  const link = window.CodexFileLinks.browser(local);
  assert.match(link, /^intent:\/\/localhost:8080\/api\/files\/content\?/);
  assert.match(link, /;package=com\.microsoft\.emmx;/);
  const fallback = link.match(/;S\.browser_fallback_url=([^;]+);end$/)[1];
  assert.equal(decodeURIComponent(fallback), new URL(local, window.location.href).href);
  Object.defineProperty(window.navigator, 'userAgent', { value: 'Android EdgA/140' });
  assert.equal(window.CodexFileLinks.browser(local), new URL(local, window.location.href).href);
});

test('file expansion fills its panel by default, changes mode without reloading HTML, and exits cleanly', async t => {
  const dom = new JSDOM('<!doctype html><aside class="inspector"><section id="files"></section></aside>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom; t.after(() => window.close());
  window.eval(await source('files.js'));
  const root = window.document.getElementById('files'), host = root.closest('.inspector');
  const panel = new window.CodexFilePanel(root, { api: async () => ({ kind: 'html', text: '<h1>Hello</h1>', size: 14, modifiedAt: new Date().toISOString() }), notify() {} });
  panel.setProject({ id: 'p' }); await panel.openFile('page.html');
  const button = root.querySelector('[data-file-expand]'), frame = root.querySelector('iframe'), src = frame.src;
  button.click(); assert.equal(root.dataset.expandMode, 'panel'); assert.equal(root.classList.contains('file-expanded'), true);
  assert.equal(button.textContent, '收起'); assert.equal(button.getAttribute('aria-expanded'), 'true');
  panel.setExpandMode('fullscreen'); assert.equal(root.dataset.expandMode, 'fullscreen'); assert.equal(host.classList.contains('file-fullscreen-host'), true);
  assert.equal(root.querySelector('iframe'), frame); assert.equal(frame.src, src);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.classList.contains('file-expanded'), false); assert.equal(host.classList.contains('file-fullscreen-host'), false);
  assert.equal(window.document.activeElement, button); assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click(); panel.activateTab(''); assert.equal(root.classList.contains('file-expanded'), false);
  await panel.openFile('page.html'); button.click(); panel.setProject({ id: 'other' });
  assert.equal(root.classList.contains('file-expanded'), false); assert.equal(host.classList.contains('file-fullscreen-host'), false);
});

test('standalone HTML and PDF links use the same preview modes and native browser fallback', async t => {
  const { dir, base, project } = await fixture(t);
  await writeFile(path.join(dir, 'page.html'), '<h1>HTML</h1><script>bad()</script>');
  await writeFile(path.join(dir, 'paper.pdf'), '%PDF-1.7\n%%EOF');
  for (const file of ['page.html', 'paper.pdf']) {
    const href = base + '/file-preview.html?' + new URLSearchParams({ project: project.id, path: file });
    const dom = new JSDOM(await (await fetch(href)).text(), { url: href, runScripts: 'outside-only' });
    const { window } = dom; t.after(() => window.close());
    window.fetch = route => fetch(new URL(route, base));
    for (const script of window.document.querySelectorAll('script[src]')) window.eval(await (await fetch(script.src)).text());
    const get = id => window.document.getElementById(id);
    await until(() => !get('file-status').textContent.includes('正在读取'));
    if (file.endsWith('html')) {
      assert.match(get('file-content').querySelector('iframe').src, /\/api\/files\/html\?/);
      assert.equal(get('toggle-source').getAttribute('aria-pressed'), 'true'); get('toggle-source').click();
      assert.equal(get('file-content').querySelector('iframe'), null); assert.match(get('file-content').querySelector('pre').textContent, /<h1>HTML/);
      assert.equal(get('file-content').querySelector('script'), null);
    } else {
      assert.equal(get('toggle-source').hidden, true); assert.match(get('file-content').querySelector('iframe').src, /\/pdf-viewer\.html\?/);
      assert.equal(new URL(get('browser-file').href).searchParams.get('browser'), '1');
    }
  }
});

test('PDF reader paginates, zooms, reports errors and destroys resources on exit', async t => {
  const dom = new JSDOM(await source('pdf-viewer.html'), { url: 'http://localhost/pdf-viewer.html?project=p&path=paper.pdf', runScripts: 'outside-only' });
  const { window } = dom; t.after(() => window.close());
  window.eval(await source('file-links.js'));
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  Object.defineProperty(window.document.getElementById('viewport'), 'clientWidth', { value: 320 });
  const pages = [], scales = []; let destroyed = false, fail = false;
  const loading = { promise: Promise.resolve({ numPages: 3, async getPage(number) {
    pages.push(number);
    if (fail) throw new Error('broken page');
    return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      render({ viewport }) { scales.push(viewport.width); return { promise: Promise.resolve(), cancel() {} }; }, cleanup() {} };
  } }), async destroy() { destroyed = true; } };
  window.testPdfjs = { GlobalWorkerOptions: {}, getDocument: () => loading };
  const script = (await source('pdf-viewer.js')).replace("await import('/vendor/pdfjs/pdf.min.mjs')", 'window.testPdfjs');
  await window.eval(`(async () => { ${script}\n })()`);
  const get = id => window.document.getElementById(id);
  await until(() => get('status').textContent === '第 1 / 3 页');
  assert.equal(get('previous').disabled, true); get('next').click();
  await until(() => get('status').textContent === '第 2 / 3 页');
  get('page-number').value = '3'; get('page-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => get('status').textContent === '第 3 / 3 页'); assert.equal(get('next').disabled, true);
  const initial = scales.at(-1); get('zoom-in').click(); await until(() => scales.at(-1) > initial);
  get('fit-width').click(); await until(() => scales.at(-1) === initial);
  assert.ok(pages.includes(2)); fail = true; get('previous').click();
  await until(() => get('status').classList.contains('failed')); assert.match(get('status').textContent, /浏览器打开/);
  assert.equal(get('browser-file').hidden, false);
  window.dispatchEvent(new window.Event('pagehide')); assert.equal(destroyed, true); assert.equal(get('page').width, 0);
});
