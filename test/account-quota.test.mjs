import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountQuota } from '../server/account-quota.mjs';

const bucket = (usedPercent, windowDurationMins, resetsAt = 2000000000) => ({ usedPercent, windowDurationMins, resetsAt });
function fixture(result) {
  let now = 1800000000000;
  let calls = 0;
  const codex = { ready: true, async request(method, params, options) {
    assert.equal(method, 'account/rateLimits/read');
    assert.equal(options.timeout, 10000);
    calls++;
    return typeof result === 'function' ? result() : result;
  } };
  const quota = new AccountQuota(codex, { now: () => now });
  return { codex, quota, calls: () => calls, advance: ms => { now += ms; } };
}

test('quota identifies windows by duration, including weekly-only Pro and reversed slots', async () => {
  for (const [primary, secondary, expectedFiveHour, expectedWeekly] of [
    [bucket(26, 10080), null, null, 74],
    [bucket(20, 300), bucket(26, 10080), 80, 74],
    [bucket(26, 10080), bucket(100, 300), 0, 74],
    [bucket(0, 60), { usedPercent: 20 }, null, null],
    [bucket(130, 300), bucket(-5, 10080), 0, 100],
  ]) {
    const { quota } = fixture({ rateLimits: { primary, secondary, planType: 'pro' } });
    const result = await quota.read();
    assert.equal(result.planType, 'pro');
    assert.equal(result.fiveHour?.remainingPercent ?? null, expectedFiveHour);
    assert.equal(result.weekly?.remainingPercent ?? null, expectedWeekly);
  }
});

test('quota prefers the Codex bucket and excludes unrelated review/model limits and private fields', async () => {
  const { quota } = fixture({ accountId: 'private', rateLimits: { primary: bucket(5, 300), limitId: 'codex_review' },
    rateLimitsByLimitId: { codex: { planType: 'pro', primary: bucket(26, 10080), credits: { balance: 'private' } } } });
  assert.deepEqual(await quota.read(), { planType: 'pro', fiveHour: null, weekly: { remainingPercent: 74, resetsAt: 2000000000 }, checkedAt: 1800000000000 });
  const unrelated = fixture({ rateLimits: { limitId: 'codex_review', primary: bucket(20, 300) } });
  assert.equal((await unrelated.quota.read()).fiveHour, null);
});

test('quota deduplicates reads, expires cache, refreshes on reset and supports explicit refresh', async () => {
  const f = fixture({ rateLimits: { primary: bucket(26, 10080, 1800000090) } });
  const reads = await Promise.all([f.quota.read(), f.quota.read(), f.quota.read()]);
  assert.equal(f.calls(), 1);
  assert.equal(reads[0], reads[1]);
  f.advance(59000); await f.quota.read(); assert.equal(f.calls(), 1);
  f.advance(1000); await f.quota.read(); assert.equal(f.calls(), 2);
  f.advance(30000); await f.quota.read(); assert.equal(f.calls(), 3, 'reset bypasses cache before its TTL');
  await f.quota.read({ refresh: true }); assert.equal(f.calls(), 4);
});

test('quota merges partial notifications, clears absent windows explicitly and ignores unrelated buckets', async () => {
  const f = fixture({ rateLimits: { primary: bucket(20, 300), secondary: bucket(26, 10080), planType: 'pro' } });
  await f.quota.read();
  f.quota.ingest({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: bucket(40, 300) } } });
  assert.equal((await f.quota.read()).fiveHour.remainingPercent, 60);
  assert.equal((await f.quota.read()).weekly.remainingPercent, 74);
  f.quota.ingest({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex_review', primary: bucket(100, 300) } } });
  assert.equal((await f.quota.read()).fiveHour.remainingPercent, 60);
  f.quota.ingest({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: bucket(30, 10080), secondary: null } } });
  assert.equal((await f.quota.read()).fiveHour, null);
  assert.equal((await f.quota.read()).weekly.remainingPercent, 70);
  assert.equal(f.calls(), 1);
});

test('quota discards in-flight reads after account changes or newer notifications', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const reading = f.quota.read();
  f.quota.ingest({ method: 'account/updated', params: {} });
  f.codex.request = async () => ({ rateLimits: { primary: bucket(10, 10080) } });
  release({ rateLimits: { primary: bucket(90, 10080) } });
  assert.equal((await reading).weekly.remainingPercent, 90);
  f.quota.invalidate();
  f.codex.request = async () => new Promise(resolve => { release = resolve; });
  const next = f.quota.read();
  f.quota.ingest({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: bucket(35, 10080) } } });
  release({ rateLimits: { primary: bucket(90, 10080) } });
  assert.equal((await next).weekly.remainingPercent, 65);
});

test('quota handles unavailable auth, retries failures, and rejects disconnected reads', async () => {
  const f = fixture(() => { throw new Error('ChatGPT 登录后才可读取额度'); });
  await assert.rejects(f.quota.read(), /ChatGPT/);
  f.codex.request = async () => ({});
  assert.equal((await f.quota.read()).weekly, null);
  f.codex.ready = false;
  await assert.rejects(f.quota.read(), { status: 503 });
});
