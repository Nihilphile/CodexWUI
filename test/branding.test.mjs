import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readlink, symlink, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { resourceLimits } from '../server/limits.mjs';
import { fileUploadLimit } from '../server/attachments.mjs';
import { AppConfig } from '../server/config.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codexwui-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('startup limits accept legacy names, prefer new names and report environment sources', async t => {
  const env = { CODEXWEB_MAX_RSS_MB: '5000', CODEXWEB_MAX_FILE_MB: '200', CODEXWEB_IDLE_MINUTES: '8' };
  assert.equal(resourceLimits(env).maxRssMb, 5000);
  assert.equal(resourceLimits(env).idleMs, 480000);
  assert.equal(fileUploadLimit(env), 200 * 1024 * 1024);
  env.CODEXWUI_MAX_RSS_MB = '6000'; env.CODEXWUI_MAX_FILE_MB = '300';
  const config = new AppConfig({ dataDir: await directory(t), env, limits: resourceLimits(env), maxFileBytes: fileUploadLimit(env) });
  await config.load();
  const { settings, sources } = config.snapshot();
  assert.equal(settings.maxRssMb, 6000); assert.equal(settings.maxFileMb, 300);
  assert.equal(sources.maxRssMb, 'environment'); assert.equal(sources.idleMinutes, 'environment');
  assert.equal(sources.defaultModel, 'default');
  assert.throws(() => resourceLimits({ ...env, CODEXWUI_MAX_RSS_MB: '' }), /CODEXWUI_MAX_RSS_MB/);
});

test('setup migrates its old launcher, installs both new spellings, and preserves unrelated commands', async t => {
  const dir = await directory(t), checkout = path.join(dir, 'checkout');
  for (const file of ['scripts/install.mjs', 'scripts/build-subreaper.mjs', 'scripts/build-terminal.mjs', 'server/subreaper.mjs', 'bin/codexwui', 'bin/agentctl', 'skills/agent-chat/SKILL.md']) {
    const target = path.join(checkout, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, file), target);
  }
  const prefix = path.join(dir, 'prefix'), bin = path.join(prefix, 'bin');
  await mkdir(bin, { recursive: true });
  const old = path.join(bin, 'CodexWeb');
  await symlink(path.join(checkout, 'bin/CodexWeb'), old);
  const env = { ...process.env, PREFIX: prefix, CODEX_HOME: path.join(dir, 'codex-home'), CC: path.join(dir, 'no-compiler') };
  const install = () => exec(process.execPath, [path.join(checkout, 'scripts/install.mjs')], { env });
  await install();
  for (const name of ['codexwui', 'CodexWUI']) assert.equal(await readlink(path.join(bin, name)), path.join(checkout, 'bin/codexwui'));
  assert.equal(await readlink(path.join(bin, 'agentctl')), path.join(checkout, 'bin/agentctl'));
  await assert.rejects(lstat(old), { code: 'ENOENT' });
  await writeFile(old, 'another application');
  await install();
  assert.equal(await readFile(old, 'utf8'), 'another application');
});

for (const app of ['termux-codex-web', 'codexwui']) {
  test(`new launcher recognizes an already running ${app} service`, async t => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ app, root, connected: true }));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const env = { ...process.env, DATA_DIR: await directory(t), PORT: String(server.address().port) };
    const result = await exec(process.execPath, [path.join(root, 'scripts/launch.mjs'), '--no-open'], { env, timeout: 5000 });
    assert.match(result.stdout, /CodexWUI：/);
    assert.match(result.stdout, /codexwui --stop/);
    const status = await exec(process.execPath, [path.join(root, 'scripts/launch.mjs'), '--status'], { env, timeout: 5000 });
    assert.match(status.stdout, /运行中.*已连接/);
  });
}
