import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { ensureTerminalHelper } from '../scripts/build-terminal.mjs';
import { readProcess } from '../server/processes.mjs';

const supported = ['android', 'linux'].includes(process.platform);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const alive = pid => { const value = readProcess(pid); return value && !['Z', 'X'].includes(value.state); };
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail('Timed out waiting for native terminal behavior');
}
async function start(t, { pauseOutput = false } = {}) {
  const binary = await ensureTerminalHelper();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codexwui-terminal-'));
  const child = spawn(binary, [process.env.SHELL || '/bin/sh', '80', '24'], {
    cwd, env: { ...process.env, HOME: cwd }, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  let output = '', errors = '', pending = '', exited = false;
  const messages = [], decoder = new StringDecoder('utf8');
  child.stdout.on('data', bytes => { output += decoder.write(bytes); });
  if (pauseOutput) child.stdout.pause();
  child.stderr.on('data', bytes => { errors += bytes; });
  child.stdio[4].on('data', bytes => {
    pending += bytes;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) if (line) messages.push(JSON.parse(line));
  });
  // Closing the helper may race with an in-flight test input write.
  child.stdin.on('error', () => {});
  child.stdio[3].on('error', () => {});
  const done = new Promise(resolve => child.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  t.after(async () => {
    if (!exited) { child.stdio[3].end('close\n'); await Promise.race([done, delay(4000)]); }
    if (!exited) { child.kill('SIGKILL'); await done; }
    await rm(cwd, { recursive: true, force: true });
  });
  const ready = await until(() => messages.find(message => message.type === 'ready') ||
    (exited && assert.fail(`Native startup failed: ${errors} ${JSON.stringify(messages)}`)));
  return { binary, cwd, child, done, ready, messages, output: () => output, errors: () => errors };
}

test('native PTY has cwd, interactive Ctrl+C and resize, and preserves final exit output', { skip: !supported }, async t => {
  const terminal = await start(t);
  terminal.child.stdin.write("printf '\\nTTY:'; test -t 0 && pwd\r");
  await until(() => terminal.output().split('\r\n').some(line => line.startsWith('TTY:') && line.endsWith(path.basename(terminal.cwd))));
  terminal.child.stdio[3].write('resize 111 37\n');
  terminal.child.stdin.write("printf '\\nSIZE:'; stty size\r");
  await until(() => terminal.output().includes('SIZE:37 111\r\n'));
  terminal.child.stdin.write("PS1='__NATIVE_PROMPT__ '; printf '\\nRUNNING\\n'; sleep 30\r");
  await until(() => terminal.output().includes('\r\nRUNNING\r\n'));
  const beforeInterrupt = terminal.output().length;
  terminal.child.stdin.write('\x03');
  await until(() => terminal.output().slice(beforeInterrupt).includes('__NATIVE_PROMPT__ '));
  terminal.child.stdin.write("printf '\\nAFTER_INTERRUPT\\n'\r");
  await until(() => terminal.output().includes('\r\nAFTER_INTERRUPT\r\n'));
  terminal.child.stdin.write("printf '\\nFINAL_OUTPUT\\n'; exit 7\r");
  const exited = await terminal.done;
  await until(() => terminal.messages.some(message => message.type === 'exit'));
  assert.equal(exited.code, 0);
  assert.match(terminal.output(), /\r\nFINAL_OUTPUT\r\n/);
  assert.deepEqual(terminal.messages.find(message => message.type === 'exit'), { type: 'exit', code: 7, signal: null });
});

for (const mode of ['close', 'exit']) {
  test(`native ${mode} reaps a detached descendant that ignores TERM/HUP`, { skip: !supported }, async t => {
    const terminal = await start(t);
    const pidFile = path.join(terminal.cwd, 'detached.pid');
    const command = `trap '' TERM HUP; echo $$ > ${quote(pidFile)}; while :; do sleep 30; done`;
    terminal.child.stdin.write(`setsid sh -c ${quote(command)} >/dev/null 2>&1 &\r`);
    const descendant = await until(async () => {
      try { return Number((await readFile(pidFile, 'utf8')).trim()); } catch { return false; }
    });
    assert.ok(alive(descendant));
    if (mode === 'close') terminal.child.stdio[3].write('close\n');
    else terminal.child.stdin.write('exit\r');
    assert.equal((await terminal.done).code, 0, terminal.errors());
    assert.ok(!alive(descendant), `Detached process ${descendant} survived terminal ${mode}`);
    assert.ok(!alive(terminal.ready.pid));
  });
}

test('native helper handles close while terminal output is backpressured', { skip: !supported }, async t => {
  const terminal = await start(t, { pauseOutput: true });
  terminal.child.stdin.write('yes NATIVE_OUTPUT_FLOOD\r');
  await delay(200);
  const started = Date.now();
  terminal.child.stdio[3].write('close\n');
  assert.equal((await terminal.done).code, 0, terminal.errors());
  assert.ok(Date.now() - started < 4000);
  assert.ok(!alive(terminal.ready.pid));
});

test('native exec failure emits an error and never reports ready', { skip: !supported }, async () => {
  const binary = await ensureTerminalHelper();
  const child = spawn(binary, ['/no-such-codexwui-shell', '80', '24'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let status = '';
  child.stdio[4].on('data', bytes => { status += bytes; });
  child.stdout.resume(); child.stderr.resume();
  const result = await new Promise(resolve => child.on('close', code => resolve(code)));
  const messages = status.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(result, 1);
  assert.ok(messages.some(message => message.type === 'error' && /Execute terminal shell/.test(message.message)));
  assert.ok(!messages.some(message => message.type === 'ready'));
});

test('native helper cleans descendants after abrupt owner death', { skip: !supported }, async t => {
  const binary = await ensureTerminalHelper();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'codexwui-terminal-owner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = `
    const {spawn}=require('node:child_process');
    const child=spawn(${JSON.stringify(binary)},[process.env.SHELL||'/bin/sh','80','24'],{cwd:${JSON.stringify(cwd)},env:{...process.env,HOME:${JSON.stringify(cwd)}},stdio:['pipe','pipe','pipe','pipe','pipe']});
    child.stdout.resume();child.stderr.resume();
    child.stdio[4].on('data', bytes=>{
      for (const line of String(bytes).trim().split('\\n')) {
        const message=JSON.parse(line);
        if(message.type==='ready'){
          child.stdin.write('setsid sh -c '+${JSON.stringify(quote(`trap '' TERM HUP; echo $$ > ${quote(path.join(cwd, 'detached.pid'))}; while :; do sleep 30; done`))}+' >/dev/null 2>&1 &\\r');
          process.stdout.write(JSON.stringify({helper:child.pid,shell:message.pid})+'\\n');
        }
      }
    });
  `;
  const owner = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  owner.stdout.on('data', bytes => { output += bytes; }); owner.stderr.on('data', bytes => { error += bytes; });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const record = await until(() => output.includes('\n') && JSON.parse(output.trim()));
  const descendant = await until(async () => {
    try { return Number((await readFile(path.join(cwd, 'detached.pid'), 'utf8')).trim()); } catch { return false; }
  });
  assert.ok(alive(descendant), error);
  owner.kill('SIGKILL');
  await until(() => !alive(record.helper) && !alive(record.shell) && !alive(descendant), 7000);
});
