import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { AppConfig } from '../server/config.mjs';
import { resourceLimits } from '../server/limits.mjs';
import { createApp } from '../server/index.mjs';
import { CodexConnection } from '../server/codex.mjs';
import { FakeCodex } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-config-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
async function fixture(t) {
  const dir = await directory(t), dataDir = path.join(dir, 'data');
  const codex = new FakeCodex(dir);
  codex.updateLimits = async limits => { codex.appliedLimits = { ...limits }; };
  const app = await createApp({ codex, dataDir, initialProject: dir, limits: resourceLimits({}), maxFileBytes: 100 * 1024 * 1024 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, data, options = {}) => {
    const response = await fetch(base + url, { ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), ...options });
    return { status: response.status, body: await response.json() };
  };
  const project = (await request('/api/bootstrap')).body.projects[0];
  return { dir, dataDir, app, codex, base, request, project };
}
async function until(predicate) {
  for (let i = 0; i < 160; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for config update');
}

test('config serializes saves, rejects stale revisions and survives restart with precedence over environment', async t => {
  const dir = await directory(t);
  const options = { dataDir: dir, limits: resourceLimits({ CODEXWEB_MAX_RSS_MB: '5000' }), maxFileBytes: 100 * 1024 * 1024, env: { CODEXWEB_MAX_RSS_MB: '5000' } };
  const config = new AppConfig(options); await config.load();
  assert.equal(config.snapshot().sources.maxRssMb, 'environment');
  const applied = [], changed = [];
  const hooks = { apply: async next => { await tick(); applied.push(next.maxRssMb); }, changed: value => changed.push(value) };
  const a = config.update({ maxRssMb: 6000 }, 0, hooks);
  const b = assert.rejects(config.update({ maxRssMb: 7000 }, 0, hooks), { status: 409 });
  await a; await b;
  assert.deepEqual(applied, [6000]); assert.equal(changed.length, 1);
  assert.equal((await stat(config.file)).mode & 0o777, 0o600);
  const restored = new AppConfig(options); await restored.load();
  assert.equal(restored.value.maxRssMb, 6000); assert.equal(restored.snapshot().sources.maxRssMb, 'saved');
  assert.deepEqual(await readdir(dir), ['config.json']);
});

test('invalid or rejected updates leave disk, revision and live settings unchanged', async t => {
  const dir = await directory(t), config = new AppConfig({ dataDir: dir, limits: resourceLimits({}), maxFileBytes: 104857600, env: {} });
  let calls = 0;
  const hooks = { apply: async () => { calls++; throw Object.assign(new Error('RAM 上限低于当前用量'), { status: 409 }); } };
  for (const patch of [{ maxActiveTurns: 0 }, { maxRssMb: '4096' }, { maxFileMb: Infinity }, { unknown: true }, { defaultEffort: 'high' }]) {
    await assert.rejects(config.update(patch, 0, hooks), { status: 400 });
  }
  assert.equal(calls, 0);
  await assert.rejects(config.update({ maxRssMb: 1 }, 0, hooks), { status: 409 });
  assert.equal(config.snapshot().revision, 0); assert.equal(config.value.maxRssMb, 4096);
  assert.deepEqual(await readdir(dir), []);
});

test('disk publication failure restores the previous runtime configuration', async t => {
  const dir = await directory(t), config = new AppConfig({ dataDir: dir, limits: resourceLimits({}), maxFileBytes: 104857600 });
  await mkdir(config.file); // Renaming a file over a directory must fail.
  const applied = [];
  await assert.rejects(config.update({ maxActiveTurns: 4 }, 0, { apply: async value => { applied.push(value.maxActiveTurns); } }));
  assert.deepEqual(applied, [4, 2]); assert.equal(config.value.maxActiveTurns, 2);
  assert.deepEqual(await readdir(dir), ['config.json']);
});

test('failed rollback invokes backend recovery and keeps the persisted revision unchanged', async t => {
  const dir = await directory(t), config = new AppConfig({ dataDir: dir, limits: resourceLimits({}), maxFileBytes: 104857600 });
  await mkdir(config.file);
  let recovered = false;
  await assert.rejects(config.update({ maxRssMb: 8192 }, 0, {
    apply: async value => { if (value.maxRssMb === 4096) throw new Error('old budget no longer fits'); },
    rollbackFailed: async previous => { recovered = true; assert.equal(previous.maxRssMb, 4096); },
  }), /恢复旧配置失败/);
  assert.equal(recovered, true); assert.equal(config.snapshot().revision, 0); assert.equal(config.value.maxRssMb, 4096);
});

test('HTTP save waits for supervisor confirmation and leaves the previous config intact on rejection', async t => {
  const { request, codex, dataDir } = await fixture(t);
  let rejectUpdate;
  codex.updateLimits = () => new Promise((resolve, reject) => { rejectUpdate = reject; });
  const snapshot = (await request('/api/config')).body;
  const saving = request('/api/config', { instance: snapshot.instance, revision: snapshot.revision, settings: { maxRssMb: 1 } });
  await until(() => rejectUpdate);
  assert.equal((await request('/api/config')).body.settings.maxRssMb, 4096);
  await assert.rejects(readFile(path.join(dataDir, 'config.json')), { code: 'ENOENT' });
  rejectUpdate(Object.assign(new Error('RAM 上限低于当前用量'), { status: 409 }));
  assert.equal((await saving).status, 409);
  assert.equal((await request('/api/resources')).body.limits.maxRssMb, 4096);
});

test('HTTP config changes admission immediately, preserves running work and uses defaults only for new threads', async t => {
  const { request, project, codex, app, dataDir } = await fixture(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await request('/api/threads', { project: project.id })).body.thread.id);
  await request(`/api/threads/${ids[0]}/send`, { text: 'first' });
  await request(`/api/threads/${ids[1]}/send`, { text: 'second' });
  assert.equal((await request(`/api/threads/${ids[2]}/send`, { text: 'third' })).status, 429);
  let snapshot = (await request('/api/config')).body;
  const save = await request('/api/config', { instance: snapshot.instance, revision: snapshot.revision, settings: { maxActiveTurns: 3, maxRssMb: 8192, defaultModel: 'test-deep', defaultEffort: 'high' } });
  assert.equal(save.status, 200); snapshot = save.body;
  assert.equal(codex.appliedLimits.maxRssMb, 8192);
  assert.equal((await request(`/api/threads/${ids[2]}/send`, { text: 'third' })).status, 200);
  assert.equal((await request('/api/config', { instance: snapshot.instance, revision: snapshot.revision, settings: { maxActiveTurns: 1 } })).status, 200);
  assert.equal(app.lifecycle.busy(ids[0]), true); assert.equal(app.lifecycle.busy(ids[1]), true); assert.equal(app.lifecycle.busy(ids[2]), true);
  await request('/api/threads', { project: project.id });
  const latest = codex.calls.filter(call => call.method === 'thread/start').at(-1).params;
  assert.equal(latest.model, 'test-deep'); assert.equal(latest.config.model_reasoning_effort, 'high');
  assert.equal(codex.calls.filter(call => call.method === 'thread/settings/update').length, 0);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.maxActiveTurns, 1); assert.equal(saved.defaultModel, 'test-deep');
  snapshot = (await request('/api/config')).body;
  for (const settings of [{ defaultEffort: 'low' }, { defaultModel: 'unknown' }]) {
    assert.equal((await request('/api/config', { instance: snapshot.instance, revision: snapshot.revision, settings })).status, 400);
  }
});

test('HTTP config and resource saves work offline, sync snapshots include config, and origin checks still apply', async t => {
  const { request, codex, base, app } = await fixture(t);
  codex.fail(new Error('offline'));
  const before = (await request('/api/config')).body;
  assert.equal((await request('/api/config', { instance: 'previous-service', revision: before.revision, settings: { maxRssMb: 8192 } })).status, 409);
  const saved = await request('/api/config', { instance: before.instance, revision: before.revision, settings: { maxRssMb: 8192, maxFileMb: 2 } });
  assert.equal(saved.status, 200);
  assert.equal((await request('/api/resources')).body.limits.maxRssMb, 8192);
  assert.equal((await request('/api/bootstrap')).body.uploadLimits.fileBytes, 2 * 1024 * 1024);
  assert.equal((await request('/api/config', undefined, { headers: { Origin: 'https://example.com' } })).status, 403);
  const controller = new AbortController();
  const stream = await fetch(base + '/api/events', { signal: controller.signal });
  const reader = stream.body.getReader(); const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('web/sync')) received += decoder.decode((await reader.read()).value);
  assert.ok(received.includes('"maxRssMb":8192'));
  await request('/api/config', { instance: saved.body.instance, revision: saved.body.revision, settings: { maxFileMb: 3 } });
  while (!received.includes('web/config')) received += decoder.decode((await reader.read()).value);
  assert.ok(received.includes('"maxFileMb":3')); controller.abort();
  assert.equal(app.codex.ready, false);
});

test('upload limits update frontend and server checks; uploads already in progress keep their starting limit', async t => {
  const { AttachmentStore } = await import('../server/attachments.mjs');
  const { PassThrough } = await import('node:stream');
  const dir = await directory(t), store = new AttachmentStore(dir, { maxBytes: 10 });
  const req = new PassThrough(); req.headers = { 'x-file-name': 'test.txt' };
  const upload = store.upload(req); req.write('12345');
  await until(() => req.readableLength === 0); store.maxBytes = 3;
  req.end('67890'); const uploaded = await upload; assert.equal(uploaded.size, 10);
  await assert.rejects(store.inputs([uploaded.id]), { status: 400 });
  const f = await fixture(t);
  const snapshot = (await f.request('/api/config')).body;
  await f.request('/api/config', { instance: snapshot.instance, revision: snapshot.revision, settings: { maxFileMb: 1 / 1048576 } });
  const response = await fetch(f.base + '/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'small.txt' }, body: '12' });
  assert.equal(response.status, 413);
});

test('real supervisor acknowledges new limits and rejects RAM reductions below live usage without stopping work', async t => {
  const dir = await directory(t), binary = path.join(dir, 'echo.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nimport { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\ncreateInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.id !== undefined) console.log(JSON.stringify({ id: m.id, result: { ok: true } })); });\n`, { mode: 0o700 });
  const connection = new CodexConnection({ binary, limits: resourceLimits({}), timeout: 4000 });
  t.after(() => connection.close()); await connection.start();
  await connection.updateLimits({ ...resourceLimits({}), maxRssMb: 8192 });
  assert.equal(connection.limits.maxRssMb, 8192);
  await assert.rejects(connection.updateLimits({ ...resourceLimits({}), maxRssMb: 1 }), { status: 409 });
  await assert.rejects(connection.updateLimits({ ...resourceLimits({}), maxProcesses: 1, maxRssMb: 8192 }), { status: 409 });
  assert.equal(connection.limits.maxRssMb, 8192); assert.equal(connection.ready, true);
  assert.deepEqual(await connection.request('still/alive'), { ok: true });
  await until(() => connection.resources?.maxRssMb === 8192);
});

test('browser config panel saves, reports concurrent edits and remains usable without model catalog', async t => {
  const { request, base } = await fixture(t);
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><body></body>', { url: base, runScripts: 'outside-only', virtualConsole });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.eval(await readFile(new URL('../public/config.js', import.meta.url), 'utf8'));
  let online = true, sync;
  const panel = new dom.window.CodexConfigPanel({ api: async (url, data) => {
    if (!online && url === '/api/models') throw new Error('offline');
    const response = await request(url, data); if (response.status >= 400) throw new Error(response.body.error); return response.body;
  }, notify() {}, changed: value => { sync = value; } });
  await panel.open(); assert.equal(panel.dialog.open, true);
  panel.field('maxActiveTurns').value = '4'; await panel.save(); assert.equal(sync.settings.maxActiveTurns, 4);
  const revision = sync.revision;
  const external = await request('/api/config', { instance: sync.instance, revision, settings: { maxActiveTurns: 3 } });
  panel.sync(external.body); panel.field('maxActiveTurns').value = '5';
  await panel.save(); assert.match(panel.dialog.querySelector('[data-config-error]').textContent, /其他页面更新/);
  online = false; await panel.open(); panel.field('maxFileMb').value = '5'; await panel.save();
  assert.equal(sync.settings.maxFileMb, 5); assert.equal(sync.settings.maxActiveTurns, 3);
  panel.sync({ ...sync, instance: 'new-service', revision: 0, settings: { ...sync.settings, maxActiveTurns: 7 } });
  assert.equal(sync.settings.maxActiveTurns, 7, 'a new server instance resets the revision baseline');
  assert.deepEqual(errors, []);
});

test('served app opens /config without creating a thread and receives config updates while Codex is offline', async t => {
  const { base, request, codex } = await fixture(t);
  const html = await (await fetch(base + '/')).text();
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom; t.after(() => window.close());
  window.fetch = (url, options) => fetch(new URL(url, base), options);
  window.AbortSignal = AbortSignal; window.AbortController = AbortController;
  let source;
  window.EventSource = class { constructor() { source = this; } close() {} };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const script of window.document.querySelectorAll('script[src]')) {
    const response = await fetch(script.src); assert.equal(response.status, 200); window.eval(await response.text());
  }
  const $ = id => window.document.getElementById(id);
  await until(() => $('project-select').options.length === 1);
  const submit = text => { $('prompt').value = text; $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); };
  submit('/config'); await until(() => $('config-dialog').open && !$('config-form').querySelector('[data-config-save]').disabled);
  assert.equal(codex.calls.filter(call => call.method === 'thread/start').length, 0);
  $('config-dialog').close(); codex.fail(new Error('offline'));
  source.onmessage({ data: JSON.stringify({ method: 'web/connection', params: { connected: false, error: 'offline' } }) });
  submit('/config'); await until(() => $('config-dialog').open && !$('config-form').querySelector('[data-config-save]').disabled);
  assert.match($('config-form').querySelector('[data-config-model-note]').textContent, /暂不可用/);
  const snapshot = (await request('/api/config')).body;
  const saved = (await request('/api/config', { instance: snapshot.instance, revision: snapshot.revision, settings: { maxFileMb: 5, maxRssMb: 8192 } })).body;
  source.onmessage({ data: JSON.stringify({ method: 'web/config', params: saved }) });
  await until(() => $('attach-file').title.includes('5 MiB'));
  await until(() => /8G/.test($('memory-usage').textContent));
  assert.match($('config-form').querySelector('[data-config-status]').textContent, /其他页面更新/);
  assert.deepEqual(errors, []);
});
