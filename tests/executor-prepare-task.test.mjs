import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../executor/src/store.mjs';import {Runtime} from '../executor/src/runtime.mjs';
test('shared task preparation refuses existing submission boundaries and runs only while the queue is paused',async()=>{
 const store=new Store(':memory:');store.set('paused',true);store.set('task:t',{id:'t',status:'submitted_unconfirmed',attemptBoundary:'sent'});
 const runtime=new Runtime(store,'.');await assert.rejects(runtime.control('prepareTask',{taskId:'t'}),/先核验/);
 store.set('task:t',{id:'t',status:'needs_manual',url:'https://directory.example/submit'});store.set('paused',false);
 await assert.rejects(runtime.control('prepareTask',{taskId:'t'}),/暂停/);store.close();
});
test('normal engine media bridge refuses unrelated images before any network call',async()=>{
 const store=new Store(':memory:');const runtime=new Runtime(store,'.');
 const response=await runtime.bridge({profileSnapshot:{id:'p',fields:{Url:'https://product.example'}}},{action:'fetchSubmissionMedia',url:'https://other.example/private.png'});
 assert.equal(response.ok,false);assert.match(response.error,/原任务产品/);store.close();
});
test('frozen task release uses original task and frozen product without releasing historical pending work',async()=>{
 const store=new Store(':memory:');store.set('paused',true);store.set('task:old',{id:'old',profileId:'JevPlay',status:'pending'});
 const profile={id:'other',fields:{Name:'Other',Url:'https://other.example'}};
 store.set('task:new',{id:'new',profileId:'other',status:'needs_manual',url:'https://site.example/submit'});
 store.set('acceptance:fixed',{count:1,sha256:'scope',combinations:[{identity:'site.example::other',existingTaskId:'new',profileId:'other',profile,profileRevision:2}]});
 const runtime=new Runtime(store,'.');Object.defineProperty(runtime,'cloud',{value:{request:async()=>({documents:{submissionRecords:{}}})}});
 runtime.lease=async()=>{};let started=0;runtime.tick=()=>started++;
 await runtime.control('runTask',{taskId:'new',acceptanceId:'fixed'});
 assert.equal(store.get('singleTaskId'),'new');assert.deepEqual(store.get('task:new').profileSnapshot,profile);assert.equal(store.get('task:old').status,'pending');assert.equal(started,1);
 store.set('paused',true);store.set('singleTaskId',null);store.set('task:new',{...store.get('task:new'),attemptBoundary:'unknown'});
 await assert.rejects(runtime.control('runTask',{taskId:'new',acceptanceId:'fixed'}),/核验/);store.close();
});
