import { EventEmitter } from 'node:events';

export class FakeCodex extends EventEmitter {
  constructor(cwd) { super(); this.cwd = cwd; this.ready = false; this.approvals = new Map(); this.calls = []; this.threads = new Map(); this.next = 0; }
  async start() { this.ready = true; this.emit('connection', { connected: true }); }
  close() { this.ready = false; }
  fail(error) { this.ready = false; this.emit('connection', { connected: false, error: error.message }); }
  event(method, params) { this.emit('notification', { method, params }); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { dangerous: { enabled: true } }, plugins: {} } };
    if (method === 'model/list') {
      const data = [
        { id: 'catalog-fast', model: 'test-fast', displayName: 'Fast', description: 'Fast model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium' },
        { id: 'catalog-deep', model: 'test-deep', displayName: 'Deep', description: 'Deep model', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deeper' }, { reasoningEffort: 'ultra', description: 'Most effort' }], defaultReasoningEffort: 'high' },
      ];
      return { data: params.cursor ? data.slice(1) : data.slice(0, 1), nextCursor: params.cursor ? null : 'second-page' };
    }
    if (method === 'thread/start') {
      const thread = { id: `thread-${++this.next}`, model: 'test-fast', reasoningEffort: 'medium', name: null, cwd: params.cwd, preview: '', status: { type: 'idle' }, turns: [], createdAt: 1, updatedAt: 1, parentThreadId: null, canAcceptDirectInput: true };
      this.threads.set(thread.id, thread); this.event('thread/started', { thread }); return { thread };
    }
    if (method === 'thread/fork') {
      const source = this.threads.get(params.threadId);
      if (!source) throw new Error('Unknown thread');
      if (!source.turns.length) throw new Error(`no rollout found for thread id ${params.threadId}`);
      const turns = structuredClone(source.turns);
      if (turns.at(-1)?.status === 'inProgress') turns.at(-1).status = 'interrupted';
      const thread = { ...source, id: `thread-${++this.next}`, forkedFromId: source.id, turns, status: { type: 'idle' } };
      this.threads.set(thread.id, thread); this.event('thread/started', { thread }); return { thread };
    }
    if (method === 'thread/read' || method === 'thread/resume') {
      const thread = this.threads.get(params.threadId); if (!thread) throw new Error('Unknown thread'); return { thread };
    }
    if (method === 'thread/settings/update') {
      const thread = this.threads.get(params.threadId);
      thread.model = params.model; thread.reasoningEffort = params.effort;
      this.event('thread/settings/updated', { threadId: thread.id, threadSettings: { model: thread.model, effort: thread.reasoningEffort } });
      return {};
    }
    if (method === 'thread/turns/list') {
      const turns = [...(this.threads.get(params.threadId)?.turns || [])].reverse().slice(0, params.limit || 100);
      return { data: params.itemsView === 'notLoaded' ? turns.map(turn => ({ ...turn, items: [] })) : turns, nextCursor: null };
    }
    if (method === 'thread/list') return { data: [...this.threads.values()].filter(t => params.ancestorThreadId ? t.parentThreadId === params.ancestorThreadId : (!params.cwd || t.cwd === params.cwd) && (!t.parentThreadId || params.sourceKinds?.includes('subAgentThreadSpawn'))), nextCursor: null };
    if (method === 'thread/loaded/list') return { data: [...this.threads.keys()] };
    if (method === 'skills/list') return { data: [{ cwd: this.cwd, skills: [{ name: 'example', path: this.cwd + '/SKILL.md', description: 'Example skill', enabled: true }], errors: [] }] };
    if (method === 'turn/start') {
      const thread = this.threads.get(params.threadId);
      const turn = { id: `turn-${++this.next}`, model: thread.model, effort: thread.reasoningEffort, status: 'inProgress', items: [{ type: 'userMessage', id: `user-${this.next}`, content: params.input }], error: null };
      thread.turns.push(turn); thread.status = { type: 'active' };
      this.event('turn/started', { threadId: thread.id, turn });
      this.event('item/started', { threadId: thread.id, turnId: turn.id, item: turn.items[0] });
      return { turn };
    }
    if (method === 'turn/steer') {
      this.pendingSteers ||= [];
      this.pendingSteers.push(params);
      return { turnId: params.expectedTurnId };
    }
    if (method === 'turn/interrupt') { this.complete(params.threadId, 'interrupted'); return {}; }
    if (method === 'thread/compact/start') return {};
    if (method === 'thread/backgroundTerminals/clean') return {};
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    throw new Error('Unexpected method ' + method);
  }
  complete(id, status = 'completed') {
    const thread = this.threads.get(id); const turn = thread.turns.at(-1);
    turn.status = status; thread.status = { type: 'idle' };
    this.event('turn/completed', { threadId: id, turn });
  }
  boundary(id) {
    this.event('thread/tokenUsage/updated', { threadId: id, turnId: this.threads.get(id).turns.at(-1).id, tokenUsage: {} });
  }
  consumeSteers(id) {
    const turn = this.threads.get(id).turns.at(-1);
    for (const pending of (this.pendingSteers || []).filter(entry => entry.threadId === id)) {
      const item = { type: 'userMessage', id: `user-${++this.next}`, clientId: pending.clientUserMessageId, content: pending.input };
      turn.items.push(item);
      this.event('item/started', { threadId: id, turnId: turn.id, item });
      this.event('item/completed', { threadId: id, turnId: turn.id, item });
    }
    this.pendingSteers = (this.pendingSteers || []).filter(entry => entry.threadId !== id);
  }
  respond(id, result) {
    this.lastResponse = { id, result }; this.approvals.delete(String(id));
    this.event('serverRequest/resolved', { requestId: id });
  }
}
