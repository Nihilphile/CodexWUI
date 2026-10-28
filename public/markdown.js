// Keep parsing local and synchronous so history and streaming use the same path.
(() => {
  const md = window.markdownit({ html: false, breaks: true, linkify: true });
  const escape = md.utils.escapeHtml;
  const validateLink = md.validateLink;
  md.validateLink = url => {
    if (/^file:/i.test(url)) {
      try { const parsed = new URL(url); return !parsed.hostname || parsed.hostname === 'localhost'; }
      catch { return false; }
    }
    if (/^sandbox:/i.test(url)) return /^sandbox:\//i.test(url);
    return validateLink(url);
  };
  const localLink = (url, env) => {
    if (!env.project || !url || url.startsWith('#') || url.startsWith('//')) return null;
    if (/^file:/i.test(url)) {
      try { const parsed = new URL(url); url = parsed.pathname + parsed.hash; } catch { return null; }
    } else if (/^sandbox:/i.test(url)) url = url.slice('sandbox:'.length);
    else if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/:\d+(?::\d+)?(?:#|$)/.test(url)) return null;
    const hash = url.indexOf('#');
    const fragment = hash === -1 ? '' : url.slice(hash + 1);
    let location = url.slice(0, hash === -1 ? undefined : hash).split('?')[0];
    let line = fragment.match(/^L?(\d+)(?:[-:]|$)/)?.[1];
    const suffix = location.match(/:(\d+)(?::\d+)?$/);
    if (suffix) { line = suffix[1]; location = location.slice(0, suffix.index); }
    try { location = decodeURIComponent(location); } catch { return null; }
    if (!location) return null;
    if (!location.startsWith('/') && env.directory) location = `${env.directory}/${location}`;
    const query = new URLSearchParams({ project: env.project, path: location });
    if (line) query.set('line', line);
    return `/file-preview.html?${query}${fragment && !line ? '#' + encodeURIComponent(fragment) : ''}`;
  };
  const escaped = (source, index) => {
    let slashes = 0;
    while (index > 0 && source[--index] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  const closing = (source, delimiter, start) => {
    let index = source.indexOf(delimiter, start);
    while (index !== -1 && escaped(source, index)) index = source.indexOf(delimiter, index + delimiter.length);
    return index;
  };
  const renderMath = (source, displayMode) => {
    try {
      return window.katex.renderToString(source, {
        displayMode, throwOnError: true, trust: false, strict: 'ignore',
        maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml',
      });
    } catch {
      // Incomplete streamed TeX and unsupported commands stay readable.
      return `<code class="math-fallback">${escape(source)}</code>`;
    }
  };

  md.inline.ruler.before('escape', 'math', (state, silent) => {
    const start = state.pos;
    const open = ['\\(', '\\[', '$$', '$'].find(value => state.src.startsWith(value, start));
    if (!open) return false;
    const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
    const from = start + open.length;
    if (open === '$' && /\s/.test(state.src[from] || ' ')) return false;
    const end = closing(state.src, close, from);
    if (open === '$') {
      // A currency amount such as "$5 and $10" is ordinary text.
      if (end !== -1 && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] || ''))) return false;
    }
    if (end === -1 || end + close.length > state.posMax) {
      if (open[0] !== '\\') return false;
      if (!silent) state.push('text', '', 0).content = open;
      state.pos = from;
      return true;
    }
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = state.src.slice(from, end);
      token.meta = { display: open === '$$' || open === '\\[' };
    }
    state.pos = end + close.length;
    return true;
  });
  md.renderer.rules.math_inline = (tokens, index) => renderMath(tokens[index].content, tokens[index].meta.display);

  md.block.ruler.before('fence', 'math_block', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
    if (!open) return false;
    const close = open === '$$' ? '$$' : '\\]';
    let content = first.slice(open.length), line = start;
    let finish = closing(content, close, 0);
    while (finish === -1 && ++line < end) {
      if (state.sCount[line] < state.blkIndent && !state.isEmpty(line)) return false;
      content += '\n' + state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      finish = closing(content, close, 0);
    }
    if (finish === -1 || content.slice(finish + close.length).trim()) return false;
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.block = true; token.content = content.slice(0, finish); token.map = [start, line + 1];
    state.line = line + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_block = (tokens, index) => `<div class="math-block">${renderMath(tokens[index].content, true)}</div>\n`;

  const link = md.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const href = tokens[index].attrGet('href');
    const preview = localLink(href, env);
    if (preview) tokens[index].attrSet('href', preview);
    else if (/^(?:file|sandbox):/i.test(href)) tokens[index].attrSet('href', '#');
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
    return link(tokens, index, options, env, renderer);
  };
  // Uploaded images have their own renderer. Markdown images remain links so
  // model text cannot silently fetch third-party resources.
  md.renderer.rules.image = (tokens, index, options, env) => {
    const token = tokens[index], url = token.attrGet('src');
    const label = escape(token.content || '图片');
    const href = localLink(url, env) || (/^https?:\/\//i.test(url) ? url : null);
    return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  };
  md.renderer.rules.table_open = () => '<div class="table-scroll" role="region" aria-label="表格" tabindex="0"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';

  // Rendering the full history on every delta must not re-typeset old formulas.
  const cache = new Map();
  let size = 0;
  window.CodexMarkdown = (text = '', env = {}) => {
    const source = String(text);
    const key = JSON.stringify([env.project, env.directory, source]);
    if (cache.has(key)) return cache.get(key);
    const html = md.render(source, env);
    const weight = key.length + html.length;
    if (weight <= 1024 * 1024) {
      while (cache.size && (size + weight > 1024 * 1024 || cache.size >= 100)) {
        const key = cache.keys().next().value;
        size -= key.length + cache.get(key).length; cache.delete(key);
      }
      cache.set(key, html); size += weight;
    }
    return html;
  };
})();
