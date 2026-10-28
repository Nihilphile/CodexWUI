import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudyCards, STUDYCARD_STOP } from '../server/studycards.mjs';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'studycard-')));
  const dataDir = path.join(cwd, 'data'); await mkdir(dataDir);
  const events = [], cards = new StudyCards({ dataDir, broadcast: message => events.push(structuredClone(message)) });
  await cards.load();
  t.after(async () => { await cards.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, dataDir, cards, events };
}
async function start(cards, cwd, id = 'a', turnId = 't1') {
  const capture = await cards.prepare(id, cwd);
  cards.ingest({ method: 'turn/started', params: { threadId: id, turn: { id: turnId } } });
  return capture;
}
function complete(cards, { id = 'a', turnId = 't1', text = 'StudyCard: Python语法/容器/list\n\n# 列表\n完整解释。', status = 'completed', phase = 'final_answer', items } = {}) {
  const item = { id: 'answer', type: 'agentMessage', text, ...(phase ? { phase } : {}) };
  cards.ingest({ method: 'item/completed', params: { threadId: id, turnId, item } });
  cards.ingest({ method: 'turn/completed', params: { threadId: id, turn: { id: turnId, status, items: items || [] } } });
}

test('switch is opt-in and per-thread; enabled prompts include fresh existing names and host-only storage rules', async t => {
  const { cards, cwd } = await fixture(t);
  assert.equal(await cards.prepare('a', cwd), null);
  complete(cards);
  assert.deepEqual(await readdir(cwd), ['data']);
  await cards.set('a', cwd, true);
  await mkdir(path.join(cwd, 'StudyCard/Python语法/容器'), { recursive: true });
  await writeFile(path.join(cwd, 'StudyCard/Python语法/容器/list.md'), 'old');
  const capture = await start(cards, cwd);
  assert.match(capture.input.text, /"Python语法"\/[\s\S]*"容器"\/[\s\S]*"list.md"/);
  assert.match(capture.input.text, /同一概念尽量复用/);
  assert.match(capture.input.text, /普通闲聊[\s\S]*不输出归档头/);
  assert.match(capture.input.text, /不需要调用工具/);
  assert.equal(await cards.prepare('b', cwd), null);
  complete(cards); await cards.close();
  assert.equal(await readFile(path.join(cwd, 'StudyCard/Python语法/容器/list.md'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(cwd, 'StudyCard/Python语法/容器/list-2.md'), 'utf8'), '# 列表\n完整解释。');
});

test('stop keeps in-flight snapshot, persists across restart, and injects a closing notice once after acceptance', async t => {
  const { cards, cwd, dataDir } = await fixture(t);
  await cards.set('a', cwd, true); await start(cards, cwd);
  await cards.set('a', cwd, false);
  complete(cards); await cards.close();
  assert.equal(cards.snapshot('a').results[0].status, 'saved');
  const restored = new StudyCards({ dataDir, broadcast: () => {} }); await restored.load();
  assert.equal(restored.snapshot('a').enabled, false);
  let next = await restored.prepare('a', cwd);
  assert.ok(next.input.text.includes(STUDYCARD_STOP));
  assert.doesNotMatch(next.input.text, /现有目录树/);
  restored.rejected(next); // A rejected send must not consume the one-time notice.
  next = await start(restored, cwd, 'a', 't2');
  complete(restored, { turnId: 't2', text: 'StudyCard: 不应保存\n\n旧指示残留' });
  restored.accepted(next, { id: 't2' }); // Late RPC response must not resurrect capture.
  await restored.close();
  assert.equal(await restored.prepare('a', cwd), null);
  assert.equal(restored.snapshot('a').results.length, 1);
  assert.deepEqual((await readdir(path.join(cwd, 'StudyCard'))).sort(), ['Python语法']);
  const again = new StudyCards({ dataDir, broadcast: () => {} }); await again.load();
  assert.equal(await again.prepare('a', cwd), null);
  await again.set('a', cwd, true);
  assert.match((await again.prepare('a', cwd)).input.text, /现有目录树/);
  await again.close();
});

test('only successful final replies are archived; commentary, partial replies, failed turns and ordinary chat are skipped', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true);
  for (const [i, options] of [{ phase: 'commentary' }, { phase: 'partial_answer' }, { status: 'interrupted' }, { status: 'failed' }, { text: '好的，继续。' }, { text: '说明\nStudyCard: Python/list\n不是首行。' }].entries()) {
    const turnId = 'skip-' + i;
    await start(cards, cwd, 'a', turnId); complete(cards, { ...options, turnId }); await cards.close();
  }
  assert.deepEqual(await readdir(path.join(cwd, 'StudyCard')), []);
  assert.deepEqual(cards.snapshot('a').results, []);
  await start(cards, cwd, 'a', 'old-version');
  complete(cards, { turnId: 'old-version', phase: null }); await cards.close();
  assert.equal(cards.snapshot('a').results[0].status, 'saved', 'older protocols without phase use the last completed agent reply');
});

test('final answer beats unphased items and duplicate events do not write a second card', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true); const capture = await start(cards, cwd);
  cards.ingest({ method: 'item/completed', params: { threadId: 'a', turnId: 't1', item: { type: 'agentMessage', phase: 'final_answer', text: 'StudyCard: Python/list\r\n\r\n原文\r\n```python\r\nxs = []\r\n```' } } });
  complete(cards, { text: 'StudyCard: 错误路径\n\n不要保存这个回退项', phase: null });
  complete(cards); cards.accepted(capture, { id: 't1' }); await cards.close();
  assert.equal(cards.snapshot('a').results.length, 1);
  assert.equal(await readFile(path.join(cwd, 'StudyCard/Python/list.md'), 'utf8'), '原文\r\n```python\r\nxs = []\r\n```');
  assert.deepEqual(await readdir(path.join(cwd, 'StudyCard')), ['Python']);
});

test('concurrent conversations publish whole cards without overwriting each other or preexisting files', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true); await cards.set('b', cwd, true);
  await start(cards, cwd); await start(cards, cwd, 'b', 't2');
  complete(cards, { text: 'StudyCard: Python/list\n\nfirst' });
  complete(cards, { id: 'b', turnId: 't2', text: 'StudyCard: Python/list\n\nsecond' }); await cards.close();
  const names = await readdir(path.join(cwd, 'StudyCard/Python'));
  assert.deepEqual(names.sort(), ['list-2.md', 'list.md']);
  const contents = await Promise.all(names.map(name => readFile(path.join(cwd, 'StudyCard/Python', name), 'utf8')));
  assert.deepEqual(contents.sort(), ['first', 'second']);
});

test('malformed headers and escaping paths fail visibly; symlink directories cannot redirect host writes', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true);
  for (const [i, header] of ['../../escape', '/absolute', 'Python//list', 'Python/../list', 'C:\\escape', 'Python/list.md', ''].entries()) {
    const turnId = 'invalid-' + i;
    await start(cards, cwd, 'a', turnId);
    complete(cards, { turnId, text: `StudyCard: ${header}\n\ncontent` }); await cards.close();
    assert.equal(cards.snapshot('a').results.at(-1).status, 'error');
  }
  await symlink(cwd, path.join(cwd, 'StudyCard/outside'));
  await start(cards, cwd, 'a', 'symlink');
  complete(cards, { turnId: 'symlink', text: 'StudyCard: outside/escape\n\ncontent' }); await cards.close();
  assert.equal(cards.snapshot('a').results.at(-1).status, 'error');
  assert.deepEqual((await readdir(cwd)).sort(), ['StudyCard', 'data']);
});

test('directory trees are bounded and replaced card roots are rejected', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true);
  const deep = Array.from({ length: 16 }, (_, i) => 'level-' + i);
  await mkdir(path.join(cwd, 'StudyCard', ...deep), { recursive: true });
  const capture = await cards.prepare('a', cwd);
  assert.match(capture.input.text, /已截断/);
  cards.rejected(capture);
  await rm(path.join(cwd, 'StudyCard'), { recursive: true });
  await symlink(cwd, path.join(cwd, 'StudyCard'));
  await assert.rejects(cards.prepare('a', cwd));
  await assert.rejects(cards.set('b', cwd, true));
});
