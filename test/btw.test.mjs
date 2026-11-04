import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentStore } from '../server/attachments.mjs';
import { Readable } from 'node:stream';

test('BTW MCP exposes project readers and rejects traversal, escaped symlinks, writes and extra arguments', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'btw-mcp-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); await mkdir(root);
  await writeFile(path.join(root, 'readme.txt'), 'Project contents');
  await writeFile(path.join(directory, 'outside.txt'), 'Outside contents');
  await symlink('../outside.txt', path.join(root, 'escape'));
  const call = (name, args) => ({ method: 'tools/call', params: { name, arguments: args } });
  const requests = [
    { method: 'initialize', params: {} }, { method: 'tools/list', params: {} },
    call('btw_read_file', { path: 'readme.txt' }), call('btw_list_directory', { path: '' }),
    call('btw_read_file', { path: '../outside.txt' }), call('btw_read_file', { path: 'escape' }),
    call('apply_patch', { path: 'readme.txt' }), call('btw_read_file', { path: 'readme.txt', command: 'write' }),
  ].map((message, id) => ({ jsonrpc: '2.0', id, ...message }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../server/btw-mcp.mjs', import.meta.url)), root], {
    input: requests.map(message => JSON.stringify(message)).join('\n') + '\n', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line).result);
  assert.deepEqual(replies[1].tools.map(tool => tool.name), ['btw_list_directory', 'btw_read_file']);
  assert.ok(replies[2].content[0].text.includes('Project contents'));
  assert.ok(replies[3].content[0].text.includes('readme.txt'));
  for (const reply of replies.slice(4)) assert.equal(reply.isError, true);
  assert.equal(await readFile(path.join(root, 'readme.txt'), 'utf8'), 'Project contents');
});

test('BTW MCP reads only attachments granted to this side chat and persists the scope across processes', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'btw-attachments-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'), dataDir = path.join(directory, 'data');
  await mkdir(root); await mkdir(dataDir);
  const store = new AttachmentStore(path.join(dataDir, 'attachments'));
  const upload = async text => {
    const req = Readable.from([Buffer.from(text)]); req.headers = { 'x-file-name': 'notes.txt' };
    return store.upload(req);
  };
  const own = await upload('Attached side notes'), other = await upload('Other side notes');
  await symlink(path.join(directory, 'outside.txt'), path.join(root, 'escape'));
  await writeFile(path.join(directory, 'outside.txt'), 'Private contents');
  const records = [{ id: 'side-one', cwd: root, files: [own.id] }, { id: 'side-two', cwd: root, files: [other.id] }];
  await writeFile(path.join(dataDir, 'btw.json'), JSON.stringify(records));
  for (const record of records) {
    const paths = [store.location(own.id), store.location(other.id), path.join(directory, 'outside.txt'), 'escape', '../data/btw.json'];
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../server/btw-mcp.mjs', import.meta.url)), root, dataDir, record.id], {
      input: paths.map((value, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'btw_read_file', arguments: { path: value } } })).join('\n') + '\n', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line).result);
    assert.equal(replies[0].isError, record.id === 'side-one' ? undefined : true);
    assert.equal(replies[1].isError, record.id === 'side-two' ? undefined : true);
    assert.match(replies[record.id === 'side-one' ? 0 : 1].content[0].text, /side notes/);
    for (const reply of replies.slice(2)) assert.equal(reply.isError, true);
  }
});
