import { JsonFile } from './persistence.mjs';
import { operationId } from './recovery.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

export class TurnHistory {
  constructor(codex, file) {
    this.codex = codex; this.file = new JsonFile(file); this.forks = new Map(); this.running = new Map();
  }
  async load() { this.forks = new Map(await this.file.read([])); }
  async list(id) {
    const turns = [], cursors = new Set();
    let cursor;
    do {
      const page = await this.codex.request('thread/turns/list', { threadId: id, limit: 100, cursor, sortDirection: 'asc', itemsView: 'notLoaded' });
      turns.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw fail(502, '轮次分页未前进，请刷新后重试');
      cursors.add(cursor);
    } while (cursor);
    return [...new Map(turns.map(turn => [turn.id, turn])).values()];
  }
  async read(id, turnId) {
    // Exact turn items may span multiple pages, including long tool executions.
    const turns = await this.list(id);
    const turn = turns.find(turn => turn.id === turnId);
    if (!turn) throw fail(404, '这一轮已不存在，请刷新会话');
    const items = [], cursors = new Set(); let cursor;
    do {
      const page = await this.codex.request('thread/items/list', { threadId: id, turnId, limit: 100, cursor, sortDirection: 'asc' });
      items.push(...page.data.map(value => value.item)); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw fail(502, '消息分页未前进，请刷新后重试');
      cursors.add(cursor);
    } while (cursor);
    return { turn: { ...turn, items }, latest: turns.at(-1)?.id === turnId };
  }
  fork(command, create, finish) {
    operationId(command.id);
    const identity = JSON.stringify(command);
    const saved = this.forks.get(command.id);
    if (saved && saved.identity !== identity) throw fail(409, '分叉操作已变化，请刷新后重试');
    if (this.running.has(command.id)) return this.running.get(command.id);
    if (saved && !saved.threadId) throw fail(409, '上次分叉结果待确认，请先刷新会话列表');
    const record = saved || { identity, threadId: null };
    this.forks.set(command.id, record);
    let submitted = false;
    const promise = (async () => {
      if (!saved) {
        await this.file.write([...this.forks]);
        submitted = true;
        const result = await create();
        record.threadId = result.thread.id;
        await this.file.write([...this.forks]);
      }
      return await finish(record.threadId);
    })().catch(async error => {
      if (!record.threadId && (!submitted || error.rpcRejected)) {
        this.forks.delete(command.id); await this.file.write([...this.forks]);
      } else {
        error.retrySameOperation = true;
        error.message = record.threadId ? '分叉已建立，但设置尚未完成；请再次点击以完成同一个分叉' : '分叉结果待确认，请先刷新会话列表';
      }
      throw error;
    }).finally(() => this.running.delete(command.id));
    this.running.set(command.id, promise);
    return promise;
  }
}
