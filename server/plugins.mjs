const fail = (status, message) => Object.assign(new Error(message), { status });

// Keep config writes in Codex so its TOML edits, policy checks and version
// checks stay authoritative. The browser can only toggle discovered installs.
export class PluginService {
  constructor({ codex, changed }) {
    Object.assign(this, { codex, changed });
    this.queue = Promise.resolve();
  }
  async read(cwd) {
    let catalog, config;
    try {
      [catalog, config] = await Promise.all([
        this.codex.request('plugin/installed', { cwds: [cwd] }),
        this.codex.request('config/read', { includeLayers: true }),
      ]);
    } catch (error) {
      if (error.code === -32601 || /unknown (?:method|variant)|method not found/i.test(error.message)) throw fail(501, '当前 Codex 不支持插件管理接口，请升级 Codex 后重试');
      throw error;
    }
    const user = config.layers?.find(layer => layer.name.type === 'user' && !layer.name.profile);
    const plugins = new Map();
    for (const marketplace of catalog.marketplaces || []) {
      for (const plugin of marketplace.plugins || []) {
        if (!plugin.installed) continue;
        plugins.set(plugin.id, {
          id: plugin.id, name: plugin.interface?.displayName || plugin.name,
          description: plugin.interface?.shortDescription || '',
          marketplace: marketplace.interface?.displayName || marketplace.name,
          enabled: plugin.enabled, version: plugin.localVersion || plugin.version || null,
          blocked: plugin.availability === 'DISABLED_BY_ADMIN' || Boolean(plugin.disabledReason),
          disabledReason: plugin.disabledReason || (plugin.availability === 'DISABLED_BY_ADMIN' ? 'disabled_by_admin' : null),
        });
      }
    }
    return { plugins: [...plugins.values()], errors: (catalog.marketplaceLoadErrors || []).map(error => error.message), version: user?.version ?? null };
  }
  update(cwd, input) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 512 || /[\x00-\x1f\x7f]/.test(input.id) || typeof input.enabled !== 'boolean' || !(input.version === null || typeof input.version === 'string')) throw fail(400, '插件开关参数无效，请重新读取列表');
      const before = await this.read(cwd);
      const plugin = before.plugins.find(plugin => plugin.id === input.id);
      if (!plugin) throw fail(404, '插件未安装或已移除，请重新读取列表');
      if (plugin.blocked) throw fail(403, '此插件受账号或管理员策略限制，无法切换');
      if (input.version !== before.version) throw fail(409, 'Codex 配置已更新，请重新读取列表后再切换');
      const result = await this.codex.request('config/value/write', {
        keyPath: `plugins.${JSON.stringify(plugin.id)}.enabled`, value: input.enabled,
        mergeStrategy: 'upsert', expectedVersion: before.version,
      });
      this.changed();
      let snapshot;
      try { snapshot = await this.read(cwd); }
      catch { return { ...before, version: result.version, refreshRequired: true, message: '开关已保存，暂时无法确认生效状态，请重新读取列表。新建会话使用新配置。' }; }
      const effective = snapshot.plugins.find(plugin => plugin.id === input.id);
      const overridden = result.status === 'okOverridden' || effective?.enabled !== input.enabled;
      return { ...snapshot, message: overridden ? '开关已保存，但实际状态受更高优先级配置或策略限制。' : '开关已保存。新建会话使用新配置；已有会话可能保留已加载的技能和工具。' };
    });
    this.queue = operation;
    return operation;
  }
}
