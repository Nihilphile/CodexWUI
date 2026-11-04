import { JsonFile } from './persistence.mjs';

export const AUTHORITY_CHOICES = ['default', 'read-only', 'workspace', 'full'];
export function authorityParams(choice) {
  if (!AUTHORITY_CHOICES.includes(choice)) throw Object.assign(new Error('权限选项无效'), { status: 400 });
  if (choice === 'default') return {};
  return { permissions: { 'read-only': ':read-only', workspace: ':workspace', full: ':danger-full-access' }[choice], approvalPolicy: choice === 'full' ? 'never' : 'on-request' };
}

// Keep the selection across unload/restart; settings/update applies atomically
// to future turns in Codex, including queued follow-ups.
export class ThreadAuthority {
  constructor(file) { this.file = new JsonFile(file); this.records = new Map(); }
  async load() { this.records = new Map(await this.file.read([])); }
  get(id) { return this.records.get(id)?.choice || 'default'; }
  async save(id, choice, params, pendingTurnId = null) {
    this.records.set(id, { choice, params, pendingTurnId });
    await this.file.write([...this.records]);
  }
  async params(choice, cwd, codex) {
    if (choice !== 'default') return authorityParams(choice);
    const { config } = await codex.request('config/read', { cwd, includeLayers: false });
    const approvalPolicy = config.approval_policy || 'on-request';
    if (config.default_permissions) return { permissions: config.default_permissions, approvalPolicy };
    const mode = config.sandbox_mode || 'read-only';
    if (mode === 'danger-full-access') return { sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy };
    if (mode === 'read-only') return { sandboxPolicy: { type: 'readOnly', networkAccess: config.sandbox_read_only?.network_access ?? false }, approvalPolicy };
    if (mode === 'workspace-write') {
      const s = config.sandbox_workspace_write || {};
      return { sandboxPolicy: { type: 'workspaceWrite', writableRoots: s.writable_roots || [], networkAccess: s.network_access ?? false,
        excludeTmpdirEnvVar: s.exclude_tmpdir_env_var ?? false, excludeSlashTmp: s.exclude_slash_tmp ?? false }, approvalPolicy };
    }
    throw Object.assign(new Error('当前本机权限配置无法恢复，请选择明确的权限模式'), { status: 400 });
  }
  async restore(id, codex) {
    const record = this.records.get(id);
    if (record) await codex.request('thread/settings/update', { threadId: id, ...record.params });
  }
  pending(id, activeTurnId) { return Boolean(activeTurnId && this.records.get(id)?.pendingTurnId === activeTurnId); }
}
