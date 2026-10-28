import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listDirectory, readTextFile } from './files.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const BTW_INSTRUCTIONS = '你正在独立的 BTW 侧边对话中，是只读侧聊助手；主会话仍在继续。历史来自创建侧聊时的主会话分叉，此前的任务、目标和指令仅供参考，不要继续执行它们。只回答侧聊用户的新问题。可以使用网页搜索与浏览获取资料，也可以使用 btw_list_directory 和 btw_read_file 查看项目。不能修改文件、执行命令、通过外部服务进行写入或联系其他会话。需要行动时解释建议，由用户带回主会话。';
export const BTW_TOOLS = ['btw_list_directory', 'btw_read_file'].map(name => ({
  type: 'function', name, description: name === 'btw_read_file' ? 'Read a UTF-8 text file inside this project. Use a project-relative path.' : 'List a directory inside this project. Use an empty path for the project root.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
}));
export function btwConfig(config = {}, cwd) {
  const disabled = ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'apps', 'connectors', 'plugins', 'remote_plugin', 'recommended_plugins', 'tool_suggest', 'multi_agent', 'multi_agent_v2', 'collab', 'agent_message_board', 'send_async_message', 'code_mode', 'code_mode_host', 'code_mode_only', 'js_repl', 'browser_use', 'computer_use', 'image_generation', 'imagegenext', 'hooks', 'codex_hooks', 'plugin_hooks', 'goals', 'memory_tool', 'memories', 'request_permissions', 'request_permissions_tool', 'request_rule', 'exec_permission_approvals', 'undo', 'view_image'];
  return {
    ...Object.fromEntries(disabled.map(name => [`features.${name}`, false])),
    'features.skip_host_skill_discovery': true,
    'tools.experimental_request_user_input.enabled': false,
    web_search: 'live', notify: [], project_doc_max_bytes: 0,
    mcp_servers: {
      ...Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [name, { enabled: false }])),
      ...(cwd ? { codexweb_btw: { enabled: true, command: process.execPath, args: [fileURLToPath(new URL('./btw-mcp.mjs', import.meta.url)), cwd] } } : {}),
    },
    plugins: Object.fromEntries(Object.keys(config.plugins || {}).map(name => [name, { enabled: false }])),
  };
}

export async function readBtwProject(cwd, tool, args) {
  if (!BTW_TOOLS.some(definition => definition.name === tool)) throw fail(403, 'BTW 不允许此工具');
  if (!args || typeof args.path !== 'string' || Object.keys(args).some(key => key !== 'path')) throw fail(400, '工具参数无效');
  const result = tool === 'btw_read_file' ? await readTextFile(cwd, args.path) : await listDirectory(cwd, args.path);
  if (result.text?.length > 80000) { result.text = result.text.slice(0, 80000); result.truncated = true; }
  if (result.entries?.length > 500) { result.entries = result.entries.slice(0, 500); result.truncated = true; }
  return result;
}

const emptyHistory = () => ({ data: [], nextCursor: null });
const missingHistory = error => /not materialized yet|no rollout found|thread not loaded/i.test(error.message);
const textInput = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200000) throw fail(400, 'BTW 消息无效');
  const text = value;
  return { text, resolvedInput: [{ type: 'text', text, text_elements: [] }] };
};

// Side chats own separate Codex threads. Only this service can start their turns;
// the browser never supplies a side-thread ID, policy, or tool definition.
export class BtwSessions {
  constructor({ codex, live, lifecycle, starting, dataDir, parent, broadcast, queue, steers, settled }) {
    Object.assign(this, { codex, live, lifecycle, starting, parent, broadcast, queue, steers, settled });
    this.file = path.join(dataDir, 'btw.json');
    this.records = new Map(); this.byThread = new Map(); this.locks = new Map(); this.saveQueue = Promise.resolve();
  }
  async load() {
    let records = [];
    try { records = JSON.parse(await readFile(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!Array.isArray(records)) throw new Error('BTW 会话记录格式错误');
    for (const record of records) {
      if (!record.parentId || !record.cwd || (!record.id && !record.threadId)) throw new Error('BTW 会话记录无效');
      // Records written before native forks used the parent id as their key.
      if (!record.id) { record.id = record.threadId; record.legacy = true; }
      this.records.set(record.id, record);
      if (record.threadId) this.byThread.set(record.threadId, record);
    }
  }
  owns(id) { return this.byThread.has(id); }
  save() {
    const contents = JSON.stringify([...this.records.values()]);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await writeFile(this.file + '.tmp', contents, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    });
    return this.saveQueue;
  }
  async locked(id, action) {
    if (this.locks.has(id)) throw fail(409, 'BTW 正在处理请求，请稍后再试');
    this.locks.set(id, true);
    try { return await action(); } finally { this.locks.delete(id); }
  }
  sessions(parentId) { return [...this.records.values()].filter(record => record.parentId === parentId); }
  record(parentId, sessionId) {
    const record = sessionId ? this.records.get(sessionId) : this.sessions(parentId).at(-1);
    if (sessionId && record?.parentId !== parentId) throw fail(404, 'BTW 侧聊不存在');
    return record;
  }
  async snapshot(parentId, sessionId) {
    await this.parent(parentId);
    const record = this.record(parentId, sessionId), sessions = this.sessions(parentId);
    if (!record) return { session: null, sessions };
    let history = emptyHistory();
    if (record.threadId) {
      try {
        const params = { threadId: record.threadId, limit: 100, sortDirection: 'desc' };
        // Inspect turn metadata first so opening a fresh fork never hydrates
        // large inherited tool results just to discard them in the panel.
        let count = 100, includesBoundary = false;
        if (record.forkTurnId) {
          const page = await this.codex.request('thread/turns/list', { ...params, itemsView: 'notLoaded' });
          const boundary = page.data.findIndex(turn => turn.id === record.forkTurnId);
          includesBoundary = boundary >= 0;
          count = includesBoundary ? boundary : page.data.length;
        }
        if (count) history = await this.codex.request('thread/turns/list', { ...params, limit: count, itemsView: 'full' });
        if (includesBoundary) history.nextCursor = null;
      }
      catch (error) {
        if (!missingHistory(error) || record.hasMessages || (!record.legacy && !record.empty && record.forkTurnId)) throw error;
      }
    }
    // The fork history stays available to the model, but the panel shows only
    // side-chat turns. An interrupted inherited turn must not look active here.
    const boundary = history.data.findIndex(turn => turn.id === record.forkTurnId);
    if (boundary >= 0) history = { ...history, data: history.data.slice(0, boundary), nextCursor: null };
    return { session: record, sessions, history, live: record.threadId ? this.live.snapshot(record.threadId) : { turns: [] },
      queue: this.queue.snapshot(record.id), steers: this.steers.snapshot(record.threadId || record.id) };
  }
  async open(parentId) {
    return this.locked(parentId, async () => {
      const parent = await this.parent(parentId);
      const { config } = await this.codex.request('config/read', { cwd: parent.cwd, includeLayers: false });
      const policy = btwConfig(config, parent.cwd);
      let threadId = null, forkTurnId = null;
      try {
        const result = await this.codex.request('thread/fork', {
          threadId: parentId, excludeTurns: true, deferGoalContinuation: true,
          cwd: parent.cwd, ...(parent.model ? { model: parent.model } : {}),
          sandbox: 'read-only', approvalPolicy: 'never', config: policy,
          baseInstructions: BTW_INSTRUCTIONS, developerInstructions: BTW_INSTRUCTIONS,
        });
        threadId = result.thread.id;
        this.lifecycle.markLoaded(threadId);
      } catch (error) {
        // Only a genuinely blank parent may lack a rollout. A stored but
        // unloaded parent must still be forked, never replaced with no history.
        if (!/no rollout found|not materialized yet/i.test(error.message) || parent.preview || this.live.snapshot(parentId)?.turns.length) throw error;
      }
      if (threadId) {
        const inherited = await this.codex.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        forkTurnId = inherited.data[0]?.id || null;
      }
      const record = { id: randomUUID(), parentId, threadId, forkTurnId, empty: !threadId, cwd: parent.cwd, model: parent.model, createdAt: Date.now() };
      this.records.set(record.id, record);
      if (threadId) this.byThread.set(threadId, record);
      await this.save();
      this.broadcast({ method: 'web/btw', params: { session: record } });
      return this.snapshot(parentId, record.id);
    });
  }
  async ensureLoaded(record) {
    if (record.threadId && this.lifecycle.loaded.has(record.threadId)) return;
    const { config } = await this.codex.request('config/read', { cwd: record.cwd, includeLayers: false });
    const options = {
      sandbox: 'read-only', approvalPolicy: 'never', config: btwConfig(config, record.cwd),
      baseInstructions: BTW_INSTRUCTIONS, developerInstructions: BTW_INSTRUCTIONS,
    };
    if (record.threadId) {
      try {
        await this.codex.request('thread/resume', { ...options, threadId: record.threadId, excludeTurns: true });
        this.lifecycle.markLoaded(record.threadId); return;
      } catch (error) {
        if (!missingHistory(error)) throw error;
        if (record.legacy) throw fail(409, '旧侧聊未保存，无法恢复原上下文；请点击“新侧聊”重新分叉');
        if (!record.empty || record.hasMessages) throw error;
        // This branch captured an empty parent, so a failed first send can be
        // retried with a fresh empty Codex thread without moving its context.
      }
    }
    const result = await this.codex.request('thread/start', {
      ...options,
      cwd: record.cwd, ...(record.model ? { model: record.model } : {}),
      dynamicTools: BTW_TOOLS,
    });
    if (record.threadId) this.byThread.delete(record.threadId);
    record.threadId = result.thread.id;
    this.byThread.set(record.threadId, record);
    this.lifecycle.markLoaded(record.threadId);
    await this.save();
    this.broadcast({ method: 'web/btw', params: { session: record } });
  }
  async send(parentId, prompt, sessionId) {
    const { text, resolvedInput } = textInput(prompt);
    let record = this.record(parentId, sessionId);
    if (!record) record = (await this.open(parentId)).session;
    let ownsLock = false;
    try {
      return await this.locked(record.id, async () => {
        ownsLock = true;
        await this.parent(parentId);
        // Reserve before asynchronous resume/start so parallel sends cannot exceed
        // the shared budget, including side chats that still have only a local id.
        if (this.lifecycle.busy(record.threadId || record.id)) throw fail(409, 'BTW 正在回答，请等待或先停止');
        const reservation = record.threadId || record.id;
        this.lifecycle.reserve(reservation);
        try {
          await this.ensureLoaded(record);
          if (reservation !== record.threadId) { this.starting.delete(reservation); this.starting.add(record.threadId); }
          const result = await this.codex.request('turn/start', { threadId: record.threadId, input: resolvedInput, sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' });
          record.title ||= text.slice(0, 48);
          record.hasMessages = true;
          await this.save();
          this.broadcast({ method: 'web/btw', params: { session: record } });
          return result;
        } finally { this.starting.delete(reservation); this.starting.delete(record.threadId); }
      });
    } finally {
      // Release the per-side lock before draining a completion that arrived
      // before turn/start returned. The queued turn must use this same policy.
      if (ownsLock && record.threadId) this.settled(record.threadId);
    }
  }
  async control(parentId, sessionId, action, input) {
    await this.parent(parentId);
    const record = this.record(parentId, sessionId);
    if (!record) throw fail(404, 'BTW 侧聊不存在');
    const id = record.threadId;
    if (action === 'queue') {
      const { text } = textInput(input.text);
      this.queue.add(record.id, { text });
      if (!id || !this.lifecycle.busy(id)) void this.queue.drain(record.id);
      return { queue: this.queue.snapshot(record.id) };
    }
    if (['queue-remove', 'queue-edit', 'queue-update', 'queue-run'].includes(action)) {
      let entry;
      if (action === 'queue-remove') this.queue.remove(record.id, input.id, input.revision);
      if (action === 'queue-edit') entry = this.queue.edit(record.id, input.id, input.revision);
      if (action === 'queue-update') this.queue.update(record.id, input.id, input.revision, input.text);
      if (action === 'queue-run') {
        this.queue.resume(record.id, input.id, input.revision);
        if (!id || !this.lifecycle.busy(id)) await this.queue.drain(record.id);
      }
      await this.queue.flush();
      return { entry, queue: this.queue.snapshot(record.id) };
    }
    if (!id) throw fail(409, '当前侧聊没有正在进行的回答');
    if (action === 'steer') {
      const resolved = textInput(input.text);
      const turnId = this.live.get(id).activeTurnId;
      if (!turnId || input.expectedTurnId !== turnId) throw fail(409, '回答状态已变化，请检查后重新发送；草稿已保留');
      if (input.clientUserMessageId !== undefined && (typeof input.clientUserMessageId !== 'string' || !/^[\w-]{1,100}$/.test(input.clientUserMessageId))) throw fail(400, '消息标识无效');
      this.steers.add(id, { ...resolved, expectedTurnId: turnId, clientUserMessageId: input.clientUserMessageId });
    } else {
      if (typeof input.id !== 'string' || !input.id || input.id.length > 100 || !Number.isInteger(input.revision)) throw fail(400, '引导标识或版本无效');
      let entry;
      if (action === 'steer-edit') entry = this.steers.beginEdit(id, input.id, input.revision);
      else if (action === 'steer-update') {
        const resolved = textInput(input.text), pending = this.steers.get(id, input.id, input.revision);
        entry = this.steers.update(id, input.id, input.revision, resolved, this.live.get(id).activeTurnId === pending.expectedTurnId);
      } else if (action === 'steer-cancel-edit') this.steers.cancelEdit(id, input.id, input.revision);
      else if (action === 'steer-remove') this.steers.remove(id, input.id, input.revision);
      else if (action === 'steer-send') await this.steers.dispatch(id, input.id, input.revision);
      else throw fail(400, '不支持的侧聊操作');
      return { entry, steers: this.steers.snapshot(id) };
    }
    return { steers: this.steers.snapshot(id) };
  }
  async stop(parentId, sessionId) {
    await this.parent(parentId);
    const record = this.record(parentId, sessionId);
    if (record) this.queue.pause(record.id);
    if (record?.threadId) await this.lifecycle.clean(record.threadId, { stop: true });
    await this.queue.flush();
    return {};
  }
  async tool(params) {
    const record = this.byThread.get(params.threadId);
    if (!record) throw fail(403, 'BTW 不允许此工具');
    const result = await readBtwProject(record.cwd, params.tool, params.arguments);
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
  }
}
