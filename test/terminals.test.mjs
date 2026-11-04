import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/index.mjs';
import { readProcess } from '../server/processes.mjs';
import { FakeCodex } from './helpers.mjs';

const supported = ['android', 'linux'].includes(process.platform);
const base64 = value => Buffer.from(value).toString('base64');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const alive = pid => { const value = readProcess(pid); return value && !['Z', 'X'].includes(value.state); };
async function until(predicate, description = 'terminal behavior', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  assert.fail(`Timed out: ${description}`);
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexwui-terminal-http-'));
  const codex = new FakeCodex(dir);
  const app = await createApp({ codex, initialProject: dir, dataDir: path.join(dir, 'data') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); await app.startup;
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, value, options = {}) => {
    const response = await fetch(base + route, { ...(value === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    }), ...options });
    return { status: response.status, data: await response.json() };
  };
  const project = (await request('/api/bootstrap')).data.projects[0];
  const create = async (id = project.id) => {
    const result = await request('/api/terminals', { project: id, cols: 80, rows: 24 });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.terminal;
  };
  const send = (id, data, projectId = project.id) => request(`/api/terminals/${id}/input`, { project: projectId, data: base64(data) });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, codex, dir, base, request, project, create, send };
}
async function stream(t, base, project, id, after = 0) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/terminals/${id}/events?${new URLSearchParams({ project, after })}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  let error;
  const done = (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const type = block.match(/^event: (.+)$/m)?.[1], data = block.match(/^data: (.+)$/m)?.[1];
          if (type && data) events.push({ type, ...JSON.parse(data) });
        }
      }
    } catch (failure) { if (!controller.signal.aborted) error = failure; }
  })();
  const close = async () => { controller.abort(); await done; };
  t.after(close);
  await until(() => events.length || error, 'SSE ready');
  assert.ifError(error);
  return { events, close, done, output: () => Buffer.concat(events.filter(event => event.type === 'output').map(event => Buffer.from(event.data, 'base64'))).toString() };
}

test('project terminal HTTP uses real tty, preserves UTF-8, resizes and reconnects without replaying input', { skip: !supported }, async t => {
  const { app, base, project, request, create, send } = await fixture(t);
  assert.deepEqual((await request(`/api/terminals?project=${project.id}`)).data.terminals, []);
  const terminal = await create();
  const first = await stream(t, base, project.id, terminal.id);
  assert.equal(first.events[0].type, 'ready');
  assert.equal(first.events[0].reset, true);
  assert.equal((await send(terminal.id, "test -t 0 && printf '__%s__\\n' 'TTY中文'\r")).status, 200);
  await until(() => first.output().includes('__TTY中文__\r\n'));
  assert.equal((await request(`/api/terminals/${terminal.id}/resize`, { project: project.id, cols: 103, rows: 33 })).status, 200);
  await send(terminal.id, "printf '__%s__\\n' \"$(stty size)\"\r");
  await until(() => first.output().includes('__33 103__\r\n'));
  const cursor = first.events.filter(event => event.type === 'output').at(-1).sequence;
  await first.close();
  const record = app.terminals.session(project, terminal.id);
  const shellPid = record.shellPid;
  assert.ok(alive(shellPid));
  await send(terminal.id, "printf '__%s__\\n' 'MISSED'\r");
  await until(() => record.sequence > cursor);
  const second = await stream(t, base, project.id, terminal.id, cursor);
  assert.equal(second.events[0].reset, false);
  await until(() => second.output().includes('__MISSED__\r\n'));
  assert.ok(second.events.filter(event => event.type === 'output').every(event => event.sequence > cursor));
  await send(terminal.id, "PS1='__HTTP_PROMPT__ '; printf '__%s__\\n' 'SLEEPING'; sleep 30\r");
  await until(() => second.output().includes('__SLEEPING__\r\n'));
  const beforeInterrupt = second.output().length;
  await send(terminal.id, '\x03');
  await until(() => second.output().slice(beforeInterrupt).includes('__HTTP_PROMPT__ '));
  await send(terminal.id, "printf '__%s__\\n' 'INTERRUPTED'\r");
  await until(() => second.output().includes('__INTERRUPTED__\r\n'));
  assert.equal(record.shellPid, shellPid);
  await send(terminal.id, "printf '__%s__\\n' 'FINAL'; exit 7\r");
  await until(() => second.events.some(event => event.type === 'exit'));
  assert.ok(second.output().includes('__FINAL__\r\n'));
  assert.equal(second.events.find(event => event.type === 'exit').terminal.exitCode, 7);
  assert.equal((await send(terminal.id, 'echo forbidden\r')).status, 409);
  assert.equal((await request(`/api/terminals/${terminal.id}/close`, { project: project.id })).status, 200);
});

test('terminal APIs enforce project ownership, same origin, byte limits and live capacity', { skip: !supported }, async t => {
  const { dir, base, project, request, create, send, app } = await fixture(t);
  await mkdir(path.join(dir, 'other'));
  const other = (await request('/api/projects', { path: path.join(dir, 'other') })).data.project;
  const terminal = await create();
  assert.equal((await send(terminal.id, 'bad\r', other.id)).status, 404);
  assert.equal((await request(`/api/terminals/${terminal.id}/resize`, { project: other.id, cols: 80, rows: 24 })).status, 404);
  assert.equal((await request(`/api/terminals/${terminal.id}/close`, { project: other.id })).status, 404);
  const denied = await fetch(`${base}/api/terminals/${terminal.id}/input`, { method: 'POST', headers: { Origin: 'https://example.org', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: project.id, data: base64('bad\r') }) });
  assert.equal(denied.status, 403);
  for (const data of ['!bad', 'Zg=', 'Zh==', base64('x'.repeat(16385))]) {
    assert.equal((await request(`/api/terminals/${terminal.id}/input`, { project: project.id, data })).status, 400);
  }
  assert.equal((await request('/api/terminals', { project: project.id, cols: 0, rows: 30 })).status, 400);
  assert.equal((await request(`/api/terminals/${terminal.id}/resize`, { project: project.id, cols: 80, rows: 10000 })).status, 400);
  const parallel = await Promise.all(Array.from({ length: 4 }, () => request('/api/terminals', { project: project.id, cols: 80, rows: 24 })));
  assert.deepEqual(parallel.map(value => value.status).sort(), [201, 201, 201, 429]);
  assert.equal(app.terminals.list(project).terminals.length, 4);
  assert.equal((await request(`/api/terminals?project=${other.id}`)).data.terminals.length, 0);
  const own = await create(other.id);
  assert.equal(own.project, other.id);
  const missing = await stream(t, base, other.id, terminal.id);
  assert.equal(missing.events[0].type, 'missing');
  assert.equal((await request(`/api/terminals/${terminal.id}/close`, { project: project.id })).status, 200);
  await create();
});

test('bounded output and truncated replay leave chat history independent; app close reaps detached jobs', { skip: !supported }, async t => {
  const { app, base, dir, project, request, create, send, codex } = await fixture(t);
  const terminal = await create();
  const pidFile = path.join(dir, 'terminal-job.pid');
  const command = `trap '' TERM HUP; echo $$ > ${quote(pidFile)}; while :; do sleep 30; done`;
  await send(terminal.id, `setsid sh -c ${quote(command)} >/dev/null 2>&1 &\r`);
  let descendant;
  await until(async () => { try { descendant = Number((await readFile(pidFile, 'utf8')).trim()); return descendant > 1; } catch { return false; } });
  const record = app.terminals.session(project, terminal.id);
  const shellPid = record.shellPid, helperPid = record.child.pid;
  await send(terminal.id, "head -c 900000 /dev/zero | tr '\\0' x; printf '__%s__\\n' 'FLOOD_END'\r");
  await until(() => record.history.map(entry => Buffer.from(entry.data, 'base64').toString()).join('').includes('__FLOOD_END__'));
  assert.ok(record.historyBytes <= 512 * 1024);
  assert.ok(record.history[0].sequence > 1);
  const source = await stream(t, base, project.id, terminal.id, 1);
  assert.equal(source.events[0].reset, true);
  assert.equal(source.events[0].truncated, true);
  await until(() => source.output().includes('__FLOOD_END__'));
  await source.close();
  const usage = (await request('/api/resources')).data.manualTerminals;
  assert.equal(usage.terminals, 1); assert.ok(usage.processes >= 2);
  await app.lifecycle.sweep();
  assert.ok(alive(shellPid));
  assert.equal(codex.calls.filter(call => call.method.startsWith('turn/')).length, 0, 'manual input never calls the model');
  await app.close();
  assert.ok(!alive(descendant), 'detached TERM-ignoring child stopped with the service');
  assert.ok(!alive(shellPid)); assert.ok(!alive(helperPid));
});

test('ending a terminal falls back to process reaping when close cannot reach its helper', { skip: !supported }, async t => {
  const { app, project, request, create } = await fixture(t);
  const terminal = await create();
  const session = app.terminals.session(project, terminal.id), shellPid = session.shellPid, helperPid = session.child.pid;
  const control = session.child.stdio[3], input = session.child.stdin;
  const endControl = control.end, endInput = input.end;
  control.end = () => control;
  input.end = () => input;
  try {
    const started = Date.now();
    const result = await request(`/api/terminals/${terminal.id}/close`, { project: project.id });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(Date.now() - started < 8000, 'ending has a bounded fallback');
    assert.ok(!alive(shellPid)); assert.ok(!alive(helperPid));
    assert.deepEqual(app.terminals.list(project).terminals, []);
  } finally { control.end = endControl; input.end = endInput; }
});
