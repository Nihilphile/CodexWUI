// Synthetic diagnosis using the real HTTP server and served frontend, with FakeCodex.
// No account credentials or remote model calls. JSDOM does not measure browser paint.
// Run: node --test scripts/probe-tab-stream.mjs
// CWUI_PROBE_HISTORY=110 adds distinct old messages to exercise the Markdown cache.
// CWUI_PROBE_FILTER=1 drops foreign deltas before frontend reduction, for comparison.
// CWUI_PROBE_HIDDEN=1 sets document.hidden; native timer throttling is not simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createApp } from '../server/index.mjs';
import { FakeCodex } from '../test/helpers.mjs';

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
  await until(() => $('project-select').options.length >= 1 && $('connection-label').textContent === 'Codex 已连接', 'bootstrap');
  return { ...f, window, $, submit, errors };
}

test('measure cross-project event delivery and rendering in two tabs', async t => {
  const f = await fixture(t);
  const bdir = path.join(f.dir, 'project-b'); await mkdir(bdir);
  const projectB = (await f.request('/api/projects', { path: bdir })).body.project;
  const a = (await f.request('/api/threads', { project: f.project.id })).body.thread.id;
  const b = (await f.request('/api/threads', { project: projectB.id })).body.thread.id;
  await f.request(`/api/threads/${a}/send`, { text: 'A question' });
  const at = f.codex.threads.get(a).turns.at(-1);
  at.items.push({ id: 'a-answer', type: 'agentMessage', text: 'A-history\n\n' + 'A paragraph with **bold** and $x^2$.\n\n'.repeat(40) });
  for (let i = 1; i < Number(process.env.CWUI_PROBE_HISTORY || 1); i++) at.items.push({ id: `a-answer-${i}`, type: 'agentMessage', text: `A-history-${i}\n\nItem ${i} has **bold**, a paragraph, and $x^2 + y^2 = z^2$.` });
  f.codex.complete(a);
  await f.request(`/api/threads/${b}/send`, { text: 'B question' });
  const bt = f.codex.threads.get(b).turns.at(-1);
  const tabs = [await browserFixture(t, f), await browserFixture(t, f)];
  await tabs[0].window.selectThread(a);
  await tabs[1].window.chooseProject(projectB.id);
  await tabs[1].window.selectThread(b);
  await new Promise(resolve => setTimeout(resolve, 220));
  if (process.env.CWUI_PROBE_HIDDEN === '1') Object.defineProperty(tabs[0].window.document, 'hidden', { configurable: true, value: true });
  const stats = tabs.map(tab => {
    const stat = { foreignEvents: 0, ownEvents: 0, aMarkdownCalls: 0, aMarkdownMs: 0, messageRenderCalls: 0, messageRenderMs: 0, mathTypesets: 0 };
    const receive = tab.window.receiveEvent;
    tab.window.receiveEvent = event => {
      const p = JSON.parse(event.data).params || {};
      if (p.threadId === b && typeof p.delta === 'string') stat[tab === tabs[0] ? 'foreignEvents' : 'ownEvents']++;
      if (process.env.CWUI_PROBE_FILTER === '1' && tab === tabs[0] && p.threadId === b && typeof p.delta === 'string') return;
      return receive(event);
    };
    const renderMessages = tab.window.renderMessages;
    tab.window.renderMessages = () => { const start = performance.now(); const result = renderMessages(); stat.messageRenderCalls++; stat.messageRenderMs += performance.now() - start; return result; };
    const typeset = tab.window.katex.renderToString;
    tab.window.katex.renderToString = (...args) => { stat.mathTypesets++; return typeset(...args); };
    const markdown = tab.window.CodexMarkdown;
    tab.window.CodexMarkdown = (text, env) => {
      const mark = performance.now();
      const result = markdown(text, env);
      if (text.startsWith('A-history')) { stat.aMarkdownCalls++; stat.aMarkdownMs += performance.now() - mark; }
      return result;
    };
    return stat;
  });
  for (let i = 0; i < 40; i++) {
    f.codex.event('item/agentMessage/delta', { threadId: b, turnId: bt.id, itemId: 'b-answer', delta: 'B token ' });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  console.log(JSON.stringify({ historyItems: Number(process.env.CWUI_PROBE_HISTORY || 1), hiddenA: process.env.CWUI_PROBE_HIDDEN === '1', filterForeignDeltas: process.env.CWUI_PROBE_FILTER === '1', emittedBDeltas: 40, tabA: stats[0], tabB: stats[1], errors: tabs.flatMap(tab => tab.errors) }, null, 2));
  assert.equal(stats[1].ownEvents, 40, 'tab B must receive its full stream');
  assert.deepEqual(tabs.flatMap(tab => tab.errors), []);
  if (process.env.CWUI_PROBE_FILTER === '1') assert.equal(stats[0].messageRenderCalls, 0, 'filtered foreign deltas must not redraw A');
});
