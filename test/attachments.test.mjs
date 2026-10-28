import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { AttachmentStore, fileUploadLimit, MAX_FILE_BYTES } from '../server/attachments.mjs';

async function fixture(t, maxBytes) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AttachmentStore(directory, { maxBytes }) };
}
const until = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Upload did not write to disk before EOF');
};
const request = source => Object.assign(source, { headers: { 'x-file-name': encodeURIComponent('数据.txt') } });

test('file limit defaults to 100 MiB and validates configured values', () => {
  assert.equal(fileUploadLimit({}), 100 * 1024 * 1024);
  assert.equal(MAX_FILE_BYTES, fileUploadLimit({}));
  assert.equal(fileUploadLimit({ CODEXWEB_MAX_FILE_MB: '500' }), 500 * 1024 * 1024);
  for (const value of ['', '0', '-1', '1.5', 'no', 'Infinity', String(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => fileUploadLimit({ CODEXWEB_MAX_FILE_MB: value }), /CODEXWEB_MAX_FILE_MB/);
  }
});

test('upload writes before EOF and publishes a usable attachment only when complete', async t => {
  const { directory, store } = await fixture(t, 10);
  const req = request(new PassThrough());
  const upload = store.upload(req);
  req.write(Buffer.from('first'));
  let partial;
  await until(async () => {
    partial = (await readdir(directory)).find(name => name.endsWith('.upload'));
    return partial && (await stat(path.join(directory, partial))).size === 5;
  });
  assert.equal(await readFile(path.join(directory, partial), 'utf8'), 'first');
  await assert.rejects(store.inputs([partial]), { status: 400 });
  req.end(Buffer.from('last!'));
  const file = await upload;
  assert.equal(file.size, 10);
  assert.equal(file.name, '数据.txt');
  assert.deepEqual(await readdir(directory), [file.id]);
  assert.equal(await readFile(store.location(file.id), 'utf8'), 'firstlast!');
  assert.equal((await stat(store.location(file.id))).mode & 0o777, 0o600);
  assert.ok((await store.inputs([file.id]))[0].text.includes(file.id));
});

test('oversized and interrupted streams remove their partial files', async t => {
  const { directory, store } = await fixture(t, 8);
  const oversized = request(Readable.from([Buffer.from('12345'), Buffer.from('6789')]));
  await assert.rejects(store.upload(oversized), { status: 413 });
  assert.deepEqual(await readdir(directory), []);
  const interrupted = request(new PassThrough());
  const upload = store.upload(interrupted);
  const rejected = assert.rejects(upload, /connection lost/);
  interrupted.write(Buffer.from('123'));
  await until(async () => {
    const file = (await readdir(directory))[0];
    return file && (await stat(path.join(directory, file))).size === 3;
  });
  interrupted.destroy(new Error('connection lost'));
  await rejected;
  assert.deepEqual(await readdir(directory), []);
});

test('declared oversize is rejected before creating a file and empty files remain valid', async t => {
  const { directory, store } = await fixture(t, 8);
  const req = request(Readable.from([])); req.headers['content-length'] = '9';
  await assert.rejects(store.upload(req), { status: 413 });
  assert.deepEqual(await readdir(directory), []);
  const file = await store.upload(request(Readable.from([])));
  assert.equal(file.size, 0);
  assert.equal((await stat(store.location(file.id))).size, 0);
});
