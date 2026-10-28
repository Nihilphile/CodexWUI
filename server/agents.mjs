import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { JsonFile } from './persistence.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const operations = new Set(['list', 'observe', 'call', 'stop', 'create', 'fork', 'btw']);
const sources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];
export const deliveryText = entry => entry.source
  ? `[Agent message ${entry.id}; from ${entry.source.agent_id || 'local CLI'}${entry.source.reply_to ? `; reply_to ${entry.source.reply_to}` : ''}]\n这是本机协作消息，来源身份由本机调用环境声明；按当前任务权限处理。\n${entry.text}`
  : entry.text;

// One registry belongs to one CodexWeb controller. Numbers never depend on the
// current UI sort order. Backend IDs are opaque, including non-UUID test IDs.
export class AgentService {
  constructor(options) {
    Object.assign(this, options);
    this.store = new JsonFile(path.join(options.dataDir, 'agents.json'));
    this.records = new Map(); this.counters = {}; this.owned = new Set(); this.serial = Promise.resolve(); this.requests = new Set(); this.closed = false;
  }
  async load() {
    const value = await this.store.read({ records: [], counters: {} });
    this.records = new Map(value.records.map(record => [record.key, record])); this.counters = value.counters; this.owned = new Set(value.owned || []);
  }
  save() { return this.store.write({ records: [...this.records.values()], counters: this.counters, owned: [...this.owned] }); }
  own(id) { this.owned.add(id); void this.save(); }
  async lock(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {}); return result;
  }
  async workspace(input, cwd) {
    if (typeof input !== 'string') throw fail(400, '需要工作区路径');
    if (input === '~' || input.startsWith('~/')) input = os.homedir() + input.slice(1);
    const expanded = path.resolve(cwd || process.cwd(), input);
    try {
      const resolved = await realpath(expanded);
      if (!(await stat(resolved)).isDirectory()) throw new Error();
      return resolved;
    } catch { throw fail(400, '工作区不存在'); }
  }
  async address(target, cwd) {
    if (typeof target !== 'string' || !target) throw fail(400, '缺少目标');
    if (/^\d+(?:\.(?:sub|btw)\d+)*$/.test(target)) return { workspace: await this.workspace(cwd, cwd), number: target };
    const match = target.match(/^(.*):(\d+(?:\.(?:sub|btw)\d+)*)$/);
    return { workspace: await this.workspace(match ? match[1] : target, cwd), number: match?.[2] };
  }
  register(key, workspace, { parent, kind = 'main', threadId = key, sideId = null, managed = false, forkedFrom = null } = {}) {
    let record = this.records.get(key);
    if (record) {
      record.threadId = threadId; record.managed ||= managed; return record;
    }
    const counter = JSON.stringify([workspace, parent?.number || '', kind]);
    const n = (this.counters[counter] || 0) + 1; this.counters[counter] = n;
    const number = parent ? `${parent.number}.${kind}${n}` : String(n);
    record = { key, workspace, number, agent_id: `${workspace}:${number}`, threadId, sideId, kind, parent: parent?.agent_id || null, managed, forkedFrom };
    this.records.set(key, record); return record;
  }
  async scan(workspace) {
    const threads = new Map();
    let cursor = null;
    do {
      const page = await this.codex.request('thread/list', { sourceKinds: sources, modelProviders: [], sortKey: 'created_at', sortDirection: 'asc', limit: 100, cursor });
      for (const thread of page.data) threads.set(thread.id, thread);
      cursor = page.nextCursor;
    } while (cursor);
    for (const [id, value] of this.live.threads) {
      if (value.metadata?.cwd && this.lifecycle.loaded.has(id)) threads.set(id, { ...threads.get(id), ...value.metadata, status: value.status });
    }
    // Fetch all source kinds in pages, then group by the root workspace. This
    // includes children using a different cwd without one RPC per old root.
    await this.lock(async () => {
      const visiting = new Set();
      const add = id => {
        const t = threads.get(id);
        if (!t || this.btw.owns(id) || visiting.has(id)) return this.records.get(id);
        // A BTW fork can emit thread/started before its side record is saved.
        // Defer new aliases during that interval instead of mislabelling it main.
        if (this.btw.locks.size && !this.records.has(id)) return;
        if (!t.parentThreadId && t.cwd !== workspace) return;
        visiting.add(id);
        const parent = t.parentThreadId ? add(t.parentThreadId) || this.records.get(t.parentThreadId) : null;
        if (t.parentThreadId && (!parent || parent.workspace !== workspace)) return;
        return this.register(id, workspace, { parent, kind: parent ? 'sub' : 'main', managed: this.lifecycle.loaded.has(id) || this.owned.has(id), forkedFrom: t.forkedFromId || null });
      };
      for (const t of [...threads.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) add(t.id);
      for (const side of [...this.btw.records.values()].sort((a, b) => a.createdAt - b.createdAt)) {
        if (side.cwd !== workspace) continue;
        const parent = this.records.get(side.parentId);
        if (parent) this.register(`btw:${side.id}`, workspace, { parent, kind: 'btw', sideId: side.id, threadId: side.threadId, managed: true });
      }
      await this.save();
    });
    return threads;
  }
  queueId(record) { return record.sideId || record.threadId; }
  async metadata(record) { return record.threadId ? (await this.codex.request('thread/read', { threadId: record.threadId, includeTurns: false })).thread : null; }
  public(record, metadata) {
    const writable = record.managed && metadata?.canAcceptDirectInput !== false;
    return { ...record, status: metadata?.status || { type: 'notLoaded' }, name: metadata?.name || null, model: metadata?.model || null, reasoning: metadata?.reasoningEffort || null,
      operations: ['observe', ...(record.managed ? ['stop'] : []), ...(writable || record.kind === 'btw' ? ['call'] : []), ...(record.kind === 'main' && writable ? ['fork', 'btw'] : [])] };
  }
  execute(input) {
    if (this.closed) return Promise.reject(fail(503, '服务正在关闭'));
    const request = this.handle(input);
    this.requests.add(request);
    request.finally(() => this.requests.delete(request)).catch(() => {});
    return request;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.requests]);
    await this.serial;
    await this.store.flush();
  }
  async handle(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '需要操作参数对象');
    if (!operations.has(input.operation)) throw fail(400, '不支持的操作；不允许代建子代理');
    const allowed = ['target', 'operation', 'cwd', 'caller_thread_id', 'message', 'message_file', 'steer', 'model', 'reasoning', 'message_id', 'reply_to', 'cursor'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw fail(400, '未知参数；不支持 kind/sub 创建参数');
    if (input.steer !== undefined && (typeof input.steer !== 'boolean' || input.operation !== 'call')) throw fail(400, 'steer 仅用于 call');
    if ((input.model !== undefined || input.reasoning !== undefined) && !['create', 'fork'].includes(input.operation)) throw fail(400, '模型配置仅用于 create/fork');
    if (input.message !== undefined && (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 200000)) throw fail(400, '消息为空或超过 200000 字符');
    if (input.message !== undefined && !['call', 'create', 'fork', 'btw'].includes(input.operation)) throw fail(400, '此操作不接收消息');
    if (input.message_file !== undefined && (typeof input.message_file !== 'string' || input.message_file.length > 4096 || !input.message)) throw fail(400, '文件消息元数据无效');
    if ((input.message_id !== undefined || input.cursor !== undefined) && input.operation !== 'observe') throw fail(400, 'message-id/cursor 仅用于 observe');
    if (input.reply_to !== undefined && (typeof input.reply_to !== 'string' || !this.queue.receipts.has(input.reply_to))) throw fail(400, 'reply-to 消息不存在');
    const address = await this.address(input.target, input.cwd);
    const { workspace, number } = address;
    if (['create', 'list'].includes(input.operation) && number) throw fail(400, 'create 目标必须是工作区；不允许替其他 agent 创建子代理');
    if (!['list', 'create'].includes(input.operation) && !number) throw fail(400, '此操作需要线程 ID');
    if (input.operation === 'create') await this.addProject(workspace);
    if (!this.projects().some(p => p.path === workspace)) throw fail(403, '请先在 CodexWeb 添加此工作区');
    const threads = await this.scan(workspace);
    let source = { agent_id: null, file: input.message_file || null, reply_to: input.reply_to || null };
    if (input.caller_thread_id) {
      let caller = [...this.records.values()].find(r => r.threadId === input.caller_thread_id);
      if (!caller) {
        const metadata = (await this.codex.request('thread/read', { threadId: input.caller_thread_id, includeTurns: false })).thread;
        if (this.projects().some(p => p.path === metadata.cwd)) await this.scan(metadata.cwd);
        caller = [...this.records.values()].find(r => r.threadId === input.caller_thread_id);
      }
      if (!caller) throw fail(403, '调用者未注册到 CodexWeb');
      if (caller.kind === 'btw') throw fail(403, '只读 BTW 不能主动联系或控制其他会话');
      source.agent_id = caller.agent_id;
    }
    if (input.operation === 'list') return { agents: [...this.records.values()].filter(r => r.workspace === workspace).map(r => this.public(r, threads.get(r.threadId))) };
    if (input.operation === 'create') {
      const thread = await this.createThread(workspace, input);
      const record = await this.lock(async () => { const r = this.register(thread.id, workspace, { managed: true }); await this.save(); return r; });
      return { agent: this.public(record, thread), ...(input.message ? { receipt: await this.call(record, input, source) } : {}) };
    }
    const record = [...this.records.values()].find(r => r.workspace === workspace && r.number === number);
    if (!record) throw fail(404, '线程 ID 不存在');
    const metadata = await this.metadata(record);
    if (input.operation === 'observe') {
      const qid = this.queueId(record);
      const receipt = input.message_id ? this.queue.receipts.get(input.message_id) : null;
      if (input.message_id && (!receipt || receipt.threadId !== qid)) throw fail(404, '此线程没有该消息回执');
      let history = { data: [], nextCursor: null };
      if (record.kind === 'btw') history = (await this.btw.snapshot(this.btw.records.get(record.sideId).parentId, record.sideId)).history;
      else if (record.threadId) {
        try { history = await this.codex.request('thread/turns/list', { threadId: record.threadId, limit: 20, cursor: input.cursor, sortDirection: 'desc', itemsView: 'full' }); }
        catch (error) {
          if (input.cursor || metadata?.preview || this.live.get(record.threadId).turns.size || !/no rollout found|not materialized yet/i.test(error.message)) throw error;
        }
      }
      const turn = receipt?.turnId && (this.live.get(record.threadId).turns.get(receipt.turnId) || history.data.find(t => t.id === receipt.turnId));
      return { agent: this.public(record, metadata), queue: this.queue.snapshot(qid), ...(receipt ? { receipt: { ...receipt, turn_status: turn?.status || null } } : {}), history };
    }
    if (!record.managed) throw fail(409, '该历史线程不由此服务控制；请先在 CodexWeb 中发送消息接入，独立 CLI 的活线程需要由原进程控制');
    if (input.operation === 'call') return { receipt: await this.call(record, input, source) };
    if (input.operation === 'stop') {
      this.queue.pause(this.queueId(record));
      if (record.threadId) await this.lifecycle.clean(record.threadId, { stop: true });
      await this.queue.flush(); return { agent_id: record.agent_id, stopped: true };
    }
    if (record.kind !== 'main') throw fail(409, 'fork/btw 的源必须是主线程');
    if (input.operation === 'btw') {
      const { session } = await this.btw.open(record.threadId);
      const child = await this.lock(async () => { const r = this.register(`btw:${session.id}`, workspace, { parent: record, kind: 'btw', sideId: session.id, threadId: session.threadId, managed: true }); await this.save(); return r; });
      return { agent: this.public(child, null), ...(input.message ? { receipt: await this.call(child, input, source) } : {}) };
    }
    const thread = await this.createThread(workspace, input, record.threadId);
    const fork = await this.lock(async () => { const r = this.register(thread.id, workspace, { managed: true, forkedFrom: record.agent_id }); await this.save(); return r; });
    return { agent: this.public(fork, thread), ...(input.message ? { receipt: await this.call(fork, input, source) } : {}) };
  }
  async call(record, input, source) {
    if (!input.message) throw fail(400, 'call 需要 message 或 message-file');
    const metadata = await this.metadata(record);
    if (metadata?.canAcceptDirectInput === false) throw fail(409, '后端不允许向此子代理直接发送消息');
    const qid = this.queueId(record);
    const entry = { text: input.message, source, agentDelivery: true };
    if (record.kind === 'btw' && deliveryText({ ...entry, id: '00000000-0000-0000-0000-000000000000' }).length > 200000) throw fail(400, 'BTW 消息过长');
    if (input.steer) {
      const turnId = record.threadId && this.live.get(record.threadId).activeTurnId;
      if (!turnId) throw fail(409, 'not_running：目标没有正在执行的任务');
      const id = randomUUID(); entry.id = id;
      const receipt = this.queue.receipt(qid, { ...entry, status: 'sending', revision: 1 });
      this.queue.notify(qid); await this.queue.flush();
      try {
        await this.codex.request('turn/steer', { threadId: record.threadId, expectedTurnId: turnId, clientUserMessageId: id, input: [{ type: 'text', text: deliveryText(entry), text_elements: [] }] });
        Object.assign(receipt, { status: 'delivered', turnId });
      } catch (error) { Object.assign(receipt, { status: 'delivery_unknown', error: error.message }); throw error; }
      finally { this.queue.notify(qid); await this.queue.flush(); }
      return { ...receipt, target: record.agent_id };
    }
    const result = this.queue.add(qid, entry), added = result.entries.at(-1);
    await this.queue.flush();
    const receipt = { ...this.queue.receipts.get(added.id), target: record.agent_id };
    // Return after durable acceptance. Generation belongs to the service.
    setImmediate(() => { void this.queue.drain(qid); });
    return receipt;
  }
}
