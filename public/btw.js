// Each pane owns its history window; complete turn data stays in its conversation.
window.CodexTurnWindow = class {
  static historyOrder(previous, page) {
    const known = [...previous.keys()], incoming = page.map(turn => turn.id);
    const overlap = incoming.find(id => previous.has(id));
    const prefix = overlap ? known.slice(0, known.indexOf(overlap)) : known;
    return [...new Set([...prefix, ...incoming, ...known])];
  }
  constructor({ scroller, root, button, key, read, loadOlder, changed, fail }) {
    Object.assign(this, { scroller, root, button, key, read, loadOlder, changed, fail });
    this.views = new Map(); this.currentKey = null; this.lastTop = 0;
    button.onclick = () => { void this.earlier().catch(fail); };
    scroller.addEventListener('scroll', () => {
      const top = scroller.scrollTop, previous = this.lastTop; this.lastTop = top;
      if (this.currentKey === this.key()) {
        const view = this.view(this.currentKey); view.top = top;
        if (top < previous && scroller.scrollHeight - top - scroller.clientHeight >= 80) view.expanded = true;
      }
      if (top < previous && top <= 80) void this.earlier().catch(fail);
    }, { passive: true });
    scroller.addEventListener('wheel', event => {
      if (event.deltaY < 0 && scroller.scrollTop <= 80) void this.earlier().catch(fail);
    }, { passive: true });
    let touchY = null;
    scroller.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
    scroller.addEventListener('touchmove', event => {
      const next = event.touches[0]?.clientY;
      if (touchY !== null && next > touchY + 10 && scroller.scrollTop <= 80) { touchY = next; void this.earlier().catch(fail); }
    }, { passive: true });
  }
  view(key) {
    if (!this.views.has(key)) this.views.set(key, { first: null, expanded: false, loading: false, prepend: false });
    return this.views.get(key);
  }
  visible(key, turns) {
    const all = [...turns.values()], view = this.view(key);
    let index = all.findIndex(turn => turn.id === view.first);
    const atBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    if (index < 0 || (!view.expanded && (this.currentKey !== key || atBottom) && !view.prepend)) index = Math.max(0, all.length - 5);
    view.first = all[index]?.id || null;
    return all.slice(index);
  }
  commit(key, mutate) {
    const view = this.view(key), switching = this.currentKey !== key;
    const top = this.scroller.scrollTop, height = this.scroller.scrollHeight;
    const following = height - top - this.scroller.clientHeight < 80;
    const edge = this.scroller.getBoundingClientRect().top;
    const anchor = switching ? null : [...this.root.children].find(node => node.getBoundingClientRect().bottom > edge);
    const offset = anchor?.getBoundingClientRect().top;
    if (!switching && !following) view.expanded = true;
    mutate();
    if (switching) this.scroller.scrollTop = view.expanded ? view.top ?? this.scroller.scrollHeight : this.scroller.scrollHeight;
    else if (view.prepend) {
      if (anchor?.isConnected) this.scroller.scrollTop += anchor.getBoundingClientRect().top - offset;
      else this.scroller.scrollTop = top + this.scroller.scrollHeight - height;
    } else if (following) this.scroller.scrollTop = this.scroller.scrollHeight;
    else if (anchor?.isConnected) this.scroller.scrollTop += anchor.getBoundingClientRect().top - offset;
    view.prepend = false;
    this.currentKey = key; this.lastTop = this.scroller.scrollTop; view.top = this.lastTop;
    const owner = this.read(key), all = [...(owner?.turns.values() || [])];
    this.button.hidden = !(all.findIndex(turn => turn.id === view.first) > 0 || owner?.nextTurns);
    this.button.disabled = view.loading;
  }
  async earlier() {
    const key = this.key(), owner = this.read(key);
    if (!owner || !key) return;
    const view = this.view(key);
    if (view.loading || view.prepend) return;
    let all = [...owner.turns.values()], index = all.findIndex(turn => turn.id === view.first);
    if (index <= 0 && !owner.nextTurns) return;
    view.loading = true; this.button.disabled = true;
    try {
      if (index <= 0) await this.loadOlder(key);
      all = [...(this.read(key)?.turns.values() || [])];
      index = all.findIndex(turn => turn.id === view.first);
      view.first = all[Math.max(0, index - 5)]?.id || view.first;
      view.expanded = true; view.prepend = true;
    } finally {
      view.loading = false;
      if (this.key() === key) this.changed();
    }
  }
};

// Main and side composers use the same upload validation and previews.
window.CodexAttachments = {
  sequence: 0,
  pending(entry, escape) {
    return (entry.images?.length ? `<div class="pending-steer-images">${entry.images.map(id => `<img src="/api/images/${encodeURIComponent(id)}" alt="引导图片" loading="lazy">`).join('')}</div>` : '') + (entry.files?.length ? `<div>${entry.files.map(id => escape(id.slice(38))).join(' · ')}</div>` : '');
  },
  html(attachments, escape, disabled, attribute = 'data-remove-image') {
    return attachments.map(item => `<div class="image-attachment">${item.url ? `<img src="${escape(item.url)}" alt="${escape(item.name)}">` : '<span class="image-placeholder">▧</span>'}<span class="image-name">${escape(item.name)}</span><span class="image-status">${escape(item.error || (item.id ? '已就绪' : '上传中…'))}</span><button type="button" ${attribute}="${escape(item.key)}" aria-label="移除附件 ${escape(item.name)}" ${disabled ? 'disabled' : ''}>×</button></div>`).join('');
  },
  add(files, kind, attachments, { maxFileBytes, notify, changed }) {
    for (const file of files) {
      if (attachments.filter(item => (item.kind || 'image') === kind).length >= 4) { notify('每条消息最多附加 4 张图片和 4 个文件'); break; }
      if (kind === 'file' && !maxFileBytes) { notify('正在读取文件上传限制，请稍后重试'); break; }
      if (kind === 'image' && file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { notify('请选择 PNG、JPEG 或 WebP 图片；其他格式请先转换'); continue; }
      const maxBytes = kind === 'file' ? maxFileBytes : 10 * 1024 * 1024;
      if ((kind === 'image' && !file.size) || file.size > maxBytes) { notify(kind === 'file' ? `单个文件不能超过 ${maxBytes / (1024 * 1024)} MiB` : '请选择非空图片，单张不能超过 10 MiB'); continue; }
      const item = { kind, key: `${Date.now()}-${++this.sequence}`, name: file.name || (kind === 'file' ? '文件' : '图片') };
      attachments.push(item); changed();
      void (async () => {
        try {
          const response = await fetch(kind === 'file' ? '/api/attachments' : '/api/images', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'file') }, body: file });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '附件上传失败');
          Object.assign(item, result);
        } catch (error) { item.error = `${error.message}，请移除后重选`; }
        finally { changed(); }
      })();
    }
    changed();
  },
  bind(form, input, attach) {
    const receive = event => {
      const files = [...(event.clipboardData?.files || event.dataTransfer?.files || [])];
      if (!files.length) return;
      event.preventDefault();
      for (const kind of ['image', 'file']) {
        const selected = files.filter(file => file.type.startsWith('image/') === (kind === 'image'));
        if (selected.length) attach(selected, kind);
      }
    };
    input.addEventListener('paste', receive);
    form.addEventListener('drop', receive);
    form.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  },
};

// Shared pending-message UI travels with the existing BTW asset so an older
// running backend can serve updated frontend files without new asset routes.
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
  mount(root, html) {
    if (root.innerHTML === html) return;
    const active = document.activeElement;
    const editing = root.contains(active) && active.dataset.queueDraft;
    const selection = editing ? [active.selectionStart, active.selectionEnd] : null;
    root.innerHTML = html;
    if (editing) {
      const replacement = [...root.querySelectorAll('[data-queue-draft]')].find(el => el.dataset.queueDraft === editing);
      if (replacement) { replacement.focus(); replacement.setSelectionRange(...selection); }
    }
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

// Each side chat owns its draft and hydration, independently of main rendering.
window.CodexBtwPanel = class {
  constructor(root, { api, markdown, escape, notify, bringBack, getUploadLimit, renderItem, mountMessages }) {
    Object.assign(this, { root, api, markdown, escape, notify, bringBack, getUploadLimit, renderItem, mountMessages });
    this.parentId = null; this.sessionId = null; this.sessions = new Map(); this.sides = new Map(); this.selected = new Map();
    this.drafts = new Map(); this.attachments = new Map(); this.modes = new Map(); this.editors = new Map(); this.busy = new Set(); this.creating = new Set(); this.events = []; this.serial = 0;
    root.innerHTML = '<div class="btw-heading"><strong>BTW · 侧聊</strong><div class="btw-picker"><label class="sr-only" for="btw-select">选择侧聊</label><select id="btw-select"></select><button id="btw-new" type="button" class="secondary-button">新侧聊 ＋</button></div><p id="btw-context">创建时继承主会话上下文，后续独立讨论。</p></div><div id="btw-messages" class="btw-messages" role="log" aria-label="BTW 对话"></div><div id="btw-pending" class="btw-pending"></div><form id="btw-steer-form" hidden><label for="btw-steer-text">修改预引导</label><textarea id="btw-steer-text" rows="3"></textarea><p id="btw-steer-error" class="error-text"></p><div class="btw-actions"><button id="btw-steer-cancel" type="button" class="secondary-button">取消修改</button><button class="primary-button" type="submit">保存</button></div></form><p id="btw-error" class="error-text" role="status"></p><form id="btw-form"><label class="sr-only" for="btw-prompt">BTW 问题</label><textarea id="btw-prompt" rows="3" placeholder="顺便问一下…"></textarea><div class="btw-actions"><label class="sr-only" for="btw-send-mode">运行中发送方式</label><select id="btw-send-mode" hidden><option value="steer">引导（steer）</option><option value="queue">排队（follow-up）</option></select><button id="btw-stop" type="button" class="secondary-button" hidden>停止回答</button><button id="btw-send" class="primary-button" type="submit">发送 ↑</button></div></form>';
    this.input = root.querySelector('#btw-prompt'); this.messages = root.querySelector('#btw-messages'); this.error = root.querySelector('#btw-error');
    this.more = document.createElement('button'); this.more.id = 'btw-more-turns'; this.more.type = 'button'; this.more.className = 'text-button older-button'; this.more.textContent = '加载更早消息'; this.more.hidden = true;
    this.content = document.createElement('div'); this.content.id = 'btw-turns';
    this.messages.append(this.more, this.content);
    this.turnWindow = new window.CodexTurnWindow({ scroller: this.messages, root: this.content, button: this.more,
      key: () => this.sessionId, read: id => this.sessions.get(id), loadOlder: id => this.loadEarlier(id),
      changed: () => this.render(), fail: error => this.showError(error),
    });
    const editorAttachments = document.createElement('div'); editorAttachments.id = 'btw-steer-attachments'; editorAttachments.className = 'steer-edit-attachments';
    root.querySelector('#btw-steer-text').after(editorAttachments);
    const form = root.querySelector('#btw-form');
    const attachmentBar = document.createElement('div');
    attachmentBar.id = 'btw-attachments'; attachmentBar.className = 'image-attachments'; attachmentBar.hidden = true;
    attachmentBar.setAttribute('aria-label', 'BTW 附件'); attachmentBar.setAttribute('aria-live', 'polite');
    this.input.after(attachmentBar);
    const actions = root.querySelector('#btw-form .btw-actions');
    for (const kind of ['image', 'file']) {
      const picker = document.querySelector(`#${kind}-input`).cloneNode();
      picker.id = `btw-${kind}-input`; form.append(picker);
      const button = document.createElement('button'); button.type = 'button'; button.id = `btw-attach-${kind}`; button.className = 'composer-tool';
      button.textContent = kind === 'image' ? '▧' : '📎'; button.setAttribute('aria-label', kind === 'image' ? '添加图片' : '添加文件');
      actions.insertBefore(button, root.querySelector('#btw-send-mode'));
      button.onclick = () => picker.click();
      picker.onchange = event => { const files = [...event.target.files]; event.target.value = ''; this.attach(files, kind); };
    }
    window.CodexAttachments.bind(form, this.input, (files, kind) => this.attach(files, kind));
    this.input.oninput = () => { this.rememberDraft(); this.sizeInput(); };
    this.input.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    };
    root.querySelector('#btw-send-mode').onchange = event => { this.modes.set(this.sessionId, event.target.value); this.render(); };
    root.querySelector('#btw-steer-text').oninput = event => { const editor = this.editors.get(this.sessionId); if (editor) editor.text = event.target.value; };
    root.querySelector('#btw-steer-form').onsubmit = event => { event.preventDefault(); void this.editorAction(false); };
    root.querySelector('#btw-steer-cancel').onclick = () => { void this.editorAction(true); };
    root.querySelector('#btw-form').onsubmit = event => { event.preventDefault(); void this.send().catch(() => {}); };
    root.querySelector('#btw-new').onclick = () => { void this.show(this.parentId, '').catch(error => this.showError(error)); };
    root.querySelector('#btw-select').onchange = event => {
      const id = this.parentId, sessionId = event.target.value;
      this.select(sessionId);
      void this.load(id, sessionId).catch(error => { if (this.sessionId === sessionId) this.showError(error); });
    };
    root.querySelector('#btw-stop').onclick = () => {
      const parentId = this.parentId, sessionId = this.sessionId;
      void api(`/api/btw/${encodeURIComponent(parentId)}/stop`, { sessionId }).catch(error => { if (this.sessionId === sessionId) this.showError(error); });
    };
    root.addEventListener('click', event => {
      const editRemove = event.target.closest('[data-btw-edit-attachment]');
      if (editRemove) {
        const editor = this.editors.get(this.sessionId);
        if (editor && !editor.busy) editor.entry[editRemove.dataset.btwEditAttachment].splice(Number(editRemove.dataset.index), 1);
        this.render(); return;
      }
      const remove = event.target.closest('[data-btw-remove-attachment]');
      if (remove) {
        if (!this.busy.has(this.sessionId)) this.attachments.set(this.sessionId, (this.attachments.get(this.sessionId) || []).filter(item => item.key !== remove.dataset.btwRemoveAttachment));
        this.render(); return;
      }
      const action = event.target.closest('[data-btw-steer], [data-btw-queue]');
      if (action) {
        const sessionId = this.sessionId;
        action.disabled = true;
        void this.pendingAction(action, sessionId).catch(error => { if (this.sessionId === sessionId) this.showError(error); }).finally(() => { action.disabled = false; this.render(); });
        return;
      }
      const button = event.target.closest('[data-btw-bring]');
      if (!button || !this.parentId) return;
      const session = this.sessions.get(this.sessionId);
      const item = [...(session?.turns.values() || [])].flatMap(turn => [...turn.items.values()]).find(item => item.id === button.dataset.btwBring);
      if (item?.text) this.bringBack(this.parentId, item.text);
    });
  }
  rememberDraft() { if (this.sessionId) this.drafts.set(this.sessionId, this.input.value); }
  sizeInput() { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(180, Math.max(70, this.input.scrollHeight))}px`; }
  attach(files, kind) {
    const sessionId = this.sessionId;
    if (!sessionId || this.root.querySelector(`#btw-attach-${kind}`).disabled) return;
    if (!this.attachments.has(sessionId)) this.attachments.set(sessionId, []);
    window.CodexAttachments.add(files, kind, this.attachments.get(sessionId), { maxFileBytes: this.getUploadLimit?.(), notify: this.notify, changed: () => this.render() });
  }
  register(record) {
    if (!record) return;
    record = { ...record, id: record.id || record.threadId };
    const existing = this.sessions.get(record.id);
    this.sessions.set(record.id, { turns: new Map(), queue: { entries: [] }, steers: { entries: [], version: -1 }, sendingSteers: new Map(), queueEvent: 0, ...existing, ...record });
    if (record.threadId) this.sides.set(record.threadId, record.id);
    if (this.drafts.has(record.parentId) && !this.drafts.has(record.id)) {
      this.drafts.set(record.id, this.drafts.get(record.parentId)); this.drafts.delete(record.parentId);
    }
  }
  owns(id) { return this.sides.has(id); }
  select(sessionId) {
    if (sessionId === this.sessionId) return;
    this.rememberDraft(); this.serial++;
    this.sessionId = sessionId;
    if (this.parentId && sessionId) this.selected.set(this.parentId, sessionId);
    this.input.value = this.drafts.get(sessionId) || ''; this.error.textContent = ''; this.render();
  }
  setParent(id, allowed = true) {
    if (this.parentId === id && this.allowed === (allowed && Boolean(id))) return;
    if (this.parentId !== id) {
      this.rememberDraft(); this.parentId = id; this.sessionId = null; this.serial++; this.input.value = ''; this.error.textContent = '';
    }
    this.allowed = allowed && Boolean(id);
    if (!this.sessionId) {
      const selected = this.selected.get(id), latest = [...this.sessions.values()].filter(session => session.parentId === id).at(-1);
      this.select(this.sessions.get(selected)?.parentId === id ? selected : latest?.id || null);
    }
    this.render();
  }
  async show(id, question) {
    this.setParent(id, this.allowed);
    if (!this.allowed) throw new Error('请先选择一个主会话再打开 BTW');
    if (question !== undefined) await this.create(id, question);
    else {
      await this.load(id);
      if (this.parentId === id && !this.sessionId) await this.create(id, '');
    }
    if (this.parentId === id) this.input.focus();
  }
  async create(id, question = '') {
    if (this.creating.has(id)) return;
    this.creating.add(id); const version = ++this.serial; this.render();
    try {
      const snapshot = await this.api(`/api/btw/${encodeURIComponent(id)}/open`, {});
      this.hydrate(snapshot);
      const sessionId = snapshot.session.id;
      this.drafts.set(sessionId, question);
      if (this.parentId === id && (version === this.serial || this.sessionId === sessionId)) { this.select(sessionId); this.input.value = question; }
      // Inline questions stay attached to this new chat if the user switches.
      if (question.trim()) await this.send(sessionId);
    } finally { this.creating.delete(id); this.render(); }
  }
  async load(id = this.parentId, sessionId = this.selected.get(id)) {
    if (!id || !this.allowed) return;
    const version = ++this.serial;
    const snapshot = await this.api(`/api/btw/${encodeURIComponent(id)}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`);
    if (version !== this.serial || this.parentId !== id) return;
    this.hydrate(snapshot);
    if (snapshot.session) this.select(snapshot.session.id);
    this.render();
  }
  async loadEarlier(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.nextTurns) return;
    const snapshot = await this.api(`/api/btw/${encodeURIComponent(session.parentId)}?session=${encodeURIComponent(sessionId)}&cursor=${encodeURIComponent(session.nextTurns)}`);
    const current = this.sessions.get(sessionId), previous = current.turns; current.turns = new Map();
    for (const turn of [...snapshot.history.data].reverse()) this.merge(current, turn);
    for (const [id, turn] of previous) current.turns.set(id, turn);
    current.nextTurns = snapshot.history.nextCursor;
  }
  hydrate(snapshot) {
    for (const record of snapshot.sessions || []) this.register(record);
    if (snapshot.session) {
      this.register(snapshot.session);
      const session = this.sessions.get(snapshot.session.id);
      if (!session.hydrated) { session.turns = new Map(); session.nextTurns = snapshot.history.nextCursor; }
      if (snapshot.queue) session.queue = snapshot.queue;
      this.setSteers(session, snapshot.steers);
      const page = [...snapshot.history.data].reverse();
      const live = (snapshot.live?.turns || []).filter(turn => turn.id !== session.forkTurnId);
      const order = window.CodexTurnWindow.historyOrder(session.turns, [...page, ...live]);
      for (const turn of [...page, ...live]) this.merge(session, turn);
      session.turns = new Map(order.map(id => [id, session.turns.get(id)]));
      session.activeTurnId = snapshot.live?.activeTurnId || [...session.turns.values()].find(turn => turn.status === 'inProgress')?.id || null;
      for (const event of this.events) {
        const params = event.message.params || {};
        if (event.n > snapshot.eventSequence && (params.sessionId === session.id || (session.threadId && (params.threadId || params.thread?.id) === session.threadId))) this.ingest(event.message, false);
      }
      session.hydrated = true;
    }
  }
  merge(session, raw) {
    const previous = session.turns.get(raw.id);
    if (previous && previous.status !== 'inProgress' && raw.status === 'inProgress') return;
    session.turns.set(raw.id, { ...raw, items: new Map((raw.items || []).map(item => [item.id, item])) });
  }
  setSteers(session, snapshot) {
    if (snapshot && (snapshot.instance !== session.steers.instance || snapshot.version >= session.steers.version)) session.steers = snapshot;
  }
  async control(action, input, sessionId = this.sessionId) {
    const session = this.sessions.get(sessionId), queueEvent = session.queueEvent;
    const result = await this.api(`/api/btw/${encodeURIComponent(session.parentId)}/${action}`, { ...input, sessionId });
    const current = this.sessions.get(sessionId);
    if (result.queue && current.queueEvent === queueEvent) current.queue = result.queue;
    this.setSteers(current, result.steers); this.render();
    return result;
  }
  async pendingAction(button, sessionId) {
    if (button.dataset.btwQueue) return window.CodexQueue.action(button, (action, input) => this.control(action, input, sessionId));
    const action = button.dataset.btwSteer, session = this.sessions.get(sessionId);
    const entry = session.steers.entries.find(value => value.id === button.dataset.entry);
    if (!entry) throw new Error('引导消息状态已变化，请稍后重试');
    if (action === 'copy') { await navigator.clipboard.writeText(entry.text); this.notify('已复制引导文字'); return; }
    if (action === 'edit' && this.editors.has(sessionId)) throw new Error('请先保存或取消当前修改');
    const result = await this.control(`steer-${action}`, { id: entry.id, revision: Number(button.dataset.revision) }, sessionId);
    if (action === 'edit') this.editors.set(sessionId, { entry: result.entry, text: result.entry.text });
    if (action === 'remove' && this.editors.get(sessionId)?.entry.id === entry.id) this.editors.delete(sessionId);
  }
  async editorAction(cancel) {
    const sessionId = this.sessionId, editor = this.editors.get(sessionId);
    if (!editor || editor.busy) return;
    editor.busy = true; this.render();
    try {
      await this.control(cancel ? 'steer-cancel-edit' : 'steer-update', { id: editor.entry.id, revision: editor.entry.revision, text: editor.text, files: editor.entry.files, images: editor.entry.images }, sessionId);
      this.editors.delete(sessionId);
    } catch (error) {
      if (cancel) { this.editors.delete(sessionId); if (this.sessionId === sessionId) this.showError(error); }
      else editor.error = error.message;
    }
    finally { editor.busy = false; this.render(); }
  }
  ingest(message, record = true, sequence = 0) {
    if (record) { this.events.push({ message, n: sequence }); if (this.events.length > 2000) this.events.shift(); }
    if (message.method === 'web/btw') { this.register(message.params.session); if (message.params.session.parentId === this.parentId) this.requestRender(false); return true; }
    const p = message.params || {}, id = p.threadId || p.thread?.id;
    const session = this.sessions.get(p.sessionId || this.sides.get(id));
    if (!session) return false;
    if (message.method === 'web/queue') { session.queue = p.queue; session.queueEvent++; if (session.id === this.sessionId) this.requestRender(false); return true; }
    if (message.method === 'web/steers') { this.setSteers(session, p.steers); if (session.id === this.sessionId) this.requestRender(false); return true; }
    const turnId = p.turnId || p.turn?.id;
    if (turnId && turnId !== session.forkTurnId) {
      if (!session.turns.has(turnId)) session.turns.set(turnId, { id: turnId, status: 'inProgress', items: new Map() });
      const turn = session.turns.get(turnId);
      if (message.method === 'turn/started') session.activeTurnId = turnId;
      if (message.method === 'turn/completed') {
        this.merge(session, p.turn); session.activeTurnId = null;
      } else if (p.item) turn.items.set(p.item.id, p.item);
      else if (p.itemId && typeof p.delta === 'string' && message.method === 'item/agentMessage/delta') {
        const item = turn.items.get(p.itemId) || { id: p.itemId, type: 'agentMessage', text: '' };
        item.text = ((item.text || '') + p.delta).slice(-250000); turn.items.set(item.id, item);
      }
    }
    if (message.method === 'error' && this.sessionId === session.id) this.error.textContent = p.error?.message || 'BTW 回答失败';
    if (session.id === this.sessionId) this.requestRender();
    else if (session.parentId === this.parentId && ['turn/started', 'turn/completed'].includes(message.method)) this.requestRender(false);
    return true;
  }
  async send(sessionId = this.sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || this.busy.has(sessionId)) return;
    const text = (sessionId === this.sessionId ? this.input.value : this.drafts.get(sessionId) || '').trim();
    const attachments = this.attachments.get(sessionId) || [];
    if ((!text && !attachments.length) || attachments.some(item => !item.id || item.error)) return;
    const files = attachments.filter(item => item.kind === 'file').map(item => item.id), images = attachments.filter(item => item.kind !== 'file').map(item => item.id);
    const expectedTurnId = session.activeTurnId, mode = expectedTurnId ? this.modes.get(sessionId) || 'steer' : 'send';
    const clientUserMessageId = mode === 'steer' ? crypto.randomUUID() : undefined;
    if (clientUserMessageId) session.sendingSteers.set(clientUserMessageId, { id: clientUserMessageId, text, files, images, status: 'staging' });
    this.busy.add(sessionId); if (this.sessionId === sessionId) this.error.textContent = ''; this.render();
    try {
      const result = mode === 'send'
        ? await this.api(`/api/btw/${encodeURIComponent(session.parentId)}/send`, { sessionId, text, files, images })
        : await this.control(mode, { text, files, images, expectedTurnId, clientUserMessageId }, sessionId);
      const currentSession = this.sessions.get(sessionId);
      if (result.turn) {
        // Streaming events can arrive before this HTTP response. The initial
        // turn is only a fallback; it must not replace newer deltas or completion.
        if (!currentSession.turns.has(result.turn.id)) this.merge(currentSession, result.turn);
        const current = currentSession.turns.get(result.turn.id);
        for (const item of result.turn.items || []) if (!current.items.has(item.id)) current.items.set(item.id, item);
        if (!currentSession.activeTurnId || currentSession.activeTurnId === current.id) currentSession.activeTurnId = current.status === 'inProgress' ? current.id : null;
      }
      this.drafts.delete(sessionId);
      this.attachments.delete(sessionId);
      if (this.sessionId === sessionId) this.input.value = '';
    } catch (error) { if (this.sessionId === sessionId) this.showError(error); throw error; }
    finally { this.sessions.get(sessionId)?.sendingSteers.delete(clientUserMessageId); this.busy.delete(sessionId); this.render(); }
  }
  showError(error) { this.error.textContent = error.message; }
  renderPending(session) {
    const queue = session?.queue, received = new Set([...(session?.turns.values() || [])].flatMap(turn => [...turn.items.values()].filter(item => item.type === 'userMessage').map(item => item.clientId)));
    const steers = session ? [...session.steers.entries, ...[...session.sendingSteers.values()].filter(entry => !session.steers.entries.some(value => value.id === entry.id))] : [];
    let html = steers.filter(entry => !received.has(entry.id)).map(entry => {
      const canEdit = ['staged', 'editing', 'failed'].includes(entry.status);
      const label = ({ staging: '正在暂存…', staged: '等待当前执行轮次结束', editing: '正在编辑 · 已暂停发送', submitting: '正在提交 · 无法撤回', accepted: '等待 Codex 接收', failed: '未提交 · 内容已保留', unknown: '提交结果待确认 · 请勿重复发送' })[entry.status] || entry.status;
      const attrs = `data-entry="${this.escape(entry.id)}" data-revision="${entry.revision}"`;
      return `<article class="pending-steer"><div class="pending-steer-label">预引导 · ${this.escape(label)}</div><div class="pending-steer-text">${this.escape(entry.text)}</div>${window.CodexAttachments.pending(entry, this.escape)}${entry.error ? `<p class="error-text">${this.escape(entry.error)}</p>` : ''}<div class="pending-steer-actions">${canEdit ? `<button type="button" data-btw-steer="edit" ${attrs}>修改</button><button type="button" data-btw-steer="remove" ${attrs}>${entry.status === 'failed' ? '移除' : '撤回'}</button>` : ''}${entry.status === 'staged' ? `<button type="button" data-btw-steer="send" ${attrs}>立即引导</button>` : ''}<button type="button" data-btw-steer="copy" ${attrs}>复制文字</button></div></article>`;
    }).join('');
    html += window.CodexQueue.html(queue, this.sessionId, this.escape, true);
    const pending = this.root.querySelector('#btw-pending');
    window.CodexQueue.mount(pending, html);
    const editor = this.editors.get(this.sessionId), form = this.root.querySelector('#btw-steer-form');
    form.hidden = !editor;
    const key = editor ? `${this.sessionId}:${editor.entry.id}:${editor.entry.revision}` : null;
    if (editor) {
      if (this.editorKey !== key) this.root.querySelector('#btw-steer-text').value = editor.text;
      this.root.querySelector('#btw-steer-attachments').innerHTML = ['files', 'images'].flatMap(kind => (editor.entry[kind] || []).map((id, index) => `<button type="button" data-btw-edit-attachment="${kind}" data-index="${index}" aria-label="移除引导附件">${kind === 'images' ? `<img src="/api/images/${encodeURIComponent(id)}" alt="引导图片">` : this.escape(id.slice(38))} ×</button>`)).join('');
      this.root.querySelector('#btw-steer-error').textContent = editor.error || '';
      for (const element of form.querySelectorAll('button, textarea')) element.disabled = Boolean(editor.busy);
    }
    this.editorKey = key;
  }
  requestRender(messages = true) {
    this.dirtyMessages ||= messages;
    if (this.renderTimer || document.hidden || this.root.closest('[hidden]')) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (document.hidden || this.root.closest('[hidden]')) return;
      const messages = this.dirtyMessages; this.dirtyMessages = false;
      this.render({ messages });
    }, 90);
  }
  render({ messages = true } = {}) {
    const session = this.sessions.get(this.sessionId), creating = this.creating.has(this.parentId), busy = this.busy.has(this.sessionId), active = Boolean(session?.activeTurnId);
    const sessions = [...this.sessions.values()].filter(value => value.parentId === this.parentId);
    const options = sessions.map((value, index) => `<option value="${this.escape(value.id)}">${this.escape(value.title || `侧聊 ${index + 1}`)} · ${this.escape(new Date(value.createdAt).toLocaleTimeString())}${value.activeTurnId ? ' · 回答中' : ''}</option>`).join('');
    const picker = this.root.querySelector('#btw-select');
    if (picker.innerHTML !== options) picker.innerHTML = options;
    picker.value = this.sessionId || ''; picker.disabled = !sessions.length || creating;
    this.root.querySelector('#btw-new').disabled = !this.allowed || creating;
    if (messages && !document.hidden && !this.root.closest('[hidden]')) this.turnWindow.commit(this.sessionId, () => {
      const entries = [];
      for (const turn of this.turnWindow.visible(this.sessionId, session?.turns || new Map())) {
        for (const item of turn.items.values()) {
          let html = '';
          if (item.type !== 'agentMessage') html += this.renderItem(item);
          if (item.type === 'agentMessage') html += `<article class="message assistant"><div class="message-label">BTW</div><div class="prose">${this.markdown(item.text || '')}</div>${turn.status !== 'inProgress' && item.text ? `<button type="button" class="text-button" data-btw-bring="${this.escape(item.id)}">带回主会话 ↗</button>` : ''}</article>`;
          if (html) entries.push({ key: `btw:${this.sessionId}:${turn.id}:${item.id}`, html });
        }
        if (turn.error) entries.push({ key: `btw:${this.sessionId}:${turn.id}:error`, html: `<p class="error-text">${this.escape(turn.error.message || '回答失败')}</p>` });
        if (turn.status === 'interrupted') entries.push({ key: `btw:${this.sessionId}:${turn.id}:stopped`, html: '<p class="btw-tool">已停止回答</p>' });
      }
      if (!entries.length) entries.push({ key: `btw:${this.sessionId}:empty`, html: `<div class="empty-state">${this.allowed ? '顺便问一下，主会话继续工作。<br>可传文件和图片、联网搜索、只读查看项目。' : '选择一个主会话后开启 BTW。'}</div>` });
      if (active || busy) entries.push({ key: `btw:${this.sessionId}:running`, html: '<p class="running-line">BTW 正在回答…</p>' });
      if (creating) entries.push({ key: `btw:${this.sessionId}:creating`, html: '<p class="btw-tool">正在创建侧聊…</p>' });
      this.mountMessages(this.content, entries, session?.threadId);
    });
    this.renderPending(session);
    this.input.disabled = !this.allowed || !session || busy || creating;
    const mode = this.modes.get(this.sessionId) || 'steer', pickerMode = this.root.querySelector('#btw-send-mode');
    pickerMode.value = mode; pickerMode.hidden = !active; pickerMode.disabled = busy || creating;
    const attachments = this.attachments.get(this.sessionId) || [], disabled = !this.allowed || !session || busy || creating;
    const attachmentBar = this.root.querySelector('#btw-attachments');
    attachmentBar.hidden = !attachments.length;
    const attachmentHtml = window.CodexAttachments.html(attachments, this.escape, busy, 'data-btw-remove-attachment');
    if (attachmentBar.innerHTML !== attachmentHtml) attachmentBar.innerHTML = attachmentHtml;
    for (const kind of ['image', 'file']) {
      const button = this.root.querySelector(`#btw-attach-${kind}`);
      button.disabled = disabled || (kind === 'file' && !this.getUploadLimit?.()) || attachments.filter(item => (item.kind || 'image') === kind).length >= 4;
      button.title = kind === 'file' ? `添加文件 · 单个最多 ${(this.getUploadLimit?.() || 0) / (1024 * 1024)} MiB` : '添加图片 · PNG / JPEG / WebP · 单张最多 10 MiB';
    }
    this.root.querySelector('#btw-send').disabled = disabled || attachments.some(item => !item.id || item.error);
    this.sizeInput();
    this.root.querySelector('#btw-send').textContent = active ? mode === 'queue' ? '排队 ＋' : '引导 ↑' : '发送 ↑';
    this.root.querySelector('#btw-stop').hidden = !active;
    this.root.querySelector('#btw-context').textContent = session ? `创建于 ${new Date(session.createdAt).toLocaleString()} · 只读侧聊 · 上下文固定` : '创建时继承主会话上下文，后续只读讨论。';
  }
};
