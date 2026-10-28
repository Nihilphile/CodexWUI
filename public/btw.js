// Each side chat owns its draft and hydration, independently of main rendering.
window.CodexBtwPanel = class {
  constructor(root, { api, markdown, escape, notify, bringBack }) {
    Object.assign(this, { root, api, markdown, escape, notify, bringBack });
    this.parentId = null; this.sessionId = null; this.sessions = new Map(); this.sides = new Map(); this.selected = new Map();
    this.drafts = new Map(); this.modes = new Map(); this.editors = new Map(); this.busy = new Set(); this.creating = new Set(); this.events = []; this.serial = 0;
    root.innerHTML = '<div class="btw-heading"><strong>BTW · 侧聊</strong><div class="btw-picker"><label class="sr-only" for="btw-select">选择侧聊</label><select id="btw-select"></select><button id="btw-new" type="button" class="secondary-button">新侧聊 ＋</button></div><p id="btw-context">创建时继承主会话上下文，后续独立讨论。</p></div><div id="btw-messages" class="btw-messages" role="log" aria-label="BTW 对话"></div><div id="btw-pending" class="btw-pending"></div><form id="btw-steer-form" hidden><label for="btw-steer-text">修改预引导</label><textarea id="btw-steer-text" rows="3"></textarea><p id="btw-steer-error" class="error-text"></p><div class="btw-actions"><button id="btw-steer-cancel" type="button" class="secondary-button">取消修改</button><button class="primary-button" type="submit">保存</button></div></form><p id="btw-error" class="error-text" role="status"></p><form id="btw-form"><label class="sr-only" for="btw-prompt">BTW 问题</label><textarea id="btw-prompt" rows="3" placeholder="顺便问一下…"></textarea><div class="btw-actions"><label class="sr-only" for="btw-send-mode">运行中发送方式</label><select id="btw-send-mode" hidden><option value="steer">引导（steer）</option><option value="queue">排队（follow-up）</option></select><button id="btw-stop" type="button" class="secondary-button" hidden>停止回答</button><button id="btw-send" class="primary-button" type="submit">发送 ↑</button></div></form>';
    this.input = root.querySelector('#btw-prompt'); this.messages = root.querySelector('#btw-messages'); this.error = root.querySelector('#btw-error');
    this.input.oninput = () => this.rememberDraft();
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
  hydrate(snapshot) {
    for (const record of snapshot.sessions || []) this.register(record);
    if (snapshot.session) {
      this.register(snapshot.session);
      const session = this.sessions.get(snapshot.session.id); session.turns = new Map();
      if (snapshot.queue) session.queue = snapshot.queue;
      this.setSteers(session, snapshot.steers);
      for (const turn of [...snapshot.history.data].reverse()) this.merge(session, turn);
      for (const turn of snapshot.live?.turns || []) if (turn.id !== session.forkTurnId) this.merge(session, turn);
      session.activeTurnId = snapshot.live?.activeTurnId || [...session.turns.values()].find(turn => turn.status === 'inProgress')?.id || null;
      for (const event of this.events) {
        const params = event.message.params || {};
        if (event.n > snapshot.eventSequence && (params.sessionId === session.id || (session.threadId && (params.threadId || params.thread?.id) === session.threadId))) this.ingest(event.message, false);
      }
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
      await this.control(cancel ? 'steer-cancel-edit' : 'steer-update', { id: editor.entry.id, revision: editor.entry.revision, text: editor.text }, sessionId);
      this.editors.delete(sessionId);
    } catch (error) {
      if (cancel) { this.editors.delete(sessionId); if (this.sessionId === sessionId) this.showError(error); }
      else editor.error = error.message;
    }
    finally { editor.busy = false; this.render(); }
  }
  ingest(message, record = true, sequence = 0) {
    if (record) { this.events.push({ message, n: sequence }); if (this.events.length > 2000) this.events.shift(); }
    if (message.method === 'web/btw') { this.register(message.params.session); this.render(); return true; }
    const p = message.params || {}, id = p.threadId || p.thread?.id;
    const session = this.sessions.get(p.sessionId || this.sides.get(id));
    if (!session) return false;
    if (message.method === 'web/queue') { session.queue = p.queue; session.queueEvent++; this.render(); return true; }
    if (message.method === 'web/steers') { this.setSteers(session, p.steers); this.render(); return true; }
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
    this.render(); return true;
  }
  async send(sessionId = this.sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || this.busy.has(sessionId)) return;
    const text = (sessionId === this.sessionId ? this.input.value : this.drafts.get(sessionId) || '').trim();
    if (!text) return;
    const expectedTurnId = session.activeTurnId, mode = expectedTurnId ? this.modes.get(sessionId) || 'steer' : 'send';
    const clientUserMessageId = mode === 'steer' ? crypto.randomUUID() : undefined;
    if (clientUserMessageId) session.sendingSteers.set(clientUserMessageId, { id: clientUserMessageId, text, status: 'staging' });
    this.busy.add(sessionId); if (this.sessionId === sessionId) this.error.textContent = ''; this.render();
    try {
      const result = mode === 'send'
        ? await this.api(`/api/btw/${encodeURIComponent(session.parentId)}/send`, { sessionId, text })
        : await this.control(mode, { text, expectedTurnId, clientUserMessageId }, sessionId);
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
      return `<article class="pending-steer"><div class="pending-steer-label">预引导 · ${this.escape(label)}</div><div class="pending-steer-text">${this.escape(entry.text)}</div>${entry.error ? `<p class="error-text">${this.escape(entry.error)}</p>` : ''}<div class="pending-steer-actions">${canEdit ? `<button type="button" data-btw-steer="edit" ${attrs}>修改</button><button type="button" data-btw-steer="remove" ${attrs}>${entry.status === 'failed' ? '移除' : '撤回'}</button>` : ''}${entry.status === 'staged' ? `<button type="button" data-btw-steer="send" ${attrs}>立即引导</button>` : ''}<button type="button" data-btw-steer="copy" ${attrs}>复制文字</button></div></article>`;
    }).join('');
    html += window.CodexQueue.html(queue, this.sessionId, this.escape, true);
    const pending = this.root.querySelector('#btw-pending');
    if (pending.innerHTML !== html) pending.innerHTML = html;
    const editor = this.editors.get(this.sessionId), form = this.root.querySelector('#btw-steer-form');
    form.hidden = !editor;
    const key = editor ? `${this.sessionId}:${editor.entry.id}:${editor.entry.revision}` : null;
    if (editor) {
      if (this.editorKey !== key) this.root.querySelector('#btw-steer-text').value = editor.text;
      this.root.querySelector('#btw-steer-error').textContent = editor.error || '';
      for (const element of form.querySelectorAll('button, textarea')) element.disabled = Boolean(editor.busy);
    }
    this.editorKey = key;
  }
  render() {
    const session = this.sessions.get(this.sessionId), creating = this.creating.has(this.parentId), busy = this.busy.has(this.sessionId), active = Boolean(session?.activeTurnId);
    const nearBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 80;
    const sessions = [...this.sessions.values()].filter(value => value.parentId === this.parentId);
    const options = sessions.map((value, index) => `<option value="${this.escape(value.id)}">${this.escape(value.title || `侧聊 ${index + 1}`)} · ${this.escape(new Date(value.createdAt).toLocaleTimeString())}${value.activeTurnId ? ' · 回答中' : ''}</option>`).join('');
    const picker = this.root.querySelector('#btw-select');
    if (picker.innerHTML !== options) picker.innerHTML = options;
    picker.value = this.sessionId || ''; picker.disabled = !sessions.length || creating;
    this.root.querySelector('#btw-new').disabled = !this.allowed || creating;
    let html = '';
    for (const turn of session?.turns.values() || []) {
      for (const item of turn.items.values()) {
        if (item.type === 'userMessage') html += `<article class="message user"><div class="message-label">你</div><div class="prose">${(item.content || []).map(c => this.markdown(c.text || '')).join('')}</div></article>`;
        if (item.type === 'agentMessage') html += `<article class="message assistant"><div class="message-label">BTW</div><div class="prose">${this.markdown(item.text || '')}</div>${turn.status !== 'inProgress' && item.text ? `<button type="button" class="text-button" data-btw-bring="${this.escape(item.id)}">带回主会话 ↗</button>` : ''}</article>`;
        if (['dynamicToolCall', 'mcpToolCall'].includes(item.type)) html += `<p class="btw-tool">查看项目 · ${this.escape(item.tool || '')}</p>`;
      }
      if (turn.error) html += `<p class="error-text">${this.escape(turn.error.message || '回答失败')}</p>`;
      if (turn.status === 'interrupted') html += '<p class="btw-tool">已停止回答</p>';
    }
    if (!html) html = `<div class="empty-state">${this.allowed ? '顺便问一下，主会话继续工作。<br>可联网搜索、查看项目；修改建议带回主会话。' : '选择一个主会话后开启 BTW。'}</div>`;
    if (active || busy) html += '<p class="running-line">BTW 正在回答…</p>';
    if (creating) html += '<p class="btw-tool">正在创建侧聊…</p>';
    if (this.messages.innerHTML !== html) this.messages.innerHTML = html;
    if (nearBottom) this.messages.scrollTop = this.messages.scrollHeight;
    this.renderPending(session);
    this.input.disabled = !this.allowed || !session || busy || creating;
    const mode = this.modes.get(this.sessionId) || 'steer', pickerMode = this.root.querySelector('#btw-send-mode');
    pickerMode.value = mode; pickerMode.hidden = !active; pickerMode.disabled = busy || creating;
    this.root.querySelector('#btw-send').disabled = !this.allowed || !session || busy || creating;
    this.root.querySelector('#btw-send').textContent = active ? mode === 'queue' ? '排队 ＋' : '引导 ↑' : '发送 ↑';
    this.root.querySelector('#btw-stop').hidden = !active;
    this.root.querySelector('#btw-context').textContent = session ? `创建于 ${new Date(session.createdAt).toLocaleString()} · 上下文固定，后续独立讨论` : '创建时继承主会话上下文，后续独立讨论。';
  }
};
