import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

async function client(options) {
  const context = { window: {}, AbortSignal, Date, setTimeout };
  vm.runInNewContext(await readFile(new URL('../public/reload.js', import.meta.url), 'utf8'), context);
  return new context.window.CodexServiceReload(options);
}
const response = body => ({ ok: true, json: async () => body });

test('reload waits through old service, downtime and new startup before refreshing once', async () => {
  const checks = [
    { app: 'termux-codex-web', serverInstance: 'old', connected: true },
    null,
    { app: 'termux-codex-web', serverInstance: 'new', connected: false },
    { app: 'termux-codex-web', serverInstance: 'new', connected: true },
  ];
  let saves = 0, refreshes = 0, starts = 0, polls = 0;
  const messages = [];
  const reload = await client({
    fetch: async url => {
      if (url === '/api/reload') { starts++; return response({ serverInstance: 'old' }); }
      polls++; const value = checks.shift(); if (!value) throw new Error('connection refused'); return response(value);
    }, save: () => saves++, refresh: () => refreshes++, status: message => messages.push(message), sleep: async () => {},
  });
  await Promise.all([reload.run(), reload.run()]);
  assert.equal(starts, 1); assert.equal(saves, 1); assert.equal(refreshes, 1); assert.equal(polls, 4);
  assert.ok(messages.some(message => message.includes('正在连接 Codex')));
});

test('reload reports request errors and timeout without refreshing or losing saved drafts', async () => {
  let saved = 0, refreshed = 0, failure;
  const reload = await client({ fetch: async () => ({ ok: false, json: async () => ({ error: 'helper failed' }) }), save: () => saved++, refresh: () => refreshed++, status: (text, failed) => { if (failed) failure = text; } });
  await reload.run();
  assert.equal(failure, 'helper failed'); assert.equal(reload.running, false); assert.equal(saved, 1); assert.equal(refreshed, 0);
  reload.fetch = async () => response({ serverInstance: 'old' }); reload.timeout = 0;
  await reload.run();
  assert.match(failure, /等待超时/); assert.equal(refreshed, 0);
});

test('restart helper survives owner exit and launches only after cleanup finishes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-reload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = new URL('../server/reload.mjs', import.meta.url).href;
  const processModule = new URL('../server/processes.mjs', import.meta.url).href;
  const owner = path.join(directory, 'owner.mjs'), next = path.join(directory, 'next.mjs'), marker = path.join(directory, 'started.json');
  await writeFile(next, `import {writeFile,readFile} from 'node:fs/promises'; import {readProcess} from ${JSON.stringify(processModule)}; const old=JSON.parse(await readFile(${JSON.stringify(path.join(directory,'owner.json'))},'utf8')); await writeFile(${JSON.stringify(marker)}, JSON.stringify({old:readProcess(old.pid),cleaned:await readFile(${JSON.stringify(path.join(directory,'cleaned'))},'utf8'),port:process.env.PORT,dataDir:process.env.DATA_DIR}));`);
  await writeFile(owner, `import {prepareReload} from ${JSON.stringify(runtime)}; import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(path.join(directory,'owner.json'))},JSON.stringify({pid:process.pid})); const commit=await prepareReload({dataDir:${JSON.stringify(directory)},port:54321,launchPath:${JSON.stringify(next)},close:async()=>{await new Promise(r=>setTimeout(r,100));await writeFile(${JSON.stringify(path.join(directory,'cleaned'))},'yes');}}); commit();commit();`);
  const proc = spawn(process.execPath, [owner], { stdio: 'ignore' });
  const exited = once(proc, 'exit');
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 10000);
  t.after(() => clearTimeout(timeout));
  const [code] = await exited;
  assert.equal(code, 0);
  let result;
  for (let i = 0; i < 100; i++) {
    try { result = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  assert.ok(result, 'replacement launched');
  assert.ok(!result.old || ['Z', 'X'].includes(result.old.state));
  assert.equal(result.cleaned, 'yes'); assert.equal(result.port, '54321'); assert.equal(result.dataDir, directory);
});
