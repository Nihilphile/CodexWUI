import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createApp } from '../server/index.mjs';
import { FakeCodex } from './helpers.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexwui-plugins-'));
  const codex = new FakeCodex(dir);
  const installed = [
    { id: 'pstack@local.market', name: 'pstack', installed: true, enabled: true, interface: { shortDescription: '<img src=x onerror=alert(1)>' } },
    { id: 'blocked@remote', name: 'Blocked', installed: true, enabled: false, availability: 'DISABLED_BY_ADMIN', disabledReason: 'disabled_by_admin' },
    { id: 'available@remote', name: 'Available', installed: false, enabled: false },
  ];
  const original = codex.request.bind(codex);
  let version = 1;
  codex.request = async (method, params) => {
    if (method === 'plugin/installed') {
      codex.calls.push({ method, params });
      return { marketplaces: [{ name: 'local.market', plugins: structuredClone(installed) }], marketplaceLoadErrors: [{ message: '无法读取另一个市场' }] };
    }
    if (method === 'config/read' && params.includeLayers) {
      codex.calls.push({ method, params });
      return { config: {}, layers: [{ name: { type: 'user', file: '/test/config.toml' }, version: String(version) }] };
    }
    if (method === 'config/value/write') {
      codex.calls.push({ method, params });
      if (codex.writeError) throw new Error(codex.writeError);
      assert.equal(params.expectedVersion, String(version));
      assert.equal(params.keyPath, 'plugins."pstack@local.market".enabled');
      assert.equal(params.mergeStrategy, 'upsert');
      if (!codex.overridden) installed[0].enabled = params.value;
      version++;
      return { status: codex.overridden ? 'okOverridden' : 'ok', version: String(version) };
    }
    if (method === 'skills/list') {
      codex.calls.push({ method, params });
      return { data: [{ cwd: dir, skills: installed[0].enabled ? [{ name: 'pstack:poteto-mode', path: '/test/pstack/SKILL.md', enabled: true }] : [] }] };
    }
    return original(method, params);
  };
  const app = await createApp({ codex, dataDir: path.join(dir, 'data'), initialProject: dir });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, data) => {
    const response = await fetch(base + url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const project = (await request('/api/bootstrap')).body.projects[0].id;
  return { app, codex, base, project, request, installed, externalChange: () => { version++; } };
}

test('plugin HTTP lists installs, toggles quoted plugin IDs and invalidates cached skills', async t => {
  const { request, project, codex } = await fixture(t);
  const list = (await request(`/api/plugins?project=${project}`)).body;
  assert.equal(list.plugins.length, 2); assert.equal(list.plugins[1].blocked, true);
  assert.deepEqual(list.errors, ['无法读取另一个市场']);
  assert.equal((await request(`/api/skills?project=${project}`)).body.skills.length, 1);
  const result = await request('/api/plugins', { project, id: list.plugins[0].id, enabled: false, version: list.version });
  assert.equal(result.status, 200); assert.equal(result.body.plugins[0].enabled, false);
  assert.match(result.body.message, /新建会话/);
  assert.equal((await request(`/api/skills?project=${project}`)).body.skills.length, 0);
  assert.equal(codex.calls.filter(call => call.method === 'skills/list').length, 2);
  assert.equal(codex.calls.some(call => call.method === 'thread/start'), false);
});

test('plugin writes reject stale pages, policy blocks, uninstalled IDs and malformed input', async t => {
  const { request, project, codex, externalChange } = await fixture(t);
  const value = { project, id: 'pstack@local.market', enabled: false, version: '1' };
  assert.equal((await request('/api/plugins', { ...value, enabled: 'false' })).status, 400);
  assert.equal((await request('/api/plugins', { ...value, id: 'pstack\n' })).status, 400);
  assert.equal((await request('/api/plugins', { ...value, id: 'available@remote' })).status, 404);
  assert.equal((await request('/api/plugins', { ...value, id: 'blocked@remote' })).status, 403);
  assert.equal((await request('/api/plugins', { ...value, project: 'missing' })).status, 404);
  externalChange();
  assert.equal((await request('/api/plugins', value)).status, 409);
  assert.equal(codex.calls.some(call => call.method === 'config/value/write'), false);
});

test('concurrent plugin saves protect against stale versions; rejected writes remain retryable', async t => {
  const { request, project, codex } = await fixture(t);
  const value = { project, id: 'pstack@local.market', enabled: false, version: '1' };
  codex.writeError = 'config is read only';
  assert.match((await request('/api/plugins', value)).body.error, /read only/);
  codex.writeError = null;
  const results = await Promise.all([request('/api/plugins', value), request('/api/plugins', value)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});

test('overridden plugin writes report effective state instead of claiming a successful toggle', async t => {
  const { request, project, codex } = await fixture(t);
  codex.overridden = true;
  const result = await request('/api/plugins', { project, id: 'pstack@local.market', enabled: false, version: '1' });
  assert.equal(result.status, 200); assert.equal(result.body.plugins[0].enabled, true);
  assert.match(result.body.message, /策略限制/);
});

test('older Codex reports unsupported plugin interface and offline backend returns 503', async t => {
  const { request, project, codex } = await fixture(t);
  const original = codex.request.bind(codex);
  codex.request = (method, params) => method === 'plugin/installed' ? Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 })) : original(method, params);
  const result = await request(`/api/plugins?project=${project}`);
  assert.equal(result.status, 501); assert.match(result.body.error, /升级 Codex/);
  codex.fail(new Error('offline'));
  assert.equal((await request(`/api/plugins?project=${project}`)).status, 503);
});

const until = async predicate => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for plugin UI');
};

test('served /plugin and /plugins open accessible switches, filter safely and recover from save errors', async t => {
  const { base, codex } = await fixture(t);
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await (await fetch(base)).text(), { url: base, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const { window } = dom; t.after(() => window.close());
  window.fetch = (url, options) => fetch(new URL(url, base), options);
  window.AbortSignal = AbortSignal; window.AbortController = AbortController;
  let source;
  window.EventSource = class { constructor() { source = this; } close() {} };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const script of window.document.querySelectorAll('script[src]')) {
    const response = await fetch(script.src); assert.equal(response.status, 200, script.src);
    window.eval(await response.text());
  }
  const $ = id => window.document.getElementById(id);
  await until(() => $('project-select').options.length === 1);
  $('command-menu').click();
  await until(() => window.document.querySelector('[data-command="plugin"]'));
  window.document.querySelector('[data-command="plugin"]').click();
  const dialog = $('plugin-dialog');
  const switches = () => [...dialog.querySelectorAll('[role="switch"]')];
  await until(() => switches().length === 2);
  assert.equal(dialog.open, true); assert.equal(switches()[1].disabled, true);
  assert.equal(dialog.querySelector('img'), null); assert.match(dialog.textContent, /<img/);
  assert.equal(codex.calls.some(call => call.method === 'thread/start'), false);
  $('plugin-search').value = 'pstack'; $('plugin-search').dispatchEvent(new window.Event('input'));
  assert.equal(switches().length, 1);
  switches()[0].click(); assert.equal(switches()[0].disabled, true);
  await until(() => switches()[0].getAttribute('aria-checked') === 'false');
  source.onmessage({ data: JSON.stringify({ method: 'web/plugins', params: {} }) });
  await until(() => codex.calls.some(call => call.method === 'skills/list' && call.params.forceReload));
  codex.writeError = 'disk full'; switches()[0].click();
  await until(() => dialog.querySelector('[data-plugin-error]').textContent.includes('disk full'));
  assert.equal(switches()[0].getAttribute('aria-checked'), 'false'); assert.equal(switches()[0].disabled, true);
  codex.writeError = null; dialog.querySelector('[data-plugin-refresh]').click();
  await until(() => !switches()[0].disabled);
  dialog.close(); $('prompt').value = '/plugins';
  $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => dialog.open && !switches()[0].disabled);
  assert.equal(codex.calls.some(call => call.method === 'thread/start'), false);
  assert.deepEqual(errors, []);
});
