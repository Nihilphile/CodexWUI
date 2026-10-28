// A bounded live projection complements Codex's persisted history. It keeps
// partial messages visible across view switches and browser reconnections.
export class LiveState {
  constructor({ maxBytes = 16 * 1024 * 1024, maxItems = 100, maxThreads = 64 } = {}) {
    Object.assign(this, { maxBytes, maxItems, maxThreads });
    this.threads = new Map(); this.sizes = new WeakMap(); this.bytes = 0;
  }
  get(id) {
    if (!this.threads.has(id)) {
      if (this.threads.size >= this.maxThreads) {
        const idle = [...this.threads].find(([, value]) => !value.activeTurnId && value.status?.type !== 'active');
        if (idle) { this.clearTurns(idle[0]); this.threads.delete(idle[0]); }
      }
      this.threads.set(id, { id, turns: new Map(), status: null, activeTurnId: null });
    }
    return this.threads.get(id);
  }
  removeItem(turn, id) {
    this.bytes -= this.sizes.get(turn)?.get(id) || 0;
    this.sizes.get(turn)?.delete(id); turn.items.delete(id);
  }
  clearTurns(id) {
    const t = this.threads.get(id);
    if (!t) return;
    for (const turn of t.turns.values()) for (const key of turn.items.keys()) this.removeItem(turn, key);
    t.turns.clear();
  }
  setItem(turn, item) {
    let wire = JSON.stringify(item);
    if (Buffer.byteLength(wire) > 256 * 1024) {
      item = { id: item.id, type: item.type, status: item.status,
        command: typeof item.command === 'string' ? item.command.slice(0, 4096) : undefined,
        text: typeof item.text === 'string' ? item.text.slice(-65536) : undefined,
        aggregatedOutput: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(-65536) : undefined,
        outputPreview: wire.slice(-32768), outputTruncated: true };
      wire = JSON.stringify(item);
      while (Buffer.byteLength(wire) > 256 * 1024) {
        let shrunk = false;
        for (const key of ['text', 'aggregatedOutput', 'outputPreview', 'command']) {
          if (typeof item[key] === 'string' && item[key].length) {
            const keep = Math.floor(item[key].length / 2);
            item[key] = keep ? item[key].slice(-keep) : ''; shrunk = true;
          }
        }
        if (!shrunk) break;
        wire = JSON.stringify(item);
      }
    }
    if (!this.sizes.has(turn)) this.sizes.set(turn, new Map());
    const sizes = this.sizes.get(turn);
    this.bytes += Buffer.byteLength(wire) - (sizes.get(item.id) || 0);
    sizes.set(item.id, Buffer.byteLength(wire)); turn.items.set(item.id, item);
    while (turn.items.size > this.maxItems) this.removeItem(turn, turn.items.keys().next().value);
    if (this.bytes > this.maxBytes) {
      for (const t of this.threads.values()) {
        for (const old of t.turns.values()) {
          for (const key of old.items.keys()) {
            if (this.bytes <= this.maxBytes) return;
            this.removeItem(old, key);
          }
        }
      }
    }
  }
  ingest(message) {
    const p = message.params || {};
    const id = p.threadId || p.thread?.id;
    if (!id) return;
    const t = this.get(id);
    if (p.thread) t.metadata = { ...p.thread, turns: [] };
    if (message.method === 'thread/settings/updated') {
      t.metadata = { ...t.metadata, id, model: p.threadSettings.model, reasoningEffort: p.threadSettings.effort };
    }
    if (message.method === 'thread/status/changed') t.status = p.status;
    const turnId = p.turnId || p.turn?.id;
    if (!turnId) return;
    if (!t.turns.has(turnId)) t.turns.set(turnId, { id: turnId, status: 'inProgress', items: new Map() });
    const turn = t.turns.get(turnId);
    if (message.method === 'turn/started') {
      t.activeTurnId = turnId; t.status = { type: 'active', activeFlags: [] };
      turn.startedAt = p.turn.startedAt ?? Date.now() / 1000;
    }
    if (message.method === 'turn/completed') {
      turn.status = p.turn.status; turn.error = p.turn.error;
      turn.completedAt = p.turn.completedAt ?? turn.completedAt ?? Date.now() / 1000;
      if (t.activeTurnId === turnId) t.activeTurnId = null;
      t.status = { type: 'idle' };
      for (const item of p.turn.items || []) this.setItem(turn, item);
    }
    if (p.item) this.setItem(turn, p.item);
    if (p.itemId && typeof p.delta === 'string') {
      const item = turn.items.get(p.itemId) || { id: p.itemId, type: message.method.includes('commandExecution') ? 'commandExecution' : 'agentMessage' };
      const key = message.method.includes('outputDelta') ? 'aggregatedOutput' : 'text';
      // Reasoning deltas have distinct semantics; render their completed item instead.
      if (!message.method.includes('reasoning')) item[key] = ((item[key] || '') + p.delta).slice(-250000);
      this.setItem(turn, item);
    }
    // Keep the active turn and recent completed turns; durable history is in Codex.
    if (t.turns.size > 4) {
      for (const [key, value] of t.turns) {
        if (value.status !== 'inProgress') {
          for (const itemId of value.items.keys()) this.removeItem(value, itemId);
          t.turns.delete(key); break;
        }
      }
    }
  }
  snapshot(id) {
    const t = this.threads.get(id);
    if (!t) return null;
    return { id, metadata: t.metadata, status: t.status, activeTurnId: t.activeTurnId,
      turns: [...t.turns.values()].map(turn => ({ ...turn, items: [...turn.items.values()] })) };
  }
  summary() {
    return [...this.threads.keys()].map(id => {
      const t = this.threads.get(id);
      return { id, status: t.status, activeTurnId: t.activeTurnId };
    });
  }
}
