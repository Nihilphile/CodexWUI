// Drafts stay outside rendering so live output cannot overwrite an edit.
window.CodexQueue = {
  drafts: new Map(),
  html(q, scope, escape, btw = false) {
    if (!q?.entries?.length) return '';
    const attr = btw ? 'data-btw-queue' : 'data-queue-action';
    const button = (action, label, e) => `<button type="button" ${attr}="${action}" data-entry="${escape(e?.id || '')}" data-revision="${e?.revision || 0}" data-scope="${escape(scope)}" ${e?.status === 'sending' ? 'disabled' : ''}>${label}</button>`;
    return `<div class="queue-title">待发送消息 · ${q.entries.length}</div>${q.error ? `<p class="error-text">${escape(q.error)}</p>` : ''}` + q.entries.map(e => {
      const key = `${scope}:${e.id}:${e.revision}`;
      const label = { queued: '等待当前任务完成', unsent: '未发出 · 已停止', editing: '未发出 · 编辑中', sending: '正在投递' }[e.status] || '等待发送';
      const source = e.source ? ` · 来自 ${e.source.agent_id || '本机 CLI'}` : '';
      const file = e.source?.file ? ` · ${e.source.file}` : '';
      return `<article class="queue-entry"><div class="queue-message"><div class="queue-title">${escape(label + source + file)}</div>${e.status === 'editing' ? `<textarea aria-label="修改待发送消息" data-queue-draft="${escape(key)}" rows="4">${escape(this.drafts.get(key) ?? e.text)}</textarea>` : `<details><summary>${escape(e.text.slice(0, 160) || '附件消息')}${e.text.length > 160 ? '…' : ''}</summary><pre>${escape(e.text)}</pre></details>`}${e.files?.length ? ` · ${e.files.length} 个文件` : ''}${e.images?.length ? ` · ${e.images.length} 张图片` : ''}${e.error ? `<p class="error-text">${escape(e.error)}</p>` : ''}<div class="queue-actions">${e.status === 'editing' ? button('update', '保存为未发出', e) : button('edit', '撤回修改', e) + (e.status === 'unsent' ? button('run', '继续发送', e) : '')}${button('remove', '删除', e)}</div></div></article>`;
    }).join('') + (q.entries.some(e => e.status === 'unsent') ? button('run', '继续全部') : '');
  },
  async action(button, request) {
    const action = button.dataset.queueAction || button.dataset.btwQueue;
    const id = button.dataset.entry || undefined, revision = id ? Number(button.dataset.revision) : undefined;
    const key = `${button.dataset.scope}:${id}:${revision}`;
    const input = { id, revision };
    if (action === 'update') {
      const textarea = [...document.querySelectorAll('[data-queue-draft]')].find(el => el.dataset.queueDraft === key);
      input.text = this.drafts.get(key) ?? textarea?.value;
    }
    const result = await request(`queue-${action}`, input);
    if (action === 'update' || action === 'remove') this.drafts.delete(key);
    return result;
  },
};
document.addEventListener('input', event => {
  if (event.target.dataset.queueDraft) window.CodexQueue.drafts.set(event.target.dataset.queueDraft, event.target.value);
});
