function snapshot(bucket, checkedAt) {
  const windows = [bucket?.primary, bucket?.secondary];
  const windowFor = minutes => {
    const window = windows.find(value => value?.windowDurationMins === minutes && Number.isFinite(value.usedPercent));
    if (!window) return null;
    return {
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
    };
  };
  return { planType: typeof bucket?.planType === 'string' ? bucket.planType : null,
    fiveHour: windowFor(300), weekly: windowFor(10080), checkedAt };
}

export class AccountQuota {
  constructor(codex, { now = Date.now } = {}) {
    this.codex = codex;
    this.now = now;
    this.generation = 0;
  }

  invalidate() {
    this.generation++;
    this.bucket = null;
    this.cached = null;
    this.pending = null;
  }

  ingest({ method, params }) {
    if (method === 'account/updated') { this.invalidate(); return; }
    if (method !== 'account/rateLimits/updated') return;
    const bucket = params?.rateLimits;
    if (!bucket || (bucket.limitId && bucket.limitId !== 'codex')) return;
    this.generation++;
    this.pending = null;
    this.bucket = { ...this.bucket, ...bucket };
    this.cached = snapshot(this.bucket, this.now());
  }

  read({ refresh = false } = {}) {
    if (!this.codex.ready) return Promise.reject(Object.assign(new Error('Codex 未连接，无法读取账户额度'), { status: 503 }));
    const current = this.cached;
    const resetPassed = [current?.fiveHour, current?.weekly].some(window => window?.resetsAt && window.resetsAt * 1000 <= this.now() && window.resetsAt * 1000 > current.checkedAt);
    if (!refresh && current && this.now() - current.checkedAt < 60000 && !resetPassed) return Promise.resolve(current);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.codex.request('account/rateLimits/read', {}, { timeout: 10000 }).then(result => {
      if (generation !== this.generation) return this.read();
      const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
      this.bucket = bucket && (!bucket.limitId || bucket.limitId === 'codex') ? bucket : null;
      this.cached = snapshot(this.bucket, this.now());
      return this.cached;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
}
