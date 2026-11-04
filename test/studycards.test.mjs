import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { StudyCards, STUDYCARD_STOP } from '../server/studycards.mjs';
import { VisualizationStore } from '../server/visualizations.mjs';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'studycard-')));
  const dataDir = path.join(cwd, 'data'); await mkdir(dataDir);
  const visualizations = new VisualizationStore(path.join(dataDir, 'visualizations'));
  const events = [], cards = new StudyCards({ dataDir, visualizations, broadcast: message => events.push(structuredClone(message)) });
  await cards.load();
  t.after(async () => { await cards.close(); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, dataDir, cards, events, visualizations };
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
  assert.match(await readFile(path.join(cwd, 'StudyCard/Python语法/容器/list-2.html'), 'utf8'), /<h1>列表<\/h1>\n<p>完整解释。<\/p>/);
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

test('successful marked spans can start in any agent phase; failed turns, chat and quoted markers are skipped', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true);
  for (const [i, options] of [{ status: 'interrupted' }, { status: 'failed' }, { text: '好的，继续。' }, { text: '```text\nStudyCard: Python/list\n```' }, { text: '> StudyCard: Python/list' }].entries()) {
    const turnId = 'skip-' + i;
    await start(cards, cwd, 'a', turnId); complete(cards, { ...options, turnId }); await cards.close();
  }
  assert.deepEqual(await readdir(path.join(cwd, 'StudyCard')), []);
  assert.deepEqual(cards.snapshot('a').results, []);
  for (const [index, phase] of ['commentary', 'partial_answer', null].entries()) {
    const turnId = 'phase-' + index;
    await start(cards, cwd, 'a', turnId); complete(cards, { turnId, phase }); await cards.close();
    assert.equal(cards.snapshot('a').results.at(-1).status, 'saved');
  }
});

test('capture starts at the marker and preserves message/tool order and deduplicates completed items', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true); const capture = await start(cards, cwd);
  const item = (method, value) => cards.ingest({ method: 'item/' + method, params: { threadId: 'a', turnId: 't1', item: value } });
  const before = { id: 'before', type: 'commandExecution', command: 'before marker' };
  item('started', before);
  const first = { id: 'first', type: 'agentMessage', phase: 'commentary', text: '不属于卡片的前言\r\nStudyCard: Python/list\r\n\r\n原文\r\n```python\r\nxs = []\r\n```' };
  item('started', { ...first, text: '' });
  cards.ingest({ method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 't1', itemId: 'first', delta: first.text.slice(0, 40) } });
  cards.ingest({ method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 't1', itemId: 'first', delta: first.text.slice(40) } });
  item('completed', first);
  const tool = { id: 'tool', type: 'mcpToolCall', server: 'example', tool: 'calculate', arguments: { x: 2 }, result: { output: 4 } };
  item('started', tool);
  const tail = { id: 'tail', type: 'agentMessage', phase: 'final_answer', text: '尾部解释' };
  item('started', tail); item('completed', tail); item('completed', tool); item('completed', before);
  item('completed', { id: 'private', type: 'reasoning', text: '私有推理不归档' });
  const terminal = { method: 'turn/completed', params: { threadId: 'a', turn: { id: 't1', status: 'completed', items: [before, first, tool, tail] } } };
  cards.ingest(terminal); cards.ingest(terminal); cards.accepted(capture, { id: 't1' }); await cards.close();
  assert.equal(cards.snapshot('a').results.length, 1);
  const html = await readFile(path.join(cwd, 'StudyCard/Python/list.html'), 'utf8');
  const dom = new JSDOM(html); t.after(() => dom.window.close());
  const main = dom.window.document.querySelector('main');
  assert.deepEqual([...main.children].map(node => node.tagName), ['SECTION', 'DETAILS', 'SECTION']);
  assert.match(main.querySelector('code').textContent, /xs = \[\]/);
  assert.match(main.querySelector('details').textContent, /calculate/);
  assert.equal(main.lastElementChild.textContent.trim(), '尾部解释');
  assert.doesNotMatch(main.textContent, /不属于卡片的前言|before marker|私有推理|StudyCard:/);
  assert.deepEqual(await readdir(path.join(cwd, 'StudyCard')), ['Python']);
});

test('concurrent conversations publish whole cards without overwriting each other or preexisting files', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true); await cards.set('b', cwd, true);
  await start(cards, cwd); await start(cards, cwd, 'b', 't2');
  complete(cards, { text: 'StudyCard: Python/list\n\nfirst' });
  complete(cards, { id: 'b', turnId: 't2', text: 'StudyCard: Python/list\n\nsecond' }); await cards.close();
  const names = await readdir(path.join(cwd, 'StudyCard/Python'));
  assert.deepEqual(names.sort(), ['list-2.html', 'list.html']);
  const contents = await Promise.all(names.map(name => readFile(path.join(cwd, 'StudyCard/Python', name), 'utf8')));
  assert.ok(contents.some(content => content.includes('<p>first</p>')));
  assert.ok(contents.some(content => content.includes('<p>second</p>')));
});

test('malformed headers and escaping paths fail visibly; symlink directories cannot redirect host writes', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true);
  for (const [i, header] of ['../../escape', '/absolute', 'Python//list', 'Python/../list', 'C:\\escape', 'Python/list.md', 'Python/list.html', ''].entries()) {
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

test('HTML cards embed complete visualization snapshots and archive-time state without server references', async t => {
  const { cards, cwd, visualizations } = await fixture(t);
  await writeFile(path.join(cwd, 'plot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64'));
  const html = await visualizations.publish(cwd, { type: 'html', title: '列表模拟', content: '<!doctype html><button onclick="this.textContent=123">点击运行</button>' });
  await visualizations.saveState(html.artifactId, { n: 4 });
  const md = await visualizations.publish(cwd, { type: 'markdown', title: '公式', content: '# 原报告\n\n$x^2$\n\n<script>unsafe()</script>' });
  const image = await visualizations.publish(cwd, { type: 'image', path: 'plot.png', title: '示意图' });
  await rm(path.join(cwd, 'plot.png'));
  await cards.set('a', cwd, true); await start(cards, cwd);
  const send = item => cards.ingest({ method: 'item/completed', params: { threadId: 'a', turnId: 't1', item } });
  send({ id: 'header', type: 'agentMessage', phase: 'commentary', text: 'StudyCard: Python/list' });
  for (const artifact of [html, md, image]) send({ id: artifact.artifactId, type: 'mcpToolCall', server: 'codexwui_visualize', tool: 'visualize', status: 'completed', result: { structuredContent: artifact } });
  complete(cards, { text: '这是可视化之后的完整解释。' }); await cards.close();
  const result = cards.snapshot('a').results[0]; assert.equal(result.status, 'saved');
  const source = await readFile(path.join(cwd, result.path), 'utf8');
  const dom = new JSDOM(source); t.after(() => dom.window.close());
  const main = dom.window.document.querySelector('main');
  assert.deepEqual([...main.children].map(node => node.tagName), ['SECTION', 'SECTION', 'FIGURE', 'SECTION']);
  const frame = main.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.match(frame.srcdoc, /点击运行/);
  assert.match(frame.srcdoc, /window.codexVisualize/);
  assert.deepEqual(JSON.parse(frame.dataset.state), { n: 4 });
  assert.ok(main.querySelector('math'), 'formulas use native MathML without external fonts');
  assert.equal(main.querySelector('.document script'), null);
  assert.match(main.querySelector('img').src, /^data:image\/png;base64,/);
  assert.equal(main.querySelector('details'), null, 'visualization protocol is replaced by published content');
  assert.doesNotMatch(source, /\/api\/visualizations\//);
  assert.match(main.textContent, /可视化之后的完整解释/);
  await rm(visualizations.directory, { recursive: true });
  assert.equal(await readFile(path.join(cwd, result.path), 'utf8'), source);
});

test('capture limit fails visibly instead of silently losing later messages', async t => {
  const { cards, cwd } = await fixture(t);
  await cards.set('a', cwd, true); await start(cards, cwd);
  complete(cards, { text: 'StudyCard: Python/list\n\n' + 'x'.repeat(4 * 1024 * 1024) }); await cards.close();
  assert.equal(cards.snapshot('a').results[0].status, 'error');
  assert.match(cards.snapshot('a').results[0].error, /4 MiB/);
  assert.deepEqual(await readdir(path.join(cwd, 'StudyCard')), []);
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
