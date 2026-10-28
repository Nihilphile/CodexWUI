import { randomUUID, createHash } from 'node:crypto';
import { JsonFile } from './persistence.mjs';

const conflict = message => Object.assign(new Error(message), { status: 409 });
export const messageDigest = text => createHash('sha256').update(text).digest('hex');

export class FollowUpQueue {
  constructor({ run, changed, file, busy = () => false }) {
    Object.assign(this, { run, changed, busy });
    this.threads = new Map(); this.receipts = new Map();
    if (file) this.store = new JsonFile(file);
  }
  async load() {
    const saved = await this.store?.read({ threads: [], receipts: [] });
    if (!saved) return;
    this.receipts = new Map(saved.receipts);
    for (const [id, q] of saved.threads) {
      for (const entry of q.entries) {
        if (entry.status === 'sending') entry.error = '服务重启，投递结果未知；请检查会话后决定是否重发';
        entry.status = 'unsent'; delete entry.inFlight; entry.revision++;
        this.receipt(id, entry);
      }
      this.threads.set(id, { entries: q.entries, paused: true, dispatching: false });
    }
  }
  get(id) {
    if (!this.threads.has(id)) this.threads.set(id, { entries: [], paused: false, dispatching: false });
    return this.threads.get(id);
  }
  snapshot(id) {
    const q = this.get(id);
    return structuredClone({ entries: q.entries, paused: q.paused, dispatching: q.dispatching, error: q.error || this.store?.error?.message || null });
  }
  receipt(id, entry, extra = {}) {
    const value = { ...this.receipts.get(entry.id), message_id: entry.id, threadId: id, status: entry.status, revision: entry.revision,
      source: entry.source || null, modified: Boolean(entry.modified), bytes: Buffer.byteLength(entry.text), sha256: messageDigest(entry.text), ...extra };
    this.receipts.set(entry.id, value);
    return value;
  }
  notify(id) {
    const q = this.get(id);
    q.paused = !q.entries.some(e => e.status === 'queued') && (q.paused || q.entries.some(e => e.status === 'unsent' || e.status === 'editing'));
    if (this.store) void this.store.write({ threads: [...this.threads], receipts: [...this.receipts] });
    this.changed(id);
  }
  flush() { return this.store?.flush() || Promise.resolve(); }
  add(id, input) {
    const q = this.get(id);
    if (q.entries.length >= 20) throw conflict('每个会话最多保留 20 条待发送消息');
    const entry = { ...input, id: randomUUID(), status: 'queued', revision: 1 };
    q.entries.push(entry); q.paused = false;
    this.receipt(id, entry); this.notify(id);
    return this.snapshot(id);
  }
  entry(id, entryId, revision) {
    const entry = this.get(id).entries.find(e => e.id === entryId);
    if (!entry || (revision !== undefined && revision !== entry.revision)) throw conflict('消息已变化，请刷新后重试');
    if (entry.status === 'sending') throw conflict('消息已开始投递，不能修改或删除');
    return entry;
  }
  remove(id, entryId, revision) {
    const entry = this.entry(id, entryId, revision);
    this.receipt(id, entry, { status: 'cancelled' });
    this.get(id).entries = this.get(id).entries.filter(e => e.id !== entryId); this.notify(id);
  }
  edit(id, entryId, revision) {
    const entry = this.entry(id, entryId, revision);
    entry.status = 'editing'; entry.revision++;
    this.receipt(id, entry); this.notify(id); return structuredClone(entry);
  }
  update(id, entryId, revision, text) {
    const entry = this.entry(id, entryId, revision);
    if (entry.status !== 'editing') throw conflict('请先撤回修改');
    if (typeof text !== 'string' || text.length > 200000 || (!text.trim() && !entry.images?.length && !entry.files?.length)) throw conflict('消息内容无效或过长');
    entry.modified ||= entry.text !== text;
    entry.text = text; entry.status = 'unsent'; entry.revision++;
    this.receipt(id, entry); this.notify(id);
  }
  resume(id, entryId, revision) {
    const entries = entryId ? [this.entry(id, entryId, revision)] : this.get(id).entries.filter(e => e.status === 'unsent');
    for (const entry of entries) {
      if (entry.status === 'editing') throw conflict('请先保存修改');
      entry.status = 'queued'; entry.revision++; entry.error = null; this.receipt(id, entry);
    }
    this.notify(id);
  }
  complete(id, status) {
    const q = this.get(id);
    if (status !== 'completed') { this.pause(id); return; }
    q.drainAgain = true;
    if (!q.dispatching) void this.drain(id);
  }
  async drain(id, explicit = false) {
    if (explicit) this.resume(id);
    const q = this.get(id);
    if (q.dispatching || this.busy(id)) return;
    const entry = q.entries.find(e => e.status === 'queued');
    if (!entry) return;
    q.dispatching = true; q.error = null; q.drainAgain = false;
    entry.status = 'sending'; this.receipt(id, entry); this.notify(id);
    try {
      await this.flush();
      if (entry.status !== 'sending') return;
      entry.inFlight = true;
      const result = await this.run(id, entry);
      this.receipt(id, entry, { status: 'delivered', turnId: result?.turn?.id || result?.turnId || null });
      q.entries = q.entries.filter(e => e.id !== entry.id);
    } catch (error) {
      entry.inFlight = false; entry.status = 'unsent'; entry.error = error.message;
      q.error = error.message; this.pause(id);
    } finally {
      q.dispatching = false; this.notify(id);
      if (q.drainAgain) queueMicrotask(() => this.drain(id));
    }
  }
  pauseAll() { for (const id of this.threads.keys()) this.pause(id); }
  pause(id) {
    const q = this.get(id); q.paused = true;
    for (const entry of q.entries) {
      if (entry.inFlight) continue;
      if (entry.status !== 'editing') entry.status = 'unsent';
      entry.revision++; this.receipt(id, entry);
    }
    this.notify(id);
  }
}
