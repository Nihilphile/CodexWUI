void (async () => {
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(window.location.search);
  const project = query.get('project'), location = query.get('path');
  const status = $('file-status'), content = $('file-content');
  try {
    if (!project || !location) throw new Error('文件链接缺少项目或路径，请从对话中的文件链接打开');
    const params = new URLSearchParams({ project, path: location });
    const response = await fetch(`/api/files/preview?${params}`);
    const file = await response.json();
    if (!response.ok) throw new Error(file.error || `读取失败 (${response.status})`);
    document.title = `${file.path.split('/').pop()} · Codex`;
    $('file-name').textContent = file.path.split('/').pop();
    $('file-path').textContent = file.path;
    params.set('path', file.path);
    const original = `/api/files/content?${params}`;
    $('original-file').href = original; $('original-file').hidden = false;
    $('download-file').href = original + '&download=1'; $('download-file').hidden = false;
    const size = file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KiB` : `${(file.size / (1024 * 1024)).toFixed(1)} MiB`;
    status.textContent = size;
    if (file.truncated) status.textContent += ' · 文件较大，仅显示前 1 MiB；下载可获取完整文件。';
    const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const lineNumber = Number(query.get('line'));
    const line = Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber : null;
    let source = Boolean(line);
    const renderText = () => {
      content.replaceChildren();
      if (file.kind === 'markdown' && !source) {
        content.innerHTML = window.CodexMarkdown(file.text, { project, directory });
        for (const heading of content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
          heading.id = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s+/g, '-');
        }
        if (window.location.hash) {
          try { document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView?.(); } catch { /* Invalid fragment. */ }
        }
      } else {
        const pre = document.createElement('pre'); pre.className = 'preview-raw';
        if (line) {
          const lines = file.text.split('\n');
          if (line <= lines.length) {
            pre.append(document.createTextNode(lines.slice(0, line - 1).join('\n') + (line > 1 ? '\n' : '')));
            const selected = document.createElement('span'); selected.className = 'preview-line selected';
            selected.textContent = lines[line - 1]; pre.append(selected);
            pre.append(document.createTextNode((line < lines.length ? '\n' : '') + lines.slice(line).join('\n')));
          } else { pre.textContent = file.text; status.textContent += ' · 该行超出当前预览范围。'; }
        } else pre.textContent = file.text;
        content.append(pre);
        content.querySelector('.selected')?.scrollIntoView?.({ block: 'center' });
      }
      $('toggle-source').textContent = source ? '查看排版' : '查看原文';
      $('toggle-source').setAttribute('aria-pressed', String(source));
    };
    if (file.kind === 'markdown' || file.kind === 'text') {
      renderText();
      if (file.kind === 'markdown') {
        $('toggle-source').hidden = false;
        $('toggle-source').onclick = () => { source = !source; renderText(); };
      }
    } else if (file.kind === 'image') {
      const link = document.createElement('a'); link.href = original; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'preview-image-link';
      const image = document.createElement('img'); image.src = original; image.alt = file.path; image.className = 'preview-image';
      image.onerror = () => { status.textContent = '图片无法显示，可尝试下载原文件。'; status.classList.add('failed'); };
      link.append(image); content.append(link); status.textContent += ' · 点击图片打开原图';
    } else if (file.kind === 'pdf') {
      status.textContent += ' · 点击“打开原文件”使用浏览器阅读 PDF，或下载查看。';
    } else status.textContent += ` · ${file.reason || '此类型暂不支持预览'}，可下载原文件。`;
  } catch (error) {
    status.textContent = `无法打开文件：${error.message}`;
    status.classList.add('failed');
  }
})();
