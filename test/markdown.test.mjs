import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const scripts = await Promise.all(['vendor/markdown-it.min.js', 'vendor/katex/katex.min.js', 'markdown.js']
  .map(file => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));

function fixture(t) {
  const dom = new JSDOM('<!doctype html><div id="prose"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  for (const script of scripts) dom.window.eval(script);
  const root = dom.window.document.getElementById('prose');
  return { window: dom.window, root, render: text => { root.innerHTML = dom.window.CodexMarkdown(text); return root; } };
}

test('renders the screenshot table and orbital formulas as Markdown and accessible math', t => {
  const { render } = fixture(t);
  const root = render(String.raw`可以设计两个模式：

| 模式 | 用户调节 | 页面自动计算 |
|---|---|---|
| 自由探索 | \(T\) 或 \(a\) | 当前地面轨迹 |
| 重复轨迹 | \(N,D\)，\(i,e,\omega,\Omega\) | 满足重复条件的 \(T\) 和 \(a\) |

选 \(N=15,D=1\)，并考虑 \(J_2\) 摄动。`);
  assert.equal(root.querySelectorAll('table').length, 1);
  assert.equal(root.querySelectorAll('th').length, 3);
  assert.equal(root.querySelectorAll('tbody tr').length, 2);
  assert.equal(root.querySelectorAll('.katex').length, 8);
  assert.equal(root.querySelectorAll('math').length, 8);
  assert.equal(root.querySelector('.table-scroll').tabIndex, 0);
});

test('supports inline and display delimiters, multiline equations, lists and blockquotes', t => {
  const { render } = fixture(t);
  const root = render(String.raw`# 轨道

行内 $a^2$ 与 \(\Omega\)。

\[
T = 2\pi\sqrt{\frac{a^3}{\mu}}
\]

$$x = 1$$

1. **第一项**
   - *子项* 与 \(i\)
2. 第二项

> $$
> y = 2
> $$`);
  assert.equal(root.querySelector('h1').textContent, '轨道');
  assert.equal(root.querySelectorAll('.katex').length, 6);
  assert.equal(root.querySelectorAll('.math-block').length, 3);
  assert.ok(root.querySelector('ol li ul em'));
  assert.ok(root.querySelector('blockquote .math-block'));
});

test('code and escaped delimiters remain literal and do not run inline Markdown', t => {
  const { render } = fixture(t);
  const root = render('`\\(x\\) **literal** $a$`\n\n```tex\n\\[x\\]\n$$a$$\n<script>alert(1)</script>\n```\n\n\\$5 and \\\\(literal\\\\)');
  assert.equal(root.querySelectorAll('.katex').length, 0);
  assert.equal(root.querySelector('code').textContent, '\\(x\\) **literal** $a$');
  assert.ok(root.querySelector('pre code').textContent.includes('<script>'));
  assert.equal(root.querySelectorAll('script, strong').length, 0);
});

test('currency and unmatched formulas remain readable and render when the stream closes', t => {
  const { render } = fixture(t);
  assert.equal(render('成本 $5 和 $10，共 $15。').querySelectorAll('.katex').length, 0);
  assert.equal(render('成本 $5 和 $10，变量 $x$。').querySelectorAll('.katex').length, 1);
  let root = render(String.raw`公式 \(\frac{a`);
  assert.ok(root.textContent.includes(String.raw`\(\frac{a`));
  root = render(String.raw`公式 \(\frac{a}{b}\)`);
  assert.equal(root.querySelectorAll('.katex').length, 1);
  root = render('$$\nx = 1');
  assert.ok(root.textContent.includes('$$'));
  root = render('$$\nx = 1\n$$');
  assert.equal(root.querySelectorAll('.math-block .katex').length, 1);
  root = render(String.raw`无效 \(\frac{\) 后面的 **文字** 正常。`);
  assert.ok(root.querySelector('.math-fallback'));
  assert.equal(root.querySelector('strong').textContent, '文字');
});

test('untrusted HTML, links, images and TeX cannot inject elements or load remote resources', t => {
  const { render } = fixture(t);
  const root = render(String.raw`<script>alert(1)</script><img src=x onerror=alert(1)>

[unsafe](javascript:alert(1)) [safe](https://example.org/?a=1&b=2)

![remote](https://example.org/pixel.png) ![svg](data:image/svg+xml;base64,PHN2Zz4=)

\(\href{javascript:alert(1)}{click}\)

\(\includegraphics{https://example.org/pixel.png}\)

\(\htmlClass{injected}{x}\)`);
  assert.equal(root.querySelectorAll('script, img, iframe, .injected, [onerror]').length, 0);
  const links = [...root.querySelectorAll('a')];
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.ok(link.href.startsWith('https://example.org/'));
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('macros are isolated between messages and runaway formulas fall back without breaking text', t => {
  const { render } = fixture(t);
  render(String.raw`\(\gdef\private{123}\private\)`);
  assert.ok(render(String.raw`\(\private\)`).querySelector('.math-fallback'));
  const root = render(String.raw`\(\def\loop{\loop}\loop\)

仍可阅读。`);
  assert.ok(root.querySelector('.math-fallback'));
  assert.ok(root.textContent.includes('仍可阅读'));
});

test('local file links and images open a browser preview with project and line context', t => {
  const { window, root } = fixture(t);
  const source = '[绝对](/workspace/docs/报告.md:12) [相对](docs/report.md#L8) [本机](file:///workspace/plot.png) [沙盒](sandbox:/workspace/plot.png) ![图片](plot.png) [外链](https://example.org/)';
  root.innerHTML = window.CodexMarkdown(source, { project: 'first' });
  const links = [...root.querySelectorAll('a')];
  assert.equal(links.length, 6);
  for (const link of links.slice(0, 5)) {
    const url = new URL(link.getAttribute('href'), 'http://localhost');
    assert.equal(url.pathname, '/file-preview.html');
    assert.equal(url.searchParams.get('project'), 'first');
    assert.equal(link.target, '_blank');
  }
  assert.equal(new URL(links[0].href, 'http://localhost').searchParams.get('path'), '/workspace/docs/报告.md');
  assert.equal(new URL(links[0].href, 'http://localhost').searchParams.get('line'), '12');
  assert.equal(new URL(links[1].href, 'http://localhost').searchParams.get('line'), '8');
  assert.equal(links[5].getAttribute('href'), 'https://example.org/');
  root.innerHTML = window.CodexMarkdown(source, { project: 'second' });
  assert.equal(new URL(root.querySelector('a').getAttribute('href'), 'http://localhost').searchParams.get('project'), 'second');
  root.innerHTML = window.CodexMarkdown('[下一份](../next.md) [标题](#intro)', { project: 'first', directory: 'docs/sub' });
  assert.equal(new URL(root.querySelector('a').getAttribute('href'), 'http://localhost').searchParams.get('path'), 'docs/sub/../next.md');
  assert.equal(root.querySelectorAll('a')[1].getAttribute('href'), '#intro');
  root.innerHTML = window.CodexMarkdown('[代码](run.py:2:3)', { project: 'first' });
  const bare = new URL(root.querySelector('a').getAttribute('href'), 'http://localhost');
  assert.equal(bare.searchParams.get('path'), 'run.py');
  assert.equal(bare.searchParams.get('line'), '2');
  root.innerHTML = window.CodexMarkdown('[坏](javascript:alert(1)) [远程文件](file://evil.example/secret)', { project: 'first' });
  assert.equal(root.querySelectorAll('a').length, 0);
});
