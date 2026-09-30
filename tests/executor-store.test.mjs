import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../executor/src/store.mjs';
import { Cloud } from '../executor/src/cloud.mjs';

test('SQLite recovery retains all 3101 unsynced events and never retries a submission boundary', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'el-outbox-')), 'state.db');
  let store = new Store(file);
  for (let i = 0; i < 3101; i++) store.transition({ id: 'task', version: 1, status: 'submitting', attemptBoundary: '2026-09-27T00:00:00Z', counter: i }, 'boundary');
  store.close(); store = new Store(file); store.recover();
  assert.equal(store.get('task:task').status, 'submitted_unconfirmed');
  assert.equal(store.pending().length, 3102);
  assert.equal(store.pending()[0].state.counter, 0);
  store.close();
});

test('recovery preserves an already verified unknown result and its operator reason', () => {
  const store = new Store(':memory:');
  store.transition({ id: 'unknown', version: 1, status: 'submitted_unconfirmed', siteStatus: 'sent_unconfirmed',
    attemptBoundary: '2026-09-27T00:00:00Z', reason: 'Site showed a validation error; no receipt', attentionType: 'site_error' }, 'operator_note');
  store.recover();
  store.recover();
  assert.equal(store.get('task:unknown').reason, 'Site showed a validation error; no receipt');
  assert.equal(store.get('task:unknown').attentionType, 'site_error');
  assert.equal(store.pending().length, 1);
  store.close();
});
test('status summary preserves every event identity without loading full historical states',()=>{
 const store=new Store(':memory:');const event=store.transition({id:'t',version:1,status:'pending',history:'x'.repeat(100000)},'queued');
 assert.deepEqual(store.pendingSummary().map(r=>({...r})),[{id:event.id,taskId:'t'}]);assert.equal(store.pending()[0].state.history.length,100000);store.close();
});

test('recovery keeps an explicit site rejection without retrying or making it unknown', () => {
  const store = new Store(':memory:');
  store.transition({ id: 'rejected', version: 1, status: 'needs_manual', siteStatus: 'rejected',
    attemptBoundary: '2026-09-27T00:00:00Z', reason: 'Site displayed URL validation error' }, 'operator_note');
  store.recover();
  assert.equal(store.get('task:rejected').status, 'needs_manual');
  assert.equal(store.get('task:rejected').siteStatus, 'rejected');
  assert.equal(store.pending().length, 1);
  store.close();
});
test('outbox is removed only after matching readback; network loss and mismatched read retain it', async () => {
  const store = new Store(':memory:');
  const event = store.transition({ id: 'x', status: 'finished', version: 1 }, 'receipt');
  const cloud = new Cloud({});
  cloud.request = async () => { throw new Error('offline'); };
  await assert.rejects(cloud.flush(store), /offline/); assert.equal(store.pending().length, 1);
  cloud.request = async route => route === 'event' ? { ok: true } : { event: { ...event, type: 'wrong' } };
  await assert.rejects(cloud.flush(store), /不一致/); assert.equal(store.pending().length, 1);
  cloud.request = async route => route === 'event' ? { ok: true } : { event };
  await cloud.flush(store); assert.equal(store.pending().length, 0); store.close();
});
