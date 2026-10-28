import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingSteers } from '../server/steers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const draft = (id = 'one') => ({ clientUserMessageId: id, expectedTurnId: 'turn-a', text: 'original', images: ['image'], skills: [{ name: 'example', path: '/skill' }] });
const boundary = (store, threadId = 'a', turnId = 'turn-a') => store.ingest({ method: 'thread/tokenUsage/updated', params: { threadId, turnId } });

test('staged steer waits for its own loop boundary, is editable, and submits only the latest revision', async () => {
  const sent = [];
  const store = new PendingSteers({ send: async (_, entry) => sent.push(structuredClone(entry)), changed() {} });
  const entry = store.add('a', draft());
  await tick(); assert.equal(sent.length, 0);
  boundary(store, 'b'); boundary(store, 'a', 'other'); await tick(); assert.equal(sent.length, 0);
  const editing = store.beginEdit('a', entry.id, entry.revision);
  boundary(store); await tick(); assert.equal(sent.length, 0);
  const edited = store.update('a', editing.id, editing.revision, { ...draft(), text: 'corrected' });
  assert.throws(() => store.remove('a', entry.id, editing.revision), /状态已变化/);
  await tick(); assert.equal(sent.length, 0);
  boundary(store); boundary(store); await tick();
  assert.equal(sent.length, 1); assert.equal(sent[0].text, 'corrected');
  assert.deepEqual(sent[0].images, ['image']); assert.equal(sent[0].skills[0].name, 'example');
  assert.equal(store.snapshot('a').entries[0].status, 'accepted');
  assert.throws(() => store.remove('a', entry.id, edited.revision), /状态已变化/);
});

test('recall wins before a boundary; submission wins after it; receipt removes exactly its matching message', async () => {
  let release;
  const store = new PendingSteers({ send: () => new Promise(resolve => { release = resolve; }), changed() {} });
  const removed = store.add('a', draft('removed')); store.remove('a', removed.id, removed.revision);
  boundary(store); assert.equal(release, undefined);
  store.add('a', draft('kept')); boundary(store);
  const sending = store.snapshot('a').entries[0]; assert.equal(sending.status, 'submitting');
  assert.throws(() => store.beginEdit('a', sending.id, sending.revision), /已提交/);
  assert.throws(() => store.remove('a', sending.id, sending.revision), /已提交/);
  // A receipt can arrive before the turn/steer RPC response.
  store.ingest({ method: 'item/started', params: { threadId: 'a', turnId: 'turn-a', item: { type: 'userMessage', clientId: 'kept' } } });
  release(); await tick(); assert.equal(store.snapshot('a').entries.length, 0);
  store.add('a', draft('kept')); assert.equal(store.snapshot('a').entries.length, 0);
});

test('parallel tools hold staged input until the response boundary and all observed tools have completed', async () => {
  let count = 0;
  const store = new PendingSteers({ send: async () => { count++; }, changed() {} });
  store.add('a', draft());
  for (const id of ['one', 'two']) store.ingest({ method: 'item/started', params: { threadId: 'a', turnId: 'turn-a', item: { id, type: 'commandExecution' } } });
  boundary(store); assert.equal(count, 0);
  store.ingest({ method: 'item/completed', params: { threadId: 'a', turnId: 'turn-a', item: { id: 'one', type: 'commandExecution' } } });
  assert.equal(count, 0);
  store.ingest({ method: 'item/completed', params: { threadId: 'a', turnId: 'turn-a', item: { id: 'two', type: 'commandExecution' } } });
  await tick(); assert.equal(count, 1);
});

test('turn completion preserves unsent drafts and never carries them into the next turn', async () => {
  let count = 0;
  const store = new PendingSteers({ send: async () => { count++; }, changed() {} });
  store.add('a', draft());
  store.ingest({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'turn-a', status: 'completed', items: [] } } });
  boundary(store, 'a', 'turn-b'); await tick();
  assert.equal(count, 0); assert.equal(store.snapshot('a').entries[0].status, 'failed');
  assert.equal(store.snapshot('a').entries[0].text, 'original');
});

test('rejection is retryable but unknown transport outcomes cannot be recalled or resent', async () => {
  const store = new PendingSteers({ send: async (_, entry) => { throw entry.id === 'rejected' ? Object.assign(new Error('refused'), { rpcRejected: true }) : new Error('timeout'); }, changed() {} });
  store.add('a', draft('rejected')); store.add('a', draft('uncertain')); boundary(store); await tick();
  const [rejected, uncertain] = store.snapshot('a').entries;
  assert.equal(rejected.status, 'failed'); assert.equal(uncertain.status, 'unknown');
  assert.throws(() => store.remove('a', uncertain.id, uncertain.revision), /无法撤回/);
  store.beginEdit('a', rejected.id, rejected.revision);
  store.disconnect(); assert.equal(store.snapshot('a').entries[0].beforeEdit, 'failed');
});
