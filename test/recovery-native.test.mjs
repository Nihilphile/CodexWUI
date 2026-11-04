import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { CodexConnection } from '../server/codex.mjs';

// Uses a real Codex process and a local provider. No account or upstream inference.
test('native recovery and turn forks preserve inputs and opaque compaction boundaries', { skip: !process.env.CODEXWUI_TEST_CODEX, timeout: 90000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'recovery-native-')));
  const inputs = [];
  const opaque = 'opaque-fixture-context-do-not-decode';
  let deny = false;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url.endsWith('/responses')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); return; }
    inputs.push(JSON.parse(raw));
    if (deny) { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>local fixture blocked</html>'); return; }
    const n = inputs.length;
    const output = [{ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Answer ${n}`, annotations: [] }] }];
    if (n === 2) output.unshift({ type: 'compaction', id: 'compact_fixture', encrypted_content: opaque });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.created', { response: { id: `resp_${n}`, object: 'response', status: 'in_progress', output: [] } });
    for (const [output_index, item] of output.entries()) {
      emit('response.output_item.added', { output_index, item });
      emit('response.output_item.done', { output_index, item });
    }
    emit('response.completed', { response: { id: `resp_${n}`, object: 'response', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    res.end();
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(directory, { recursive: true, force: true }); }
  });
  await writeFile(path.join(directory, 'config.toml'), `model_provider = "fixture"
model = "fixture"
project_doc_max_bytes = 0
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${mock.address().port}"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[features]
skip_host_skill_discovery = true
hooks = false
goals = false
`);
  const codex = new CodexConnection({ binary: process.env.CODEXWUI_TEST_CODEX,
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, env: { ...options.env, CODEX_HOME: directory } }),
  });
  app = await createApp({ codex, initialProject: directory, dataDir: path.join(directory, 'web') });
  await app.startup; assert.equal(codex.ready, true);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, data) => {
    const response = await fetch(base + url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result) + ' ' + JSON.stringify([...app.recovery.records.values()].map(entry => entry.failure))); return result;
  };
  const bootstrap = await request('/api/bootstrap');
  const { thread } = await request('/api/threads', { project: bootstrap.projects[0].id });
  const until = async condition => {
    for (let i = 0; i < 600; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Native turn did not finish');
  };
  async function send(id, text) {
    const sent = await request(`/api/threads/${id}/send`, { text, clientUserMessageId: `native-${inputs.length}-${id}` });
    await until(() => app.live.get(id).turns.get(sent.turn.id)?.status === 'completed');
    return sent.turn.id;
  }
  const first = await send(thread.id, 'Before compaction');
  const second = await send(thread.id, 'Compact here');
  await send(thread.id, 'Later information');
  assert.ok(inputs[2].input.some(item => item.type === 'compaction' && item.encrypted_content === opaque), 'native retained the opaque compaction');
  const before = await request(`/api/threads/${thread.id}/fork`, { turnId: first, actionId: 'native-before' });
  const after = await request(`/api/threads/${thread.id}/fork`, { turnId: second, actionId: 'native-after' });
  assert.equal(inputs.length, 3, 'forking never starts generation');
  assert.equal((await request(`/api/threads/${before.thread.id}/turn-count`)).count, 1);
  assert.equal((await request(`/api/threads/${after.thread.id}/turn-count`)).count, 2);
  assert.match(after.thread.name, /^fork /);
  await send(before.thread.id, 'Branch before');
  assert.equal(inputs.at(-1).input.some(item => item.type === 'compaction'), false, 'no future compressed information in earlier fork');
  await send(after.thread.id, 'Branch after');
  assert.ok(inputs.at(-1).input.some(item => item.type === 'compaction' && item.encrypted_content === opaque));
  assert.equal(JSON.stringify(inputs.at(-1).input).includes('Later information'), false);
  const fresh = (await request('/api/threads', { project: bootstrap.projects[0].id })).thread;
  deny = true;
  const failed = await request(`/api/threads/${fresh.id}/send`, { text: 'Recover this exact question', clientUserMessageId: 'native-denied' });
  await until(() => app.live.get(fresh.id).turns.get(failed.turn.id)?.status === 'failed');
  const snapshot = await request(`/api/threads/${fresh.id}`);
  assert.equal(snapshot.history.data[0].failure.category, 'access');
  assert.equal(snapshot.history.data[0].recoveryMode, 'retry');
  deny = false;
  const retried = await request(`/api/threads/${fresh.id}/recover`, { turnId: failed.turn.id, action: 'retry', actionId: 'native-retry' });
  await until(() => app.live.get(fresh.id).turns.get(retried.turn.id)?.status === 'completed');
  assert.equal(app.recovery.forTurn(fresh.id, retried.turn.id).input.text, 'Recover this exact question');
});
