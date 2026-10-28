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

// Opt in with CODEXWEB_TEST_CODEX=codex-native. The real runtime talks only to
// this local Responses fixture, with an isolated CODEX_HOME and no account key.
test('native BTW fork closes pending tool calls without interrupting its parent or generating on open', { skip: !process.env.CODEXWEB_TEST_CODEX, timeout: 60000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'btw-native-')));
  const inputs = [];
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url.endsWith('/responses')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); return; }
    inputs.push(JSON.parse(raw));
    const n = inputs.length;
    const item = n === 1
      ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'hold', arguments: '{}', status: 'completed' }
      : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Side answer', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [type, data] of [
      ['response.created', { response: { id: `resp_${n}`, object: 'response', status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item }],
      ['response.output_item.done', { output_index: 0, item }],
      ['response.completed', { response: { id: `resp_${n}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }],
    ]) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
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
  const connect = () => new CodexConnection({ binary: process.env.CODEXWEB_TEST_CODEX,
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, env: { ...options.env, CODEX_HOME: directory } }),
  });
  const codex = connect();
  app = await createApp({ codex, initialProject: directory, dataDir: path.join(directory, 'web') });
  await app.startup; assert.equal(codex.ready, true);
  const { thread: parent } = await codex.request('thread/start', {
    cwd: directory, model: 'fixture', sandbox: 'read-only', approvalPolicy: 'never',
    baseInstructions: 'Local fixture', developerInstructions: 'Local fixture',
    dynamicTools: [{ name: 'hold', description: 'Wait for fixture result', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  let held = false, release;
  const original = codex.dynamicToolHandler;
  codex.dynamicToolHandler = params => params.threadId === parent.id
    ? new Promise(resolve => { held = true; release = () => resolve({ success: false, contentItems: [{ type: 'inputText', text: 'stopped' }] }); })
    : original(params);
  t.after(() => release?.());
  const until = async condition => {
    for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Native fixture timed out');
  };
  await codex.request('turn/start', { threadId: parent.id, input: [{ type: 'text', text: 'Parent question', text_elements: [] }] });
  await until(() => held);
  const opened = await app.btw.open(parent.id), record = opened.session;
  assert.equal(inputs.length, 1, 'opening a fork must not invoke the model');
  assert.deepEqual(opened.history.data, [], 'inherited history must stay out of the BTW panel');
  const inherited = await codex.request('thread/turns/list', { threadId: record.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  assert.equal(inherited.data[0].status, 'interrupted');
  const sent = await app.btw.send(parent.id, 'Side question', record.id);
  await until(() => app.live.snapshot(record.threadId)?.turns.some(turn => turn.id === sent.turn.id && turn.status === 'completed'));
  assert.equal(inputs.length, 2);
  const calls = inputs[1].input.filter(item => item.type === 'function_call');
  const outputs = inputs[1].input.filter(item => item.type === 'function_call_output');
  assert.ok(calls.some(call => call.call_id === 'call_1'));
  assert.equal(outputs.find(output => output.call_id === 'call_1')?.output, 'aborted');
  assert.ok(app.live.get(parent.id).activeTurnId, 'forking must leave the original tool call running');
  assert.ok(inputs[1].tools.some(tool => /btw_read_file/.test(JSON.stringify(tool))), `the native fork must expose project readers: ${JSON.stringify(inputs[1].tools.map(tool => ({ type: tool.type, name: tool.name, tools: tool.tools?.map(child => child.name) })))}`);
  const own = await app.btw.snapshot(parent.id, record.id);
  assert.equal(own.history.data.length, 1);
  await app.btw.control(parent.id, record.id, 'queue', { text: 'Queued side question' });
  await until(() => app.live.snapshot(record.threadId)?.turns.filter(turn => turn.status === 'completed').length === 2 && !app.btw.queue.snapshot(record.id).dispatching);
  assert.equal(inputs.length, 3);
  assert.deepEqual(app.btw.queue.snapshot(record.id).entries, []);
  assert.ok(inputs[2].tools.some(tool => /btw_read_file/.test(JSON.stringify(tool))), 'queued turns must keep BTW tools');
  await app.close();
  app = await createApp({ codex: connect(), initialProject: directory, dataDir: path.join(directory, 'web') });
  await app.startup;
  const restored = await app.btw.snapshot(parent.id, record.id);
  assert.equal(restored.history.data.length, 2, 'persistent forks must be readable after a runtime restart');
  assert.equal(inputs.length, 3);
  const { thread: blank } = await app.codex.request('thread/start', { cwd: directory, model: 'fixture', sandbox: 'read-only', approvalPolicy: 'never' });
  const empty = await app.btw.open(blank.id);
  assert.equal(empty.session.threadId, null);
  assert.deepEqual(empty.history.data, []);
  assert.equal(inputs.length, 3, 'blank local side chats must not invoke the model');
  await app.btw.send(blank.id, 'First blank-side question', empty.session.id);
  const created = app.btw.records.get(empty.session.id);
  await until(() => app.live.snapshot(created.threadId)?.turns.some(turn => turn.status === 'completed'));
  assert.equal(inputs.length, 4);
});
