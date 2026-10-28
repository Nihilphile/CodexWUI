import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexConnection } from '../server/codex.mjs';
import { LiveState } from '../server/state.mjs';
import { FollowUpQueue } from '../server/queue.mjs';
import { gitStatus, gitDiff } from '../server/git.mjs';
import { resolveCodexBinary } from '../server/runtime.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Termux avoids nested proot while preserving the normal terminal launcher and explicit override', () => {
  const options = { env: { PREFIX: '/termux' }, platform: 'android', exists: () => true,
    read: p => p === '/proc/self/status' ? 'Name: node\nTracerPid:\t42\n' : 'proot\n' };
  assert.equal(resolveCodexBinary(options), '/termux/bin/codex-native');
  assert.equal(resolveCodexBinary({ ...options, read: () => 'TracerPid:\t0\n' }), 'codex');
  assert.equal(resolveCodexBinary({ ...options, exists: () => false }), 'codex');
  assert.equal(resolveCodexBinary({ ...options, env: { CODEX_BIN: '/custom/codex' } }), '/custom/codex');
  assert.equal(resolveCodexBinary({ ...options, platform: 'linux' }), 'codex');
});

test('RPC resolves out-of-order responses and does not confuse server requests with responses', async () => {
  const connection = new CodexConnection({ timeout: 500 });
  const sent = []; connection.send = message => sent.push(message);
  const first = connection.request('thread/read', { threadId: 'a' });
  const second = connection.request('thread/read', { threadId: 'b' });
  connection.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
  assert.equal(connection.approvals.size, 1);
  connection.receive({ id: 2, result: { id: 'b' } });
  connection.receive({ method: 'item/agentMessage/delta', params: { threadId: 'b', delta: 'x' } });
  connection.receive({ id: 1, result: { id: 'a' } });
  assert.deepEqual(await Promise.all([first, second]), [{ id: 'a' }, { id: 'b' }]);
  connection.respond('1', { decision: 'decline' });
  assert.deepEqual(sent.at(-1), { id: 1, result: { decision: 'decline' } });
  assert.equal(connection.approvals.size, 0);
  assert.throws(() => connection.respond('1', {}));
});

test('connection failure rejects all outstanding requests', async () => {
  const connection = new CodexConnection(); connection.send = () => {};
  const pending = assert.rejects(connection.request('thread/list'), /closed/);
  connection.fail(new Error('closed'));
  await pending; assert.equal(connection.pending.size, 0);
});

test('streamed turns remain isolated across simultaneous threads and survive snapshots', () => {
  const live = new LiveState();
  for (const id of ['one', 'two']) live.ingest({ method: 'turn/started', params: { threadId: id, turn: { id: 'turn-' + id } } });
  live.ingest({ method: 'item/agentMessage/delta', params: { threadId: 'one', turnId: 'turn-one', itemId: 'message', delta: 'hello ' } });
  live.ingest({ method: 'item/agentMessage/delta', params: { threadId: 'two', turnId: 'turn-two', itemId: 'message', delta: 'world' } });
  live.ingest({ method: 'item/agentMessage/delta', params: { threadId: 'one', turnId: 'turn-one', itemId: 'message', delta: 'one' } });
  assert.equal(live.snapshot('one').turns[0].items[0].text, 'hello one');
  assert.equal(live.snapshot('two').turns[0].items[0].text, 'world');
  live.ingest({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'turn-one', status: 'completed', items: [] } } });
  assert.equal(live.snapshot('one').activeTurnId, null);
  assert.equal(live.snapshot('two').activeTurnId, 'turn-two');
});

test('live output stays bounded during a long task and clearing released sessions accounts for cache bytes', () => {
  const live = new LiveState({ maxBytes: 4096, maxItems: 3, maxThreads: 2 });
  for (const id of ['a', 'b']) {
    live.ingest({ method: 'turn/started', params: { threadId: id, turn: { id: id + '-turn' } } });
    for (let i = 0; i < 100; i++) {
      live.ingest({ method: 'item/completed', params: { threadId: id, turnId: id + '-turn', item: {
        id: id + i, type: 'commandExecution', status: 'completed', aggregatedOutput: 'x'.repeat(1200),
      } } });
      assert.ok(live.bytes <= 4096);
      assert.ok(live.get(id).turns.get(id + '-turn').items.size <= 3);
    }
  }
  live.clearTurns('a'); live.clearTurns('b'); assert.equal(live.bytes, 0);
  live.ingest({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'a-turn', status: 'completed' } } });
  live.get('c'); assert.equal(live.threads.size, 2); assert.equal(live.threads.has('b'), true, 'active task must remain tracked');
});

test('follow-up queue runs once after success and pauses after interruption', async () => {
  const runs = [];
  const queue = new FollowUpQueue({ run: async (id, entry) => runs.push(entry.text), changed: () => {} });
  queue.add('a', { text: 'first' }); queue.add('a', { text: 'second' });
  queue.complete('a', 'completed'); await tick();
  assert.deepEqual(runs, ['first']); assert.equal(queue.snapshot('a').entries.length, 1);
  queue.complete('a', 'interrupted'); await tick();
  assert.equal(queue.snapshot('a').paused, true); assert.deepEqual(runs, ['first']);
  await queue.drain('a', true); assert.deepEqual(runs, ['first', 'second']);
});

test('follow-up handles completion arriving before the start RPC response', async () => {
  let count = 0;
  const queue = new FollowUpQueue({ run: async id => { count++; queue.complete(id, 'completed'); }, changed: () => {} });
  queue.add('a', { text: 'one' }); queue.add('a', { text: 'two' });
  await queue.drain('a'); await tick();
  assert.equal(count, 2); assert.equal(queue.snapshot('a').entries.length, 0);
});

test('follow-up send failure preserves the draft for retry', async () => {
  const queue = new FollowUpQueue({ run: async () => { throw new Error('offline'); }, changed: () => {} });
  queue.add('a', { text: 'keep me' }); await queue.drain('a');
  assert.equal(queue.snapshot('a').entries[0].text, 'keep me');
  assert.equal(queue.snapshot('a').paused, true);
});

test('Git shows staged/unstaged changes, renames and unusual file names without changing the index', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-web-git-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q'); await writeFile(path.join(dir, 'space name.md'), 'before\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  git('mv', 'space name.md', 'renamed name.md');
  await writeFile(path.join(dir, 'renamed name.md'), 'after\n');
  await writeFile(path.join(dir, '--odd.yaml'), 'test: yes\n');
  const before = git('diff', '--cached');
  const status = await gitStatus(dir);
  assert.equal(status.available, true);
  assert.ok(status.files.some(f => f.path === 'renamed name.md' && f.originalPath === 'space name.md'));
  assert.ok(status.files.some(f => f.path === '--odd.yaml' && f.status === '??'));
  assert.match((await gitDiff(dir)).diff, /\+after/);
  assert.match((await gitDiff(dir, true)).diff, /rename to renamed name.md/);
  assert.equal(git('diff', '--cached'), before);
});

test('non-repository project has a readable Git empty state', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-web-nogit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await gitStatus(dir)).available, false);
});
