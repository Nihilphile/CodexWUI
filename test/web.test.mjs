import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, readdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createApp } from '../server/index.mjs';
import { FakeCodex } from './helpers.mjs';
import { resourceLimits } from '../server/limits.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexwui-http-'));
  const codex = new FakeCodex(dir);
  const app = await createApp({ codex, initialProject: dir, dataDir: path.join(dir, 'data'), ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, data, options = {}) => {
    const response = await fetch(base + url, { ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), ...options });
    return { status: response.status, body: await response.json() };
  };
  const bootstrap = (await request('/api/bootstrap')).body;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, codex, base, request, project: bootstrap.projects[0], dir };
}
const until = async (predicate, description = 'condition') => {
  for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out waiting for ${description}`);
};

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
const withoutVisualizationGuide = input => input.filter(item => !item.text?.startsWith('[CodexWUI visualization instructions]\n'));

test('simultaneous sends reserve tablet capacity before async validation and resume after completion', async t => {
  const { request, project, codex } = await fixture(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await request('/api/threads', { project: project.id })).body.thread.id);
  const original = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method === 'thread/read') await new Promise(resolve => setTimeout(resolve, 40));
    return original(method, params);
  };
  const results = await Promise.all(ids.map(id => request(`/api/threads/${id}/send`, { text: 'work' })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 429]);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 2);
  const blocked = ids[results.findIndex(result => result.status === 429)];
  codex.complete(ids[results.findIndex(result => result.status === 200)]);
  assert.equal((await request(`/api/threads/${blocked}/send`, { text: 'retry' })).status, 200);
});

test('stop waits for completion, cleans descendants and pauses their queues while preserving another task', async t => {
  const { app, request, project, codex } = await fixture(t);
  const a = (await request('/api/threads', { project: project.id })).body.thread.id;
  const child = (await request('/api/threads', { project: project.id })).body.thread.id;
  const other = (await request('/api/threads', { project: project.id })).body.thread.id;
  codex.threads.get(child).parentThreadId = a;
  codex.event('thread/started', { thread: codex.threads.get(child) });
  await request(`/api/threads/${a}/send`, { text: 'parent' });
  await codex.request('turn/start', { threadId: child, input: [{ type: 'text', text: 'child' }] });
  await request(`/api/threads/${other}/send`, { text: 'other' });
  await request(`/api/threads/${a}/queue`, { text: 'do not launch after stop' });
  const original = codex.request.bind(codex);
  let acknowledged = false;
  codex.request = async (method, params) => {
    if (method === 'turn/interrupt' && params.threadId === a) {
      codex.calls.push({ method, params }); acknowledged = true; return {};
    }
    return original(method, params);
  };
  let settled = false;
  const stopping = request(`/api/threads/${a}/stop`, {}).then(result => { settled = true; return result; });
  await until(() => acknowledged);
  assert.equal(settled, false, 'RPC acknowledgement is not turn completion');
  codex.complete(a, 'interrupted');
  assert.equal((await stopping).status, 200);
  const cleaned = codex.calls.filter(call => call.method === 'thread/backgroundTerminals/clean').map(call => call.params.threadId);
  assert.deepEqual(new Set(cleaned), new Set([a, child]));
  assert.equal(app.live.get(other).activeTurnId, codex.threads.get(other).turns.at(-1).id);
  assert.equal((await request(`/api/threads/${a}/queue`)).body.paused, true);
});

test('idle cleanup skips active families, drops output cache and resumes released sessions before reuse', async t => {
  const limits = { ...resourceLimits({}), idleMs: 100 };
  const { app, request, project, codex } = await fixture(t, { limits });
  let time = 1000; app.lifecycle.now = () => time;
  const root = (await request('/api/threads', { project: project.id })).body.thread.id;
  const child = (await request('/api/threads', { project: project.id })).body.thread.id;
  codex.threads.get(child).parentThreadId = root;
  codex.event('thread/started', { thread: codex.threads.get(child) });
  await request(`/api/threads/${root}/send`, { text: 'parent' }); codex.complete(root);
  await codex.request('turn/start', { threadId: child, input: [] });
  time += 200; await app.lifecycle.sweep();
  assert.equal(codex.calls.some(call => call.method === 'thread/unsubscribe'), false);
  codex.complete(child); time += 200;
  await app.lifecycle.sweep();
  assert.deepEqual(new Set(codex.calls.filter(call => call.method === 'thread/unsubscribe').map(call => call.params.threadId)), new Set([root, child]));
  assert.equal(app.live.get(root).turns.size, 0);
  assert.equal((await request(`/api/threads/${root}/send`, { text: 'resume' })).status, 200);
  assert.ok(codex.calls.some(call => call.method === 'thread/resume' && call.params.threadId === root));
});

test('manual cleanup blocks new work until it finishes and cleanup failure retires the backend', async t => {
  const { app, request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const original = codex.request.bind(codex);
  let release;
  codex.request = async (method, params) => {
    if (method === 'thread/backgroundTerminals/clean') await new Promise(resolve => { release = resolve; });
    return original(method, params);
  };
  const cleaning = request(`/api/threads/${id}/cleanup`, {});
  await until(() => release);
  assert.equal((await request(`/api/threads/${id}/send`, { text: 'keep draft' })).status, 409);
  release(); assert.equal((await cleaning).status, 200);
  assert.equal((await request(`/api/threads/${id}/send`, { text: 'resume' })).status, 200);
  codex.complete(id);
  codex.request = async (method, params) => {
    if (method === 'thread/backgroundTerminals/clean') throw new Error('cleanup unavailable');
    return original(method, params);
  };
  assert.equal((await request(`/api/threads/${id}/cleanup`, {})).status, 500);
  assert.equal(codex.ready, false);
  assert.equal((await request('/api/resources')).status, 200);
  assert.equal(app.lifecycle.loaded.size, 0);
});

test('idle sweep discovers unsubscribed active subagents and stop obtains their real turn identities', async t => {
  const { app, request, project, codex } = await fixture(t, { limits: { ...resourceLimits({}), idleMs: 100 } });
  let time = 1000; app.lifecycle.now = () => time;
  const root = (await request('/api/threads', { project: project.id })).body.thread.id;
  codex.threads.set('silent-child', { id: 'silent-child', cwd: codex.cwd, parentThreadId: root,
    status: { type: 'active' }, turns: [{ id: 'silent-turn', status: 'inProgress', items: [] }] });
  time += 200; await app.lifecycle.sweep();
  assert.equal(codex.ready, true);
  assert.equal(codex.calls.some(call => call.method === 'thread/backgroundTerminals/clean'), false);
  assert.equal((await request(`/api/threads/${root}/stop`, {})).status, 200);
  const interrupt = codex.calls.find(call => call.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'silent-child', turnId: 'silent-turn' });
  assert.equal(app.live.get('silent-child').activeTurnId, null);
});

test('image uploads are bounded, same-origin and passed as real local images through send, steer and queue', async t => {
  const { request, base, project, codex, dir } = await fixture(t);
  const upload = (bytes = png, type = 'image/png', headers = {}) => request('/api/images', undefined, { method: 'POST', headers: { 'Content-Type': type, ...headers }, body: bytes });
  assert.equal((await upload(png, 'image/png', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload(Buffer.from('<svg></svg>'), 'image/svg+xml')).status, 415);
  assert.equal((await upload(Buffer.from('not an image'))).status, 415);
  assert.equal((await upload(png, 'image/jpeg')).status, 415);
  assert.equal((await upload(Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
  const result = await upload();
  assert.equal(result.status, 201);
  const image = result.body;
  const contents = await fetch(base + image.url);
  assert.equal(contents.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await contents.arrayBuffer()), png);
  assert.deepEqual(await readFile(path.join(dir, 'data/uploads', image.id)), png);
  assert.equal((await request(image.url, undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/images/%2Fetc%2Fpasswd')).status, 400);
  const large = await upload(Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
  assert.equal(large.status, 201); // Images do not pass through the 1 MiB JSON reader.
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  assert.equal((await request(`/api/threads/${id}/send`, { text: '' })).status, 400);
  for (const images of [['/etc/passwd'], ['https://example.com/x.png'], [null], 'bad', Array(5).fill(image.id)]) {
    assert.equal((await request(`/api/threads/${id}/send`, { text: '', images })).status, 400);
  }
  assert.equal((await request(`/api/threads/${id}/send`, { text: '', images: ['00000000-0000-0000-0000-000000000000.png'] })).status, 404);
  const sent = await request(`/api/threads/${id}/send`, { text: '', images: [image.id] });
  assert.equal(sent.status, 200);
  const expected = { type: 'localImage', path: path.join(dir, 'data/uploads', image.id) };
  assert.deepEqual(withoutVisualizationGuide(codex.calls.find(call => call.method === 'turn/start').params.input), [expected]);
  const steer = await request(`/api/threads/${id}/steer`, { text: 'look', images: [image.id], expectedTurnId: sent.body.turn.id });
  assert.equal(steer.status, 200);
  codex.boundary(id);
  await until(() => codex.calls.some(call => call.method === 'turn/steer'));
  assert.deepEqual(codex.calls.find(call => call.method === 'turn/steer').params.input[1], expected);
  const queued = await request(`/api/threads/${id}/queue`, { text: '', images: [image.id] });
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.body.entries[0].images, [image.id]);
  codex.complete(id);
  await until(() => codex.threads.get(id).turns.length === 2);
  assert.deepEqual(withoutVisualizationGuide(codex.threads.get(id).turns[1].items[0].content), [expected]);
});

test('browser keeps image drafts isolated during uploads and failures, and renders sent images in history', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  const originalFetch = window.fetch;
  let releaseUpload;
  window.fetch = async (url, options) => {
    if (url === '/api/images') await new Promise(resolve => { releaseUpload = resolve; });
    return originalFetch(url, options);
  };
  const selectImage = () => {
    Object.defineProperty($('image-input'), 'files', { configurable: true, value: [new File([png], '手机截图.png', { type: 'image/png' })] });
    $('image-input').dispatchEvent(new window.Event('change'));
  };
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  const first = [...codex.threads.values()][0];
  selectImage(); await until(() => releaseUpload);
  assert.equal($('send').disabled, true);
  $('new-thread').click(); await until(() => codex.threads.size === 2 && !$('new-thread').disabled);
  assert.equal($('image-attachments').hidden, true);
  releaseUpload(); window.fetch = originalFetch;
  await until(() => !$('send').disabled);
  window.document.querySelector(`[data-thread="${first.id}"]`).click();
  await until(() => $('image-attachments').querySelector('img') && !$('send').disabled);
  assert.match($('image-attachments').textContent, /手机截图/);
  window.fetch = async (url, options) => url.endsWith('/send') ? new Response(JSON.stringify({ error: 'test offline' }), { status: 503 }) : originalFetch(url, options);
  submit(''); await until(() => $('toast').textContent === 'test offline' && !$('send').disabled);
  assert.equal($('image-attachments').querySelectorAll('img').length, 1);
  assert.equal(first.turns.length, 0);
  window.fetch = originalFetch;
  submit(''); await until(() => first.turns.length === 1 && $('image-attachments').hidden);
  assert.equal(first.turns[0].items[0].content[0].type, 'localImage');
  await until(() => $('messages').querySelector('.message-image'));
  const source = $('messages').querySelector('.message-image').getAttribute('src');
  assert.match(source, /^\/api\/images\//);
  // Reloading history must reconstruct previews from the persisted localImage.
  const second = [...codex.threads.values()][1];
  window.document.querySelector(`[data-thread="${second.id}"]`).click();
  await until(() => !$('messages').querySelector('.message-image'));
  window.document.querySelector(`[data-thread="${first.id}"]`).click();
  await until(() => $('messages').querySelector('.message-image'));
  assert.equal($('messages').querySelector('.message-image').getAttribute('src'), source);
  selectImage(); await until(() => $('image-attachments').querySelector('img') && !$('send').disabled);
  $('send-mode').value = 'queue';
  submit('next picture'); await until(() => $('queue-list').textContent.includes('1 张图片'));
  assert.equal(first.turns.length, 1);
  codex.complete(first.id); await until(() => first.turns.length === 2);
  assert.equal(first.turns[1].items[0].content[1].type, 'localImage');
  selectImage(); await until(() => $('image-attachments').querySelector('img') && !$('send').disabled);
  $('image-attachments').querySelector('[data-remove-image]').click();
  await until(() => $('image-attachments').hidden);
  assert.deepEqual(errors, []);
});

test('image-only first message creates a thread, and upload failures can be removed and retried', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  const originalFetch = window.fetch;
  const choose = () => {
    Object.defineProperty($('image-input'), 'files', { configurable: true, value: [new File([png], 'first.png', { type: 'image/png' })] });
    $('image-input').dispatchEvent(new window.Event('change'));
  };
  window.fetch = async (url, options) => url === '/api/images' ? new Response(JSON.stringify({ error: 'Upload failed' }), { status: 500 }) : originalFetch(url, options);
  choose(); await until(() => $('image-attachments').textContent.includes('Upload failed'));
  assert.equal($('send').disabled, true);
  $('image-attachments').querySelector('[data-remove-image]').click();
  await until(() => $('image-attachments').hidden && !$('send').disabled);
  window.fetch = originalFetch;
  choose(); await until(() => $('image-attachments').querySelector('img') && !$('send').disabled);
  submit('');
  await until(() => codex.calls.some(call => call.method === 'turn/start') && $('image-attachments').hidden);
  assert.equal(codex.threads.size, 1);
  const input = withoutVisualizationGuide(codex.calls.find(call => call.method === 'turn/start').params.input);
  assert.equal(input.length, 1); assert.equal(input[0].type, 'localImage');
  // Returning to the unassigned project draft must not resurrect sent images.
  $('project-select').dispatchEvent(new window.Event('change'));
  await until(() => !$('send').disabled);
  assert.equal($('image-attachments').hidden, true);
  assert.deepEqual(errors, []);
});

test('file APIs remain read-only, rooted and same-origin even while Codex is disconnected', async t => {
  const { request, project, codex, dir, base } = await fixture(t);
  await writeFile(dir + '/raw.md', '# <script>raw</script>');
  await writeFile(dir + '/ 中文 #?.yaml ', '特殊文件名'); await writeFile(dir + '/ ', 'space');
  assert.equal((await request('/api/files/read', { project: project.id, path: 'raw.md' })).status, 404);
  codex.ready = false;
  const route = `/api/files/read?project=${project.id}&path=`;
  assert.equal((await request(`/api/files/list?project=${project.id}`)).status, 200);
  assert.equal((await request(route + 'raw.md')).body.text, '# <script>raw</script>');
  assert.equal((await request(route + encodeURIComponent(' 中文 #?.yaml '))).body.text, '特殊文件名');
  assert.equal((await request(route + '%20')).body.text, 'space');
  assert.equal((await request(`/api/files/read?project=${project.id}`)).status, 400);
  assert.equal((await request(route + '../secret')).status, 400);
  assert.equal((await request(route + '%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await request('/api/files/list?project=unknown')).status, 404);
  assert.equal((await request(route + 'raw.md', undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/files.js')).status, 200);
});

test('browser file previews serve local Markdown, images and downloads within the project', async t => {
  const { request, project, dir, base, codex } = await fixture(t);
  await mkdir(dir + '/docs');
  await writeFile(dir + '/docs/报告 #?.md', '# 报告\n\n**正文**');
  await writeFile(dir + '/plot.png', png);
  await writeFile(dir + '/code.html', '<script>alert(1)</script>');
  await symlink('/etc/passwd', dir + '/outside');
  codex.ready = false;
  const url = (route, file) => `${route}?project=${project.id}&path=${encodeURIComponent(file)}`;
  const preview = await request(url('/api/files/preview', dir + '/docs/报告 #?.md'));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.kind, 'markdown');
  assert.equal(preview.body.path, 'docs/报告 #?.md');
  assert.equal(preview.body.text, '# 报告\n\n**正文**');
  assert.equal((await request(url('/api/files/preview', 'docs/../plot.png'))).body.kind, 'image');
  const image = await fetch(base + url('/api/files/content', 'plot.png'));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.ok(image.headers.get('content-security-policy').includes('sandbox'));
  const download = await fetch(base + url('/api/files/content', 'docs/报告 #?.md') + '&download=1');
  assert.ok(download.headers.get('content-disposition').startsWith('attachment;'));
  assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent('报告 #?.md')));
  assert.equal((await fetch(base + url('/api/files/content', 'code.html'))).headers.get('content-type'), 'text/plain; charset=utf-8');
  for (const route of ['/api/files/preview', '/api/files/content']) {
    for (const file of ['../secret', '/etc/passwd', 'outside', dir + '-other/secret']) assert.equal((await request(url(route, file))).status, 403);
    assert.equal((await request(url(route, 'missing.md'))).status, 404);
    assert.equal((await request(url(route, 'plot.png'), undefined, { headers: { Origin: 'https://evil.example' } })).status, 403);
  }
  assert.equal((await fetch(base + '/file-preview.html')).status, 200);
});

test('file panel navigates with keyboard/touch and separates tab focus from activation', async t => {
  const { request, project, dir } = await fixture(t);
  await mkdir(dir + '/src'); await writeFile(dir + '/src/a.md', '# <img src=x onerror=alert(1)>\n原始文本');
  await writeFile(dir + '/src/b.yaml', 'enabled: true');
  const dom = new JSDOM('<section id="files"></section>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom; const doc = window.document;
  t.after(() => window.close());
  window.eval(await readFile(new URL('../public/files.js', import.meta.url), 'utf8'));
  let copied; Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  const root = doc.getElementById('files');
  const panel = new window.CodexFilePanel(root, { api: async url => {
    const response = await request(url); if (response.status !== 200) throw new Error(response.body.error); return response.body;
  }, notify: () => {} });
  const key = (element, name, extras = {}) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extras }));
  const tab = location => [...root.querySelectorAll('[data-file-tab]')].find(button => button.dataset.fileTab === location);
  panel.setProject(project); await panel.show();
  panel.list.focus(); key(panel.list, 'ArrowLeft'); assert.equal(panel.current.dir, '');
  panel.selectEntry('src'); key(panel.list, 'ArrowRight');
  await until(() => panel.current.dir === 'src' && !panel.current.loading);
  assert.equal(doc.activeElement, panel.list);
  key(panel.list, 'Home'); key(panel.list, 'ArrowUp'); assert.equal(panel.directory().selected, '..');
  key(panel.list, 'ArrowDown'); assert.equal(panel.directory().selected, 'src/a.md');
  panel.list.scrollTop = 32;
  key(panel.list, 'ArrowRight'); await until(() => panel.raw.textContent.includes('原始文本'));
  assert.equal(doc.activeElement, panel.raw); assert.equal(panel.raw.querySelector('img'), null);
  panel.raw.scrollTop = 60;
  key(panel.raw, 'Tab', { shiftKey: true }); assert.equal(doc.activeElement, tab('src/a.md'));
  key(doc.activeElement, 'ArrowLeft'); assert.equal(doc.activeElement, tab(''));
  assert.equal(panel.current.active, 'src/a.md'); assert.equal(tab('src/a.md').getAttribute('aria-selected'), 'true');
  key(doc.activeElement, 'Enter'); assert.equal(panel.current.active, ''); assert.equal(doc.activeElement, panel.list);
  assert.equal(panel.list.scrollTop, 32);
  key(panel.list, 'End'); key(panel.list, 'ArrowDown'); assert.equal(panel.directory().selected, 'src/b.yaml');
  root.querySelector('[data-file-entry="src/b.yaml"]').click(); await until(() => panel.raw.textContent === 'enabled: true');
  assert.equal(root.querySelectorAll('[role=tab]').length, 3);
  tab('src/a.md').click(); assert.equal(panel.raw.scrollTop, 60);
  assert.equal(doc.activeElement, tab('src/a.md'));
  key(doc.activeElement, 'ArrowRight'); assert.equal(panel.current.active, 'src/a.md');
  key(doc.activeElement, 'Enter'); assert.equal(panel.current.active, 'src/b.yaml'); assert.equal(doc.activeElement, panel.raw);
  root.querySelector('[data-file-wrap]').click(); assert.equal(panel.raw.classList.contains('wrap'), false);
  root.querySelector('[data-file-copy]').click(); await until(() => copied === 'enabled: true');
  await writeFile(dir + '/src/b.yaml', 'enabled: false');
  root.querySelector('[data-file-refresh-text]').click(); await until(() => panel.raw.textContent === 'enabled: false');
  const reading = panel.current;
  panel.setProject({ id: 'other', name: 'Other' }); assert.equal(panel.current.files.size, 0);
  panel.setProject(project); assert.equal(panel.current, reading); assert.equal(panel.current.active, 'src/b.yaml');
  assert.equal(panel.raw.classList.contains('wrap'), false);
  await panel.openFile('src/b.yaml'); assert.equal(root.querySelectorAll('[role=tab]').length, 3);
  tab('').click(); key(panel.list, 'ArrowLeft');
  await until(() => panel.current.dir === '' && !panel.current.loading);
  assert.equal(panel.directory().selected, 'src');
  tab('src/b.yaml').click(); key(doc.activeElement, 'Delete');
  assert.equal(panel.current.active, 'src/a.md'); assert.equal(root.querySelectorAll('[role=tab]').length, 2);
  root.querySelector('[data-file-close]').click(); assert.equal(panel.current.active, '');
});

test('late file/directory responses neither overwrite another project nor steal keyboard focus', async t => {
  const dom = new JSDOM('<section id="files"></section><textarea></textarea>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom; t.after(() => window.close());
  window.eval(await readFile(new URL('../public/files.js', import.meta.url), 'utf8'));
  const pending = []; const root = window.document.getElementById('files');
  const panel = new window.CodexFilePanel(root, { api: () => new Promise(resolve => pending.push(resolve)), notify: () => {} });
  const first = { id: 'one', name: 'One' }; const second = { id: 'two', name: 'Two' };
  panel.setProject(first); const navigation = panel.navigate('', { focus: true });
  window.document.querySelector('textarea').focus();
  pending.shift()({ entries: [{ name: 'a', path: 'a', type: 'file' }] }); await navigation;
  assert.equal(window.document.activeElement.tagName, 'TEXTAREA');
  const fileRequest = panel.openFile('a'); panel.closeFile('a');
  const reopened = panel.openFile('a');
  pending.shift()({ kind: 'text', text: 'stale', size: 5, modifiedAt: new Date().toISOString() }); await fileRequest;
  assert.notEqual(panel.raw.textContent, 'stale');
  panel.setProject(second);
  pending.shift()({ kind: 'text', text: 'current', size: 7, modifiedAt: new Date().toISOString() }); await reopened;
  assert.equal(panel.current.files.size, 0); assert.equal(root.querySelector('.file-text-pane').hidden, true);
  panel.setProject(first); assert.equal(panel.raw.textContent, 'current');
  const oldDirectory = panel.navigate('old'); const newDirectory = panel.navigate('new');
  pending.pop()({ entries: [{ name: 'new', path: 'new/new', type: 'file' }] }); await newDirectory;
  pending.shift()({ entries: [{ name: 'old', path: 'old/old', type: 'file' }] }); await oldDirectory;
  assert.equal(panel.current.dir, 'new'); assert.equal(panel.directory().entries[0].name, 'new');
});

test('history collapse gives chat and inspector equal widths and preserves the choice while navigating', async t => {
  const { window, $, codex, errors } = await browserFixture(t, undefined, window => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
  });
  const style = window.document.createElement('style');
  style.textContent = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  window.document.head.append(style);
  assert.equal($('sidebar').hidden, false);
  $('close-sidebar').click(); assert.equal($('sidebar').hidden, true);
  assert.equal($('open-sidebar').getAttribute('aria-expanded'), 'false');
  $('toggle-inspector').click(); assert.equal($('inspector').hidden, false);
  assert.equal(window.document.body.classList.contains('inspector-open'), true);
  assert.equal($('inspector-scrim').hidden, true);
  const css = window.getComputedStyle(window.document.querySelector('.workspace'));
  assert.equal(css.flexBasis, '50%'); assert.equal(css.width, '50%');
  assert.equal(window.getComputedStyle($('inspector')).flexBasis, '50%');
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  assert.equal($('sidebar').hidden, true, 'opening a conversation preserves the collapsed desktop list');
  window.innerWidth = 720; window.dispatchEvent(new window.Event('resize'));
  assert.equal($('inspector-scrim').hidden, true); assert.equal(window.getComputedStyle($('inspector')).position, 'relative');
  $('open-sidebar').click(); assert.equal($('sidebar').hidden, false); assert.equal($('inspector').hidden, true);
  assert.equal($('scrim').hidden, false);
  $('scrim').click(); assert.equal($('sidebar').hidden, true);
  $('toggle-inspector').click(); assert.equal($('inspector-scrim').hidden, true);
  $('close-inspector').click(); assert.equal(window.document.body.classList.contains('inspector-open'), false);
  assert.equal($('toggle-inspector').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);
});

test('file expansion follows live config and closing the workspace removes the expanded overlay', async t => {
  const { window, $, dir, errors } = await browserFixture(t, undefined, window => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  });
  await writeFile(path.join(dir, 'page.html'), '<h1>Hello</h1>');
  $('toggle-inspector').click();
  await until(() => $('files-view').querySelector('[data-file-entry="page.html"]'));
  $('files-view').querySelector('[data-file-entry="page.html"]').click();
  const root = $('files-view'); await until(() => !root.querySelector('.file-card-preview').hidden);
  const frame = root.querySelector('.file-card-preview'), src = frame.src;
  root.querySelector('[data-file-expand]').click(); assert.equal(root.classList.contains('file-expanded'), true);
  assert.equal(root.dataset.expandMode, 'panel');
  $('open-config').click(); await until(() => $('config-dialog').open && !$('config-form').querySelector('[data-config-save]').disabled);
  $('config-fileExpandMode').value = 'fullscreen'; $('config-form').querySelector('[data-config-save]').click();
  await until(() => root.dataset.expandMode === 'fullscreen');
  assert.equal($('inspector').classList.contains('file-fullscreen-host'), true);
  assert.equal(root.querySelector('.file-card-preview'), frame); assert.equal(frame.src, src);
  $('config-dialog').close();
  $('close-inspector').click(); assert.equal(root.classList.contains('file-expanded'), false);
  assert.equal($('inspector').classList.contains('file-fullscreen-host'), false);
  $('toggle-inspector').click(); root.querySelector('[data-file-expand]').click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(root.classList.contains('file-expanded'), false);
  assert.deepEqual(errors, []);
});

test('external links may navigate to the homepage but cannot access APIs or embed the app', async t => {
  const { base } = await fixture(t);
  const get = (route, headers) => new Promise((resolve, reject) => {
    http.get(base + route, { headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await get('/', navigation), 200);
  assert.equal(await get('/', { ...navigation, Origin: 'null' }), 200);
  assert.equal(await get('/', { ...navigation, Origin: 'https://chat.example' }), 200);
  assert.equal(await get('/api/bootstrap', navigation), 403);
  assert.equal(await get('/api/events', navigation), 403);
  assert.equal(await get('/', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await get('/', { ...navigation, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }), 403);
  assert.equal(await get('/api/bootstrap', { Origin: 'null' }), 403);
  assert.equal(await get('/', { ...navigation, Host: 'evil.example' }), 403);
});

test('HTTP boundaries reject cross-site requests, arbitrary hosts and invalid project paths', async t => {
  const { request, base, project } = await fixture(t);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/bootstrap', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/api/projects', { path: '/' }, { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await request('/api/projects', undefined, { method: 'POST', body: 'path=/' })).status, 415);
  assert.equal((await request('/api/projects', { path: '/this/path/does/not/exist' })).status, 400);
  assert.equal((await request('/api/git/diff?project=' + project.id + '&path=../secret')).status, 400);
  const page = await fetch(base + '/'); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/.data/projects.json')).status, 404);
});

test('independent turns, explicit steer identity, and backend follow-up queue', async t => {
  const { request, project, codex } = await fixture(t);
  const a = (await request('/api/threads', { project: project.id })).body.thread.id;
  const b = (await request('/api/threads', { project: project.id })).body.thread.id;
  const responses = await Promise.all([request(`/api/threads/${a}/send`, { text: 'A' }), request(`/api/threads/${b}/send`, { text: 'B' })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const turnId = responses[0].body.turn.id;
  assert.equal((await request(`/api/threads/${a}/steer`, { text: 'direction', expectedTurnId: 'stale' })).status, 409);
  assert.equal((await request(`/api/threads/${a}/steer`, { text: 'direction', expectedTurnId: turnId })).status, 200);
  await request(`/api/threads/${a}/queue`, { text: 'follow up' });
  assert.equal(codex.threads.get(a).turns.length, 1);
  codex.complete(a);
  await until(() => codex.threads.get(a).turns.length === 2, 'queued follow-up');
  assert.equal(codex.threads.get(b).turns[0].status, 'inProgress');
  await request(`/api/threads/${a}/queue`, { text: 'paused' });
  await request(`/api/threads/${a}/stop`, {});
  const queue = (await request(`/api/threads/${a}/queue`)).body;
  assert.equal(queue.paused, true); assert.equal(queue.entries[0].text, 'paused');
});

test('structured skill inputs are validated against the project skill list', async t => {
  const { request, project, codex, dir } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  assert.equal((await request(`/api/threads/${id}/send`, { text: 'use', skills: [{ name: 'unknown', path: '/secret' }] })).status, 400);
  assert.equal((await request(`/api/threads/${id}/send`, { text: '$example help', skills: [{ name: 'example', path: dir + '/SKILL.md' }] })).status, 200);
  const input = codex.calls.find(c => c.method === 'turn/start').params.input;
  assert.deepEqual(input[1], { type: 'skill', name: 'example', path: dir + '/SKILL.md' });
});

test('model settings validate catalog efforts and affect only future turns of the selected thread', async t => {
  const { request, project, codex } = await fixture(t);
  const a = (await request('/api/threads', { project: project.id })).body.thread.id;
  const b = (await request('/api/threads', { project: project.id })).body.thread.id;
  const catalog = (await request('/api/models')).body.models;
  assert.equal(catalog.length, 2); // The picker must include every catalog page.
  assert.equal((await request(`/api/threads/${a}/model`, { model: 'test-deep', effort: 'low' })).status, 400);
  assert.equal((await request(`/api/threads/${a}/model`, { model: 'invented', effort: 'high' })).status, 400);
  await request(`/api/threads/${a}/send`, { text: 'first' });
  const response = await request(`/api/threads/${a}/model`, { model: 'test-deep', effort: 'ultra' });
  assert.equal(response.status, 200);
  assert.equal(response.body.thread.reasoningEffort, 'ultra');
  assert.equal(codex.threads.get(a).turns[0].model, 'test-fast');
  assert.equal(codex.threads.get(b).model, 'test-fast');
  await request(`/api/threads/${a}/queue`, { text: 'next' }); codex.complete(a);
  await until(() => codex.threads.get(a).turns.length === 2);
  assert.equal(codex.threads.get(a).turns[1].model, 'test-deep');
  assert.equal(codex.threads.get(a).turns[1].effort, 'ultra');
  const updates = codex.calls.filter(c => c.method === 'thread/settings/update');
  assert.deepEqual(updates[0].params, { threadId: a, model: 'test-deep', effort: 'ultra' });
  codex.threads.get(b).parentThreadId = a;
  assert.equal((await request(`/api/threads/${b}/model`, { model: 'test-deep', effort: 'high' })).status, 409);
});

test('snapshot combines persisted history, live partial output and pending approvals', async t => {
  const { request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const started = await request(`/api/threads/${id}/send`, { text: 'hello' });
  codex.event('item/agentMessage/delta', { threadId: id, turnId: started.body.turn.id, itemId: 'answer', delta: 'partial' });
  codex.approvals.set('7', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: id, command: 'test' } });
  const snapshot = (await request(`/api/threads/${id}`)).body;
  assert.ok(snapshot.eventSequence > 0);
  assert.equal(snapshot.live.turns[0].items.at(-1).text, 'partial');
  assert.equal(snapshot.approvals.length, 1);
  await request('/api/approvals', { id: '7', decision: 'decline' });
  assert.deepEqual(codex.lastResponse.result, { decision: 'decline' });
});

async function browserFixture(t, existing, configureWindow) {
  const f = existing || await fixture(t);
  const { base, codex, dir } = f;
  const errors = [];
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const html = await (await fetch(base + '/')).text();
  const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const sources = [];
  window.fetch = (url, options) => fetch(new URL(url, base), options);
  window.AbortSignal = AbortSignal;
  window.AbortController = AbortController; // Match the Node fetch implementation used by this fixture.
  window.EventSource = class {
    constructor(url) {
      this.controller = new AbortController(); sources.push(this);
      void (async () => {
        try {
          const response = await fetch(base + url, { signal: this.controller.signal });
          let buffer = ''; const decoder = new TextDecoder();
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = block.split('\n').find(line => line.startsWith('data: '));
              const id = block.split('\n').find(line => line.startsWith('id: '));
              if (data) this.onmessage?.({ data: data.slice(6), lastEventId: id?.slice(4) || '' });
            }
          }
        } catch (error) { if (error.name !== 'AbortError') this.onerror?.(error); }
      })();
    }
    close() { this.controller.abort(); }
  };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  t.after(() => { for (const source of sources) source.close(); window.close(); });
  configureWindow?.(window);
  // Follow the served page's declarations so missing dependencies fail here
  // exactly as they do in the browser, before bootstrap can connect.
  for (const script of window.document.querySelectorAll('script[src]')) {
    const response = await fetch(script.src);
    assert.equal(response.status, 200, `script ${script.src}`);
    window.eval(await response.text());
  }
  const $ = id => window.document.getElementById(id);
  const submit = (text = '') => { $('prompt').value = text; $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  await until(() => $('project-select').options.length === 1 && $('connection-label').textContent === 'Codex 已连接', 'bootstrap');
  return { ...f, window, $, submit, errors };
}

test('conversation initially renders five turns and reveals earlier turns on upward scroll without moving the reader', async t => {
  const { window, $, request, project, codex, errors, app } = await browserFixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  codex.threads.get(id).turns = Array.from({ length: 12 }, (_, index) => ({
    id: `history-${index + 1}`, status: 'completed', items: [
      { id: `question-${index + 1}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${index + 1}` }] },
      { id: `answer-${index + 1}`, type: 'agentMessage', text: `Answer ${index + 1}` },
    ],
  }));
  const artifact = await app.visualizations.publish(project.path, { type: 'html', content: '<button>Keep interaction</button>', title: 'History interaction' });
  codex.threads.get(id).turns[9].items.push({ id: 'history-viz', type: 'mcpToolCall', server: 'codexwui_visualize', tool: 'visualize', status: 'completed', result: { structuredContent: artifact } });
  const scroller = $('message-scroll');
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, get: () => $('messages').querySelectorAll('.message.user').length * 100 }, clientHeight: { configurable: true, value: 200 } });
  await window.selectThread(id);
  await until(() => $('messages').textContent.includes('Answer 12'));
  await until(() => $('messages').querySelector('iframe'));
  const frame = $('messages').querySelector('iframe');
  assert.equal($('messages').querySelectorAll('.message.user').length, 5);
  assert.equal($('messages').textContent.includes('Answer 7'), false);
  assert.equal($('more-turns').hidden, false);
  scroller.scrollTop = 20; scroller.dispatchEvent(new window.Event('scroll'));
  await until(() => $('messages').querySelectorAll('.message.user').length === 10);
  assert.equal(scroller.scrollTop, 520, 'prepended turns must preserve the reader position');
  assert.equal($('messages').querySelector('iframe'), frame);
  $('more-turns').click();
  await until(() => $('messages').querySelectorAll('.message.user').length === 12);
  assert.equal($('more-turns').hidden, true);
  scroller.scrollTop = 200;
  await request(`/api/threads/${id}/send`, { text: 'New turn while reading history' });
  await until(() => $('messages').textContent.includes('New turn while reading history'));
  assert.equal(scroller.scrollTop, 200);
  assert.ok($('messages').textContent.includes('Answer 1'));
  assert.equal($('messages').querySelector('iframe'), frame);
  assert.deepEqual(errors, []);
});

test('older-turn requests are deduplicated and cannot replace the conversation selected while loading', async t => {
  const { window, $, request, project, codex, errors } = await browserFixture(t);
  const a = (await request('/api/threads', { project: project.id })).body.thread.id;
  const b = (await request('/api/threads', { project: project.id })).body.thread.id;
  const history = Array.from({ length: 30 }, (_, index) => ({ id: `page-${index}`, status: 'completed', items: [{ id: `page-answer-${index}`, type: 'agentMessage', text: `Paged answer ${index}` }] }));
  codex.threads.get(a).turns = history;
  const original = codex.request.bind(codex); let release, pages = 0;
  codex.request = async (method, params) => {
    if (method === 'thread/turns/list' && params.threadId === a) {
      if (params.cursor) { pages++; await new Promise(resolve => { release = resolve; }); }
      const offset = Number(params.cursor || 0), all = [...history].reverse();
      return { data: all.slice(offset, offset + params.limit), nextCursor: offset + params.limit < all.length ? String(offset + params.limit) : null };
    }
    return original(method, params);
  };
  await window.selectThread(a);
  await until(() => $('messages').querySelectorAll('.message.assistant').length === 5);
  for (const count of [10, 15, 20]) { $('more-turns').click(); await until(() => $('messages').querySelectorAll('.message.assistant').length === count); }
  assert.equal(pages, 0, 'cached turns must be revealed before requesting another page');
  $('more-turns').click(); await until(() => release);
  $('message-scroll').dispatchEvent(new window.WheelEvent('wheel', { deltaY: -10 }));
  await window.selectThread(b); await until(() => !$('messages').textContent.includes('Paged answer'));
  release(); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(pages, 1);
  assert.equal($('messages').textContent.includes('Paged answer'), false);
  await window.selectThread(a); await until(() => $('messages').textContent.includes('Paged answer 5'));
  assert.equal($('messages').querySelectorAll('.message.assistant').length, 25, 'a fetched page reveals only the next five turns');
  assert.deepEqual(errors, []);
});

test('BTW history pages stop at the fork boundary across more than one hundred side turns', async t => {
  const { request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  await request(`/api/threads/${parent}/send`, { text: 'Inherited parent question' }); codex.complete(parent);
  const record = (await request(`/api/btw/${parent}/open`, {})).body.session;
  const side = codex.threads.get(record.threadId);
  side.turns.push(...Array.from({ length: 115 }, (_, index) => ({ id: `paged-side-${index}`, status: 'completed', items: [{ id: `paged-side-answer-${index}`, type: 'agentMessage', text: `Side answer ${index}` }] })));
  const original = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method === 'thread/turns/list' && params.threadId === side.id) {
      const offset = Number(params.cursor || 0), all = [...side.turns].reverse(), data = all.slice(offset, offset + params.limit);
      return { data: params.itemsView === 'notLoaded' ? data.map(turn => ({ ...turn, items: [] })) : data, nextCursor: offset + params.limit < all.length ? String(offset + params.limit) : null };
    }
    return original(method, params);
  };
  const first = (await request(`/api/btw/${parent}?session=${record.id}`)).body;
  assert.equal(first.history.data.length, 100); assert.equal(first.history.nextCursor, '100');
  const older = await request(`/api/btw/${parent}?session=${record.id}&cursor=${first.history.nextCursor}`);
  assert.equal(older.status, 200); assert.equal(older.body.history.data.length, 15);
  assert.equal(older.body.history.nextCursor, null);
  assert.ok(older.body.history.data.every(turn => turn.id.startsWith('paged-side-')));
});

test('main and BTW stream concurrently with independent five-turn windows and render scheduling', async t => {
  const { window, $, request, project, codex, submit, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  const parent = [...codex.threads.keys()][0];
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  const sessionId = $('btw-select').value;
  await request(`/api/threads/${parent}/send`, { text: 'Main question' });
  const sent = await request(`/api/btw/${parent}/send`, { sessionId, text: 'Side question' });
  const side = [...codex.threads.keys()].find(id => id !== parent), mainTurn = codex.threads.get(parent).turns.at(-1);
  const sideTurn = codex.threads.get(side).turns.at(-1);
  assert.equal(sent.status, 200);
  const seeded = Array.from({ length: 8 }, (_, index) => ({ id: `side-history-${index}`, status: 'completed', items: [{ id: `side-old-${index}`, type: 'agentMessage', text: `Side history ${index}` }] }));
  codex.threads.get(side).turns.unshift(...seeded);
  $('btw-select').dispatchEvent(new window.Event('change'));
  await until(() => $('messages').textContent.includes('Main question') && $('btw-messages').textContent.includes('Side history 7'));
  assert.equal($('btw-messages').querySelectorAll('[data-btw-bring]').length, 4, 'only four completed side turns plus the active turn are initially visible');
  await new Promise(resolve => setTimeout(resolve, 180));
  let mainRenders = 0, sideRenders = 0;
  const renderMain = window.renderMessages, renderSide = window.CodexBtwPanel.prototype.render;
  window.renderMessages = () => { mainRenders++; return renderMain(); };
  window.CodexBtwPanel.prototype.render = function (...args) { sideRenders++; return renderSide.apply(this, args); };
  const delta = (threadId, turnId, itemId, text) => codex.event('item/agentMessage/delta', { threadId, turnId, itemId, delta: text });
  for (let index = 0; index < 20; index++) delta(side, sideTurn.id, 'side-live', `side${index} `);
  await until(() => $('btw-messages').textContent.includes('side19'));
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(mainRenders, 0, 'side output must not redraw the main conversation');
  assert.ok(sideRenders <= 2, 'side deltas must be batched');
  mainRenders = 0; sideRenders = 0;
  for (let index = 0; index < 20; index++) delta(parent, mainTurn.id, 'main-live', `main${index} `);
  await until(() => $('messages').textContent.includes('main19'));
  assert.equal(sideRenders, 0, 'main output must not redraw BTW');
  assert.ok(mainRenders <= 2);
  delta(side, sideTurn.id, 'side-live', 'Side simultaneous');
  delta(parent, mainTurn.id, 'main-live', 'Main simultaneous');
  await until(() => $('btw-messages').textContent.includes('Side simultaneous') && $('messages').textContent.includes('Main simultaneous'));
  $('btw-messages').scrollTop = 0; $('btw-messages').dispatchEvent(new window.WheelEvent('wheel', { deltaY: -10 }));
  await until(() => $('btw-messages').textContent.includes('Side history 0'));
  assert.equal($('messages').querySelectorAll('.message.user').length, 1);
  assert.deepEqual(errors, []);
});

test('visualize renders HTML, Markdown and images in tool positions while hiding calls and preserving mounted frames', async t => {
  const { app, window, $, submit, codex, project, request, dir, errors } = await browserFixture(t);
  submit('展示交互解释');
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const thread = [...codex.threads.values()][0], turn = thread.turns.at(-1);
  await writeFile(path.join(dir, 'plot.png'), png);
  const html = await app.visualizations.publish(project.path, { type: 'html', title: '轨道模拟', content: '<button>HTML SOURCE</button>' });
  const md = await app.visualizations.publish(project.path, { type: 'markdown', title: '说明', content: '# 标题\n\n$x^2$\n\n<script>unsafe()</script>' });
  const image = await app.visualizations.publish(project.path, { type: 'image', path: 'plot.png', title: '轨道图' });
  for (const [index, artifact] of [html, md, image].entries()) {
    const item = { id: `visual-${index}`, type: 'mcpToolCall', server: index === 0 ? 'codexweb_visualize' : 'codexwui_visualize', tool: 'visualize', status: 'completed', arguments: { type: artifact.type, content: 'HTML SOURCE' }, result: { structuredContent: artifact } };
    turn.items.push(item); codex.event('item/completed', { threadId: thread.id, turnId: turn.id, item });
  }
  await until(() => $('messages').querySelector('iframe') && $('messages').querySelector('.visualization-content h1') && $('messages').querySelector('.visualization-content img'));
  const frame = $('messages').querySelector('iframe');
  assert.equal($('messages').querySelectorAll('.visualization-card').length, 3);
  assert.ok($('messages').querySelector('.visualization-content .katex'));
  assert.equal($('messages').querySelector('.visualization-content script'), null);
  assert.ok(!$('messages').textContent.includes('codexwui_visualize'));
  assert.ok(!$('messages').textContent.includes('HTML SOURCE'));
  assert.ok(!$('messages').textContent.includes('CodexWUI visualization instructions'));
  const answer = { id: 'answer-after-visualize', type: 'agentMessage', text: '' };
  turn.items.push(answer); codex.event('item/started', { threadId: thread.id, turnId: turn.id, item: answer });
  codex.event('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: answer.id, delta: '这是解释文字。' });
  await until(() => $('messages').textContent.includes('这是解释文字。'));
  assert.equal($('messages').querySelector('iframe'), frame);
  const snapshot = (await request(`/api/threads/${thread.id}`)).body;
  assert.equal(snapshot.history.data[0].items.find(item => item.id === 'visual-0').arguments.content, undefined);
  codex.complete(thread.id);
  const other = (await request('/api/threads', { project: project.id })).body.thread.id;
  await request(`/api/threads/${other}/send`, { text: 'another' });
  await until(() => window.document.querySelector(`[data-thread="${other}"]`));
  window.document.querySelector(`[data-thread="${other}"]`).click();
  await until(() => !$('messages').querySelector('iframe'));
  window.document.querySelector(`[data-thread="${thread.id}"]`).click();
  await until(() => $('messages').querySelector('iframe'));
  assert.notEqual($('messages').querySelector('iframe'), frame);
  assert.equal($('messages').querySelectorAll('.visualization-card').length, 3);
  assert.deepEqual(errors, []);
});

test('a silently stalled stream catches up in the active conversation without switching threads', async t => {
  const f = await fixture(t);
  let stalled = false, now = Date.now(), sourceCount = 0; const polls = [];
  const { window, $, submit, codex, errors } = await browserFixture(t, f, window => {
    window.Date.now = () => now;
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, ms, ...args) => { polls.push(callback); return interval(() => {}, ms, ...args); };
    const Source = window.EventSource;
    window.EventSource = class extends Source {
      constructor(url) { super(url); if (++sourceCount > 1) stalled = false; }
      set onmessage(callback) { super.onmessage = event => { if (!stalled) callback(event); }; }
      get onmessage() { return super.onmessage; }
    };
  });
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  const a = [...codex.threads.values()][0];
  submit('keep streaming'); await until(() => a.turns.length === 1 && !$('send').disabled);
  const emit = delta => codex.event('item/agentMessage/delta', { threadId: a.id, turnId: a.turns[0].id, itemId: 'streamed-answer', delta });
  emit('before stall'); await until(() => $('messages').textContent.includes('before stall'));
  $('prompt').value = 'draft stays here';
  stalled = true; emit(' / output during stall');
  assert.ok(f.app.live.snapshot(a.id).turns[0].items.some(item => item.text?.includes('output during stall')));
  $('new-thread').click(); await until(() => codex.threads.size === 2 && !$('new-thread').disabled);
  $('thread-list').querySelector(`[data-thread="${a.id}"]`).click();
  await until(() => $('messages').textContent.includes('output during stall'), 'switching away and back catches up');
  emit(' / stalled again');
  now += 30000;
  for (const poll of polls) poll();
  await until(() => $('messages').textContent.includes('stalled again'), 'active stream recovery without switching');
  await until(() => sourceCount > 1, 'restart a confirmed stale stream');
  emit(' / streaming resumed');
  await until(() => $('messages').textContent.includes('streaming resumed'), 'new deltas after recovery');
  assert.equal($('prompt').value, 'draft stays here');
  assert.deepEqual(errors, []);
});

test('returning to the foreground recovers missed completion even after a stream error', async t => {
  let hidden = false, stalled = false, source, now = Date.now(); const polls = [];
  const { window, $, submit, codex, errors } = await browserFixture(t, undefined, window => {
    Object.defineProperty(window.document, 'hidden', { get: () => hidden });
    window.Date.now = () => now;
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, ms) => { polls.push(callback); return interval(() => {}, ms); };
    const Source = window.EventSource;
    window.EventSource = class extends Source {
      constructor(url) { super(url); source = this; }
      set onmessage(callback) { super.onmessage = event => { if (!stalled) callback(event); }; }
      get onmessage() { return super.onmessage; }
    };
  });
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  const a = [...codex.threads.values()][0];
  submit('keep going'); await until(() => a.turns.length === 1 && !$('send').disabled);
  $('prompt').value = 'unfinished draft';
  hidden = true; window.document.dispatchEvent(new window.Event('visibilitychange'));
  stalled = true; source.onerror(new Error('network paused'));
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal($('connection-label').textContent, 'Codex 已连接', 'hidden pages defer DOM updates until they become visible');
  const answer = { id: 'finished-answer', type: 'agentMessage', text: 'finished while backgrounded' };
  a.turns[0].items.push(answer); codex.complete(a.id);
  const readsBefore = codex.calls.filter(call => call.method === 'thread/read').length;
  now += 30000; for (const poll of polls) poll();
  assert.equal(codex.calls.filter(call => call.method === 'thread/read').length, readsBefore);
  hidden = false;
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('online'));
  await until(() => $('messages').textContent.includes(answer.text) && $('connection-label').textContent === 'Codex 已连接');
  assert.equal($('stop-turn').hidden, true);
  assert.equal($('prompt').value, 'unfinished draft');
  assert.equal(codex.calls.filter(call => call.method === 'thread/read').length, readsBefore + 1);
  assert.deepEqual(errors, []);
});

test('background snapshots preserve older pages, scroll and deltas received while the snapshot is in flight', async t => {
  const f = await fixture(t), { codex, project } = f;
  const { thread: a } = await codex.request('thread/start', { cwd: project.path });
  a.name = 'A';
  a.turns = [
    { id: 'older', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'older page stays visible' }] },
    { id: 'recent', status: 'completed', items: [{ id: 'recent-answer', type: 'agentMessage', text: 'recent page' }] },
    { id: 'active', status: 'inProgress', items: [{ id: 'live-answer', type: 'agentMessage', text: 'before snapshot' }] },
  ];
  const original = codex.request.bind(codex);
  codex.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/turns/list' && params.threadId === a.id) return params.cursor ?
      { data: [a.turns[0]], nextCursor: null } : { data: a.turns.slice(-2).reverse(), nextCursor: 'older' };
    return result;
  };
  let hold = false, release;
  const { window, $, errors } = await browserFixture(t, f, window => {
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      const response = await fetch(url, options);
      if (hold && url === `/api/threads/${a.id}`) {
        hold = false;
        const snapshot = await response.json(); snapshot.thread.name = 'snapshot applied';
        await new Promise(resolve => { release = resolve; });
        return new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
  });
  await until(() => $('thread-list').querySelector(`[data-thread="${a.id}"]`));
  $('thread-list').querySelector(`[data-thread="${a.id}"]`).click();
  await until(() => $('messages').textContent.includes('before snapshot'));
  $('more-turns').click(); await until(() => $('messages').textContent.includes('older page stays visible'));
  const scroller = $('message-scroll');
  Object.defineProperty(scroller, 'scrollHeight', { value: 10000 });
  Object.defineProperty(scroller, 'clientHeight', { value: 500 });
  scroller.scrollTop = 300; $('prompt').value = 'draft survives synchronization';
  hold = true; window.dispatchEvent(new window.Event('focus')); await until(() => release);
  codex.event('item/agentMessage/delta', { threadId: a.id, turnId: 'active', itemId: 'live-answer', delta: ' / newer delta' });
  await until(() => $('messages').textContent.includes('newer delta'));
  release(); await until(() => $('thread-title').textContent === 'snapshot applied');
  assert.ok($('messages').textContent.includes('older page stays visible'));
  assert.ok($('messages').textContent.includes('before snapshot / newer delta'));
  assert.equal($('messages').textContent.match(/newer delta/g).length, 1);
  assert.equal($('more-turns').hidden, true);
  assert.equal(scroller.scrollTop, 300);
  assert.equal($('prompt').value, 'draft survives synchronization');
  assert.deepEqual(errors, []);
});

test('a hung recovery read times out, coalesces focus events and permits a later retry', async t => {
  let hold = false, attempts = 0, aborted = false, deadline;
  const { window, $, submit, codex, errors } = await browserFixture(t, undefined, window => {
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => {
      if (ms === 8000) deadline = callback;
      return timeout(callback, ms, ...args);
    };
    const fetch = window.fetch;
    window.fetch = (url, options) => {
      if (hold && /^\/api\/threads\/[^/]+$/.test(url)) {
        attempts++;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
          aborted = true; reject(new Error('read aborted'));
        }, { once: true }));
      }
      return fetch(url, options);
    };
  });
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  const a = [...codex.threads.values()][0];
  submit('run'); await until(() => a.turns.length === 1 && !$('send').disabled);
  $('prompt').value = 'draft during slow read';
  hold = true;
  window.dispatchEvent(new window.Event('focus')); window.dispatchEvent(new window.Event('focus'));
  await until(() => attempts === 1);
  deadline(); await until(() => aborted);
  hold = false; a.name = 'fresh snapshot after timeout';
  window.dispatchEvent(new window.Event('focus'));
  await until(() => $('thread-title').textContent === a.name);
  assert.equal(attempts, 1);
  assert.equal($('prompt').value, 'draft during slow read');
  assert.deepEqual(errors, []);
});

test('StudyCard archives only enabled turns and file endpoints preview HTML in an isolated sandbox', async t => {
  const { app, request, project, codex, dir, base } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const feature = `/api/threads/${id}/studycard`;
  assert.equal((await request(feature)).body.studycard.enabled, false);
  assert.equal((await request(feature, { enabled: 'yes' })).status, 400);
  assert.equal((await request(feature, { enabled: true })).status, 200);
  await request(`/api/threads/${id}/send`, { text: '讲讲 Python 列表' });
  const sent = codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input;
  assert.equal(sent[0].text, '讲讲 Python 列表');
  assert.match(sent.at(-1).text, /StudyCard: <知识路径>/);
  const turn = codex.threads.get(id).turns.at(-1);
  // Production completion events may have no items: consume item/completed.
  codex.event('item/completed', { threadId: id, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'StudyCard: Python语法/容器/list\n\n# list\n完整正文。' } });
  codex.complete(id); await app.studycards.close();
  const snapshot = (await request(`/api/threads/${id}`)).body.studycard;
  assert.equal(snapshot.results[0].status, 'saved');
  const relative = snapshot.results[0].path;
  const source = await readFile(path.join(dir, relative), 'utf8');
  assert.match(source, /<h1>list<\/h1>\n<p>完整正文。<\/p>/);
  const listed = await request(`/api/files/list?project=${project.id}&path=StudyCard/Python语法/容器`);
  assert.equal(listed.body.entries[0].name, 'list.html');
  const preview = await request(`/api/files/preview?project=${project.id}&path=${encodeURIComponent(relative)}`);
  assert.equal(preview.body.kind, 'studycard');
  const runtime = await fetch(`${base}/api/files/studycard?project=${project.id}&path=${encodeURIComponent(relative)}`);
  assert.equal(runtime.status, 200);
  assert.match(runtime.headers.get('content-type'), /text\/html/);
  assert.match(runtime.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.doesNotMatch(runtime.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal(await runtime.text(), source);
  const legacy = source.replace('CodexWUI StudyCard v1', 'CodexWeb StudyCard v1');
  await writeFile(path.join(dir, 'StudyCard/legacy.html'), legacy);
  assert.equal((await request(`/api/files/preview?project=${project.id}&path=StudyCard/legacy.html`)).body.kind, 'studycard');
  const legacyRuntime = await fetch(`${base}/api/files/studycard?project=${project.id}&path=StudyCard/legacy.html`);
  assert.equal(legacyRuntime.status, 200);
  assert.equal(await legacyRuntime.text(), legacy);
  await writeFile(path.join(dir, 'ordinary.html'), '<script>unsafe()</script>');
  assert.equal((await request(`/api/files/studycard?project=${project.id}&path=ordinary.html`)).status, 400);
  await writeFile(path.join(dir, 'StudyCard/not-a-card.html'), '<script>unsafe()</script>');
  assert.equal((await request(`/api/files/studycard?project=${project.id}&path=StudyCard/not-a-card.html`)).status, 400);
  assert.equal((await request(feature, { enabled: false }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } })).status, 403);
});

test('StudyCard snapshots switches at dispatch, refreshes the tree for follow-ups and leaves active steers unchanged', async t => {
  const { app, request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const other = (await request('/api/threads', { project: project.id })).body.thread.id;
  const feature = `/api/threads/${id}/studycard`;
  await request(feature, { enabled: true });
  await request(`/api/threads/${id}/send`, { text: 'first' });
  let turn = codex.threads.get(id).turns.at(-1);
  await request(`/api/threads/${id}/queue`, { text: 'follow-up' });
  codex.event('item/completed', { threadId: id, turnId: turn.id, item: { type: 'agentMessage', phase: 'final_answer', text: 'StudyCard: Python/list\n\nfirst answer' } });
  codex.complete(id);
  await until(() => codex.threads.get(id).turns.length === 2);
  assert.match(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input.at(-1).text, /"list.html"/);
  await request(`/api/threads/${id}/queue`, { text: 'after stop' });
  await request(feature, { enabled: false });
  turn = codex.threads.get(id).turns.at(-1);
  await request(`/api/threads/${id}/steer`, { text: 'still same turn', expectedTurnId: turn.id });
  codex.boundary(id); await until(() => codex.calls.some(call => call.method === 'turn/steer'));
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').at(-1).params.input.length, 1);
  turn.items.push({ id: 'second-answer', type: 'agentMessage', phase: 'final_answer', text: 'StudyCard: Python/list\n\nsecond answer' });
  codex.complete(id);
  await until(() => codex.threads.get(id).turns.length === 3);
  const notice = codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input;
  assert.match(notice.at(-1).text, /StudyCard 功能已关闭/);
  assert.doesNotMatch(notice.at(-1).text, /现有目录树/);
  assert.equal(app.studycards.snapshot(id).results.length, 2, 'stop did not change the in-flight turn');
  codex.threads.get(id).turns.at(-1).items.push({ id: 'ignored', type: 'agentMessage', text: 'StudyCard: 不应保存\n\nignored' });
  codex.complete(id);
  await request(`/api/threads/${id}/send`, { text: 'normal' });
  assert.equal(withoutVisualizationGuide(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input).length, 1);
  await request(`/api/threads/${other}/send`, { text: 'independent' });
  assert.equal(withoutVisualizationGuide(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input).length, 1);
  assert.equal(app.studycards.snapshot(id).results.length, 2);
  codex.threads.get(other).parentThreadId = id;
  assert.equal((await request(`/api/threads/${other}/studycard`, { enabled: true })).status, 409);
});

test('StudyCard is restored with enabled switches after a Web service restart', async t => {
  const { app, codex, dir, project } = await fixture(t);
  const { thread } = await codex.request('thread/start', { cwd: project.path });
  await app.studycards.set(thread.id, project.path, true);
  await app.close();
  const restored = await createApp({ codex: new FakeCodex(dir), initialProject: dir, dataDir: path.join(dir, 'data') });
  t.after(() => restored.close());
  assert.equal(restored.studycards.snapshot(thread.id).enabled, true);
  assert.match((await restored.studycards.prepare(thread.id, project.path)).input.text, /现有目录树/);
});

test('browser StudyCard commands, hidden host instructions, archive links and existing file panel work together', async t => {
  const { app, codex, request, window, $, submit, errors } = await browserFixture(t);
  $('prompt').value = '/studyc'; $('prompt').dispatchEvent(new window.Event('input'));
  assert.ok($('suggestions').querySelector('[data-command="StudyCard --stop"]'));
  submit('/StudyCard');
  await until(() => $('breadcrumb').textContent.includes('StudyCard 已开启'));
  const thread = [...codex.threads.values()][0], id = thread.id;
  assert.equal(codex.calls.some(call => call.method === 'turn/start'), false, 'command does not send a model turn');
  submit('解释列表'); await until(() => thread.turns.length === 1);
  await until(() => $('messages').textContent.includes('解释列表'));
  assert.doesNotMatch($('messages').textContent, /CodexWUI StudyCard instructions|现有目录树/);
  const turn = thread.turns[0];
  turn.items.push({ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'StudyCard: Python/list\n\n# 列表\n解释正文。' });
  codex.complete(id); await app.studycards.close();
  await until(() => $('messages').querySelector('a[href^="/file-preview.html?"]'));
  assert.match($('messages').textContent, /StudyCard 已保存/);
  $('toggle-inspector').click();
  await until(() => $('files-view').querySelector('[data-file-entry="StudyCard"]'));
  $('files-view').querySelector('[data-file-entry="StudyCard"]').click();
  await until(() => $('files-view').querySelector('[data-file-entry="StudyCard/Python"]'));
  $('files-view').querySelector('[data-file-entry="StudyCard/Python"]').click();
  await until(() => $('files-view').querySelector('[data-file-entry="StudyCard/Python/list.html"]'));
  $('files-view').querySelector('[data-file-entry="StudyCard/Python/list.html"]').click();
  await until(() => !$('files-view').querySelector('.file-card-preview').hidden);
  assert.equal($('files-view').querySelector('.file-card-preview').getAttribute('sandbox'), 'allow-scripts');
  assert.match($('files-view').querySelector('.file-card-preview').src, /\/api\/files\/studycard\?/);
  assert.equal($('files-view').querySelector('.file-raw').hidden, true);
  $('files-view').querySelector('[data-file-card-source]').click();
  assert.equal($('files-view').querySelector('.file-raw').hidden, false);
  await until(() => $('files-view').querySelector('.file-raw').textContent.includes('解释正文。'));
  submit('/sTuDyCaRd --STATUS'); await until(() => $('toast').textContent.includes('保存目录：'));
  submit('/StudyCard --stop'); await until(() => !$('breadcrumb').textContent.includes('StudyCard 已开启'));
  assert.match($('toast').textContent, /下一轮将注入一次关闭提示/);
  submit('继续'); await until(() => thread.turns.length === 2);
  assert.match(thread.turns[1].items[0].content.at(-1).text, /StudyCard 功能已关闭/);
  codex.complete(id);
  const saved = (await request(`/api/threads/${id}`)).body.studycard;
  assert.equal(saved.enabled, false); assert.equal(saved.closePending, false);
  assert.deepEqual(errors, []);
});

test('child metadata uses completion times, caches unchanged history and refreshes after another run', async t => {
  const { request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread;
  const child = (await request('/api/threads', { project: project.id })).body.thread;
  Object.assign(codex.threads.get(child.id), { parentThreadId: parent.id, updatedAt: 9999,
    turns: [{ id: 'old-run', status: 'completed', completedAt: 100, items: [] }] });
  const url = `/api/threads/${parent.id}/children`;
  assert.equal((await request(url)).body.data[0].lastCompletedAt, 100);
  assert.equal((await request(url)).body.data[0].lastCompletedAt, 100);
  const histories = () => codex.calls.filter(call => call.method === 'thread/turns/list' && call.params.threadId === child.id);
  assert.equal(histories().length, 1);
  assert.deepEqual(histories()[0].params, { threadId: child.id, limit: 2, sortDirection: 'desc', itemsView: 'notLoaded' });
  const { turn } = await codex.request('turn/start', { threadId: child.id, input: [] });
  turn.completedAt = 200; codex.complete(child.id);
  assert.equal((await request(url)).body.data[0].lastCompletedAt, 200);
  assert.equal(histories().length, 2);
});

test('agents put running tasks first, then latest completion, including resumed runs and page reloads', async t => {
  const f = await fixture(t); const { codex, project } = f;
  const make = async (name, completedAt, updatedAt, parentThreadId = null) => {
    const { thread } = await codex.request('thread/start', { cwd: project.path });
    Object.assign(thread, { name, parentThreadId, updatedAt });
    if (completedAt) thread.turns.push({ id: `${thread.id}-old`, status: 'completed', completedAt, items: [] });
    return thread;
  };
  const parent = await make('parent', null, 1);
  const old = await make('old', 1000, 9999, parent.id);
  const recent = await make('recent', 2000, 1, parent.id);
  const legacy = await make('legacy', null, 1500, parent.id);
  const running = await make('running', 500, 2, parent.id);
  await codex.request('turn/start', { threadId: running.id, input: [] });
  let holdChildren = false, releaseChildren;
  const { $, errors } = await browserFixture(t, f, window => {
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      const response = await fetch(url, options);
      if (holdChildren && String(url).endsWith('/children')) {
        holdChildren = false;
        await new Promise(resolve => { releaseChildren = resolve; });
      }
      return response;
    };
  });
  await until(() => $('thread-list').querySelector(`[data-thread="${parent.id}"]`));
  $('thread-list').querySelector(`[data-thread="${parent.id}"]`).click();
  await until(() => $('agents-list').querySelectorAll('.agent-card').length === 4);
  const order = (get = $) => [...get('agents-list').querySelectorAll('footer button')].map(button => button.dataset.thread);
  assert.deepEqual(order(), [running.id, recent.id, legacy.id, old.id]);
  holdChildren = true; $('refresh-agents').click(); await until(() => releaseChildren);
  running.turns.at(-1).completedAt = 2500; codex.complete(running.id);
  await until(() => !$('agents-list').querySelector('.status-dot.busy'));
  releaseChildren();
  await codex.request('turn/start', { threadId: old.id, input: [] });
  await until(() => order()[0] === old.id);
  old.turns.at(-1).completedAt = 2300; codex.complete(old.id, 'failed');
  await until(() => order().join() === [running.id, old.id, recent.id, legacy.id].join());
  assert.ok($('agents-list').querySelectorAll('.agent-card')[1].textContent.includes('异常'));
  await codex.request('turn/start', { threadId: running.id, input: [] });
  await codex.request('turn/start', { threadId: recent.id, input: [] });
  recent.turns.at(-1).completedAt = 3000; codex.complete(recent.id);
  await until(() => order().join() === [running.id, recent.id, old.id, legacy.id].join());
  running.turns.at(-1).completedAt = 2600; codex.complete(running.id, 'interrupted');
  await until(() => order().join() === [recent.id, running.id, old.id, legacy.id].join());
  assert.ok($('agents-list').querySelectorAll('.agent-card')[1].textContent.includes('已中断'));
  old.updatedAt = 999999;
  $('refresh-agents').click();
  await until(() => codex.calls.some(call => call.method === 'thread/list' && call.params.ancestorThreadId === parent.id));
  assert.deepEqual(order(), [recent.id, running.id, old.id, legacy.id]);
  const restored = await browserFixture(t, f);
  await until(() => restored.$('thread-list').querySelector(`[data-thread="${parent.id}"]`));
  restored.$('thread-list').querySelector(`[data-thread="${parent.id}"]`).click();
  await until(() => order(restored.$).length === 4);
  assert.deepEqual(order(restored.$), [recent.id, running.id, old.id, legacy.id]);
  assert.deepEqual(errors, []); assert.deepEqual(restored.errors, []);
});

test('agent links reach a rendered browser preview with source toggle, relative links and clear errors', async t => {
  const { base, dir, $, submit, codex, project, errors } = await browserFixture(t);
  await mkdir(dir + '/combustion');
  await writeFile(dir + '/combustion/report.md', '# 报告\n\n**核验** $x^2$\n\n[代码](../run.py)\n\n<script>bad()</script>');
  await writeFile(dir + '/run.py', 'first\nsecond\nthird');
  await writeFile(dir + '/plot.png', png);
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  submit('show files'); await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const thread = [...codex.threads.values()][0], turn = thread.turns.at(-1);
  const item = { type: 'agentMessage', id: 'file-answer', text: `[核验记录](${thread.cwd}/combustion/report.md)` };
  turn.items.push(item); codex.event('item/completed', { threadId: thread.id, turnId: turn.id, item }); codex.complete(thread.id);
  await until(() => $('messages').querySelector('.assistant a'));
  const link = $('messages').querySelector('.assistant a');
  assert.equal(link.target, '_blank');
  assert.equal(new URL(link.href).pathname, '/file-preview.html');
  const openPreview = async url => {
    const html = await (await fetch(url)).text();
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    dom.window.fetch = (route, options) => fetch(new URL(route, base), options);
    for (const script of dom.window.document.querySelectorAll('script[src]')) dom.window.eval(await (await fetch(script.src)).text());
    const get = id => dom.window.document.getElementById(id);
    await until(() => !get('file-status').textContent.includes('正在读取'), 'file preview');
    return { dom, get };
  };
  const { get } = await openPreview(link.href);
  assert.equal(get('file-content').querySelector('h1').textContent, '报告');
  assert.equal(get('file-content').querySelector('strong').textContent, '核验');
  assert.ok(get('file-content').querySelector('.katex'));
  assert.equal(get('file-content').querySelector('script'), null);
  const codeLink = get('file-content').querySelector('a');
  assert.equal(new URL(codeLink.href).searchParams.get('path'), 'combustion/../run.py');
  get('toggle-source').click();
  assert.ok(get('file-content').querySelector('pre').textContent.includes('# 报告'));
  get('toggle-source').click(); assert.ok(get('file-content').querySelector('h1'));
  const code = await openPreview(codeLink.href + '&line=2');
  assert.equal(code.get('file-content').querySelector('.selected').textContent, 'second');
  assert.equal(code.get('file-content').querySelector('pre').textContent, 'first\nsecond\nthird');
  const previewUrl = file => `${base}/file-preview.html?${new URLSearchParams({ project: project.id, path: file })}`;
  const image = await openPreview(previewUrl('plot.png'));
  assert.ok(image.get('file-content').querySelector('img').src.includes('/api/files/content?'));
  const missing = await openPreview(previewUrl('missing.md'));
  assert.ok(missing.get('file-status').classList.contains('failed'));
  assert.ok(missing.get('file-status').textContent.includes('已不存在'));
  assert.deepEqual(errors, []);
});

test('Mermaid renders locally in an opaque frame while session APIs remain protected', async t => {
  const { base } = await fixture(t);
  const page = await fetch(base + '/mermaid-renderer.html');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), null);
  const policy = page.headers.get('content-security-policy');
  assert.match(policy, /sandbox allow-scripts;/);
  assert.doesNotMatch(policy, /allow-same-origin/);
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  const headers = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'script' };
  for (const route of ['/mermaid-renderer.js', '/vendor/mermaid/mermaid.min.js']) {
    const response = await fetch(base + route, { headers });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  for (const route of ['/api/bootstrap', '/api/threads', '/app.js']) {
    assert.equal((await fetch(base + route, { headers })).status, 403, route);
  }
  assert.equal((await fetch(base + '/vendor/mermaid/missing.js')).status, 404);
});

test('served CSP permits KaTeX inline geometry while keeping scripts and stylesheets restricted', async t => {
  const { base, window } = await browserFixture(t);
  const page = await fetch(base + '/');
  const directives = new Map(page.headers.get('content-security-policy').split(';').map(value => {
    const [name, ...sources] = value.trim().split(/\s+/);
    return [name, sources];
  }));
  const output = window.document.createElement('div');
  output.innerHTML = window.CodexMarkdown(String.raw`\[NT=DT_E \quad\Longrightarrow\quad \frac{T_E}{T}=\frac{N}{D}\]

例如 \(T_E\approx1436.068\) 分钟。

\[T=\frac{1436.068}{15}\approx95.738\text{ 分钟}\]`);
  // KaTeX positions fractions and subscripts through per-token style attributes.
  // jsdom does not enforce CSP: inspect the actual HTTP policy explicitly.
  assert.ok(output.querySelector('.katex-strut[style*="height"]'));
  assert.ok(output.querySelector('.vlist > span[style*="top"]'));
  assert.ok(output.querySelector('.frac-line[style*="border-bottom-width"]'));
  const attributes = directives.get('style-src-attr') || directives.get('style-src') || directives.get('default-src');
  assert.ok(attributes.includes("'unsafe-inline'"), 'browser CSP blocks the inline heights and offsets needed by fractions and subscripts');
  const stylesheets = directives.get('style-src-elem') || directives.get('style-src') || directives.get('default-src');
  assert.equal(stylesheets[0], "'self'");
  assert.equal(stylesheets.length, 2);
  assert.match(stylesheets[1], /^'nonce-[A-Za-z0-9+/]+'$/);
  const nonce = (await page.text()).match(/name="terminal-style-nonce" content="([^"]+)"/)?.[1];
  assert.equal(stylesheets[1], `'nonce-${nonce}'`, 'only terminal-generated style elements carry the response nonce');
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('default-src'), ["'self'"]);
});

test('local math assets, streaming answers, history and BTW use the shared renderer', async t => {
  const f = await browserFixture(t);
  const { $, submit, codex, base, errors } = f;
  const css = await fetch(base + '/vendor/katex/katex.min.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const fontPaths = [...(await css.text()).matchAll(/url\(fonts\/([^\)]+)\)/g)].map(match => match[1]);
  assert.ok(fontPaths.length > 0);
  for (const name of new Set(fontPaths)) {
    const font = await fetch(base + '/vendor/katex/fonts/' + name);
    assert.equal(font.status, 200, name);
    assert.match(font.headers.get('content-type'), /^font\//);
    assert.ok((await font.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(base + '/vendor/katex/fonts/not-a-font.woff2')).status, 404);
  submit('解释轨道公式');
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const parent = [...codex.threads.values()][0], turn = parent.turns[0];
  const emit = delta => codex.event('item/agentMessage/delta', { threadId: parent.id, turnId: turn.id, itemId: 'math-answer', delta });
  emit(String.raw`公式 \(\frac{a`);
  await until(() => $('messages').textContent.includes('公式'));
  assert.equal($('messages').querySelectorAll('.katex').length, 0);
  emit(String.raw`}{b}\)

| 模式 | 周期 |
|---|---|
| 重复 | $T$ |`);
  await until(() => $('messages').querySelectorAll('.katex').length === 2);
  assert.ok($('messages').querySelector('table'));
  const answer = { id: 'math-answer', type: 'agentMessage', text: String.raw`公式 \(\frac{a}{b}\)

| 模式 | 周期 |
|---|---|
| 重复 | $T$ |` };
  turn.items.push(answer); codex.complete(parent.id);
  const restored = await browserFixture(t, f);
  await until(() => restored.$('thread-list').querySelector(`[data-thread="${parent.id}"]`));
  restored.$('thread-list').querySelector(`[data-thread="${parent.id}"]`).click();
  await until(() => restored.$('messages').querySelectorAll('.katex').length === 2);
  await until(() => !$('send').disabled);
  submit('/btw 解释周期');
  await until(() => codex.calls.filter(call => call.method === 'turn/start').length === 2);
  const side = [...codex.threads.values()][1], sideTurn = side.turns.at(-1);
  codex.event('item/agentMessage/delta', { threadId: side.id, turnId: sideTurn.id, itemId: 'side-math', delta: String.raw`\[T=2\pi\sqrt{a^3/\mu}\]` });
  await until(() => $('btw-messages').querySelector('.math-block .katex'));
  assert.deepEqual(errors, []);
  assert.deepEqual(restored.errors, []);
});

test('account quota flows through HTTP to the sidebar and dialog, prefers five hours and follows notifications', async t => {
  const f = await fixture(t);
  const original = f.codex.request.bind(f.codex);
  const resetsAt = Math.floor(Date.now() / 1000) + 86400;
  let bucket = { limitId: 'codex', planType: 'pro', primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt }, secondary: null };
  let reads = 0, fail = false;
  f.codex.request = async (method, ...args) => {
    if (method !== 'account/rateLimits/read') return original(method, ...args);
    reads++;
    if (fail) throw new Error('额度暂不可用');
    return { rateLimits: bucket };
  };
  const { $, window, errors } = await browserFixture(t, f);
  await until(() => $('account-quota').textContent === '周剩余 74%');
  $('prompt').value = '保留草稿';
  $('account-quota').click();
  assert.equal($('quota-dialog').open, true);
  assert.equal($('quota-plan').textContent, 'PRO · Codex 账户额度');
  assert.equal($('quota-weekly-remaining').textContent, '剩余 74%');
  assert.equal($('quota-weekly-progress').value, 74);
  assert.match($('quota-weekly-reset').textContent, /重置/);
  assert.equal($('quota-five-hour-reset').textContent, '当前账户未提供此项额度');
  assert.equal($('quota-five-hour-progress').hidden, true);
  await until(() => !$('refresh-quota').disabled);
  assert.equal(reads, 1, 'opening details uses the shared cache');
  bucket = { ...bucket, secondary: { usedPercent: 91, windowDurationMins: 300, resetsAt } };
  $('refresh-quota').click();
  await until(() => $('account-quota').textContent === '5h剩余 9%');
  assert.equal(reads, 2, 'manual refresh bypasses the cache');
  assert.equal($('quota-weekly-remaining').textContent, '剩余 74%');
  assert.equal($('quota-five-hour-remaining').textContent, '剩余 9%');
  assert.equal($('account-quota').classList.contains('quota-low'), true);
  bucket = { ...bucket, primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt }, secondary: null };
  f.codex.event('account/rateLimits/updated', { rateLimits: bucket });
  await until(() => $('account-quota').textContent === '周剩余 70%');
  assert.equal(reads, 2, 'notifications update the server cache without an extra RPC');
  assert.equal($('account-quota').classList.contains('quota-low'), false);
  fail = true;
  $('refresh-quota').click();
  await until(() => $('quota-status').textContent === '额度暂不可用');
  assert.equal($('account-quota').textContent, '额度 --');
  assert.equal($('toast').hidden, true);
  fail = false;
  $('refresh-quota').click();
  await until(() => $('account-quota').textContent === '周剩余 70%');
  $('close-quota-dialog').click(); assert.equal($('quota-dialog').open, false);
  f.codex.fail(new Error('backend stopped'));
  await until(() => /未连接/.test($('quota-status').textContent));
  assert.equal($('account-quota').textContent, '额度 --');
  assert.equal((await f.request('/api/account/quota')).status, 503);
  assert.equal($('prompt').value, '保留草稿');
  assert.deepEqual(errors, []);
});

test('account quota pauses polling when hidden, deduplicates requests and discards old account responses', async t => {
  const f = await fixture(t);
  const original = f.codex.request.bind(f.codex);
  const resetsAt = Math.floor(Date.now() / 1000) + 86400;
  f.codex.request = async (method, ...args) => method === 'account/rateLimits/read'
    ? { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt } } }
    : original(method, ...args);
  let poll, hidden = false, requests = 0, hold = false, release;
  const { $, window, errors } = await browserFixture(t, f, window => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, ms, ...args) => {
      if (ms === 60000) { poll = callback; return 0; }
      return interval(callback, ms, ...args);
    };
    Object.defineProperty(window.document, 'hidden', { get: () => hidden, configurable: true });
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      if (!url.startsWith('/api/account/quota')) return fetch(url, options);
      requests++;
      const response = await fetch(url, options);
      if (hold) await new Promise(resolve => { release = resolve; });
      return response;
    };
  });
  await until(() => $('account-quota').textContent === '5h剩余 80%');
  hidden = true; const before = requests; poll(); assert.equal(requests, before);
  hidden = false; hold = true; poll(); await until(() => release);
  poll(); poll(); assert.equal(requests, before + 1);
  f.codex.event('account/updated', { authMode: null, planType: null });
  hold = false;
  f.codex.request = async (method, ...args) => method === 'account/rateLimits/read' ? {} : original(method, ...args);
  await until(() => $('quota-five-hour-reset').textContent === '当前账户未提供此项额度');
  release();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal($('account-quota').textContent, '额度 --', 'an old account response must not restore its quota');
  assert.equal($('quota-weekly-reset').textContent, '当前账户未提供此项额度');
  assert.deepEqual(errors, []);
});

test('sidebar RAM uses cached totals and polls without overlap, pauses when hidden and handles failure quietly', async t => {
  const f = await fixture(t, { limits: resourceLimits({}) });
  f.codex.resources = { rssMb: 1229, sampledAt: Date.now() };
  let poll, hidden = false, requests = 0, hold = false, release, fail = false;
  const { window, $, errors } = await browserFixture(t, f, window => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, ms, ...args) => {
      if (ms === 5000) { poll = callback; return 0; }
      return interval(callback, ms, ...args);
    };
    Object.defineProperty(window.document, 'hidden', { get: () => hidden, configurable: true });
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      if (url === '/api/resources') {
        requests++;
        if (hold) await new Promise(resolve => { release = resolve; });
        if (fail) return new Response('{}', { status: 503 });
      }
      return fetch(url, options);
    };
  });
  await until(() => $('memory-usage').textContent === 'RAM 1.2/4G');
  assert.equal($('connection-label').nextElementSibling, $('memory-usage'));
  assert.equal($('memory-usage').nextElementSibling, $('account-quota'));
  $('prompt').value = '保留正在输入的草稿';
  hidden = true; poll(); assert.equal(requests, 0);
  f.codex.resources = { rssMb: 2560, sampledAt: Date.now() };
  hidden = false; window.document.dispatchEvent(new window.Event('visibilitychange'));
  await until(() => $('memory-usage').textContent === 'RAM 2.5/4G');
  assert.equal(requests, 1);
  hold = true; f.codex.resources = { rssMb: 3072, sampledAt: Date.now() };
  poll(); await until(() => release); poll(); assert.equal(requests, 2);
  release(); hold = false;
  await until(() => $('memory-usage').textContent === 'RAM 3.0/4G');
  fail = true; poll(); await until(() => $('memory-usage').textContent === 'RAM --/4G');
  assert.equal($('toast').hidden, true);
  fail = false; poll(); await until(() => $('memory-usage').textContent === 'RAM 3.0/4G');
  f.codex.fail(new Error('backend stopped'));
  await until(() => $('memory-usage').textContent === 'RAM --/4G');
  assert.equal($('prompt').value, '保留正在输入的草稿');
  assert.deepEqual(errors, []);
});

test('steer remains visible before Codex emits the user message', async t => {
  const { $, submit, codex } = await browserFixture(t);
  submit('initial task');
  await until(() => codex.calls.some(call => call.method === 'turn/start') && !$('send').disabled);
  submit('keep this guidance visible');
  await until(() => $('prompt').value === '' && !$('send').disabled);
  assert.ok(windowText($).includes('keep this guidance visible'), 'submitted steer disappeared before Codex consumed it');
});

function windowText($) { return $('chat-view').textContent; }

test('browser can edit or recall pre-steer; reconnect restores it and receipt merges it exactly once', async t => {
  const f = await browserFixture(t);
  const { $, window, submit, codex, request } = f;
  submit('initial task');
  await until(() => codex.calls.some(call => call.method === 'turn/start') && !$('send').disabled);
  const id = [...codex.threads.keys()][0];
  submit('$example <img src=x onerror=alert(1)>');
  await until(() => $('prompt').value === '' && !$('send').disabled && $('steer-list').querySelector('[data-steer-action="edit"]'));
  assert.equal($('steer-list').querySelector('img'), null);
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 0);
  $('steer-list').querySelector('[data-steer-action="edit"]').click();
  await until(() => $('steer-dialog').open);
  assert.match($('steer-edit-attachments').textContent, /example/);
  codex.boundary(id); assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 0);
  $('steer-text').value = '$example corrected guidance';
  $('steer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('steer-dialog').open && $('steer-list').textContent.includes('corrected guidance'));
  const reconnect = await browserFixture(t, f);
  await until(() => reconnect.window.document.querySelector(`[data-thread="${id}"]`), 'restored thread list');
  reconnect.window.document.querySelector(`[data-thread="${id}"]`).click();
  await until(() => reconnect.$('steer-list').textContent.includes('corrected guidance'));
  submit('recall this one');
  await until(() => $('prompt').value === '' && !$('send').disabled && $('steer-list').querySelectorAll('.pending-steer').length === 2 &&
    [...$('steer-list').querySelectorAll('.pending-steer')].find(card => card.textContent.includes('recall this one'))?.querySelector('[data-steer-action="remove"]'));
  [...$('steer-list').querySelectorAll('.pending-steer')].find(card => card.textContent.includes('recall this one')).querySelector('[data-steer-action="remove"]').click();
  await until(() => !$('steer-list').textContent.includes('recall this one'));
  const saved = (await request(`/api/threads/${id}`)).body.steers.entries;
  assert.equal(saved.length, 1); assert.equal(saved[0].text, '$example corrected guidance');
  codex.boundary(id);
  await until(() => $('steer-list').textContent.includes('等待 Codex 接收'));
  assert.equal($('steer-list').querySelector('[data-steer-action="remove"]'), null);
  const calls = codex.calls.filter(call => call.method === 'turn/steer');
  assert.equal(calls.length, 1); assert.equal(calls[0].params.input[0].text, '$example corrected guidance');
  assert.equal(calls[0].params.input[1].type, 'skill');
  codex.consumeSteers(id);
  await until(() => !$('steer-list').querySelector('.pending-steer') && $('messages').textContent.includes('corrected guidance'));
  assert.equal($('chat-view').textContent.split('corrected guidance').length - 1, 1);
  assert.deepEqual(f.errors, []); assert.deepEqual(reconnect.errors, []);
});

test('HTTP steer editing is versioned and a late recall cannot undo an already submitted steer', async t => {
  const { request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const turnId = (await request(`/api/threads/${id}/send`, { text: 'start' })).body.turn.id;
  const staged = await request(`/api/threads/${id}/steer`, { text: 'one', expectedTurnId: turnId, clientUserMessageId: 'idempotent' });
  const entry = staged.body.steers.entries[0];
  const editing = (await request(`/api/threads/${id}/steer-edit`, { id: entry.id, revision: entry.revision })).body.entry;
  codex.boundary(id);
  assert.equal(codex.calls.some(call => call.method === 'turn/steer'), false);
  assert.equal((await request(`/api/threads/${id}/steer-update`, { id: entry.id, revision: editing.revision, text: '' })).status, 400);
  const updated = (await request(`/api/threads/${id}/steer-update`, { id: entry.id, revision: editing.revision, text: 'two' })).body.entry;
  assert.equal((await request(`/api/threads/${id}/steer-remove`, { id: entry.id, revision: entry.revision })).status, 409);
  await request(`/api/threads/${id}/steer`, { text: 'two', expectedTurnId: turnId, clientUserMessageId: 'idempotent' });
  assert.equal((await request(`/api/threads/${id}`)).body.steers.entries.length, 1);
  assert.equal((await request(`/api/threads/${id}/steer-send`, { id: entry.id, revision: updated.revision })).status, 200);
  assert.equal((await request(`/api/threads/${id}/steer-remove`, { id: entry.id, revision: updated.revision })).status, 409);
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 1);
  codex.consumeSteers(id);
  assert.equal((await request(`/api/threads/${id}`)).body.steers.entries.length, 0);
  await request(`/api/threads/${id}/steer`, { text: 'two', expectedTurnId: turnId, clientUserMessageId: 'idempotent' });
  codex.boundary(id);
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 1);
});

test('slash skill suggestions and direct slash/dollar invocations resolve to the same explicit skill input', async t => {
  const { codex, dir, window, $, submit, errors } = await browserFixture(t);
  $('command-menu').click();
  await until(() => $('suggestions').querySelector('[data-skill]'));
  assert.equal($('suggestions').querySelector('[data-skill] strong').textContent, '/skill：example');
  assert.ok($('suggestions').querySelector('[data-command="help"]'));
  $('prompt').value = '/exam'; $('prompt').dispatchEvent(new window.Event('input'));
  assert.equal($('suggestions').querySelectorAll('[data-command]').length, 0);
  assert.equal($('suggestions').querySelectorAll('[data-skill]').length, 1);
  $('suggestions').querySelector('[data-skill]').click();
  await until(() => $('prompt').value === '$example ');
  assert.equal($('prompt').value, '$example ');
  assert.match($('skill-chips').textContent, /\$example/);
  assert.equal($('suggestions').hidden, true);
  submit($('prompt').value + 'chosen from slash menu');
  await until(() => codex.calls.some(c => c.method === 'turn/start') && !$('send').disabled && $('prompt').value === '');
  const id = [...codex.threads.keys()][0];
  const first = codex.calls.find(c => c.method === 'turn/start');
  assert.equal(withoutVisualizationGuide(first.params.input)[0].text, '$example chosen from slash menu');
  assert.deepEqual(withoutVisualizationGuide(first.params.input)[1], { type: 'skill', name: 'example', path: dir + '/SKILL.md' });
  await until(() => !$('send-mode').hidden);
  for (const text of ['/example direct slash', '$example direct dollar', '/example', '/skill: example explicit skill', '/skill：example\nKeep the whole task below']) {
    codex.complete(id);
    await until(() => $('send-mode').hidden);
    const before = codex.calls.filter(c => c.method === 'turn/start').length;
    submit(text);
    await until(() => codex.calls.filter(c => c.method === 'turn/start').length === before + 1 && !$('send').disabled && $('prompt').value === '' && !$('send-mode').hidden, text);
    const input = withoutVisualizationGuide(codex.calls.filter(c => c.method === 'turn/start').at(-1).params.input);
    assert.equal(input[0].text, text.replace(/^\/skill[:：][ \t]*/, '$').replace(/^\//, '$'));
    assert.deepEqual(input[1], { type: 'skill', name: 'example', path: dir + '/SKILL.md' });
    assert.equal(input.filter(i => i.type === 'skill').length, 1);
  }
  assert.deepEqual(errors, []);
});

test('slash command button inserts a command line and choosing config preserves all draft text and skill selection', async t => {
  const { codex, window, $, submit, errors } = await browserFixture(t);
  $('skill-menu').click(); await until(() => $('suggestions').querySelector('[data-skill]'));
  $('suggestions').querySelector('[data-skill]').click(); await until(() => $('prompt').value === '$example ');
  Object.defineProperty($('file-input'), 'files', { configurable: true, value: [new File(['keep this attachment'], 'notes.txt', { type: 'text/plain' })] });
  $('file-input').dispatchEvent(new window.Event('change'));
  await until(() => $('image-attachments').textContent.includes('notes.txt') && !$('send').disabled);
  const draft = '$example 这段草稿还没有写完。\n\n第二段保留空格  \n';
  $('prompt').value = draft; $('prompt').dispatchEvent(new window.Event('input'));
  $('command-menu').click(); await until(() => $('prompt').value === `/\n${draft}`);
  assert.equal($('prompt').selectionStart, 1);
  $('command-menu').click(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal($('prompt').value, `/\n${draft}`, 'reopening does not prepend another command line');
  $('suggestions').querySelector('[data-command="config"]').click();
  await until(() => $('config-dialog').open);
  assert.equal($('prompt').value, draft);
  assert.match($('skill-chips').textContent, /\$example/);
  assert.match($('image-attachments').textContent, /notes.txt/);
  assert.equal(codex.threads.size, 0);
  $('config-dialog').close();
  submit($('prompt').value);
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const input = withoutVisualizationGuide(codex.calls.find(call => call.method === 'turn/start').params.input);
  assert.equal(input[0].text, draft.trim());
  assert.equal(input[1].type, 'skill');
  assert.ok(input.some(item => item.type === 'text' && item.text.includes('notes.txt')));
  assert.deepEqual(errors, []);
});

test('typed action commands consume only the first line, preserve drafts during async execution and restore failed commands', async t => {
  const f = await fixture(t);
  let hold = false, release;
  const { codex, window, $, submit, errors } = await browserFixture(t, f, window => {
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      if (hold && url === '/api/config' && !options?.method) await new Promise(resolve => { release = resolve; });
      return fetch(url, options);
    };
  });
  const draft = '保留第一段。\n\n保留第二段和末尾空格  \n';
  $('prompt').value = `/config\n${draft}`; $('prompt').dispatchEvent(new window.Event('input'));
  assert.equal($('send').textContent, '执行 /config');
  $('prompt').value = `/skill: example\n${draft}`; $('prompt').dispatchEvent(new window.Event('input'));
  assert.equal($('send').textContent, '发送 ↑');
  hold = true;
  submit(`/config  \r\n${draft}`); await until(() => release);
  assert.equal($('prompt').value, draft);
  $('prompt').value += '等待设置期间继续写。'; $('prompt').dispatchEvent(new window.Event('input'));
  hold = false; release();
  await until(() => $('config-dialog').open && !$('config-form').querySelector('[data-config-save]').disabled);
  assert.equal($('prompt').value, draft + '等待设置期间继续写。');
  $('config-dialog').close();
  submit(`/help\n${draft}`); await until(() => $('prompt').value === draft);
  assert.equal(codex.threads.size, 0);
  const failed = `/stop\n${draft}`;
  submit(failed); await until(() => /请先选择一个会话/.test($('toast').textContent));
  assert.equal($('prompt').value, failed);
  codex.fail(new Error('offline'));
  await until(() => $('send').disabled);
  submit(`/config\n${draft}`); await until(() => $('config-dialog').open);
  assert.equal($('prompt').value, draft);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.deepEqual(errors, []);
});

test('choosing a slash skill keeps the task below its command line and sends both together', async t => {
  const { codex, $, submit, errors } = await browserFixture(t);
  const draft = '检查异常处理。\n保留这条具体要求。';
  $('prompt').value = draft;
  $('command-menu').click(); await until(() => $('suggestions').querySelector('[data-skill]'));
  $('suggestions').querySelector('[data-skill]').click();
  await until(() => $('prompt').value === `$example \n${draft}`);
  submit($('prompt').value);
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const input = withoutVisualizationGuide(codex.calls.find(call => call.method === 'turn/start').params.input);
  assert.equal(input[0].text, `$example \n${draft}`);
  assert.equal(input[1].type, 'skill');
  assert.deepEqual(errors, []);
});

test('opening model settings carries an unsent draft into its implicit new thread while explicit new preserves the old draft', async t => {
  const { codex, window, $, submit, errors } = await browserFixture(t);
  const draft = '先选择模型，然后继续写的草稿。';
  submit(`/model\n${draft}`); await until(() => $('model-dialog').open);
  assert.equal($('prompt').value, draft);
  const originalId = [...codex.threads.keys()][0];
  $('model-dialog').close();
  submit(`/new\n${draft}`); await until(() => codex.threads.size === 2 && !$('new-thread').disabled);
  assert.equal($('prompt').value, '');
  await until(() => $('thread-list').querySelector(`[data-thread="${originalId}"]`));
  $('thread-list').querySelector(`[data-thread="${originalId}"]`).click();
  await until(() => $('prompt').value === draft);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.deepEqual(errors, []);
});

test('commands with arguments consume their first line while preserving the main draft', async t => {
  const { codex, $, submit, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1 && !$('new-thread').disabled);
  const parent = [...codex.threads.keys()][0];
  const draft = '这部分仍是主会话的草稿。\n第二段也不发送。';
  submit(`/StudyCard --status\n${draft}`);
  await until(() => /StudyCard/.test($('toast').textContent));
  assert.equal($('prompt').value, draft);
  submit(`/btw 只解释这个问题\n${draft}`);
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  assert.equal($('prompt').value, draft);
  const call = codex.calls.find(call => call.method === 'turn/start');
  assert.notEqual(call.params.threadId, parent);
  assert.ok(call.params.input.some(item => item.type === 'text' && item.text === '只解释这个问题'));
  assert.ok(!JSON.stringify(call.params.input).includes(draft));
  assert.deepEqual(errors, []);
});

test('slash skills preserve builtin commands, support namespaces, and require a menu choice for duplicate names', async t => {
  const f = await fixture(t);
  const original = f.codex.request.bind(f.codex);
  const skills = [
    { name: 'help', path: f.dir + '/help/SKILL.md', description: 'Help skill' },
    { name: 'plugin:skill-one', path: f.dir + '/plugin/SKILL.md', description: '<img src=x onerror=alert(1)>' },
    { name: 'same', path: f.dir + '/a/SKILL.md', description: 'Source A' },
    { name: 'same', path: f.dir + '/b/SKILL.md', description: 'Source B' },
  ];
  f.codex.request = async (method, ...args) => method === 'skills/list' ? { data: [{ cwd: f.dir, skills, errors: [] }] } : original(method, ...args);
  const { codex, window, $, submit, errors } = await browserFixture(t, f);
  $('prompt').value = '/h'; $('prompt').dispatchEvent(new window.Event('input'));
  await until(() => $('suggestions').querySelector('[data-skill]'));
  assert.equal($('suggestions').querySelector('[data-command] strong').textContent, '/help');
  assert.equal($('suggestions').querySelector('[data-skill] strong').textContent, '/skill：help');
  submit('/help'); await until(() => $('prompt').value === '');
  assert.equal(codex.threads.size, 0, '/help runs the builtin instead of the skill');
  assert.match($('toast').textContent, /\/技能名 或 \$技能名/);
  submit('/not-a-command'); await until(() => /不支持该命令/.test($('toast').textContent));
  assert.equal($('prompt').value, '/not-a-command');
  assert.equal(codex.threads.size, 0);
  $('prompt').value = '/plugin:s'; $('prompt').dispatchEvent(new window.Event('input'));
  assert.equal($('suggestions').querySelector('[data-skill] strong').textContent, '/skill：plugin:skill-one');
  assert.equal($('suggestions').querySelector('img'), null);
  submit('/plugin:skill-one do the task');
  await until(() => codex.calls.some(c => c.method === 'turn/start') && $('prompt').value === '' && !$('send').disabled);
  const input = withoutVisualizationGuide(codex.calls.find(c => c.method === 'turn/start').params.input);
  assert.equal(input[0].text, '$plugin:skill-one do the task');
  assert.equal(input[1].path, skills[1].path);
  const id = [...codex.threads.keys()][0];
  codex.complete(id); await until(() => $('send-mode').hidden);
  submit('/same choose one'); await until(() => /有多个来源/.test($('toast').textContent));
  assert.equal($('prompt').value, '/same choose one');
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 1);
  $('prompt').value = '/same'; $('prompt').dispatchEvent(new window.Event('input'));
  assert.equal($('suggestions').querySelectorAll('[data-skill]').length, 2);
  $('suggestions').querySelectorAll('[data-skill]')[1].click();
  await until(() => $('prompt').value === '$same ');
  submit($('prompt').value + 'use source B');
  await until(() => codex.calls.filter(c => c.method === 'turn/start').length === 2 && $('prompt').value === '');
  assert.equal(withoutVisualizationGuide(codex.calls.filter(c => c.method === 'turn/start').at(-1).params.input)[1].path, skills[3].path);
  assert.deepEqual(errors, []);
});

test('slash skill lookup prevents duplicate sends and cannot send into a conversation selected while loading', async t => {
  const f = await fixture(t);
  let release, hold = true, reads = 0;
  const { codex, $, submit, errors } = await browserFixture(t, f, window => {
    const fetch = window.fetch;
    window.fetch = async (url, options) => {
      if (url.startsWith('/api/skills')) {
        reads++;
        if (hold) await new Promise(resolve => { release = resolve; });
      }
      return fetch(url, options);
    };
  });
  submit('/example first task'); await until(() => release);
  assert.equal($('send').disabled, true);
  submit('/example first task');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 1);
  hold = false; release();
  await until(() => codex.calls.some(c => c.method === 'turn/start') && $('prompt').value === '' && !$('send').disabled);
  const id = [...codex.threads.keys()][0];
  codex.complete(id); await until(() => $('send-mode').hidden);
  hold = true; release = null;
  submit('/example keep this in the original conversation');
  await until(() => release);
  $('new-thread').click(); await until(() => codex.threads.size === 2 && !$('new-thread').disabled);
  hold = false; release();
  await until(() => !$('send').disabled);
  assert.equal($('prompt').value, '');
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 1);
  $('thread-list').querySelector(`[data-thread="${id}"]`).click();
  await until(() => $('prompt').value === '/example keep this in the original conversation');
  assert.deepEqual(errors, []);
});

test('slash skill aliases keep structured skill input in steer and follow-up queue', async t => {
  const { codex, $, submit, errors } = await browserFixture(t);
  submit('start task'); await until(() => codex.calls.some(c => c.method === 'turn/start') && !$('send').disabled);
  const id = [...codex.threads.keys()][0];
  submit('/example guide the running task');
  await until(() => $('prompt').value === '' && !$('send').disabled && $('steer-list').textContent.includes('$example guide the running task'));
  codex.boundary(id);
  await until(() => codex.calls.some(c => c.method === 'turn/steer'));
  const steer = withoutVisualizationGuide(codex.calls.find(c => c.method === 'turn/steer').params.input);
  assert.equal(steer[0].text, '$example guide the running task');
  assert.equal(steer[1].type, 'skill');
  $('send-mode').value = 'queue';
  submit('/example next task');
  await until(() => $('prompt').value === '' && !$('send').disabled && $('queue-list').textContent.includes('$example next task'));
  codex.consumeSteers(id); codex.complete(id);
  await until(() => codex.calls.filter(c => c.method === 'turn/start').length === 2);
  const queued = withoutVisualizationGuide(codex.calls.filter(c => c.method === 'turn/start').at(-1).params.input);
  assert.equal(queued[0].text, '$example next task');
  assert.equal(queued[1].type, 'skill');
  assert.deepEqual(errors, []);
});

test('browser can switch live threads, steer, choose skills and inspect children without HTML injection', async t => {
  const { codex, dir, window, $, submit, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  await until(() => $('thread-title').textContent === '新会话');
  submit('first'); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  const first = [...codex.threads.values()][0]; const turn = first.turns[0];
  codex.event('item/agentMessage/delta', { threadId: first.id, turnId: turn.id, itemId: 'answer', delta: '<img src=x onerror=alert(1)> streamed' });
  await until(() => $('messages').textContent.includes('streamed'));
  assert.equal($('messages').querySelector('img'), null);
  submit('change direction'); await until(() => $('prompt').value === '' && !$('send').disabled);
  codex.boundary(first.id); await until(() => codex.calls.some(c => c.method === 'turn/steer'));
  assert.equal(codex.calls.find(c => c.method === 'turn/steer').params.expectedTurnId, turn.id);
  $('new-thread').click(); await until(() => codex.threads.size === 2);
  assert.equal(first.turns[0].status, 'inProgress');
  await until(() => $('thread-title').textContent === '新会话');
  $('skill-menu').click(); await until(() => $('suggestions').querySelector('[data-skill]'));
  $('suggestions').querySelector('[data-skill]').click();
  await until(() => $('prompt').value.includes('$example'));
  assert.match($('prompt').value, /\$example/);
  submit($('prompt').value + ' do task');
  await until(() => codex.calls.filter(c => c.method === 'turn/start').length === 2);
  const last = codex.calls.filter(c => c.method === 'turn/start').at(-1);
  assert.equal(last.params.input[1].path, dir + '/SKILL.md');
  $('toggle-inspector').click(); assert.equal($('inspector').hidden, false);
  await until(() => $('files-view').querySelector('[data-file-entry]'), 'project files in integrated panel');
  const topFilesTab = $('inspector-files-tab'); topFilesTab.focus();
  const key = name => window.document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  key('ArrowRight'); assert.equal(window.document.activeElement, $('inspector-terminal-tab'));
  key('ArrowRight'); assert.equal(window.document.activeElement, $('inspector-agents-tab'));
  assert.equal($('files-view').hidden, false); assert.equal($('agents-view').hidden, true);
  key('Enter'); assert.equal($('files-view').hidden, true); assert.equal(window.document.activeElement, $('agents-view'));
  $('close-inspector').click(); assert.equal($('inspector').hidden, true);
  submit('/model'); await until(() => $('model-dialog').open, '/model picker');
  assert.equal($('model-select').value, 'test-fast');
  assert.equal($('reasoning-select').value, 'medium');
  $('model-select').value = 'test-deep'; $('model-select').dispatchEvent(new window.Event('change'));
  assert.deepEqual([...$('reasoning-select').options].map(o => o.value), ['high', 'ultra']);
  $('reasoning-select').value = 'ultra';
  $('model-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('model-dialog').open && $('model-label').textContent.includes('ultra'), 'saved model');
  assert.equal(codex.threads.get(last.params.threadId).model, 'test-deep');
  assert.equal(first.model, 'test-fast');
  assert.deepEqual(errors, []);
});

test('file uploads preserve bytes and resolve controlled paths for send, steer and queue', async t => {
  const { request, project, codex, dir } = await fixture(t, { maxFileBytes: 1024 * 1024 });
  const upload = (headers = {}, bytes = Buffer.from('你好\n')) => request('/api/attachments', undefined, {
    method: 'POST', headers: { 'X-File-Name': encodeURIComponent('../说明.txt'), ...headers }, body: bytes,
  });
  assert.equal((await upload({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload({}, Buffer.alloc(1024 * 1024 + 1))).status, 413);
  const result = await upload();
  assert.equal(result.status, 201);
  const file = result.body;
  assert.equal(file.name, '.._说明.txt');
  const location = path.join(dir, 'data/attachments', file.id);
  assert.equal(await readFile(location, 'utf8'), '你好\n');
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  for (const files of [['/etc/passwd'], [null], 'bad', Array(5).fill(file.id)]) {
    assert.equal((await request(`/api/threads/${id}/send`, { text: '', files })).status, 400);
  }
  const sent = await request(`/api/threads/${id}/send`, { text: '', files: [file.id] });
  assert.equal(sent.status, 200);
  const expected = codex.calls.find(call => call.method === 'turn/start').params.input[0];
  assert.equal(expected.type, 'text');
  assert.ok(expected.text.includes(location));
  const staged = await request(`/api/threads/${id}/steer`, { text: '', files: [file.id], expectedTurnId: sent.body.turn.id });
  assert.deepEqual(staged.body.steers.entries[0].files, [file.id]);
  codex.boundary(id);
  await until(() => codex.calls.some(call => call.method === 'turn/steer'));
  assert.deepEqual(codex.calls.find(call => call.method === 'turn/steer').params.input, [expected]);
  const queued = await request(`/api/threads/${id}/queue`, { text: '', files: [file.id] });
  assert.deepEqual(queued.body.entries[0].files, [file.id]);
  codex.complete(id);
  await until(() => codex.threads.get(id).turns.length === 2);
  assert.deepEqual(withoutVisualizationGuide(codex.threads.get(id).turns[1].items[0].content), [expected]);
});

test('browser uploads files above 20 MiB and reads a custom limit from the backend', async t => {
  const f = await fixture(t, { maxFileBytes: 32 * 1024 * 1024 });
  const { window, $, request, dir, submit, codex, errors } = await browserFixture(t, f);
  const bootstrap = (await request('/api/bootstrap')).body;
  assert.equal(bootstrap.uploadLimits.fileBytes, 32 * 1024 * 1024);
  assert.equal(bootstrap.uploadLimits.imageBytes, 10 * 1024 * 1024);
  assert.match($('attach-file').title, /32 MiB/);
  const large = new File([Buffer.alloc(21 * 1024 * 1024, 0x61)], 'large.txt');
  Object.defineProperty($('file-input'), 'files', { configurable: true, value: [large] });
  $('file-input').dispatchEvent(new window.Event('change'));
  await until(() => $('image-attachments').textContent.includes('已就绪'), 'large file upload');
  const saved = (await readdir(path.join(dir, 'data/attachments')))[0];
  assert.equal((await stat(path.join(dir, 'data/attachments', saved))).size, large.size);
  submit(); await until(() => codex.calls.some(call => call.method === 'turn/start'));
  assert.ok(codex.calls.find(call => call.method === 'turn/start').params.input[0].text.includes(saved));
  await until(() => $('image-attachments').hidden);
  const tooLarge = new File(['x'], 'too-large.txt');
  Object.defineProperty(tooLarge, 'size', { value: 32 * 1024 * 1024 + 1 });
  Object.defineProperty($('file-input'), 'files', { configurable: true, value: [tooLarge] });
  $('file-input').dispatchEvent(new window.Event('change'));
  await until(() => $('toast').textContent.includes('32 MiB'));
  assert.equal((await readdir(path.join(dir, 'data/attachments'))).length, 1);
  assert.deepEqual(errors, []);
});

test('chunked oversized uploads receive a 413 response and leave no partial attachment', async t => {
  const { base, dir, request } = await fixture(t, { maxFileBytes: 1024 * 1024 });
  const response = await fetch(base + '/api/attachments', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'large.bin' },
    body: Readable.from([Buffer.alloc(512 * 1024), Buffer.alloc(512 * 1024), Buffer.from('overflow')]), duplex: 'half',
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /1 MiB/);
  assert.deepEqual(await readdir(path.join(dir, 'data/attachments')), []);
  assert.equal((await request('/api/attachments', undefined, { method: 'POST', body: 'valid' })).status, 201);
});

test('browser sends a file-only first message and retains filename in history', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  Object.defineProperty($('file-input'), 'files', { configurable: true, value: [new File(['hello'], '说明.txt')] });
  $('file-input').dispatchEvent(new window.Event('change'));
  await until(() => $('image-attachments').textContent.includes('已就绪'));
  assert.ok($('image-attachments').textContent.includes('说明.txt'));
  submit();
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const input = withoutVisualizationGuide(codex.calls.find(call => call.method === 'turn/start').params.input);
  assert.equal(input.length, 1);
  assert.ok(input[0].text.includes('说明.txt'));
  await until(() => $('image-attachments').hidden);
  await until(() => window.document.querySelector('.message-file'));
  assert.equal(window.document.querySelector('.message-file').textContent, '📎 文件：说明.txt');
  assert.ok(!window.document.querySelector('.message.user').textContent.includes('attachments/'));
  assert.ok(!window.document.querySelector('.message.user').textContent.includes('本机工具'));
  assert.deepEqual(errors, []);
});

test('BTW freezes multiple native forks when opened and generates only after sending', async t => {
  const { app, request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  await request(`/api/threads/${parent}/send`, { text: 'At the first branch' });
  const before = codex.calls.filter(c => c.method === 'turn/start').length;
  const first = (await request(`/api/btw/${parent}/open`, {})).body.session;
  assert.ok(first.id);
  assert.equal(codex.calls.filter(c => c.method === 'thread/fork').length, 1);
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, before);
  assert.equal(codex.threads.get(first.threadId).turns[0].items[0].content[0].text, 'At the first branch');
  codex.complete(parent);
  await request(`/api/threads/${parent}/send`, { text: 'Later parent progress' });
  const second = (await request(`/api/btw/${parent}/open`, {})).body.session;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(codex.threads.get(first.threadId).turns.length, 1);
  assert.equal(codex.threads.get(second.threadId).turns.length, 2);
  const history = await request(`/api/btw/${parent}?session=${first.id}`);
  assert.deepEqual(history.body.history.data, []);
  assert.equal(codex.calls.filter(call => call.method === 'thread/turns/list' && call.params.threadId === first.threadId && call.params.itemsView === 'full').length, 0);
  assert.equal(history.body.sessions.length, 2);
  const fork = codex.calls.find(c => c.method === 'thread/fork').params;
  assert.equal(fork.deferGoalContinuation, true);
  assert.equal(fork.sandbox, 'read-only');
  assert.equal(fork.config.mcp_servers.codexwui_btw.enabled, true);
  assert.equal(fork.config['features.goals'], false);
  await request(`/api/btw/${parent}/send`, { sessionId: first.id, text: 'First question' });
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').at(-1).params.threadId, first.threadId);
  assert.equal(codex.calls.filter(c => c.method === 'thread/resume' && c.params.threadId === first.threadId).length, 0);
  const own = (await request(`/api/btw/${parent}?session=${first.id}`)).body.history.data;
  assert.equal(own.length, 1);
  assert.equal(own[0].items[0].content[0].text, 'First question');
  const otherParent = (await request('/api/threads', { project: project.id })).body.thread.id;
  assert.equal((await request(`/api/btw/${otherParent}/send`, { sessionId: first.id, text: 'Wrong parent' })).status, 404);
  assert.equal(app.btw.records.size, 2);
});

test('BTW opens an empty parent without querying empty side history or resuming before its first message', async t => {
  const { request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  const original = codex.request.bind(codex);
  codex.request = async (method, params) => {
    const thread = codex.threads.get(params.threadId);
    if (method === 'thread/fork' && !thread?.turns.length) throw new Error(`no rollout found for thread id ${params.threadId}`);
    if (method === 'thread/turns/list' && !thread?.turns.length) throw new Error(`thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
    if (method === 'thread/resume' && !thread?.turns.length) throw new Error(`no rollout found for thread id ${params.threadId}`);
    return original(method, params);
  };
  const opened = await request(`/api/btw/${parent}/open`, {});
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.history.data, []);
  assert.equal((await request(`/api/btw/${parent}/send`, { sessionId: opened.body.session.id, text: 'First question' })).status, 200);
});

test('BTW forks context, persists association, enforces isolated read-only tools and never steers the parent', async t => {
  const { app, request, project, codex, dir } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  await request(`/api/threads/${parent}/send`, { text: 'Main task context' });
  const opened = await request(`/api/btw/${parent}/open`, {});
  assert.equal(opened.status, 200);
  const side = opened.body.session.threadId;
  assert.notEqual(side, parent);
  const start = codex.calls.filter(c => c.method === 'thread/fork').at(-1).params;
  assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.threadId, parent);
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config.web_search, 'live');
  assert.ok(start.baseInstructions.includes('独立的 BTW 侧边对话'));
  assert.ok(start.developerInstructions.includes('主会话仍在继续'));
  assert.equal(start.config['features.multi_agent'], false);
  assert.equal(start.config.mcp_servers.dangerous.enabled, false);
  assert.ok(start.config.mcp_servers.codexwui_btw.args.includes(project.path));
  assert.equal((await request(`/api/btw/${parent}`)).body.session.threadId, side);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'data/btw.json'), 'utf8'))[0].threadId, side);
  assert.ok(!(await request(`/api/threads?project=${project.id}`)).body.data.some(thread => thread.id === side));
  assert.equal((await request(`/api/threads/${side}/send`, { text: 'bypass' })).status, 403);
  assert.equal((await request(`/api/threads/${side}/model`, { model: 'test-fast' })).status, 403);
  assert.equal((await request(`/api/btw/${side}/open`, {})).status, 400);
  await writeFile(path.join(dir, 'readme.txt'), 'read-only contents');
  const content = await codex.dynamicToolHandler({ threadId: side, tool: 'btw_read_file', arguments: { path: 'readme.txt' } });
  assert.ok(content.contentItems[0].text.includes('read-only contents'));
  await assert.rejects(codex.dynamicToolHandler({ threadId: side, tool: 'btw_read_file', arguments: { path: '../outside' } }));
  await assert.rejects(codex.dynamicToolHandler({ threadId: parent, tool: 'btw_read_file', arguments: { path: 'readme.txt' } }));
  await assert.rejects(codex.dynamicToolHandler({ threadId: side, tool: 'exec_command', arguments: { cmd: 'touch bad' } }));
  assert.equal((await request(`/api/btw/${parent}/send`, { text: 'Explain the task', sandbox: 'danger-full-access' })).status, 200);
  const turn = codex.calls.filter(c => c.method === 'turn/start').at(-1).params;
  assert.equal(turn.threadId, side); assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
  assert.equal(turn.approvalPolicy, 'never');
  assert.equal((await request(`/api/btw/${parent}/send`, { text: 'duplicate' })).status, 409);
  assert.equal((await request(`/api/btw/${parent}/stop`, {})).status, 200);
  assert.ok(app.live.get(parent).activeTurnId);
  assert.equal(codex.calls.filter(c => c.method === 'turn/steer').length, 0);
});

test('BTW sends attachment-only messages and preserves attachments through steer edits and queue delivery', async t => {
  const { request, project, codex, app } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  const record = (await request(`/api/btw/${parent}/open`, {})).body.session;
  const image = (await request('/api/images', undefined, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).body;
  const file = (await request('/api/attachments', undefined, { method: 'POST', headers: { 'X-File-Name': 'notes.txt' }, body: 'Side attachment contents' })).body;
  const input = { text: '', images: [image.id], files: [file.id] };
  const control = (action, value) => request(`/api/btw/${parent}/${action}`, { sessionId: record.id, ...value });
  for (const invalid of [{ ...input, files: null }, { ...input, images: null }, { ...input, files: Array(5).fill(file.id) }]) {
    assert.equal((await control('send', invalid)).status, 400);
  }
  assert.equal(codex.calls.some(call => call.method === 'turn/start'), false);
  assert.equal((await control('send', input)).status, 200);
  const turn = codex.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.equal(turn.input[0].type, 'localImage');
  assert.ok(turn.input[1].text.includes(file.id));
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
  const side = turn.threadId;
  const read = await codex.dynamicToolHandler({ threadId: side, tool: 'btw_read_file', arguments: { path: app.btw.attachments.location(file.id) } });
  assert.match(read.contentItems[0].text, /Side attachment contents/);
  const staged = await control('steer', { ...input, expectedTurnId: app.live.get(side).activeTurnId });
  assert.equal(staged.status, 200);
  let entry = staged.body.steers.entries[0];
  entry = (await control('steer-edit', { id: entry.id, revision: entry.revision })).body.entry;
  assert.equal((await control('steer-update', { id: entry.id, revision: entry.revision, text: 'Edited attachment question' })).status, 200);
  entry = app.btw.steers.snapshot(side).entries[0];
  assert.deepEqual(entry.images, [image.id]); assert.deepEqual(entry.files, [file.id]);
  assert.equal((await control('steer-send', { id: entry.id, revision: entry.revision })).status, 200);
  const delivered = codex.calls.filter(call => call.method === 'turn/steer').at(-1).params;
  assert.equal(delivered.threadId, side);
  assert.deepEqual(delivered.input.slice(1), turn.input);
  assert.equal((await control('queue', input)).status, 200);
  codex.complete(side);
  await until(() => codex.threads.get(side).turns.length === 2);
  const queued = codex.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.deepEqual(queued.input, turn.input);
  assert.deepEqual(queued.sandboxPolicy, { type: 'readOnly' });
});

test('BTW browser supports file and image controls like the main composer', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  assert.ok($('btw-image-input'), 'BTW needs an image picker');
  assert.ok($('btw-file-input'), 'BTW needs a file picker');
  for (const [id, file] of [
    ['btw-image-input', new File([png], 'side.png', { type: 'image/png' })],
    ['btw-file-input', new File(['Side notes'], 'side.txt', { type: 'text/plain' })],
  ]) {
    Object.defineProperty($(id), 'files', { configurable: true, value: [file] });
    $(id).dispatchEvent(new window.Event('change'));
  }
  await until(() => $('btw-attachments').textContent.includes('side.txt') && $('btw-attachments').querySelector('img') && !$('btw-send').disabled);
  assert.equal($('image-attachments').hidden, true, 'main draft must stay separate');
  $('btw-prompt').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await until(() => codex.calls.some(call => call.method === 'turn/start') && $('btw-attachments').hidden);
  await until(() => $('btw-messages').querySelector('.message-image') && $('btw-messages').textContent.includes('side.txt'));
  for (const id of ['btw-image-input', 'btw-file-input']) $(id).dispatchEvent(new window.Event('change'));
  await until(() => $('btw-attachments').querySelector('img') && $('btw-attachments').textContent.includes('side.txt') && !$('btw-send').disabled);
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('btw-pending').querySelector('img') && $('btw-attachments').hidden);
  $('btw-pending').querySelector('[data-btw-steer="edit"]').click();
  await until(() => !$('btw-steer-form').hidden);
  assert.ok($('btw-steer-attachments').querySelector('img'));
  $('btw-steer-attachments').querySelector('[data-btw-edit-attachment="files"]').click();
  $('btw-steer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('btw-steer-form').hidden && !$('btw-pending').textContent.includes('side.txt'));
  assert.ok($('btw-pending').querySelector('img'), 'editing must preserve the remaining image');
  assert.deepEqual(errors, []);
});

test('BTW attachment uploads, failures, paste and drop stay with their original side draft', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  const first = $('btw-select').value, originalFetch = window.fetch;
  let release;
  window.fetch = async (url, options) => {
    if (url === '/api/images') await new Promise(resolve => { release = resolve; });
    return originalFetch(url, options);
  };
  const paste = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File([png], 'pasted.png', { type: 'image/png' })] } });
  $('btw-prompt').dispatchEvent(paste);
  await until(() => release);
  assert.equal(paste.defaultPrevented, true); assert.equal($('btw-send').disabled, true);
  $('btw-new').click(); await until(() => $('btw-select').options.length === 2 && !$('btw-prompt').disabled);
  assert.equal($('btw-attachments').hidden, true);
  release(); window.fetch = originalFetch;
  const select = async id => {
    $('btw-select').value = id; $('btw-select').dispatchEvent(new window.Event('change'));
    await until(() => $('btw-select').value === id && !$('btw-prompt').disabled);
  };
  await select(first);
  await until(() => $('btw-attachments').querySelector('img') && !$('btw-send').disabled);
  const drop = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['dropped notes'], 'dropped.txt', { type: 'text/plain' })] } });
  $('btw-form').dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  await until(() => $('btw-attachments').textContent.includes('dropped.txt') && !$('btw-send').disabled);
  window.fetch = (url, options) => String(url).endsWith('/send') ? Promise.resolve(new Response(JSON.stringify({ error: 'Side send failed' }), { status: 503 })) : originalFetch(url, options);
  $('btw-prompt').value = 'Keep question'; $('btw-prompt').dispatchEvent(new window.Event('input'));
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('btw-error').textContent.includes('Side send failed') && !$('btw-prompt').disabled);
  assert.equal($('btw-prompt').value, 'Keep question');
  assert.equal($('btw-attachments').querySelectorAll('[data-btw-remove-attachment]').length, 2);
  window.fetch = (url, options) => url === '/api/images' ? Promise.resolve(new Response(JSON.stringify({ error: 'Side upload failed' }), { status: 500 })) : originalFetch(url, options);
  $('btw-prompt').dispatchEvent(paste);
  await until(() => $('btw-attachments').textContent.includes('Side upload failed'));
  assert.equal($('btw-send').disabled, true);
  [...$('btw-attachments').querySelectorAll('[data-btw-remove-attachment]')].at(-1).click();
  await until(() => !$('btw-send').disabled);
  window.fetch = originalFetch;
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('btw-attachments').hidden && codex.calls.some(call => call.method === 'turn/start'));
  const input = codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input;
  assert.equal(input[1].type, 'localImage'); assert.match(input[2].text, /dropped.txt/);
  assert.equal($('image-attachments').hidden, true);
  assert.deepEqual(errors, []);
});

test('BTW browser command streams in side panel and brings an answer back as a draft only', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  submit('main task');
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const parent = [...codex.threads.keys()][0];
  await until(() => !$('send').disabled);
  submit('/BTW explain');
  await until(() => codex.calls.filter(call => call.method === 'turn/start').length === 2, 'BTW turn');
  const side = [...codex.threads.keys()][1];
  assert.equal($('btw-view').hidden, false);
  assert.equal($('thread-title').textContent.includes('explain'), false);
  assert.ok(!$('messages').textContent.includes('explain'));
  const turn = codex.threads.get(side).turns.at(-1);
  const answer = { id: 'btw-answer', type: 'agentMessage', text: 'Side answer <script>bad()</script>' };
  turn.items.push(answer);
  codex.event('item/completed', { threadId: side, turnId: turn.id, item: answer });
  codex.complete(side);
  await until(() => window.document.querySelector('[data-btw-bring]'));
  assert.ok($('btw-messages').textContent.includes('Side answer'));
  assert.ok(!$('btw-messages').textContent.includes('主会话仍在继续'));
  assert.ok(!$('btw-messages').textContent.includes('main task'));
  assert.ok(!$('messages').textContent.includes('Side answer'));
  assert.equal($('btw-messages').querySelector('script'), null);
  $('prompt').value = 'Existing draft';
  window.document.querySelector('[data-btw-bring]').click();
  assert.ok($('prompt').value.startsWith('Existing draft\n\nBTW 讨论结论：'));
  assert.ok($('prompt').value.includes('Side answer'));
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 0);
  assert.equal(codex.threads.get(parent).status.type, 'active');
  assert.deepEqual(errors, []);
});

test('BTW restores saved associations after service recreation and reapplies read-only policy', async t => {
  const f = await fixture(t);
  const parent = (await f.request('/api/threads', { project: f.project.id })).body.thread.id;
  await f.request(`/api/threads/${parent}/send`, { text: 'Persistent parent context' });
  f.codex.complete(parent);
  const record = (await f.request(`/api/btw/${parent}/open`, {})).body.session;
  await f.app.close();
  const restored = await createApp({ codex: f.codex, initialProject: f.dir, dataDir: path.join(f.dir, 'data') });
  await restored.startup;
  t.after(() => restored.close());
  assert.equal(restored.btw.records.get(record.id).threadId, record.threadId);
  const count = f.codex.calls.filter(call => call.method === 'thread/start').length;
  await restored.btw.send(parent, 'Continue after restart');
  assert.equal(f.codex.calls.filter(call => call.method === 'thread/start').length, count);
  const resume = f.codex.calls.filter(call => call.method === 'thread/resume').at(-1).params;
  assert.equal(resume.threadId, record.threadId);
  assert.equal(resume.sandbox, 'read-only');
  assert.equal(resume.approvalPolicy, 'never');
  await restored.close();
});

test('BTW keeps per-parent drafts and preserves a failed question', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  const first = [...codex.threads.keys()][0];
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  $('btw-prompt').value = 'First draft'; $('btw-prompt').dispatchEvent(new window.Event('input'));
  $('new-thread').click(); await until(() => codex.threads.size === 2 && $('btw-prompt').value === '');
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  $('btw-prompt').value = 'Second draft'; $('btw-prompt').dispatchEvent(new window.Event('input'));
  window.document.querySelector(`[data-thread="${first}"]`).click();
  await until(() => $('btw-prompt').value === 'First draft');
  const original = window.fetch;
  window.fetch = (url, options) => String(url).includes('/api/btw/') && String(url).endsWith('/send') ? Promise.resolve({ ok: false, json: async () => ({ error: 'Temporary failure' }) }) : original(url, options);
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('btw-error').textContent.includes('Temporary failure'));
  assert.equal($('btw-prompt').value, 'First draft');
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.deepEqual(errors, []);
});

test('BTW switches independent drafts under one parent and stops only the selected side chat', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  const first = $('btw-select').value;
  $('btw-prompt').value = 'First side draft'; $('btw-prompt').dispatchEvent(new window.Event('input'));
  $('btw-new').click(); await until(() => $('btw-select').options.length === 2 && !$('btw-prompt').disabled);
  const second = $('btw-select').value;
  assert.notEqual(first, second);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 0);
  $('btw-prompt').value = 'Second side draft'; $('btw-prompt').dispatchEvent(new window.Event('input'));
  const select = async id => {
    $('btw-select').value = id; $('btw-select').dispatchEvent(new window.Event('change'));
    await until(() => $('btw-select').value === id && !$('btw-prompt').disabled);
  };
  await select(first);
  assert.equal($('btw-prompt').value, 'First side draft');
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => codex.calls.filter(call => call.method === 'turn/start').length === 1 && !$('btw-stop').hidden);
  const firstThread = codex.calls.filter(call => call.method === 'turn/start')[0].params.threadId;
  await select(second);
  assert.equal($('btw-prompt').value, 'Second side draft');
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => codex.calls.filter(call => call.method === 'turn/start').length === 2 && !$('btw-stop').hidden);
  const secondThread = codex.calls.filter(call => call.method === 'turn/start')[1].params.threadId;
  $('btw-stop').click();
  await until(() => codex.threads.get(secondThread).status.type === 'idle');
  assert.equal(codex.threads.get(firstThread).status.type, 'active');
  await select(first);
  assert.equal($('btw-stop').hidden, false);
  assert.ok($('btw-messages').textContent.includes('First side draft'));
  assert.ok(!$('btw-messages').textContent.includes('Second side draft'));
  assert.deepEqual(errors, []);
});

test('BTW blank-parent branches stay blank even if the parent progresses before the first side question', async t => {
  const { request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  const record = (await request(`/api/btw/${parent}/open`, {})).body.session;
  assert.equal(record.threadId, null);
  await request(`/api/threads/${parent}/send`, { text: 'Later main context' }); codex.complete(parent);
  assert.equal((await request(`/api/btw/${parent}/send`, { sessionId: record.id, text: 'Side question' })).status, 200);
  const side = codex.threads.get(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.threadId);
  assert.equal(side.turns.length, 1);
  assert.equal(side.turns[0].items[0].content[0].text, 'Side question');
});

test('BTW preserves streamed text and completion arriving before the send response', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  const original = window.fetch; let release;
  window.fetch = async (url, options) => {
    const response = await original(url, options);
    if (String(url).includes('/api/btw/') && String(url).endsWith('/send')) await new Promise(resolve => { release = resolve; });
    return response;
  };
  $('btw-prompt').value = 'Question';
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => release);
  const side = [...codex.threads.values()].at(-1), turn = side.turns.at(-1);
  const item = { id: 'early-answer', type: 'agentMessage', text: 'Early streamed answer' };
  codex.event('item/agentMessage/delta', { threadId: side.id, turnId: turn.id, itemId: item.id, delta: item.text });
  await until(() => $('btw-messages').textContent.includes(item.text));
  release(); await until(() => !$('btw-prompt').disabled);
  assert.ok($('btw-messages').textContent.includes(item.text));
  // Another response can finish before its HTTP acknowledgement as well.
  turn.items.push(item); codex.complete(side.id);
  await until(() => $('btw-stop').hidden);
  $('btw-prompt').value = 'Follow-up';
  release = null;
  $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => release);
  await until(() => !$('btw-stop').hidden);
  codex.complete(side.id);
  await until(() => $('btw-stop').hidden);
  release(); await until(() => !$('btw-prompt').disabled);
  assert.equal($('btw-stop').hidden, true);
  assert.deepEqual(errors, []);
});

test('BTW stages, edits and recalls steers and queues read-only turns independently of its parent', async t => {
  const { app, request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  await request(`/api/threads/${parent}/send`, { text: 'Parent work' });
  const record = (await request(`/api/btw/${parent}/open`, {})).body.session;
  const side = record.threadId;
  await request(`/api/btw/${parent}/send`, { sessionId: record.id, text: 'Side question' });
  const turnId = codex.threads.get(side).turns.at(-1).id;
  const control = (action, input = {}) => request(`/api/btw/${parent}/${action}`, { sessionId: record.id, ...input });
  let result = await control('steer', { text: 'Original steer', expectedTurnId: turnId, clientUserMessageId: 'btw-steer-one' });
  assert.equal(result.status, 200);
  let entry = result.body.steers.entries[0];
  assert.equal(entry.status, 'staged');
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 0);
  result = await control('steer-edit', { id: entry.id, revision: entry.revision });
  entry = result.body.entry;
  codex.boundary(side);
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 0);
  result = await control('steer-update', { id: entry.id, revision: entry.revision, text: 'Updated steer', sandbox: 'danger-full-access' });
  assert.equal(result.status, 200);
  codex.boundary(side);
  await until(() => codex.calls.some(call => call.method === 'turn/steer'));
  const steer = codex.calls.find(call => call.method === 'turn/steer').params;
  assert.equal(steer.threadId, side);
  assert.equal(steer.input[0].text, 'Updated steer');
  codex.consumeSteers(side);
  assert.deepEqual((await request(`/api/btw/${parent}?session=${record.id}`)).body.steers.entries, []);
  result = await control('steer', { text: 'Recall me', expectedTurnId: turnId, clientUserMessageId: 'btw-steer-two' });
  entry = result.body.steers.entries[0];
  assert.equal((await control('steer-remove', { id: entry.id, revision: entry.revision })).status, 200);
  await control('queue', { text: 'Queued side question', sandbox: 'danger-full-access' });
  result = await request(`/api/btw/${parent}?session=${record.id}`);
  assert.equal(result.body.queue.entries.length, 1);
  assert.equal(codex.threads.get(parent).turns.length, 1);
  codex.complete(side);
  await until(() => codex.threads.get(side).turns.length === 3);
  const next = codex.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.equal(next.threadId, side);
  assert.equal(next.input[0].text, 'Queued side question');
  assert.deepEqual(next.sandboxPolicy, { type: 'readOnly' });
  assert.equal(next.approvalPolicy, 'never');
  assert.ok(!JSON.stringify(next).includes('visualization instructions'));
  assert.equal(codex.threads.get(parent).turns.length, 1);
  await until(() => app.btw.queue.snapshot(record.id).entries.length === 0);
});

test('BTW queues pause on stop, restore on refresh and can resume or remove entries only within their own side', async t => {
  const { request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  const first = (await request(`/api/btw/${parent}/open`, {})).body.session;
  const second = (await request(`/api/btw/${parent}/open`, {})).body.session;
  const control = (sessionId, action, input = {}) => request(`/api/btw/${parent}/${action}`, { sessionId, ...input });
  await control(first.id, 'send', { text: 'First question' });
  await control(second.id, 'send', { text: 'Other side' });
  let result = await control(first.id, 'queue', { text: 'Keep after stop' });
  const entryId = result.body.queue.entries[0].id;
  await control(first.id, 'queue', { text: 'Remove this' });
  await control(first.id, 'stop');
  result = await request(`/api/btw/${parent}?session=${first.id}`);
  assert.equal(result.body.queue.paused, true);
  assert.equal(result.body.queue.entries[0].id, entryId);
  const side = result.body.session.threadId;
  const other = (await request(`/api/btw/${parent}?session=${second.id}`)).body;
  assert.deepEqual(other.queue.entries, []);
  assert.ok(other.live.activeTurnId);
  const removed = result.body.queue.entries[1].id;
  await control(first.id, 'queue-remove', { id: removed });
  const count = codex.threads.get(side).turns.length;
  await control(first.id, 'queue-run');
  assert.equal(codex.threads.get(side).turns.length, count + 1);
  assert.equal(codex.threads.get(side).turns.at(-1).items[0].content[0].text, 'Keep after stop');
});

test('BTW queued completion before turn-start acknowledgement drains after releasing the side lock', async t => {
  const { request, project, codex } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  const record = (await request(`/api/btw/${parent}/open`, {})).body.session;
  const original = codex.request.bind(codex); let first = true;
  codex.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start' && first) {
      first = false;
      await request(`/api/btw/${parent}/queue`, { sessionId: record.id, text: 'Queued during start' });
      codex.complete(params.threadId);
    }
    return result;
  };
  assert.equal((await request(`/api/btw/${parent}/send`, { sessionId: record.id, text: 'Fast completion' })).status, 200);
  await until(() => codex.calls.filter(call => call.method === 'turn/start').length === 2);
  const side = (await request(`/api/btw/${parent}?session=${record.id}`)).body;
  assert.equal(side.queue.paused, false);
  assert.equal(side.queue.error, null);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start')[1].params.input[0].text, 'Queued during start');
});

test('BTW browser steers can be edited and recalled, while queued messages survive switching and refresh', async t => {
  const f = await browserFixture(t);
  const { window, $, submit, codex, errors } = f;
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  const parent = [...codex.threads.keys()][0];
  submit('/btw First side question');
  await until(() => codex.calls.some(call => call.method === 'turn/start') && !$('btw-prompt').disabled);
  const side = codex.calls.find(call => call.method === 'turn/start').params.threadId;
  const first = $('btw-select').value;
  assert.equal($('btw-send-mode').hidden, false);
  assert.equal($('btw-send').textContent, '引导 ↑');
  const send = async text => {
    $('btw-prompt').value = text;
    $('btw-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !$('btw-prompt').disabled && $('btw-prompt').value === '');
  };
  await send('Original steer');
  await until(() => $('btw-pending').textContent.includes('Original steer'));
  $('btw-pending').querySelector('[data-btw-steer="edit"]').click();
  await until(() => !$('btw-steer-form').hidden);
  $('btw-steer-text').value = 'Edited steer'; $('btw-steer-text').dispatchEvent(new window.Event('input'));
  codex.boundary(side);
  assert.equal(codex.calls.filter(call => call.method === 'turn/steer').length, 0);
  $('btw-steer-cancel').click();
  await until(() => $('btw-steer-form').hidden);
  assert.ok($('btw-pending').textContent.includes('Original steer'));
  $('btw-pending').querySelector('[data-btw-steer="edit"]').click();
  await until(() => !$('btw-steer-form').hidden);
  $('btw-steer-text').value = 'Edited steer'; $('btw-steer-text').dispatchEvent(new window.Event('input'));
  $('btw-steer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('btw-steer-form').hidden && $('btw-pending').textContent.includes('Edited steer'));
  $('btw-pending').querySelector('[data-btw-steer="remove"]').click();
  await until(() => !$('btw-pending').textContent.includes('Edited steer'));
  await send('Deliver this steer');
  codex.boundary(side);
  await until(() => codex.calls.some(call => call.method === 'turn/steer'));
  assert.equal(codex.calls.find(call => call.method === 'turn/steer').params.threadId, side);
  codex.consumeSteers(side);
  await until(() => !$('btw-pending').textContent.includes('Deliver this steer'));
  assert.ok($('btw-messages').textContent.includes('Deliver this steer'));
  $('btw-send-mode').value = 'queue'; $('btw-send-mode').dispatchEvent(new window.Event('change'));
  assert.equal($('btw-send').textContent, '排队 ＋');
  await send('Queued side message');
  await until(() => $('btw-pending').textContent.includes('Queued side message'));
  $('btw-new').click(); await until(() => $('btw-select').options.length === 2 && !$('btw-prompt').disabled);
  assert.ok(!$('btw-pending').textContent.includes('Queued side message'));
  $('btw-select').value = first; $('btw-select').dispatchEvent(new window.Event('change'));
  await until(() => $('btw-pending').textContent.includes('Queued side message'));
  const restored = await browserFixture(t, f);
  await until(() => restored.$('thread-list').querySelector(`[data-thread="${parent}"]`));
  restored.$('thread-list').querySelector(`[data-thread="${parent}"]`).click();
  await until(() => !restored.$('send').disabled);
  restored.window.document.querySelector('[data-view="btw"]').click();
  await until(() => restored.$('btw-select').options.length === 2);
  restored.$('btw-select').value = first; restored.$('btw-select').dispatchEvent(new restored.window.Event('change'));
  await until(() => restored.$('btw-pending').textContent.includes('Queued side message'));
  codex.complete(side);
  await until(() => restored.$('btw-messages').textContent.includes('Queued side message'));
  await until(() => !restored.$('btw-pending').textContent.includes('Queued side message'));
  assert.equal(codex.threads.get(parent).turns.length, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(restored.errors, []);
});

test('BTW migrates old associations without losing history and reports an unpersisted legacy side clearly', async t => {
  const { app, request, project, codex, dir } = await fixture(t);
  const parent = (await request('/api/threads', { project: project.id })).body.thread.id;
  const { thread: old } = await codex.request('thread/start', { cwd: project.path });
  await codex.request('turn/start', { threadId: old.id, input: [{ type: 'text', text: 'Old question' }] }); codex.complete(old.id);
  const { thread: missing } = await codex.request('thread/start', { cwd: project.path });
  const records = [old, missing].map(thread => ({ parentId: parent, threadId: thread.id, cwd: project.path, createdAt: 1 }));
  await writeFile(path.join(dir, 'data/btw.json'), JSON.stringify(records));
  await app.btw.load();
  const restored = await request(`/api/btw/${parent}?session=${old.id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.history.data[0].items[0].content[0].text, 'Old question');
  assert.equal(restored.body.sessions.length, 2);
  codex.event('thread/closed', { threadId: missing.id });
  const original = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method === 'thread/resume' && params.threadId === missing.id) throw new Error(`no rollout found for thread id ${missing.id}`);
    return original(method, params);
  };
  const count = codex.calls.filter(call => call.method === 'turn/start').length;
  const rejected = await request(`/api/btw/${parent}/send`, { sessionId: missing.id, text: 'Continue' });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /无法恢复原上下文/);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, count);
  assert.equal((await request(`/api/btw/${parent}/open`, {})).status, 200);
  assert.equal(app.btw.records.get(old.id).threadId, old.id);
});

test('reload API is same-origin, works when Codex is disconnected and prepares only one restart', async t => {
  let prepares = 0;
  const { request, codex } = await fixture(t, { reload: async () => { prepares++; return () => {}; } });
  codex.fail(new Error('Disconnected'));
  const denied = await request('/api/reload', {}, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403); assert.equal(prepares, 0);
  const before = (await request('/api/bootstrap')).body;
  const [one, two] = await Promise.all([request('/api/reload', {}), request('/api/reload', {})]);
  assert.equal(one.status, 202); assert.equal(two.status, 202); assert.equal(prepares, 1);
  assert.equal(one.body.serverInstance, before.serverInstance);
  assert.equal((await request('/api/threads', { project: 'anything' })).status, 503);
});

test('browser reload saves main and BTW drafts and can be requested while disconnected', async t => {
  const { window, $, submit, codex, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  const id = [...codex.threads.keys()][0];
  submit('/btw'); await until(() => $('btw-select').options.length === 1 && !$('btw-prompt').disabled);
  const sideId = $('btw-select').value;
  $('btw-prompt').value = 'Keep side draft'; $('btw-prompt').dispatchEvent(new window.Event('input'));
  Object.defineProperty($('btw-image-input'), 'files', { configurable: true, value: [new File([png], 'saved-side.png', { type: 'image/png' })] });
  $('btw-image-input').dispatchEvent(new window.Event('change'));
  await until(() => $('btw-attachments').querySelector('img') && !$('btw-send').disabled);
  codex.fail(new Error('Disconnected'));
  await until(() => $('connection-label').textContent !== 'Codex 已连接');
  const original = window.fetch;
  let requested = 0;
  window.fetch = (url, options) => {
    if (url === '/api/reload') { requested++; return Promise.resolve({ ok: false, json: async () => ({ error: 'test reload rejected' }) }); }
    return original(url, options);
  };
  submit('/reload');
  await until(() => window.document.querySelector('.reload-status').textContent.includes('test reload rejected'));
  assert.equal(requested, 1);
  const saved = JSON.parse(window.sessionStorage.getItem('codex-reload-drafts'));
  assert.equal(new Map(saved.drafts).get(id).text, '');
  assert.equal(new Map(saved.btw).get(sideId), 'Keep side draft');
  assert.equal(new Map(saved.btwSelected).get(id), sideId);
  const attachments = new Map(saved.btwAttachments).get(sideId);
  assert.equal(attachments[0].name, 'saved-side.png');
  assert.ok(attachments[0].id);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.deepEqual(errors, []);
});

test('browser queue edits stay unsent and single continuation leaves other stopped messages intact', async t => {
  const { window, $, submit, codex, request, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  const id = [...codex.threads.keys()][0];
  submit('work'); await until(() => codex.threads.get(id).turns.length === 1);
  await request(`/api/threads/${id}/queue`, { text: 'first stopped' });
  await request(`/api/threads/${id}/queue`, { text: 'second stopped' });
  await request(`/api/threads/${id}/stop`, {});
  await until(() => $('queue-list').textContent.includes('未发出'));
  $('queue-list').querySelector('[data-queue-action="edit"]').click();
  await until(() => $('queue-list').querySelector('textarea'));
  const textarea = $('queue-list').querySelector('textarea');
  textarea.value = 'edited first'; textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  $('queue-list').querySelector('[data-queue-action="update"]').click();
  await until(() => !$('queue-list').querySelector('textarea') && $('queue-list').textContent.includes('edited first'));
  const resume = [...$('queue-list').querySelectorAll('[data-queue-action="run"]')].find(button => button.dataset.entry);
  resume.click(); await until(() => codex.threads.get(id).turns.length === 2);
  assert.equal(codex.threads.get(id).turns.at(-1).items[0].content[0].text, 'edited first');
  codex.complete(id); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(codex.threads.get(id).turns.length, 2);
  assert.ok($('queue-list').textContent.includes('second stopped'));
  $('queue-list').querySelector('[data-queue-action="remove"]').click();
  await until(() => !$('queue-list').textContent.includes('second stopped'));
  assert.deepEqual(errors, []);
});

test('BTW queue supports withdraw edit, delete and explicit continuation', async t => {
  const { window, $, submit, codex, request, errors } = await browserFixture(t);
  $('new-thread').click(); await until(() => codex.threads.size === 1);
  const parent = [...codex.threads.keys()][0];
  submit('/btw question'); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  const sessionId = $('btw-select').value;
  await request(`/api/btw/${parent}/queue`, { sessionId, text: 'side next' });
  await request(`/api/btw/${parent}/stop`, { sessionId });
  await until(() => $('btw-pending').querySelector('[data-btw-queue="edit"]'));
  $('btw-pending').querySelector('[data-btw-queue="edit"]').click();
  await until(() => $('btw-pending').querySelector('textarea'));
  const textarea = $('btw-pending').querySelector('textarea');
  textarea.value = 'revised side'; textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  $('btw-pending').querySelector('[data-btw-queue="update"]').click();
  await until(() => !$('btw-pending').querySelector('textarea'));
  $('btw-pending').querySelector('[data-btw-queue="run"]').click();
  await until(() => codex.calls.filter(c => c.method === 'turn/start').length === 2);
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text, 'revised side');
  assert.deepEqual(errors, []);
});

test('thread switching still hydrates history when an older service cannot serve queue.js', async t => {
  const f = await fixture(t);
  const first = (await f.request('/api/threads', { project: f.project.id })).body.thread.id;
  const second = (await f.request('/api/threads', { project: f.project.id })).body.thread.id;
  await f.request(`/api/threads/${second}/send`, { text: 'target thread history' });
  f.codex.complete(second);
  const historyRequests = [];
  const { window, $, errors } = await browserFixture(t, f, window => {
    // A failed classic script is skipped by the browser; subsequent scripts run.
    // Reproduce the live old-process/new-assets deployment where /queue.js is 404.
    window.document.querySelector('script[src="/queue.js"]')?.remove();
    const fetch = window.fetch;
    window.fetch = (url, options) => {
      if (url === `/api/threads/${second}`) historyRequests.push(url);
      return fetch(url, options);
    };
  });
  await until(() => window.document.querySelector(`[data-thread="${second}"]`), 'thread sidebar');
  window.document.querySelector(`[data-thread="${first}"]`).click();
  window.document.querySelector(`[data-thread="${second}"]`).click();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(errors.some(message => /reading ['"]html|property ['"]html/.test(message)), false, errors.join('\n'));
  await until(() => $('messages').textContent.includes('target thread history'), 'switched thread history');
  assert.ok(historyRequests.length, 'switch must start loading history immediately');
  assert.equal(errors.some(message => /reading ['"]html|property ['"]html/.test(message)), false, errors.join('\n'));
});

test('authority updates future turns only, validates modes, restores local defaults and survives reload', async t => {
  const f = await fixture(t), { request, project, codex, app, dir } = f;
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const other = (await request('/api/threads', { project: project.id })).body.thread.id;
  await request(`/api/threads/${id}/send`, { text: 'running task' });
  const before = structuredClone(codex.calls.find(c => c.method === 'turn/start'));
  const save = await request(`/api/threads/${id}/model`, { model: 'test-fast', effort: 'medium', authority: 'read-only' });
  assert.equal(save.status, 200); assert.equal(save.body.appliesTo, 'nextTurn');
  assert.equal(save.body.authority, 'read-only');
  assert.equal(codex.threads.get(id).permissions, ':read-only');
  assert.deepEqual(codex.calls.find(c => c.method === 'turn/start'), before);
  assert.equal((await request(`/api/threads/${other}`)).body.authority, 'default');
  assert.equal((await request(`/api/threads/${id}/model`, { model: 'test-fast', authority: 'invented' })).status, 400);
  assert.equal((await request(`/api/threads/${id}`)).body.authority, 'read-only');
  assert.equal((await request(`/api/threads/${id}`)).body.pendingAuthority, true);
  const originalRequest = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method === 'thread/settings/update' && params.permissions === ':danger-full-access') throw new Error('权限受本机要求限制');
    return originalRequest(method, params);
  };
  assert.equal((await request(`/api/threads/${id}/model`, { model: 'test-fast', authority: 'full' })).status, 500);
  assert.equal((await request(`/api/threads/${id}`)).body.authority, 'read-only');
  codex.complete(id); await app.close();
  const restored = await createApp({ codex, dataDir: path.join(dir, 'data'), initialProject: dir });
  t.after(() => restored.close());
  restored.server.listen(0, '127.0.0.1'); await once(restored.server, 'listening'); await restored.startup;
  const url = `http://127.0.0.1:${restored.server.address().port}/api/threads/${id}`;
  assert.equal((await (await fetch(url)).json()).authority, 'read-only');
  const post = data => fetch(url + '/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const reset = await post({ model: 'test-fast', effort: 'medium', authority: 'default' });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).authority, 'default');
  const updates = codex.calls.filter(c => c.method === 'thread/settings/update');
  assert.ok(updates.some(c => c.params.permissions === ':read-only'), 'saved choice is reapplied on resume');
  assert.equal(updates.at(-1).params.approvalPolicy, 'on-request');
  assert.equal(updates.at(-1).params.sandboxPolicy.type, 'workspaceWrite');
  await restored.close();
});

test('context entry separates snapshot occupancy from cumulative usage, compacts and restores after reconnect', async t => {
  const f = await browserFixture(t), { $, window, submit, codex, request, errors } = f;
  submit('usage task'); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  const id = [...codex.threads.keys()][0], turnId = codex.threads.get(id).turns[0].id;
  await until(() => !$('context-strip').hidden);
  assert.equal($('context-label').textContent, '上下文 —');
  const counts = totalTokens => ({ totalTokens, inputTokens: totalTokens - 1000, cachedInputTokens: 1000, outputTokens: 1000, reasoningOutputTokens: 400 });
  const report = (used, total) => codex.event('thread/tokenUsage/updated', { threadId: id, turnId, tokenUsage: { last: counts(used), total: counts(total), modelContextWindow: 100000 } });
  report(85000, 500000);
  await until(() => $('context-label').textContent === '上下文已用 85%');
  assert.equal($('context-strip').classList.contains('high'), true);
  $('context-usage').click(); assert.equal($('usage-dialog').open, true);
  assert.equal($('usage-total').textContent, '500k');
  assert.equal($('usage-compact').disabled, true, 'running tasks cannot compact manually');
  codex.complete(id); await until(() => !$('usage-compact').disabled);
  $('usage-compact').click(); await until(() => codex.calls.some(c => c.method === 'thread/compact/start'));
  codex.event('item/started', { threadId: id, turnId, item: { id: 'compact-1', type: 'contextCompaction' } });
  await until(() => $('context-label').textContent === '正在压缩…');
  report(20000, 520000);
  codex.event('item/completed', { threadId: id, turnId, item: { id: 'compact-1', type: 'contextCompaction' } });
  await until(() => $('context-label').textContent === '上下文已用 20%');
  assert.equal($('usage-total').textContent, '520k');
  assert.match($('context-status').textContent, /85% → 20%/);
  const other = (await request('/api/threads', { project: f.project.id })).body.thread.id;
  codex.event('thread/tokenUsage/updated', { threadId: other, turnId: 'other-turn', tokenUsage: { last: counts(90000), total: counts(90000), modelContextWindow: 100000 } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal($('context-label').textContent, '上下文已用 20%');
  const reconnect = await browserFixture(t, f);
  await until(() => reconnect.window.document.querySelector(`[data-thread="${id}"]`));
  reconnect.window.document.querySelector(`[data-thread="${id}"]`).click();
  await until(() => reconnect.$('context-label').textContent === '上下文已用 20%');
  assert.equal($('composer-hint'), null);
  assert.match($('model-label').textContent, /test-fast \/ medium \/ 默认/);
  $('close-usage-dialog').click(); $('model-label').click();
  await until(() => $('model-dialog').open);
  $('authority-select').value = 'workspace'; $('authority-select').dispatchEvent(new window.Event('change'));
  $('model-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !$('model-dialog').open && $('model-label').textContent.includes('工作区'));
  assert.equal((await request(`/api/threads/${id}`)).body.authority, 'workspace');
  assert.deepEqual(errors, []); assert.deepEqual(reconnect.errors, []);
});

test('config initial authority picker updates only subsequently created conversations', async t => {
  const { $, window, submit, codex, errors } = await browserFixture(t);
  submit('existing'); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  const old = [...codex.threads.keys()][0]; codex.complete(old);
  submit('/config'); await until(() => $('config-dialog').open && !$('config-form').querySelector('[data-config-save]').disabled);
  $('config-defaultAuthority').value = 'read-only'; $('config-defaultAuthority').dispatchEvent(new window.Event('change'));
  $('config-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => $('config-form').querySelector('[data-config-status]').textContent.startsWith('已保存'));
  assert.match($('model-label').textContent, /默认/);
  $('config-dialog').close(); $('new-thread').click();
  await until(() => codex.threads.size === 2 && $('model-label').textContent.includes('只读'));
  assert.equal(codex.calls.filter(c => c.method === 'thread/start').at(-1).params.permissions, ':read-only');
  assert.deepEqual(errors, []);
});

test('failed turns recover the persisted original attachments and skills exactly once, while successors stay paused', async t => {
  const { app, request, project, codex, base } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const image = await (await fetch(base + '/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  const file = await (await fetch(base + '/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'notes.txt' }, body: 'notes' })).json();
  const payload = { text: 'Use my notes', images: [image.id], files: [file.id], skills: [{ name: 'example', path: codex.cwd + '/SKILL.md' }], clientUserMessageId: 'original-request' };
  const sent = await request(`/api/threads/${id}/send`, payload);
  assert.equal(sent.status, 200);
  const original = codex.calls.find(call => call.method === 'turn/start').params.input;
  await request(`/api/threads/${id}/queue`, { text: 'wait for recovery' });
  codex.threads.get(id).turns.at(-1).error = { message: 'unexpected status 403 Forbidden: <html>blocked</html>', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } };
  codex.complete(id, 'failed');
  await until(() => !app.lifecycle.cleaning.has(id));
  const snapshot = (await request(`/api/threads/${id}`)).body;
  assert.equal(snapshot.history.data[0].failure.category, 'access');
  assert.equal(snapshot.history.data[0].recoveryMode, 'retry');
  const saved = JSON.parse(await readFile(path.join(app.recovery.file.file), 'utf8'));
  assert.equal(saved[0][1].input.files[0], file.id);
  const action = { action: 'retry', turnId: sent.body.turn.id, actionId: 'retry-once' };
  const results = await Promise.all([request(`/api/threads/${id}/recover`, action), request(`/api/threads/${id}/recover`, action)]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.deepEqual(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.input, original);
  codex.complete(id);
  assert.equal(app.queue.snapshot(id).entries[0].status, 'unsent');
  assert.equal((await request(`/api/threads/${id}/send`, payload)).body.turn.id, sent.body.turn.id);
  assert.equal((await request(`/api/threads/${id}/send`, { ...payload, text: 'different' })).status, 409);
});

test('partial execution offers continuation, preserves the original objective and supports explicit model switching', async t => {
  const { app, request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const sent = await request(`/api/threads/${id}/send`, { text: 'Update the project', clientUserMessageId: 'partial-original' });
  codex.threads.get(id).turns.at(-1).items.push({ id: 'tool', type: 'commandExecution', command: 'write result', status: 'completed' });
  codex.complete(id, 'failed');
  await until(() => !app.lifecycle.cleaning.has(id));
  const target = { turnId: sent.body.turn.id, actionId: 'continue-once' };
  assert.equal((await request(`/api/threads/${id}/recover`, { ...target, action: 'retry' })).status, 409);
  assert.equal((await request(`/api/threads/${id}/recover`, { ...target, action: 'continue', model: 'test-deep', effort: 'high' })).status, 200);
  const last = codex.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.equal(last.model, 'test-deep'); assert.equal(last.effort, 'high');
  assert.match(last.input[0].text, /先核对历史中的工具执行结果/);
  assert.equal(app.recovery.records.get('continue-once').input.text, 'Update the project');
});

test('lost acknowledgement is reconciled by client identity instead of blindly resending', async t => {
  const { app, request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const native = codex.request.bind(codex);
  codex.request = async (method, params) => {
    const result = await native(method, params);
    if (method === 'turn/start') throw Object.assign(new Error('response lost'), { rpcTimeout: true });
    return result;
  };
  const payload = { text: 'Only once', clientUserMessageId: 'uncertain-request' };
  const failed = await request(`/api/threads/${id}/send`, payload);
  assert.equal(failed.body.deliveryUnknown, true);
  assert.equal((await request(`/api/threads/${id}/send`, payload)).status, 409);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 1);
  const checked = await request(`/api/threads/${id}/recover`, { action: 'check' });
  assert.equal(checked.body.recovery[0].state, 'running');
  assert.equal(checked.body.recovery[0].turnId, codex.threads.get(id).turns[0].id);
  assert.equal((await request(`/api/threads/${id}/send`, payload)).status, 200);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(app.recovery.records.get('uncertain-request').state, 'running');
});

test('turn counting spans all pages and native fork boundaries preserve inherited history with the requested title', async t => {
  const { request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const source = codex.threads.get(id); source.name = 'Original';
  source.turns = Array.from({ length: 125 }, (_, i) => ({ id: `number-${i + 1}`, status: 'completed', items: [{ id: `user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Q${i}` }] }] }));
  source.turns[9].items.push({ id: 'compaction', type: 'contextCompaction' });
  assert.equal((await request(`/api/threads/${id}/turn-count`)).body.count, 125);
  const input = { turnId: 'number-11', actionId: 'fork-eleven' };
  const forks = await Promise.all([request(`/api/threads/${id}/fork`, input), request(`/api/threads/${id}/fork`, input)]);
  assert.deepEqual(forks.map(result => result.status), [200, 200]);
  assert.equal(forks[0].body.thread.id, forks[1].body.thread.id);
  const fork = forks[0].body.thread;
  assert.equal(fork.name, 'fork Original');
  assert.equal((await request(`/api/threads/${fork.id}/turn-count`)).body.count, 11);
  assert.deepEqual(codex.threads.get(fork.id).turns, source.turns.slice(0, 11));
  assert.equal(codex.calls.filter(call => call.method === 'thread/fork').length, 1);
  assert.equal(source.turns.length, 125);
  source.turns.at(-1).status = 'inProgress';
  assert.equal((await request(`/api/threads/${id}/fork`, { turnId: 'number-125', actionId: 'unfinished' })).status, 409);
  const before = await request(`/api/threads/${id}/fork`, { turnId: 'number-11', before: true, actionId: 'fork-before' });
  assert.equal(before.body.thread.turns.length, 10);
});

test('stop cancels a recovery that is waiting for failed-turn cleanup', async t => {
  const { app, request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const sent = await request(`/api/threads/${id}/send`, { text: 'work' });
  const native = codex.request.bind(codex); let release;
  codex.request = async (method, params) => {
    if (method === 'thread/backgroundTerminals/clean') await new Promise(resolve => { release = resolve; });
    return native(method, params);
  };
  codex.complete(id, 'failed'); await until(() => release);
  const recovering = request(`/api/threads/${id}/recover`, { action: 'retry', turnId: sent.body.turn.id, actionId: 'cancelled-recovery' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const stopping = request(`/api/threads/${id}/stop`, {});
  await new Promise(resolve => setTimeout(resolve, 50)); release();
  assert.equal((await stopping).status, 200);
  assert.equal((await recovering).status, 409);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('browser shows the count beside 会话, folds raw errors, displays native retries and forks at a turn footer', async t => {
  const { window, $, submit, codex, errors, app } = await browserFixture(t);
  submit('Original question');
  await until(() => codex.calls.some(call => call.method === 'turn/start'));
  const id = [...codex.threads.keys()][0], first = codex.threads.get(id).turns[0];
  await until(() => $('turn-count').textContent === ' · 第 1 轮');
  assert.equal($('turn-count').parentElement.className, 'conversation-label');
  codex.event('error', { threadId: id, turnId: first.id, willRetry: true, error: { message: 'upstream retry' } });
  await until(() => $('messages').querySelector('.turn-retrying'));
  assert.equal($('messages').querySelector('[data-turn-action="retry"]'), null);
  first.error = { message: 'unexpected status 403 Forbidden: <html>raw-error-body</html>' };
  codex.complete(id, 'failed');
  await until(() => $('messages').querySelector('[data-turn-action="retry"]'));
  const card = $('messages').querySelector('.turn-failure');
  assert.match(card.querySelector('p').textContent, /403/);
  assert.match(card.querySelector('details pre').textContent, /<html>raw-error-body/);
  assert.equal(card.querySelector('details').open, false);
  assert.equal(card.querySelector('html'), null);
  await until(() => !app.lifecycle.cleaning.has(id));
  $('messages').querySelector('[data-turn-action="model"]').click();
  await until(() => $('model-dialog').open);
  $('model-select').value = 'test-deep'; $('model-select').dispatchEvent(new window.Event('change'));
  $('reasoning-select').value = 'high';
  $('model-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => codex.calls.filter(call => call.method === 'turn/start').length === 2);
  await until(() => !$('model-dialog').open);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').at(-1).params.model, 'test-deep');
  codex.complete(id);
  await until(() => $('turn-count').textContent === ' · 第 2 轮');
  await until(() => $('messages').querySelectorAll('[data-turn-action="fork"]').length === 2);
  const button = $('messages').querySelector('[data-turn-action="fork"]');
  assert.ok(button.closest('.turn-footer'));
  button.click();
  await until(() => $('thread-title').textContent.startsWith('fork '));
  await until(() => $('turn-count').textContent === ' · 第 1 轮');
  assert.equal(codex.calls.filter(call => call.method === 'thread/fork').at(-1).params.lastTurnId, first.id);
  assert.equal(codex.calls.filter(call => call.method === 'turn/start').length, 2, 'fork does not generate');
  assert.deepEqual(errors, []);
});

test('legacy failed messages restore original text and attachments, and older failures must fork before editing', async t => {
  const { request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  codex.threads.get(id).turns = [{ id: 'legacy-failed', status: 'failed', error: { message: 'HTTP 403' }, items: [
    { id: 'legacy-input', type: 'userMessage', content: [{ type: 'text', text: 'Original legacy question' }, { type: 'text', text: '[CodexWUI visualization instructions]\ninternal guide' }] },
  ] }, { id: 'newer', status: 'completed', items: [{ id: 'newer-input', type: 'userMessage', content: [{ type: 'text', text: 'Newer message' }] }] }];
  const edit = await request(`/api/threads/${id}/recover`, { action: 'edit', turnId: 'legacy-failed' });
  assert.equal(edit.status, 200); assert.equal(edit.body.latest, false);
  assert.equal(edit.body.input.text, 'Original legacy question');
  assert.equal((await request(`/api/threads/${id}/recover`, { action: 'retry', turnId: 'legacy-failed', actionId: 'stale' })).status, 409);
  const fork = await request(`/api/threads/${id}/fork`, { turnId: 'legacy-failed', before: true, actionId: 'edit-old' });
  assert.equal(fork.status, 200); assert.equal(fork.body.thread.turns.length, 0);
});

test('a fresh browser restores failed-message editing with attachment chips and does not overwrite another draft', async t => {
  const f = await fixture(t), { request, project, codex, base, app } = f;
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const image = await (await fetch(base + '/api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  await request(`/api/threads/${id}/send`, { text: 'Saved question', images: [image.id], clientUserMessageId: 'saved-question' });
  codex.complete(id, 'failed'); await until(() => !app.lifecycle.cleaning.has(id));
  const { $, window, errors } = await browserFixture(t, f);
  await until(() => window.document.querySelector(`[data-thread="${id}"]`));
  window.document.querySelector(`[data-thread="${id}"]`).click();
  await until(() => $('messages').querySelector('[data-turn-action="edit"]'));
  $('prompt').value = 'My new draft'; $('prompt').dispatchEvent(new window.Event('input'));
  $('messages').querySelector('[data-turn-action="edit"]').click();
  await until(() => $('toast').textContent.includes('请先处理输入框中的草稿'));
  assert.equal($('prompt').value, 'My new draft');
  $('prompt').value = ''; $('prompt').dispatchEvent(new window.Event('input'));
  $('messages').querySelector('[data-turn-action="edit"]').click();
  await until(() => $('prompt').value === 'Saved question');
  assert.ok($('image-attachments').querySelector(`img[src="/api/images/${image.id}"]`));
  assert.deepEqual(errors, []);
});

test('an uncertain recovery cannot be bypassed by clicking retry with a new action ID', async t => {
  const { request, project, codex, app } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const sent = await request(`/api/threads/${id}/send`, { text: 'work' });
  codex.complete(id, 'failed'); await until(() => !app.lifecycle.cleaning.has(id));
  const native = codex.request.bind(codex);
  codex.request = async (method, params) => {
    if (method === 'turn/start') throw Object.assign(new Error('transport lost'), { rpcTimeout: true });
    return native(method, params);
  };
  const first = await request(`/api/threads/${id}/recover`, { action: 'retry', turnId: sent.body.turn.id, actionId: 'uncertain-retry' });
  assert.equal(first.body.deliveryUnknown, true);
  const second = await request(`/api/threads/${id}/recover`, { action: 'retry', turnId: sent.body.turn.id, actionId: 'another-retry' });
  assert.equal(second.status, 409); assert.match(second.body.error, /发送结果待确认/);
});

test('retrying fork setup after a naming failure completes the same fork without creating another', async t => {
  const { request, project, codex } = await fixture(t);
  const id = (await request('/api/threads', { project: project.id })).body.thread.id;
  const sent = await request(`/api/threads/${id}/send`, { text: 'source' }); codex.complete(id);
  const native = codex.request.bind(codex); let failName = true;
  codex.request = async (method, params) => {
    if (method === 'thread/name/set' && failName) { failName = false; throw Object.assign(new Error('name temporarily unavailable'), { rpcRejected: true }); }
    return native(method, params);
  };
  const action = { turnId: sent.body.turn.id, actionId: 'fork-with-name' };
  const failed = await request(`/api/threads/${id}/fork`, action);
  assert.equal(failed.status, 500); assert.equal(failed.body.retrySameOperation, true);
  const retried = await request(`/api/threads/${id}/fork`, action);
  assert.equal(retried.status, 200); assert.match(retried.body.thread.name, /^fork /);
  assert.equal(codex.calls.filter(call => call.method === 'thread/fork').length, 1);
});
