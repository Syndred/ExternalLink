import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../executor/src/store.mjs';
import { Runtime } from '../executor/src/runtime.mjs';

function fixture(taskPatch = {}) {
  const store = new Store(':memory:');
  const task = { id: 'original', runId: 'original-run', version: 1, profileId: 'JevPlay',
    url: 'https://example.com/submit', status: 'needs_manual', siteStatus: 'not_submitted',
    reason: 'old profile missing contact name', profileRevision: 152, targetId: 'old-page',
    artifactRef: 'old-proof', ...taskPatch };
  store.set('task:original', task); store.set('paused', true);
  const runtime = new Runtime(store, '.');
  Object.defineProperty(runtime, 'cloud', { value: { request: async () => ({ documents: {
    siteProfiles: { JevPlay: { name: 'JevPlay', url: 'https://jevplay.com', contactName: 'syndred' } },
    submissionRecords: {} }, revisions: { siteProfiles: 154 } }) } });
  runtime.lease = async () => {};
  runtime.synchronize = async () => runtime.status();
  return { store, task, runtime };
}

test('unsubmitted recovery preserves original identity, old proof and latest per-task profile', async () => {
  const { store, task, runtime } = fixture();
  await runtime.control('prepareRetry', { taskId: task.id, expectedReason: task.reason });
  const after = store.get('task:original');
  assert.equal(after.id, 'original'); assert.equal(after.runId, 'original-run');
  assert.equal(after.profileRevision, 154); assert.equal(after.profileSnapshot.contactName, 'syndred');
  assert.equal(after.preparationHistory[0].artifactRef, 'old-proof');
  assert.equal(after.preparationHistory[0].profileRevision, 152);
  assert.equal(after.targetId, null); assert.equal(after.status, 'pending');
  assert.equal(store.get('paused'), true); store.close();
});

test('recovery refuses unknown attempts, receipts, stale state and an active executor', async () => {
  for (const patch of [ { attemptBoundary: 'attempt' }, { receipt: { evidence: 'receipt' } },
    { attemptHistory: [{ at: 'previous' }] }, { siteStatus: 'sent_unconfirmed' } ]) {
    const { store, task, runtime } = fixture(patch);
    await assert.rejects(runtime.control('prepareRetry', { taskId: task.id, expectedReason: task.reason }));
    assert.equal(store.pending().length, 0); store.close();
  }
  const { store, task, runtime } = fixture();
  await assert.rejects(runtime.control('prepareRetry', { taskId: task.id, expectedReason: 'stale reason' }));
  store.set('paused', false);
  await assert.rejects(runtime.control('prepareRetry', { taskId: task.id, expectedReason: task.reason }));
  assert.equal(store.pending().length, 0); store.close();
});
test('reopening an unsubmitted task preserves closed-tab history but resets current closure',async()=>{
 const history=[{targetId:'old-page',disposition:'closed',closedAt:'2026-09-28T12:00:00Z'}];
 const {store,task,runtime}=fixture({tabClosedAt:history[0].closedAt,tabHistory:history,tabRetainReason:'old reason'});
 await runtime.control('prepareRetry',{taskId:task.id,expectedReason:task.reason});
 const after=store.get('task:original');
 assert.equal(after.tabClosedAt,null);assert.deepEqual(after.tabHistory,history);
 assert.equal(after.preparationHistory[0].tabClosedAt,history[0].closedAt);
 store.close();
});

test('late snapshot and lease results cannot overwrite new receipts, unknown attempts, products or execution permissions',async()=>{
 for(const stage of ['snapshot','lease'])for(const change of ['attempt','receipt','product','controller','workspace','device','backend','resume','worker']){
  const {store,task,runtime}=fixture();try{store.set('pair',{endpoint:'https://cloud.example',workspaceId:'original',deviceId:'one',storageBackend:'d1'});const snapshot={documents:{siteProfiles:{JevPlay:{name:'JevPlay',fields:{Url:'https://jevplay.com'}}},submissionRecords:{}},revisions:{siteProfiles:154}},mutate=()=>{if(['workspace','device','backend'].includes(change))store.set('pair',{...store.get('pair'),...({workspace:{workspaceId:'changed'},device:{deviceId:'changed'},backend:{storageBackend:'neon'}}[change])});else if(change==='resume')store.set('paused',false);else if(change==='worker')runtime.job=Promise.resolve();else store.set('task:original',{...store.get('task:original'),...({attempt:{attemptBoundary:'new-unknown',status:'submitted_unconfirmed'},receipt:{receipt:{evidence:'New protected receipt'}},product:{profileId:'other'},controller:{controller:'supervisor'}}[change])});};if(stage==='snapshot')runtime.cloud.request=async()=>{mutate();return snapshot;};else{runtime.cloud.request=async()=>snapshot;runtime.lease=async()=>{mutate();};}await assert.rejects(runtime.control('prepareRetry',{taskId:task.id,expectedReason:task.reason}),error=>error.staleTask===true);assert.equal(store.pendingCount(),0);assert.equal(store.get('task:original').preparationHistory,undefined);if(change==='attempt')assert.equal(store.get('task:original').attemptBoundary,'new-unknown');if(change==='receipt')assert.equal(store.get('task:original').receipt.evidence,'New protected receipt');}finally{store.close();}
 }
});

test('the original lease refuses an already stale task before contacting the cloud or granting offline authority',async()=>{
 for(const offline of [false,true]){const {store,task,runtime}=fixture();try{store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one'});if(offline)store.set('offlineMode',{enabled:true});store.set('task:original',{...task,attemptBoundary:'Protected unknown'});let calls=0;runtime.cloud.request=async()=>{calls++;return{version:2};};await assert.rejects(Runtime.prototype.lease.call(runtime,task),error=>error.staleTask===true);assert.equal(calls,0);assert.equal(store.get('task:original').attemptBoundary,'Protected unknown');assert.equal(store.get('task:original').localLease,undefined);}finally{store.close();}}
});
