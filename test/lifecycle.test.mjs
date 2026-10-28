import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexConnection } from '../server/codex.mjs';
import { resourceLimits } from '../server/limits.mjs';
import { loadSubreaper } from '../server/subreaper.mjs';

const fixtureUrl = new URL('./fixtures/tool-process.mjs', import.meta.url).href;
const connectionUrl = new URL('../server/codex.mjs', import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function running(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(value.slice(value.lastIndexOf(')') + 2).split(' ')[0]);
  } catch { return false; }
}
async function until(predicate, ms = 6000) {
  const deadline = Date.now() + ms;
  do { if (await predicate()) return; await sleep(40); } while (Date.now() < deadline);
  assert.fail('fixture processes must exit within the cleanup deadline');
}
async function executable(t, mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-lifecycle-'));
  const binary = path.join(dir, 'fixture.mjs');
  await writeFile(binary, `#!${process.execPath}\nglobalThis.fixtureMode=${JSON.stringify(mode)}; globalThis.fixtureManifest=${JSON.stringify(path.join(dir, 'pids.json'))}; await import(${JSON.stringify(fixtureUrl)});\n`, { mode: 0o700 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return binary;
}
async function fixtureProcesses(binary) {
  try { const info = JSON.parse(await readFile(path.join(path.dirname(binary), 'pids.json'), 'utf8')); return [info.pid, ...info.workers]; }
  catch { return []; }
}
async function cleanup(connection, pids = []) {
  await connection.close();
  for (const pid of pids) { if (await running(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  if (connection.process?.exitCode === null) { try { connection.process.kill('SIGKILL'); } catch {} }
}

test('close waits for TERM-resistant app-server and its detached descendants, and is idempotent', async t => {
  const connection = new CodexConnection({ binary: await executable(t, 'detached'), timeout: 4000 });
  const info = await connection.start();
  const pids = [info.pid, ...info.workers];
  t.after(() => cleanup(connection, pids));
  // Give the process inventory a chance to observe the separate process group.
  await sleep(350);
  const first = connection.close(); const second = connection.close();
  assert.ok(first instanceof Promise, 'shutdown must be awaitable');
  assert.equal(first, second, 'shutdown must run exactly once');
  await first;
  for (const pid of pids) assert.equal(await running(pid), false, `owned PID ${pid} survived shutdown`);
});

test('initialize timeout reaps the spawned process instead of leaving a disconnected backend', async t => {
  const connection = new CodexConnection({ binary: await executable(t, 'hang'), timeout: 400 });
  t.after(() => cleanup(connection));
  await assert.rejects(connection.start(), /超时/);
  assert.notEqual(connection.process.exitCode, null, 'start rejection must follow process cleanup');
});

test('guard reaps workers even when the Web owner is killed without running close', async t => {
  const binary = await executable(t, 'detached');
  const source = `import { CodexConnection } from ${JSON.stringify(connectionUrl)};
    const connection=new CodexConnection({binary:${JSON.stringify(binary)},timeout:4000});
    const info=await connection.start();
    console.log(JSON.stringify({...info,guardPid:connection.process.pid}));
    setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let pids = [];
  t.after(async () => {
    owner.kill('SIGKILL');
    for (const pid of pids) { if (await running(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  });
  const [data] = await once(owner.stdout, 'data');
  const info = JSON.parse(data.toString()); pids = [info.pid, ...info.workers, info.guardPid];
  await sleep(350); owner.kill('SIGKILL'); await once(owner, 'exit');
  await until(async () => (await Promise.all(pids.map(running))).every(value => !value));
});

test('Web owner takes over cleanup if the guardian is killed', async t => {
  const connection = new CodexConnection({ binary: await executable(t, 'detached'), timeout: 4000 });
  const info = await connection.start(); const pids = [info.pid, ...info.workers];
  t.after(() => cleanup(connection, pids));
  await until(() => connection.inventory?.known.has(info.workers[0]));
  process.kill(connection.process.pid, 'SIGKILL');
  await once(connection.process, 'exit');
  await connection.close();
  for (const pid of pids) assert.equal(await running(pid), false);
});

for (const [name, overrides, reason] of [
  ['process budget', { maxProcesses: 1 }, /进程数量超过/],
  ['memory budget', { maxRssMb: 1 }, /内存占用超过/],
]) {
  test(`${name} stops and reaps the backend without killing unrelated Termux processes`, async t => {
    const binary = await executable(t, 'detached');
    const witness = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const connection = new CodexConnection({ binary, timeout: 4000, limits: { ...resourceLimits({}), ...overrides } });
    t.after(async () => {
      await cleanup(connection, await fixtureProcesses(binary));
      witness.kill('SIGKILL');
    });
    try { await connection.start(); } catch { /* May trip before initialize replies. */ }
    await until(() => reason.test(connection.lastError || ''));
    await connection.close();
    for (const pid of await fixtureProcesses(binary)) assert.equal(await running(pid), false);
    assert.equal(await running(witness.pid), true, 'unrelated process must be preserved');
  });
}

test('invalid resource limits fail before any backend can be launched', () => {
  for (const key of ['CODEXWEB_MAX_PROCESSES', 'CODEXWEB_MAX_RSS_MB', 'CODEXWEB_MAX_ACTIVE_TURNS', 'CODEXWEB_IDLE_MINUTES']) {
    for (const value of ['0', '-1', 'NaN', '1.5', 'Infinity']) assert.throws(() => resourceLimits({ [key]: value }), /正整数/);
  }
});

test('oversized tool output is rejected before JSON parsing and the backend is reaped', async t => {
  const binary = await executable(t, 'oversized');
  const connection = new CodexConnection({ binary, timeout: 4000 });
  t.after(async () => cleanup(connection, await fixtureProcesses(binary)));
  await assert.rejects(connection.start(), /单条输出消息超过/);
  assert.equal(connection.info, undefined);
  for (const pid of await fixtureProcesses(binary)) assert.equal(await running(pid), false);
});

test('ambiguous turn-start timeout retires the backend so retry cannot launch duplicate work', async t => {
  const connection = new CodexConnection({ binary: await executable(t, 'turn-timeout'), timeout: 4000 });
  const info = await connection.start(); const pids = [info.pid, ...info.workers];
  t.after(() => cleanup(connection, pids));
  await assert.rejects(connection.request('turn/start', { threadId: 'test' }, { timeout: 100 }), /超时/);
  assert.equal(connection.ready, false);
  await connection.close();
  for (const pid of pids) assert.equal(await running(pid), false);
  await assert.rejects(connection.request('turn/start', { threadId: 'test' }), /未连接/);
});

test('unexpected app-server exit still reaps previously observed detached workers', async t => {
  const connection = new CodexConnection({ binary: await executable(t, 'root-exit'), timeout: 4000 });
  const info = await connection.start(); const pids = [info.pid, ...info.workers];
  t.after(() => cleanup(connection, pids));
  await until(() => connection.inventory?.known.has(info.workers[0]));
  await connection.request('fixture/exit');
  await until(() => !connection.ready);
  await connection.close();
  for (const pid of pids) assert.equal(await running(pid), false);
});

test('a detached worker orphaned before the first process scan is still reclaimed', { skip: !loadSubreaper() }, async t => {
  const connection = new CodexConnection({ binary: await executable(t, 'root-exit'), timeout: 4000,
    limits: { ...resourceLimits({}), pollIntervalMs: 10000 } });
  const info = await connection.start(); const pids = [info.pid, ...info.workers];
  t.after(() => cleanup(connection, pids));
  if (!connection.resources?.orphanProtection) { t.skip('kernel does not support subreaper'); return; }
  await connection.request('fixture/exit');
  await until(() => !connection.ready);
  await connection.close();
  for (const pid of pids) assert.equal(await running(pid), false, 'even unobserved orphan must be reaped');
});
