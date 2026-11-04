import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { isVisualization } from './visualizations.mjs';

export const CARD_PREFIX = '<!doctype html>\n<!-- CodexWUI StudyCard v1 -->';
// Both markers have the same byte length, so bounded prefix reads work for old cards.
export const isStudyCardHTML = text => text.startsWith(CARD_PREFIX) || text.startsWith('<!doctype html>\n<!-- CodexWeb StudyCard v1 -->');
export const CARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data: blob:; frame-src about: data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let renderer;
async function markdownRenderer() {
  // Reuse the production bundles and the same Markdown/math rules as chat.
  // Only trusted repository code executes here; user content is parsed as text.
  renderer ||= (async () => {
    const context = { URL, URLSearchParams }; context.window = context;
    for (const name of ['vendor/markdown-it.min.js', 'vendor/katex/katex.min.js', 'markdown.js']) {
      runInNewContext(await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8'), context, { filename: name });
      if (name.includes('katex.min.js')) {
        const katex = context.katex;
        // Native MathML keeps exported cards independent of fonts and CDNs.
        context.katex = { renderToString: (text, options) => katex.renderToString(text, { ...options, output: 'mathml' }) };
      }
    }
    return context.CodexMarkdown;
  })();
  return renderer;
}

// Included in exported cards: the same isolated widget bridge, with state
// embedded at archive time. Interactions stay local; no model calls or storage.
const frameHost = `addEventListener('message', event => {
  const data = event.data;
  if (!data || data.codexVisualization !== 1) return;
  const frame = [...document.querySelectorAll('iframe[data-study-visual]')].find(frame => frame.contentWindow === event.source);
  if (!frame) return;
  if (data.method === 'ready') frame.contentWindow.postMessage({codexVisualization:1,channel:data.channel,method:'init',value:{state:JSON.parse(frame.dataset.state || 'null'),theme:'light'}}, '*');
  if (data.method === 'height' && Number.isFinite(data.value)) frame.height = String(Math.max(180, Math.min(1400, Math.ceil(data.value))));
  if (data.method === 'message' && typeof data.value === 'string') frame.parentElement.querySelector('.followup').textContent = data.value.slice(0,10000);
});`;

async function visualizationHTML(item, store, cwd, markdown) {
  let result = item.result?.structuredContent;
  if (!result) {
    try { result = JSON.parse(item.result?.content?.find(block => block.type === 'text')?.text || 'null'); } catch {}
  }
  if (!result?.artifactId || !store) {
    return `<aside class="notice">可视化未能发布：${escape(item.error?.message || item.result?.content?.find(block => block.type === 'text')?.text || '缺少可视化快照')}</aside>`;
  }
  const record = await store.record(result.artifactId);
  if (record.root !== cwd) throw new Error('可视化快照不属于当前项目');
  const bytes = await store.bytes(record), title = escape(record.title);
  if (record.type === 'image') return `<figure><img alt="${title}" src="data:${escape(record.mimeType)};base64,${bytes.toString('base64')}"><figcaption>${title}</figcaption></figure>`;
  if (record.type === 'markdown') return `<section class="document"><h2>${title}</h2>${markdown(bytes.toString('utf8'))}</section>`;
  const runtime = await readFile(new URL('../public/visualization-runtime.js', import.meta.url), 'utf8');
  const bootstrap = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(CARD_CSP)}"><script>${runtime}</script>`;
  const source = bytes.toString('utf8');
  const embedded = /^\s*<!doctype[^>]*>/i.test(source)
    ? source.replace(/^(\s*<!doctype[^>]*>)/i, (_, doctype) => doctype + bootstrap) : '<!doctype html>' + bootstrap + source;
  return `<section class="visual"><h2>${title}</h2><iframe data-study-visual="${escape(record.id)}" data-state="${escape(JSON.stringify(await store.state(record.id)))}" title="${title}" sandbox="allow-scripts" referrerpolicy="no-referrer" height="480" srcdoc="${escape(embedded)}"></iframe><p class="followup"></p></section>`;
}

export async function renderStudyCard({ segments, items, visualizations, cwd }) {
  const markdown = await markdownRenderer(), blocks = [];
  let bytes = 0;
  for (const item of items) {
    let html;
    if (item.type === 'agentMessage') html = item.text.trim() ? `<section class="explanation">${markdown(item.text)}</section>` : '';
    else if (isVisualization(item)) html = await visualizationHTML(item, visualizations, cwd, markdown);
    else html = `<details class="tool-record"><summary>工具：${escape(item.tool || item.name || item.type)}</summary><pre>${escape(JSON.stringify(item, null, 2))}</pre></details>`;
    bytes += Buffer.byteLength(html);
    if (bytes > 32 * 1024 * 1024) throw new Error('HTML 卡片超过 32 MiB，未保存截断内容');
    blocks.push(html);
  }
  if (!blocks.some(block => block)) throw new Error('StudyCard 正文为空');
  return `${CARD_PREFIX}
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escape(CARD_CSP)}"><title>${escape(segments.at(-1))} · StudyCard</title>
<style>html{color-scheme:light dark}body{font:17px/1.75 system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 20px;color:light-dark(#202720,#e5e9e5);background:light-dark(#fafcf9,#172019)}header{border-bottom:1px solid #879587;margin-bottom:28px}header p{opacity:.7}h1,h2,h3{line-height:1.35}section,figure{margin:24px 0}pre{overflow:auto;padding:16px;background:light-dark(#eef2ed,#232f25);border-radius:10px}code{font-size:.9em}table{border-collapse:collapse;width:100%}th,td{border:1px solid #879587;padding:8px;text-align:left}.table-scroll{overflow:auto}blockquote,.notice{border-left:4px solid #879587;padding-left:16px}img,svg{max-width:100%}figure{margin-inline:0}figcaption{opacity:.7}iframe{width:100%;border:1px solid #879587;border-radius:10px;background:white;box-sizing:border-box}.tool-record{margin:24px 0;font-size:14px}.tool-record pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:light-dark(#176140,#8ddab1)}.katex math{font-size:1.15em}.math-block{overflow:auto}math[display=block]{padding:12px 0}.followup{white-space:pre-wrap;opacity:.75}</style>
<script>${frameHost}</script></head><body><header><h1>${escape(segments.at(-1))}</h1><p>${escape(segments.join(' / '))}</p></header><main>${blocks.join('\n')}</main></body></html>`;
}
