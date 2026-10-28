import { randomUUID } from 'node:crypto';

const conflict = message => Object.assign(new Error(message), { status: 409 });
const mutable = new Set(['staged', 'editing', 'failed']);
const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch']);

// A submitted turn/steer cannot be recalled. Keep a separate, cancellable
// staging area and cross that boundary only after locking the entry.
export class PendingSteers {
  constructor({ send, changed }) {
    this.send = send; this.versions = new Map(); this.instance = randomUUID();
    this.changed = id => { this.versions.set(id, (this.versions.get(id) || 0) + 1); changed(id); };
    this.threads = new Map(); this.boundaries = new Map(); this.settled = new Map();
  }
  entries(threadId) {
    if (!this.threads.has(threadId)) this.threads.set(threadId, new Map());
    return this.threads.get(threadId);
  }
  publicEntry(entry) { const { resolvedInput, ...value } = entry; return value; }
  snapshot(threadId) { return { entries: [...this.entries(threadId).values()].map(entry => this.publicEntry(entry)), version: this.versions.get(threadId) || 0, instance: this.instance }; }
  get(threadId, id, revision) {
    const entry = this.entries(threadId).get(id);
    if (!entry || (revision !== undefined && revision !== entry.revision)) throw conflict('引导消息状态已变化，请刷新后重试');
    return entry;
  }
  settle(threadId, id) {
    const key = `${threadId}:${id}`;
    this.settled.set(key, true);
    if (this.settled.size > 1000) this.settled.delete(this.settled.keys().next().value);
  }
  add(threadId, input) {
    const entries = this.entries(threadId);
    const id = input.clientUserMessageId || randomUUID();
    const existing = entries.get(id);
    if (existing) {
      if (existing.text !== input.text || JSON.stringify(existing.skills) !== JSON.stringify(input.skills || []) || JSON.stringify(existing.images) !== JSON.stringify(input.images || []) || JSON.stringify(existing.files) !== JSON.stringify(input.files || [])) throw conflict('同一引导标识已用于其他内容，请检查现有消息');
      return existing;
    }
    if (this.settled.has(`${threadId}:${id}`)) return null;
    if (entries.size >= 20) throw conflict('待接收引导最多保留 20 条，请先处理已有消息');
    const entry = { id, clientUserMessageId: id, expectedTurnId: input.expectedTurnId,
      text: input.text, skills: input.skills || [], images: input.images || [], files: input.files || [],
      resolvedInput: input.resolvedInput, status: 'staged', revision: 1, createdAt: Date.now(), error: null };
    entries.set(id, entry); this.changed(threadId);
    return entry;
  }
  beginEdit(threadId, id, revision) {
    const entry = this.get(threadId, id, revision);
    if (!mutable.has(entry.status)) throw conflict('这条引导已提交，无法修改');
    if (entry.status !== 'editing') entry.beforeEdit = entry.status;
    entry.status = 'editing'; entry.revision++;
    this.changed(threadId); return this.publicEntry(entry);
  }
  update(threadId, id, revision, input, canSubmit = true) {
    const entry = this.get(threadId, id, revision);
    if (entry.status !== 'editing') throw conflict('请先打开这条引导的编辑器');
    Object.assign(entry, { text: input.text, skills: input.skills || [], images: input.images || [], files: input.files || [], resolvedInput: input.resolvedInput,
      error: canSubmit ? null : '原任务已结束，修改内容已保存但未提交', status: canSubmit ? 'staged' : 'failed' });
    delete entry.beforeEdit; entry.revision++;
    this.changed(threadId); return this.publicEntry(entry);
  }
  cancelEdit(threadId, id, revision) {
    const entry = this.get(threadId, id, revision);
    if (entry.status !== 'editing') throw conflict('编辑状态已变化');
    entry.status = entry.beforeEdit || 'staged'; delete entry.beforeEdit; entry.revision++;
    this.changed(threadId);
  }
  remove(threadId, id, revision) {
    const entry = this.get(threadId, id, revision);
    if (!mutable.has(entry.status)) throw conflict('这条引导已提交，无法撤回');
    this.entries(threadId).delete(id); this.settle(threadId, id); this.changed(threadId);
  }
  async dispatch(threadId, id, revision) {
    const entry = this.entries(threadId).get(id);
    if (!entry) { if (revision !== undefined) throw conflict('引导消息状态已变化'); return; }
    if (revision !== undefined) this.get(threadId, id, revision);
    if (entry.status !== 'staged') { if (revision !== undefined) throw conflict('这条引导当前不能提交'); return; }
    entry.status = 'submitting'; entry.revision++;
    this.changed(threadId);
    try {
      await this.send(threadId, entry);
      if (this.entries(threadId).has(id) && entry.status === 'submitting') { entry.status = 'accepted'; entry.revision++; }
    } catch (error) {
      if (this.entries(threadId).has(id)) {
        entry.status = error.status || error.rpcRejected ? 'failed' : 'unknown';
        entry.error = error.message; entry.revision++;
      }
    }
    this.changed(threadId);
  }
  ingest(message) {
    const p = message.params || {};
    if (!p.threadId) return;
    const entries = this.entries(p.threadId);
    let changed = false;
    for (const item of [p.item, ...(p.turn?.items || [])]) {
      if (item?.type !== 'userMessage' || !item.clientId) continue;
      const entry = entries.get(item.clientId);
      if (entry && ['submitting', 'accepted', 'unknown'].includes(entry.status)) {
        entries.delete(entry.id); this.settle(p.threadId, entry.id); changed = true;
      }
    }
    if (message.method === 'turn/completed') {
      for (const entry of entries.values()) {
        if (entry.expectedTurnId !== p.turn.id) continue;
        if (entry.status === 'staged' || entry.status === 'editing') {
          if (entry.status === 'editing') entry.beforeEdit = 'failed'; else { entry.status = 'failed'; entry.revision++; }
          entry.error = '原任务已结束，未提交这条引导；内容已保留'; changed = true;
        } else if (entry.status === 'accepted' || entry.status === 'submitting') {
          entry.status = 'unknown'; entry.error = '原任务已结束，尚未收到这条引导的接收确认'; entry.revision++; changed = true;
        }
      }
    }
    if (changed) this.changed(p.threadId);
    // In the installed app-server this notification follows a model response
    // and its tool outputs. It is an observed boundary, not a blocking hook.
    const turnId = p.turnId || p.turn?.id;
    if (!turnId) return;
    const key = `${p.threadId}:${turnId}`;
    let boundary = this.boundaries.get(key);
    if (!boundary) { boundary = { tools: new Set(), ready: false }; this.boundaries.set(key, boundary); }
    if (message.method === 'item/started' && toolTypes.has(p.item?.type)) boundary.tools.add(p.item.id);
    if (message.method === 'item/started' && ['agentMessage', 'reasoning'].includes(p.item?.type)) boundary.ready = false;
    if (message.method === 'item/completed') boundary.tools.delete(p.item?.id);
    if (message.method === 'thread/tokenUsage/updated') boundary.ready = true;
    if (message.method === 'turn/completed') { this.boundaries.delete(key); return; }
    if (boundary.ready && !boundary.tools.size && ['thread/tokenUsage/updated', 'item/completed'].includes(message.method)) {
      boundary.ready = false;
      for (const entry of entries.values()) {
        if (entry.expectedTurnId === turnId && entry.status === 'staged') void this.dispatch(p.threadId, entry.id);
      }
    }
  }
  disconnect() {
    this.boundaries.clear();
    for (const [threadId, entries] of this.threads) {
      for (const entry of entries.values()) {
        if (entry.status === 'staged') entry.status = 'failed';
        else if (entry.status === 'editing') entry.beforeEdit = 'failed';
        else if (entry.status === 'submitting' || entry.status === 'accepted') entry.status = 'unknown';
        entry.error = 'Codex 连接中断，内容已保留'; if (entry.status !== 'editing') entry.revision++;
      }
      this.changed(threadId);
    }
  }
  close() { this.boundaries.clear(); }
}
