import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath, rename, readFile, readdir, stat } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listDirectory, readTextFile, TEXT_LIMIT, uploadProjectFile } from '../server/files.mjs';

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

const uploadRequest = (stream, name = '报告.pdf') => Object.assign(stream, { headers: { 'x-file-name': encodeURIComponent(name) } });
const bytesRequest = (bytes, name) => uploadRequest(Readable.from([Buffer.from(bytes)]), name);
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Upload did not write its partial file');
};

test('workspace uploads preserve bytes, publish unique names concurrently and never replace files or symlinks', async t => {
  const { root, outer } = await fixture(t); await mkdir(path.join(root, 'docs'));
  const original = Buffer.from([0, 255, 4, 128, 1]);
  const uploads = await Promise.all(Array.from({ length: 3 }, () => uploadProjectFile(root, 'docs', bytesRequest(original), 100)));
  assert.deepEqual(uploads.map(file => file.name).sort(), ['报告 (1).pdf', '报告 (2).pdf', '报告.pdf']);
  for (const file of uploads) assert.deepEqual(await readFile(path.join(root, file.path)), original);
  await writeFile(path.join(outer, 'outside'), 'original'); await symlink(path.join(outer, 'outside'), path.join(root, 'docs/link.txt'));
  const renamed = await uploadProjectFile(root, 'docs', bytesRequest('new', 'link.txt'), 100);
  assert.equal(renamed.name, 'link (1).txt'); assert.equal(await readFile(path.join(outer, 'outside'), 'utf8'), 'original');
  const longName = '中'.repeat(83) + '.txt';
  await uploadProjectFile(root, 'docs', bytesRequest('', longName), 100);
  const longCopy = await uploadProjectFile(root, 'docs', bytesRequest('', longName), 100);
  assert.ok(Buffer.byteLength(longCopy.name) <= 255); assert.ok(longCopy.name.endsWith(' (1).txt'));
  assert.equal((await stat(path.join(root, longCopy.path))).size, 0);
  assert.equal((await readdir(path.join(root, 'docs'))).some(name => name.endsWith('.part')), false);
});

test('workspace uploads stream to hidden partials and clean up oversize or aborted requests', async t => {
  const { root } = await fixture(t);
  const req = uploadRequest(new PassThrough()); const uploading = uploadProjectFile(root, '', req, 10);
  req.write(Buffer.from('first'));
  await until(async () => { const names = await readdir(root); return names.length === 1 && (await stat(path.join(root, names[0]))).size === 5; });
  assert.deepEqual((await listDirectory(root)).entries, []);
  req.end(Buffer.from('last!')); const result = await uploading;
  assert.equal(result.size, 10); assert.equal(await readFile(path.join(root, result.path), 'utf8'), 'firstlast!');
  await rm(path.join(root, result.path));
  await assert.rejects(uploadProjectFile(root, '', bytesRequest('12345678901'), 10), { status: 413 });
  assert.deepEqual(await readdir(root), []);
  const large = bytesRequest('small'); large.headers['content-length'] = '11';
  await assert.rejects(uploadProjectFile(root, '', large, 10), { status: 413 });
  assert.deepEqual(await readdir(root), []);
  const interrupted = uploadRequest(new PassThrough()); const pending = uploadProjectFile(root, '', interrupted, 10);
  const rejected = assert.rejects(pending); interrupted.write(Buffer.from('test'));
  await until(async () => (await readdir(root)).length === 1);
  interrupted.destroy(new Error('connection lost')); await rejected;
  assert.deepEqual(await readdir(root), []);
});

test('workspace uploads reject path escape, invalid names and a destination replaced during upload', async t => {
  const { root, outer } = await fixture(t);
  await mkdir(path.join(root, 'docs')); await symlink(outer, path.join(root, 'outside'));
  for (const [directory, status] of [['../', 400], ['/tmp', 400], ['outside', 403], ['missing', 404]]) {
    await assert.rejects(uploadProjectFile(root, directory, bytesRequest('bad'), 100), { status });
  }
  for (const name of ['', '..', '../bad', 'a/b', 'a\\b', 'bad\0.pdf', '中'.repeat(86)]) {
    await assert.rejects(uploadProjectFile(root, '', bytesRequest('bad', name), 100), { status: 400 });
  }
  const req = uploadRequest(new PassThrough()); const uploading = uploadProjectFile(root, 'docs', req, 100);
  const rejected = assert.rejects(uploading, { status: 403 }); req.write(Buffer.from('first'));
  await until(async () => (await readdir(path.join(root, 'docs'))).length === 1);
  await rename(path.join(root, 'docs'), path.join(outer, 'moved'));
  await symlink(path.join(outer, 'moved'), path.join(root, 'docs'));
  req.end(Buffer.from('last')); await rejected;
  assert.deepEqual(await readdir(path.join(outer, 'moved')), []);
});
