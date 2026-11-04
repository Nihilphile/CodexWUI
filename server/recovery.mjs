import { JsonFile } from './persistence.mjs';

const conflict = message => Object.assign(new Error(message), { status: 409 });
export function operationId(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw Object.assign(new Error('操作标识无效'), { status: 400 });
  return value;
}

export function failureInfo(error) {
  const details = String(error?.message || error || '任务未完成').slice(0, 16000);
  const code = error?.codexErrorInfo || error?.data?.codexErrorInfo;
  const name = typeof code === 'string' ? code : Object.keys(code || {})[0];
  const status = (typeof code === 'object' && Object.values(code || {})[0]?.httpStatusCode)
    || Number(details.match(/(?:status\D{0,12}|HTTP\s+)(401|403|429|5\d\d)\b/i)?.[1]);
  let category = 'unknown', summary = '本轮未完成，可以恢复任务。';
  if (status === 403) { category = 'access'; summary = '访问被拒绝 · 403。请检查网络或账号后重试。'; }
  else if (status === 401 || name === 'unauthorized') { category = 'auth'; summary = '登录状态失效，请重新登录后重试。'; }
  else if (['usageLimitExceeded', 'sessionBudgetExceeded'].includes(name) || /insufficient_quota|usage.limit|quota.exceeded/i.test(details)) { category = 'quota'; summary = '可用额度或任务预算已用尽，请恢复额度或调整预算后重试。'; }
  else if (status === 429 || name === 'rateLimitExceeded') { category = 'rate'; summary = '请求暂时受到限流，请稍后重试，或选择其他可用模型。'; }
  else if (status === 503 || ['serverOverloaded', 'flexUnavailable'].includes(name)) { category = 'overload'; summary = '模型暂时不可用，请稍后重试，或换模型重试。'; }
  else if (name === 'contextWindowExceeded') { category = 'context'; summary = '上下文已满，请压缩上下文后继续。'; }
  else if (name === 'badRequest') { category = 'input'; summary = '请求内容或设置不受支持，请编辑后发送。'; }
  else if (status >= 500 || name === 'internalServerError') { category = 'server'; summary = '服务暂时出错，请稍后重试。'; }
  else if (['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(name) || /connection|network|timeout|timed out|超时|连接/i.test(details)) { category = 'connection'; summary = '连接中断，请检查网络后恢复任务。'; }
  return { category, summary, details };
}

export function recoveryMode(turn) {
  // Only a complete native turn containing just the original input is empty.
  return turn.items?.length && turn.items.every(item => item.type === 'userMessage') ? 'retry' : 'continue';
}

export class RecoveryStore {
  constructor(file) { this.file = new JsonFile(file); this.records = new Map(); this.running = new Map(); }
  async load() {
    this.records = new Map(await this.file.read([]));
    for (const entry of this.records.values()) {
      if (entry.state === 'dispatching' || entry.state === 'running') entry.state = 'unknown';
      if (entry.state === 'preparing') entry.state = 'rejected';
    }
  }
  save() { return this.file.write([...this.records]); }
  forThread(id) { return [...this.records.values()].filter(entry => entry.threadId === id); }
  forTurn(id, turnId) { return this.forThread(id).find(entry => entry.turnId === turnId); }
  snapshot(id) {
    return this.forThread(id).filter(entry => !entry.supersededBy).map(({ id, turnId, sourceTurnId, state, failure }) => ({ id, turnId, sourceTurnId, state, failure }));
  }
  ingest(threadId, turn) {
    const clientIds = (turn.items || []).filter(item => item.type === 'userMessage').map(item => item.clientId);
    const entry = this.forTurn(threadId, turn.id) || this.forThread(threadId).find(e => clientIds.includes(e.id));
    if (!entry) return;
    const state = turn.status === 'inProgress' ? 'running' : turn.status;
    const failure = turn.error ? failureInfo(turn.error) : null;
    if (entry.turnId === turn.id && entry.state === state && JSON.stringify(entry.failure) === JSON.stringify(failure)) return;
    entry.turnId = turn.id; entry.state = state; entry.failure = failure;
    void this.save().catch(() => {});
  }
  execute(command, dispatch) {
    operationId(command.id);
    const old = this.records.get(command.id);
    const identity = JSON.stringify(command);
    if (old) {
      if (old.identity !== identity) throw conflict('操作标识已被另一条消息使用');
      if (this.running.has(command.id)) return this.running.get(command.id);
      if (old.turnId) return Promise.resolve({ turn: { id: old.turnId }, recovery: this.snapshot(command.threadId) });
      throw conflict(old.state === 'unknown' ? '正在确认发送结果，请先刷新会话；不要重复发送' : old.failure?.summary || '这次发送未成功，请使用恢复入口重试');
    }
    const entry = { ...structuredClone(command), identity, state: 'preparing', turnId: null };
    this.records.set(command.id, entry);
    const promise = (async () => {
      await this.save();
      try {
        const result = await dispatch(async () => { entry.state = 'dispatching'; await this.save(); });
        entry.turnId = result.turn.id;
        const source = this.records.get(command.sourceRecoveryId);
        if (source) source.supersededBy = entry.id;
        if (['preparing', 'dispatching', 'unknown'].includes(entry.state)) entry.state = result.turn.status === 'inProgress' ? 'running' : result.turn.status || 'running';
        await this.save();
        return { ...result, recovery: this.snapshot(command.threadId) };
      } catch (error) {
        // A transport failure after submission cannot prove that nothing ran.
        if (!entry.turnId) entry.state = entry.state === 'dispatching' && !error.rpcRejected ? 'unknown' : 'rejected';
        entry.failure = failureInfo(error);
        await this.save();
        throw Object.assign(error, { recoveryId: entry.id, deliveryUnknown: entry.state === 'unknown' });
      }
    })().finally(() => this.running.delete(command.id));
    this.running.set(command.id, promise);
    return promise;
  }
}
