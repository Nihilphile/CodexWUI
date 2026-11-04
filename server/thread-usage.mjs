import { JsonFile } from './persistence.mjs';

const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const breakdown = value => Object.fromEntries(['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'].map(key => [key, counter(value?.[key])]));

export class ThreadUsage {
  constructor(file) { this.file = new JsonFile(file); this.records = new Map(); this.compacting = new Set(); }
  async load() { this.records = new Map(await this.file.read([])); }
  snapshot(id) { return { ...(this.records.get(id) || {}), compacting: this.compacting.has(id) }; }
  ingest(message) {
    const p = message.params || {}, id = p.threadId;
    if (!id) return;
    if (p.item?.type === 'contextCompaction') {
      if (message.method === 'item/started') this.compacting.add(id);
      if (message.method === 'item/completed') this.compacting.delete(id);
    }
    if (message.method === 'turn/completed' || message.method === 'thread/closed') this.compacting.delete(id);
    if (message.method !== 'thread/tokenUsage/updated' || !p.tokenUsage?.last || !p.tokenUsage?.total) return;
    const usage = p.tokenUsage;
    this.records.delete(id);
    this.records.set(id, { last: breakdown(usage.last), total: breakdown(usage.total), modelContextWindow: counter(usage.modelContextWindow), updatedAt: Date.now() });
    while (this.records.size > 1000) this.records.delete(this.records.keys().next().value);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.file.write([...this.records]).catch(() => {}); }, 1000);
  }
  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; await this.file.write([...this.records]); }
    await this.file.flush();
  }
}
