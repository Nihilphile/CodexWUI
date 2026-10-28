import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { VisualizationStore, visualizationConfig, visualizationItem, VISUALIZE_SERVER, TEXT_BYTES } from '../server/visualizations.mjs';
import { createApp } from '../server/index.mjs';
import { FakeCodex } from './helpers.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-visualizations-')));
  const root = path.join(directory, 'project'), dataDir = path.join(directory, 'data');
  await mkdir(root);
  const store = new VisualizationStore(path.join(dataDir, 'visualizations'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, store, dataDir };
}
async function server(t, options) {
  const codex = new FakeCodex(options.root);
  const app = await createApp({ codex, initialProject: options.root, dataDir: options.dataDir });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  return { app, codex, base };
}
test('publishes HTML, Markdown and image snapshots that survive source changes and a fresh store', async t => {
  const { root, store, dataDir } = await fixture(t);
  await writeFile(path.join(root, 'report.md'), '# 原报告\n\n$x^2$');
  await writeFile(path.join(root, 'plot.png'), png);
  const html = await store.publish(root, { type: 'html', content: '<button>运行</button>', title: '模拟器' });
  const md = await store.publish(root, { type: 'md', path: 'report.md' });
  const image = await store.publish(root, { type: 'image', path: path.join(root, 'plot.png') });
  await writeFile(path.join(root, 'report.md'), 'Changed');
  const fresh = new VisualizationStore(path.join(dataDir, 'visualizations'));
  assert.equal((await fresh.bytes(await fresh.record(html.artifactId))).toString(), '<button>运行</button>');
  assert.equal((await fresh.bytes(await fresh.record(md.artifactId))).toString(), '# 原报告\n\n$x^2$');
  assert.deepEqual(await fresh.bytes(await fresh.record(image.artifactId)), png);
  assert.equal((await fresh.record(image.artifactId)).mimeType, 'image/png');
  await store.saveState(html.artifactId, { inclination: 53, height: 550 });
  assert.deepEqual(await fresh.state(html.artifactId), { inclination: 53, height: 550 });
});
test('publishing enforces project boundaries, complete UTF-8, types and size limits', async t => {
  const { root, directory, store } = await fixture(t);
  await writeFile(path.join(directory, 'outside'), 'outside');
  await symlink('../outside', path.join(root, 'escape'));
  await writeFile(path.join(root, 'legacy'), Buffer.from([255]));
  for (const location of ['../outside', path.join(directory, 'outside'), 'escape']) await assert.rejects(store.publish(root, { type: 'html', path: location }), { status: 403 });
  await assert.rejects(store.publish(root, { type: 'html', path: 'legacy' }), { status: 415 });
  await assert.rejects(store.publish(root, { type: 'image', path: 'legacy' }), { status: 415 });
  await assert.rejects(store.publish(root, { type: 'html', content: '中'.repeat(TEXT_BYTES) }), { status: 413 });
  await assert.rejects(store.publish(root, { type: 'html', content: '', path: 'legacy' }), { status: 400 });
  await assert.rejects(store.publish(root, { type: 'image', content: 'not an image' }), { status: 400 });
  await assert.rejects(store.publish(root, { type: 'html', content: 'x', extra: true }), { status: 400 });
  await assert.rejects(store.record('../../outside'), { status: 400 });
  await assert.rejects(store.saveState('00000000-0000-0000-0000-000000000000', '中'.repeat(65536)), { status: 413 });
});
test('stdio MCP exposes visualize and returns small published results with explicit input failures', async t => {
  const { root, store } = await fixture(t);
  const child = spawn(process.execPath, [new URL('../server/visualize-mcp.mjs', import.meta.url).pathname, store.directory, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const closed = once(child, 'close');
  for (const message of [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'visualize', arguments: { type: 'markdown', content: '# Result' } } },
    { id: 4, method: 'tools/call', params: { name: 'visualize', arguments: { type: 'image', content: 'invalid' } } },
  ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  child.stdin.end(); await closed;
  assert.equal(errors, '');
  const replies = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, 4]);
  assert.equal(replies[1].result.tools[0].name, 'visualize');
  const result = replies[2].result;
  assert.equal(result.structuredContent.status, 'ready');
  assert.equal((await store.record(result.structuredContent.artifactId)).type, 'markdown');
  assert.equal(replies[3].result.isError, true);
});
test('HTTP separates script-enabled runtime from host, Markdown and image responses and persists bounded state', async t => {
  const f = await fixture(t), { base } = await server(t, f);
  const html = await f.store.publish(f.root, { type: 'html', content: '<!doctype html><script>window.loaded=true</script>' });
  const image = await f.store.publish(f.root, { type: 'image', path: 'plot.png' }).catch(async () => { await writeFile(path.join(f.root, 'plot.png'), png); return f.store.publish(f.root, { type: 'image', path: 'plot.png' }); });
  const md = await f.store.publish(f.root, { type: 'markdown', content: '# Report' });
  const metadata = await (await fetch(`${base}/api/visualizations/${md.artifactId}`)).json();
  assert.equal(metadata.content, '# Report');
  const host = await fetch(base + '/');
  assert.match(host.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(host.headers.get('x-frame-options'), 'DENY');
  const runtime = await fetch(`${base}/api/visualizations/${html.artifactId}/render`);
  const policy = runtime.headers.get('content-security-policy');
  assert.match(policy, /sandbox allow-scripts/); assert.doesNotMatch(policy, /allow-same-origin/);
  assert.match(policy, /connect-src 'none'/); assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /frame-ancestors 'self'/); assert.equal(runtime.headers.get('x-frame-options'), 'SAMEORIGIN');
  const source = await runtime.text(); assert.match(source, /^<!doctype html>/i);
  assert.ok(source.indexOf('window.codexVisualize') < source.indexOf('window.loaded'));
  const picture = await fetch(`${base}/api/visualizations/${image.artifactId}/content`);
  assert.equal(picture.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), png);
  assert.match(picture.headers.get('content-security-policy'), /sandbox;/);
  const stateUrl = `${base}/api/visualizations/${html.artifactId}/state`;
  const post = state => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });
  assert.equal((await fetch(stateUrl, { ...post({ height: 700 }), headers: { 'Content-Type': 'application/json', Origin: 'null' } })).status, 403);
  assert.equal((await fetch(stateUrl, post({ height: 700 }))).status, 200);
  assert.deepEqual((await (await fetch(stateUrl.replace('/state', ''))).json()).state, { height: 700 });
  assert.equal((await fetch(stateUrl, post('x'.repeat(65537)))).status, 413);
  assert.equal((await fetch(`${base}/api/visualizations/${md.artifactId}/render`)).status, 404);
});
test('main new and resumed threads receive local MCP configuration without changing unrelated tools', async t => {
  const f = await fixture(t), { base, codex } = await server(t, f);
  const project = (await (await fetch(base + '/api/bootstrap')).json()).projects[0];
  await fetch(base + '/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: project.id }) });
  const configured = codex.calls.find(call => call.method === 'thread/start').params.config;
  assert.deepEqual(configured, visualizationConfig(f.root, f.dataDir));
  assert.deepEqual(Object.keys(configured), [`mcp_servers.${VISUALIZE_SERVER}`]);
  const old = (await codex.request('thread/start', { cwd: f.root })).thread.id;
  const send = await fetch(`${base}/api/threads/${old}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Show a diagram' }) });
  assert.equal(send.status, 200);
  assert.deepEqual(codex.calls.find(call => call.method === 'thread/resume' && call.params.threadId === old).params.config, configured);
});
test('browser keeps iframe identity through text changes and history insertion, validates bridge and restores state', async t => {
  const dom = new JSDOM('<main id="messages"></main>', { url: 'http://localhost:4310', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.eval(await readFile(new URL('../public/visualizations.js', import.meta.url), 'utf8'));
  const calls = [], drafts = [];
  const artifactId = '00000000-0000-0000-0000-000000000001';
  const panel = new window.CodexVisualizations({ api: async (url, body) => {
    calls.push({ url, body }); return { type: 'html', title: '轨道', state: { height: 550 } };
  }, markdown: text => text, bringBack: (id, text) => drafts.push({ id, text }) });
  const root = window.document.getElementById('messages');
  const item = { id: 'tool', type: 'mcpToolCall', server: VISUALIZE_SERVER, tool: 'visualize', status: 'completed', result: { structuredContent: { artifactId } } };
  const entries = [{ key: 'tool', item }, { key: 'text', html: '<p>Loading explanation</p>' }];
  panel.render(root, entries, 'thread'); await wait(0);
  const frame = root.querySelector('iframe'), originalWindow = frame.contentWindow;
  panel.render(root, [entries[0], { key: 'text', html: '<p>Finished explanation</p>' }], 'thread');
  panel.render(root, [{ key: 'older', html: '<p>Older history</p>' }, entries[0], { key: 'text', html: '<p>Finished explanation</p>' }], 'thread');
  assert.equal(root.querySelector('iframe'), frame); assert.equal(frame.contentWindow, originalWindow);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  const channel = frame.src.split('#')[1];
  const event = (method, value, source = frame.contentWindow) => window.dispatchEvent(new window.MessageEvent('message', { source, data: { codexVisualization: 1, channel, method, value } }));
  event('height', 5000); assert.equal(frame.height, '900');
  event('height', 300, window); assert.equal(frame.height, '900');
  event('message', 'Explain these parameters'); assert.deepEqual(drafts, [{ id: 'thread', text: 'Explain these parameters' }]);
  event('state', { height: 650 }); await wait(390);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).body)), { state: { height: 650 } });
  root.querySelector('[data-visual-action=expand]').click(); assert.equal(root.querySelector('iframe'), frame);
  assert.ok(root.firstElementChild.nextElementSibling.classList.contains('expanded'));
  panel.render(root, [], 'other'); assert.equal(panel.views.size, 0);
  panel.render(root, [entries[0]], 'thread'); await wait(0);
  assert.notEqual(root.querySelector('iframe'), frame);
  assert.equal(calls.filter(call => !call.body).length, 2, 'returning to a conversation loads persisted metadata/state');
  panel.render(root, [], null);
});
test('large HTML arguments are removed from Web projections while tool results stay usable', () => {
  const original = { type: 'mcpToolCall', server: VISUALIZE_SERVER, tool: 'visualize', arguments: { type: 'html', content: 'x'.repeat(300000) }, result: { structuredContent: { artifactId: 'id' } } };
  const projected = visualizationItem(original);
  assert.equal(projected.arguments.content, undefined); assert.equal(original.arguments.content.length, 300000);
  assert.deepEqual(projected.result, original.result);
});
