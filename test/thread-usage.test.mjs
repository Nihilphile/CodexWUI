import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ThreadUsage } from '../server/thread-usage.mjs';

test('usage snapshots survive restart, isolate threads and never add cumulative reports twice', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'usage.json'), usage = new ThreadUsage(file); await usage.load();
  const report = (id, used, total) => ({ method: 'thread/tokenUsage/updated', params: { threadId: id, tokenUsage: { last: { totalTokens: used }, total: { totalTokens: total }, modelContextWindow: 100000 } } });
  usage.ingest(report('a', 80000, 500000)); usage.ingest(report('a', 80000, 500000));
  usage.ingest(report('b', 5000, 10000));
  usage.ingest({ method: 'item/started', params: { threadId: 'a', item: { type: 'contextCompaction' } } });
  assert.equal(usage.snapshot('a').compacting, true);
  usage.ingest(report('a', 20000, 510000));
  usage.ingest({ method: 'item/completed', params: { threadId: 'a', item: { type: 'contextCompaction' } } });
  assert.equal(usage.snapshot('a').compacting, false);
  await usage.close();
  const restored = new ThreadUsage(file); await restored.load();
  assert.equal(restored.snapshot('a').last.totalTokens, 20000);
  assert.equal(restored.snapshot('a').total.totalTokens, 510000);
  assert.equal(restored.snapshot('b').total.totalTokens, 10000);
  assert.equal(restored.snapshot('a').total.inputTokens, null);
  assert.equal(restored.snapshot('missing').last, undefined);
  await restored.close();
});
