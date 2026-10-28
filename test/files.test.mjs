import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDirectory, readTextFile, TEXT_LIMIT } from '../server/files.mjs';

async function fixture(t) {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-files-')));
  const root = path.join(outer, 'project'); await mkdir(root);
  t.after(() => rm(outer, { recursive: true, force: true }));
  return { root, outer };
}

test('directory includes hidden entries, sorts folders first and permits only in-project symlinks', async t => {
  const { root, outer } = await fixture(t);
  await mkdir(root + '/src'); await writeFile(root + '/.env', 'secret');
  await writeFile(root + '/a10.md', 'ten'); await writeFile(root + '/a2.md', 'two');
  await writeFile(outer + '/outside', 'outside');
  await symlink('src', root + '/linked'); await symlink('a2.md', root + '/alias');
  await symlink('../outside', root + '/escape'); await symlink('missing', root + '/broken');
  const result = await listDirectory(root);
  assert.deepEqual(result.entries.slice(0, 2).map(e => e.name), ['linked', 'src']);
  assert.ok(result.entries.some(e => e.name === '.env'));
  assert.ok(result.entries.findIndex(e => e.name === 'a2.md') < result.entries.findIndex(e => e.name === 'a10.md'));
  assert.equal(result.entries.find(e => e.name === 'escape').blocked, true);
  assert.equal(result.entries.find(e => e.name === 'broken').blocked, true);
  assert.equal((await readTextFile(root, 'alias')).text, 'two');
  assert.deepEqual((await listDirectory(root, 'linked')).entries, []);
  await assert.rejects(readTextFile(root, 'escape'), { status: 403 });
  await assert.rejects(listDirectory(root, 'escape'), { status: 403 });
  for (const input of ['../outside', 'src/../../outside', '/etc/passwd', '\0']) {
    await assert.rejects(readTextFile(root, input), { status: 400 });
    await assert.rejects(listDirectory(root, input), { status: 400 });
  }
  await assert.rejects(readTextFile(root, 'missing'), { status: 404 });
  await assert.rejects(readTextFile(root, 'src'), { status: 400 });
});

test('raw UTF-8 is unchanged; binary, unsupported encoding and truncation are explicit', async t => {
  const { root } = await fixture(t);
  const raw = '\uFEFF# 文档\r\n<script>alert(1)</script>\n';
  await writeFile(root + '/text.md', raw);
  assert.equal((await readTextFile(root, 'text.md')).text, raw);
  await writeFile(root + '/empty', '');
  assert.equal((await readTextFile(root, 'empty')).text, '');
  await writeFile(root + '/binary', Buffer.from([0, 1, 2, 3]));
  const binary = await readTextFile(root, 'binary');
  assert.equal(binary.kind, 'binary'); assert.equal(binary.text, undefined);
  await writeFile(root + '/legacy', Buffer.from([0xff, 0xfe]));
  assert.equal((await readTextFile(root, 'legacy')).kind, 'unsupportedEncoding');
  await writeFile(root + '/exact', 'a'.repeat(TEXT_LIMIT));
  assert.equal((await readTextFile(root, 'exact')).truncated, false);
  await writeFile(root + '/large', 'a'.repeat(TEXT_LIMIT - 1) + '中尾');
  const large = await readTextFile(root, 'large');
  assert.equal(large.kind, 'text'); assert.equal(large.truncated, true);
  assert.equal(large.text, 'a'.repeat(TEXT_LIMIT - 1));
  assert.equal(large.bytesRead, TEXT_LIMIT);
});

test('a registered root replaced by a symlink is rejected', async t => {
  const { root, outer } = await fixture(t);
  await rename(root, outer + '/moved'); await symlink(outer + '/moved', root);
  await assert.rejects(listDirectory(root), { status: 409 });
  await assert.rejects(readTextFile(root, 'file'), { status: 409 });
});
