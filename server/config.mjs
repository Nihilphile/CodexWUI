import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const error = (status, message) => Object.assign(new Error(message), { status });
export const CONFIG_KEYS = ['maxActiveTurns', 'maxProcesses', 'maxRssMb', 'idleMinutes', 'maxFileMb', 'defaultModel', 'defaultEffort'];
const ENV_KEYS = { maxActiveTurns: 'CODEXWEB_MAX_ACTIVE_TURNS', maxProcesses: 'CODEXWEB_MAX_PROCESSES', maxRssMb: 'CODEXWEB_MAX_RSS_MB', idleMinutes: 'CODEXWEB_IDLE_MINUTES', maxFileMb: 'CODEXWEB_MAX_FILE_MB' };

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, '配置必须是对象');
  for (const key of Object.keys(value)) if (!CONFIG_KEYS.includes(key)) throw error(400, `未知配置项：${key}`);
  for (const key of ['maxActiveTurns', 'maxProcesses', 'maxRssMb']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || !Number.isSafeInteger(value[key] * 1024)) throw error(400, `${key} 必须是有效的正整数`);
  }
  for (const [key, factor] of [['idleMinutes', 60000], ['maxFileMb', 1024 * 1024]]) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0 || !Number.isSafeInteger(value[key] * factor)) throw error(400, `${key} 必须是有效的正数`);
  }
  for (const key of ['defaultModel', 'defaultEffort']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200)) throw error(400, `${key} 无效`);
  }
  if (!value.defaultModel && value.defaultEffort) throw error(400, '请先选择默认模型，再设置推理强度');
  return { ...value };
}

export function configLimits(settings) {
  return { maxActiveTurns: settings.maxActiveTurns, maxProcesses: settings.maxProcesses, maxRssMb: settings.maxRssMb, idleMs: settings.idleMinutes * 60000 };
}

// The file overrides startup environment values, so saved changes survive /reload.
// Updates are serialized and use revisions to protect edits in other tabs.
export class AppConfig {
  constructor({ dataDir, limits, maxFileBytes, env = process.env }) {
    this.file = path.join(dataDir, 'config.json');
    this.instance = randomUUID();
    this.base = validateConfig({ maxActiveTurns: limits.maxActiveTurns, maxProcesses: limits.maxProcesses, maxRssMb: limits.maxRssMb, idleMinutes: limits.idleMs / 60000, maxFileMb: maxFileBytes / (1024 * 1024), defaultModel: null, defaultEffort: null });
    this.queue = Promise.resolve(); this.revision = 0; this.saved = {};
    this.sources = Object.fromEntries(CONFIG_KEYS.map(key => [key, env[ENV_KEYS[key]] === undefined ? 'default' : 'environment']));
    this.value = { ...this.base };
  }
  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (cause) { if (cause.code === 'ENOENT') return; throw new Error(`无法读取 Web 配置：${cause.message}`); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Web 配置文件必须是对象');
    this.value = validateConfig({ ...this.base, ...saved }); this.saved = saved;
    this.revision++;
  }
  snapshot() {
    return { settings: { ...this.value }, instance: this.instance, revision: this.revision, sources: Object.fromEntries(CONFIG_KEYS.map(key => [key, Object.hasOwn(this.saved, key) ? 'saved' : this.sources[key]])) };
  }
  update(patch, revision, { validate = async () => {}, apply, changed = () => {}, rollbackFailed = async () => {} }) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!Number.isSafeInteger(revision) || revision !== this.revision) throw error(409, '配置已被其他页面更新，请重新打开设置后再保存');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw error(400, '配置必须是对象');
      const next = validateConfig({ ...this.value, ...patch });
      await validate(next, this.value);
      const previous = this.value;
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      let applied = false;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await apply(next, previous); applied = true;
        await rename(temporary, this.file);
      } catch (cause) {
        if (applied) {
          try { await apply(previous, next); }
          catch (rollback) {
            await rollbackFailed(previous);
            throw new Error(`配置保存失败，恢复旧配置失败，已停止 Codex 后端：${rollback.message}`);
          }
        }
        throw cause;
      } finally { await unlink(temporary).catch(() => {}); }
      this.value = next; this.saved = next; this.revision++;
      const result = this.snapshot(); changed(result); return result;
    });
    this.queue = operation;
    return operation;
  }
}
