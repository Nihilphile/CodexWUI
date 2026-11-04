import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RecoveryStore, failureInfo } from '../server/recovery.mjs';

test('recovery survives restart with complete inputs and uncertain delivery remains blocked until correlated', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recovery-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'recovery.json');
  const store = new RecoveryStore(file); await store.load();
  const command = { id: 'stable-id', threadId: 'thread', input: { text: 'question', images: ['image'], files: ['file'], skills: [{ name: 'skill', path: '/skill' }] } };
  await assert.rejects(store.execute(command, async submitted => { await submitted(); throw new Error('connection lost'); }), /connection lost/);
  const restored = new RecoveryStore(file); await restored.load();
  assert.deepEqual(restored.records.get('stable-id').input, command.input);
  assert.equal(restored.snapshot('thread')[0].state, 'unknown');
  assert.throws(() => restored.execute(command, () => assert.fail('must not send')), /正在确认发送结果/);
  restored.ingest('thread', { id: 'native-turn', status: 'failed', items: [{ type: 'userMessage', clientId: 'stable-id' }], error: { message: '403 Forbidden', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } } });
  const result = await restored.execute(command, () => assert.fail('must not send'));
  assert.equal(result.turn.id, 'native-turn');
  assert.equal(result.recovery[0].failure.category, 'access');
  await restored.file.flush();
});

test('structured limit categories distinguish retryable capacity from exhausted quota and preserve bounded details', () => {
  assert.equal(failureInfo({ message: '429', codexErrorInfo: 'usageLimitExceeded' }).category, 'quota');
  assert.equal(failureInfo({ message: 'limit', codexErrorInfo: 'rateLimitExceeded' }).category, 'rate');
  assert.equal(failureInfo({ message: 'busy', codexErrorInfo: 'serverOverloaded' }).category, 'overload');
  assert.equal(failureInfo({ message: 'large', codexErrorInfo: 'contextWindowExceeded' }).category, 'context');
  assert.equal(failureInfo({ message: 'HTTP 403 <html>' + 'x'.repeat(20000) }).details.length, 16000);
});
