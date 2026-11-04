import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/index.mjs';
import { FakeCodex } from './helpers.mjs';

const until = async predicate => {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Workspace upload did not settle');
};
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexwui-upload-'));
  const codex = new FakeCodex(dir);
  const app = await createApp({ codex, initialProject: dir, dataDir: path.join(dir, 'data') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json(); const project = bootstrap.projects[0];
  const url = directory => base + '/api/files/upload?' + new URLSearchParams({ project: project.id, path: directory });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, base, project, url, features: bootstrap.features };
}
async function browser(t) {
  const f = await fixture(t); await mkdir(path.join(f.dir, 'docs'));
  const dom = new JSDOM('<!doctype html><section id="files"></section>', { url: f.base, runScripts: 'outside-only' });
  const { window } = dom; t.after(() => window.close());
  window.eval(await readFile(new URL('../public/files.js', import.meta.url), 'utf8'));
  const root = window.document.getElementById('files');
  const panel = new window.CodexFilePanel(root, { api: async route => {
    const response = await fetch(f.base + route); const data = await response.json();
    if (!response.ok) throw new Error(data.error); return data;
  }, notify() {} });
  panel.setProject(f.project); await panel.navigate('docs');
  return { ...f, window, root, panel };
}

test('workspace upload endpoint accepts raw large files, enforces origin and follows the live upload limit', async t => {
  const { dir, base, url, features } = await fixture(t); await mkdir(path.join(dir, 'docs'));
  assert.equal(features.workspaceUpload, true);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 251);
  const options = { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('安卓文件.bin') }, body: bytes };
  const response = await fetch(url('docs'), options); assert.equal(response.status, 201);
  const file = await response.json(); assert.equal(file.path, 'docs/安卓文件.bin');
  assert.deepEqual(await readFile(path.join(dir, file.path)), bytes);
  assert.equal((await fetch(url('docs'), { ...options, headers: { ...options.headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(url('../'), options)).status, 400);
  assert.equal((await fetch(url('docs'), { ...options, headers: { ...options.headers, 'Content-Type': 'text/plain' } })).status, 415);
  const snapshot = await (await fetch(base + '/api/config')).json();
  const saved = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instance: snapshot.instance, revision: snapshot.revision, settings: { maxFileMb: 1 } }) });
  assert.equal(saved.status, 200); assert.equal((await fetch(url('docs'), options)).status, 413);
  assert.deepEqual(await readdir(path.join(dir, 'docs')), ['安卓文件.bin']);
});

test('upload button sits beside Directory and the Android picker uploads multiple files into the current folder', async t => {
  const { root, panel, window, dir } = await browser(t);
  assert.equal(root.querySelector('#file-directory-tab').nextElementSibling.hasAttribute('data-file-upload'), true);
  const input = root.querySelector('[data-file-upload-input]');
  assert.equal(input.multiple, true); root.querySelector('[data-file-upload]').click();
  assert.equal(panel.uploadTarget.directory, 'docs');
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['第一份'], '手机.txt'), new window.File(['第二份'], '手机.txt')] });
  input.dispatchEvent(new window.Event('change'));
  await until(() => panel.uploadBatch && !panel.uploadBatch.busy && !panel.current.loading);
  assert.equal(panel.uploadBatch.completed.length, 2); assert.deepEqual([...panel.uploadBatch.errors], []);
  assert.equal(await readFile(path.join(dir, 'docs/手机.txt'), 'utf8'), '第一份');
  assert.equal(await readFile(path.join(dir, 'docs/手机 (1).txt'), 'utf8'), '第二份');
  assert.equal(panel.directory().selected, 'docs/手机 (1).txt');
  assert.ok(root.querySelector('[data-file-entry="docs/手机 (1).txt"]'));
});

test('workspace upload pins its picker target across project changes and applies limits before sending', async t => {
  const { root, panel, window } = await browser(t);
  root.querySelector('[data-file-upload]').click(); const target = panel.uploadTarget;
  let finish, sent;
  panel.sendUpload = async (file, destination, progress) => { sent = destination; progress(50); return new Promise(resolve => { finish = resolve; }); };
  const uploading = panel.uploadFiles([new window.File(['ok'], 'first.txt')], target);
  assert.match(root.querySelector('.file-upload-note').textContent, /50%/);
  panel.setProject({ id: 'other', name: 'Other' });
  finish({ name: 'first.txt', path: 'docs/first.txt' }); await uploading;
  assert.equal(sent.project.id, target.project.id); assert.equal(sent.directory, 'docs');
  assert.equal(panel.project.id, 'other'); assert.equal(panel.current.dir, ''); assert.equal(panel.current.dirs.get('').entries, null);
  panel.getUploadLimit = () => 1; let calls = 0; panel.sendUpload = async () => { calls++; };
  await panel.uploadFiles([new window.File(['too big'], 'large.txt')], target);
  assert.equal(calls, 0); assert.equal(panel.uploadBatch.errors.length, 1);
});

test('cancelling workspace upload aborts its request and leaves later files unsent', async t => {
  const { root, panel, window } = await browser(t);
  root.querySelector('[data-file-upload]').click(); const target = panel.uploadTarget;
  let calls = 0;
  panel.sendUpload = () => { calls++; return new Promise((resolve, reject) => { panel.uploadRequest = { abort: () => reject(new Error('cancelled')) }; }); };
  const uploading = panel.uploadFiles([new window.File(['1'], 'one.txt'), new window.File(['2'], 'two.txt')], target);
  root.querySelector('[data-file-upload-cancel]').click(); await uploading;
  assert.equal(calls, 1); assert.equal(panel.uploadBatch.cancelled, true); assert.equal(panel.uploadBatch.busy, false);
  assert.equal(root.querySelector('[data-file-upload-cancel]').hidden, true);
});

test('a new file panel talking to an older backend reports the required reload and stops the batch', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++; req.resume();
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '接口不存在' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM('<!doctype html><section id="files"></section>', { url: base, runScripts: 'outside-only' });
  const { window } = dom; t.after(() => window.close());
  window.eval(await readFile(new URL('../public/files.js', import.meta.url), 'utf8'));
  const root = window.document.getElementById('files');
  const panel = new window.CodexFilePanel(root, { api: async () => ({ entries: [] }), notify() {} });
  panel.setProject({ id: 'p', name: 'ai_study' }); await panel.navigate('');
  root.querySelector('[data-file-upload]').click();
  await panel.uploadFiles([new window.File(['one'], 'first.html'), new window.File(['two'], 'second.html')], panel.uploadTarget);
  assert.equal(requests, 1, 'an unavailable route must not receive every file in the batch');
  assert.match(root.querySelector('.file-upload-note').textContent, /后端.*上传接口/);
  assert.match(root.querySelector('.file-upload-note').textContent, /\/reload/);
  assert.equal(root.querySelector('[data-file-upload]').disabled, true);
});

test('bootstrap capability checks prevent opening the picker before the backend is upgraded', async t => {
  const dom = new JSDOM('<!doctype html><section id="files"></section>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom; t.after(() => window.close());
  window.eval(await readFile(new URL('../public/files.js', import.meta.url), 'utf8'));
  let reloads = 0, sends = 0;
  const root = window.document.getElementById('files');
  const panel = new window.CodexFilePanel(root, { api: async () => ({ entries: [] }), notify() {}, onReload: () => { reloads++; } });
  panel.setProject({ id: 'p', name: 'ai_study' }); await panel.navigate('');
  panel.setUploadAvailable(false);
  assert.equal(root.querySelector('[data-file-upload]').disabled, true);
  assert.match(root.querySelector('.file-upload-note').textContent, /\/reload/);
  assert.equal(root.querySelector('[data-file-upload-reload]').hidden, false);
  panel.sendUpload = () => { sends++; };
  await panel.uploadFiles([new window.File(['test'], 'test.html')], { project: panel.project, model: panel.current, directory: '' });
  assert.equal(sends, 0); assert.equal(reloads, 0, 'a failed capability check must never restart a running conversation');
  root.querySelector('[data-file-upload-reload]').click(); assert.equal(reloads, 1);
  panel.setUploadAvailable(true); assert.equal(root.querySelector('[data-file-upload]').disabled, false);
  assert.equal(root.querySelector('.file-upload-note').hidden, true);
});
