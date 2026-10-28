import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';
import { FollowUpQueue, messageDigest } from '../server/queue.mjs';
import { FakeCodex } from './helpers.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/agentctl.mjs', import.meta.url));
const tick = () => new Promise(r => setTimeout(r, 20));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } throw new Error('Timeout'); }
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-chat-'));
  const codex = new FakeCodex(dir);
  const dataDir = path.join(dir, 'data');
  const apps = [];
  const open = async () => {
    const app = await createApp({ codex, initialProject: dir, dataDir }); apps.push(app);
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async input => {
      const response = await fetch(base + '/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: dir, ...input }) });
      return { status: response.status, ...await response.json() };
    };
    return { app, base, request };
  };
  t.after(async () => { for (const app of apps) await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...await open(), open, dir, codex, dataDir };
}

test('stop preserves per-message drafts; new calls and single resume cannot release old entries', async () => {
  const runs = [];
  const q = new FollowUpQueue({ run: async (_, e) => { runs.push(e.text); return { turn: { id: 't' } }; }, changed() {} });
  const a = q.add('a', { text: 'old 1' }).entries[0];
  const b = q.add('a', { text: 'old 2' }).entries[1];
  q.pause('a'); q.add('a', { text: 'new' }); await q.drain('a');
  assert.deepEqual(runs, ['new']);
  q.resume('a', b.id); await q.drain('a'); q.complete('a', 'completed'); await tick();
  assert.deepEqual(runs, ['new', 'old 2']);
  const edit = q.edit('a', a.id);
  assert.throws(() => q.update('a', a.id, a.revision, 'stale'), /变化/);
  q.update('a', a.id, edit.revision, 'revised');
  assert.equal(q.receipts.get(a.id).modified, true);
  q.remove('a', a.id);
  assert.equal(q.receipts.get(a.id).status, 'cancelled');
});

test('stop at persistence boundary prevents dispatch; in-flight delivery cannot be recalled', async () => {
  let unblock, ran = 0;
  const q = new FollowUpQueue({ run: async () => { ran++; }, changed() {} });
  q.add('a', { text: 'cancel' });
  q.flush = () => new Promise(r => { unblock = r; });
  const task = q.drain('a'); q.pause('a'); unblock(); await task;
  assert.equal(ran, 0);
  q.flush = async () => {};
  q.run = () => new Promise(r => { unblock = r; ran++; });
  q.resume('a'); const second = q.drain('a'); await tick(); q.pause('a');
  assert.throws(() => q.remove('a', q.snapshot('a').entries[0].id), /投递/);
  unblock({ turn: { id: 'sent' } }); await second;
  assert.equal(q.snapshot('a').entries.length, 0);
  assert.equal([...q.receipts.values()][0].turnId, 'sent');
});

test('registry persists stable hierarchy, canonical workspace aliases, counters and controller ownership', async t => {
  const f = await fixture(t);
  const a = await f.request({ target: f.dir, operation: 'create' });
  const b = await f.request({ target: f.dir, operation: 'create' });
  assert.equal(a.agent.number, '1'); assert.equal(b.agent.number, '2');
  const parent = f.codex.threads.get(a.agent.threadId);
  const child = { ...parent, id: 'child-1', parentThreadId: parent.id, turns: [] };
  f.codex.threads.set(child.id, child); f.codex.event('thread/started', { thread: child });
  await symlink(f.dir, path.join(f.dir, 'alias'));
  const list = await f.request({ target: path.join(f.dir, 'alias'), operation: 'list' });
  assert.equal(list.agents.find(r => r.threadId === child.id).number, '1.sub1');
  const sub = await f.request({ target: '1.sub1', operation: 'call', message: 'sub question' });
  assert.equal(sub.status, 200); await until(() => child.turns.length === 1); f.codex.complete(child.id);
  await f.app.close();
  const restored = await f.open();
  const again = await restored.request({ target: f.dir, operation: 'list' });
  assert.equal(again.agents.find(r => r.number === '1').managed, true);
  f.codex.threads.delete(b.agent.threadId);
  const c = await restored.request({ target: f.dir, operation: 'create' }); assert.equal(c.agent.number, '3');
});

test('CLI file input snapshots full text and returns promptly while generation stays active', async t => {
  const f = await fixture(t);
  const created = await f.request({ target: f.dir, operation: 'create', model: 'test-deep', reasoning: 'high' });
  assert.equal(created.status, 200);
  assert.equal(f.codex.calls.find(c => c.method === 'thread/start').params.model, 'test-deep');
  assert.equal((await f.request({ target: f.dir, operation: 'create', model: 'test-fast', reasoning: 'high' })).status, 400);
  const text = '# Unicode 中文\n' + 'long 中文 prompt\n'.repeat(10000) + '终点\n';
  await writeFile(path.join(f.dir, 'prompt.md'), text);
  const env = { ...process.env, AGENTCTL_URL: f.base }; delete env.CODEX_THREAD_ID;
  const result = await exec(process.execPath, [cli, '1', 'call', '--message-file', './prompt.md'], { cwd: f.dir, env, timeout: 5000 });
  const { receipt } = JSON.parse(result.stdout);
  assert.equal(receipt.sha256, messageDigest(text)); assert.equal(receipt.bytes, Buffer.byteLength(text));
  await writeFile(path.join(f.dir, 'prompt.md'), 'changed');
  await until(() => f.codex.threads.get(created.agent.threadId).turns.length === 1);
  const turn = f.codex.threads.get(created.agent.threadId).turns[0];
  assert.equal(turn.status, 'inProgress'); assert.ok(turn.items[0].content[0].text.endsWith(text));
  const observed = await f.request({ target: '1', operation: 'observe', message_id: receipt.message_id });
  assert.equal(observed.receipt.status, 'delivered'); assert.equal(observed.receipt.turn_status, 'inProgress');
  await assert.rejects(exec(process.execPath, [cli, '1', 'call', '--message', 'x', '--message-file', 'prompt.md'], { cwd: f.dir, env }), /二选一/);
  await writeFile(path.join(f.dir, 'bad.md'), Buffer.from([255]));
  await assert.rejects(exec(process.execPath, [cli, '1', 'call', '--message-file', 'bad.md'], { cwd: f.dir, env }), /encoded data/);
  await assert.rejects(exec(process.execPath, [cli, '1', 'create', '--kind', 'sub'], { cwd: f.dir, env }), /Unknown option/);
});

test('follow-ups persist as unsent on restart; user edits are visible in receipts', async t => {
  const f = await fixture(t);
  const created = await f.request({ target: f.dir, operation: 'create', message: 'start' });
  const id = created.agent.threadId;
  await until(() => f.codex.threads.get(id).turns.length === 1);
  const follow = await f.request({ target: '1', operation: 'call', message: 'keep', caller_thread_id: id });
  assert.equal(follow.receipt.source.agent_id, created.agent.agent_id);
  await f.request({ target: '1', operation: 'stop' });
  const entry = f.app.queue.snapshot(id).entries[0];
  const edited = f.app.queue.edit(id, entry.id, entry.revision);
  f.app.queue.update(id, entry.id, edited.revision, 'edited'); await f.app.close();
  const restored = await f.open();
  const observation = await restored.request({ target: '1', operation: 'observe', message_id: follow.receipt.message_id });
  assert.equal(observation.queue.entries[0].text, 'edited');
  assert.equal(observation.queue.entries[0].status, 'unsent'); assert.equal(observation.receipt.modified, true);
  await restored.request({ target: '1', operation: 'call', message: 'new work' });
  await until(() => f.codex.threads.get(id).turns.length === 2);
  f.codex.complete(id); await tick(); assert.equal(f.codex.threads.get(id).turns.length, 2);
  assert.equal(restored.app.queue.snapshot(id).entries[0].text, 'edited');
});

test('steer requires active target; fork is a new root and BTW retains read-only controls', async t => {
  const f = await fixture(t);
  const parent = await f.request({ target: f.dir, operation: 'create' });
  assert.equal((await f.request({ target: '1', operation: 'call', message: 'x', steer: true })).status, 409);
  assert.equal((await f.request({ target: '1', operation: 'create', kind: 'sub' })).status, 400);
  await f.request({ target: '1', operation: 'call', message: 'parent task' });
  await until(() => f.codex.threads.get(parent.agent.threadId).turns.length === 1);
  const steer = await f.request({ target: '1', operation: 'call', message: 'redirect', steer: true });
  assert.equal(steer.receipt.status, 'delivered'); assert.equal(f.codex.pendingSteers.length, 1);
  const fork = await f.request({ target: '1', operation: 'fork' });
  assert.equal(fork.agent.number, '2'); assert.equal(fork.agent.kind, 'main');
  const side = await f.request({ target: '1', operation: 'btw' });
  assert.equal(side.agent.number, '1.btw1');
  assert.equal(f.codex.calls.filter(c => c.method === 'turn/start').length, 1, 'creation does not generate');
  const called = await f.request({ target: '1.btw1', operation: 'call', message: 'side question' }); assert.equal(called.status, 200);
  await until(() => f.codex.calls.filter(c => c.method === 'turn/start').length === 2);
  const start = f.codex.calls.filter(c => c.method === 'turn/start').at(-1).params;
  assert.deepEqual(start.sandboxPolicy, { type: 'readOnly' });
  assert.equal((await f.request({ target: '1', operation: 'call', message: 'forbidden', caller_thread_id: side.agent.threadId })).status, 403);
  assert.equal((await f.request({ target: '1.btw1', operation: 'observe', message_id: called.receipt.message_id })).receipt.status, 'delivered');
});

test('independent historical sessions are observable but cannot be silently resumed by CLI', async t => {
  const f = await fixture(t);
  f.codex.threads.set('external', { id: 'external', cwd: await realpath(f.dir), createdAt: 1, status: { type: 'idle' }, turns: [], canAcceptDirectInput: true });
  const list = await f.request({ target: f.dir, operation: 'list' });
  assert.deepEqual(list.agents[0].operations, ['observe']);
  assert.equal((await f.request({ target: '1', operation: 'call', message: 'do not resume' })).status, 409);
  assert.equal(f.codex.calls.some(c => c.method === 'thread/resume'), false);
});


test('recovery marks uncertain delivery and never replays a pending steer or follow-up', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'queue-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const q = new FollowUpQueue({ file, run: async () => {}, changed() {} });
  const entry = q.add('target', { text: 'follow-up' }).entries[0];
  q.get('target').entries[0].status = 'sending'; q.get('target').entries[0].inFlight = true;
  q.receipt('target', { id: 'steer', text: 'direction', status: 'sending', revision: 1 });
  q.notify('target'); await q.flush();
  let runs = 0;
  const restored = new FollowUpQueue({ file, run: async () => { runs++; }, changed() {} });
  await restored.load(); await restored.drain('target');
  assert.equal(runs, 0);
  assert.equal(restored.receipts.get('steer').status, 'delivery_unknown');
  assert.equal(restored.snapshot('target').entries[0].status, 'unsent');
  restored.remove('target', entry.id);
  assert.equal(restored.receipts.get(entry.id).status, 'cancelled');
  await restored.close();
});

test('a concurrent BTW fork is never assigned a main-thread alias', async t => {
  const f = await fixture(t);
  const parent = await f.request({ target: f.dir, operation: 'create', message: 'parent' });
  await until(() => f.codex.threads.get(parent.agent.threadId).turns.length === 1);
  const original = f.codex.request.bind(f.codex);
  let release, forkId;
  f.codex.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/fork') {
      forkId = result.thread.id;
      await new Promise(resolve => { release = resolve; });
    }
    return result;
  };
  const opening = f.app.btw.open(parent.agent.threadId);
  await until(() => release);
  const during = await f.request({ target: f.dir, operation: 'list' });
  assert.equal(during.agents.some(r => r.threadId === forkId), false);
  release(); await opening;
  const after = await f.request({ target: f.dir, operation: 'list' });
  assert.equal(after.agents.find(r => r.threadId === forkId).number, '1.btw1');
  assert.equal(after.agents.filter(r => r.kind === 'main').length, 1);
});


test('UTF-8 message bytes split between HTTP chunks are preserved exactly', async t => {
  const f = await fixture(t);
  await f.request({ target: f.dir, operation: 'create' });
  const message = '开头中文结尾';
  const data = Buffer.from(JSON.stringify({ target: '1', cwd: f.dir, operation: 'call', message }));
  const split = data.indexOf(Buffer.from('中文')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(data.subarray(0, split));
    setTimeout(() => req.end(data.subarray(split)), 30);
  });
  assert.equal(result.status, 200);
  assert.equal(result.receipt.sha256, messageDigest(message));
});
