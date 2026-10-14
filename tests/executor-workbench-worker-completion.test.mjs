import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {freezeBatchConfig} from '../executor/src/workbench-batch-policy.mjs';
import {nextWorkbenchTask,finishWorkbenchTask} from '../executor/src/workbench-features.mjs';
import {runWorkbenchBatch} from '../executor/src/workbench-batch-scheduler.mjs';

function fixture(){
 const store=new Store(':memory:'),profile={id:'photo',fields:{Name:'OldPhoto',Url:'https://photo.example'}},task={id:'original',runId:'run-original',workbenchBatchId:'batch',profileId:'photo',profileRevision:16,profileSnapshot:profile,url:'https://site.example/submit',status:'submitting',siteStatus:'sent_unconfirmed',controller:'ai',controllerId:'executor',attemptBoundary:'keep-original-boundary',targetId:'keep-original-page',browserInstance:'browser'};
 const items=[{taskId:task.id,runId:task.runId,profileId:'photo',url:task.url,destinationKey:'site.example/submit',status:'running'},{taskId:'same-site',runId:'run-same-site',profileId:'graffiti',url:task.url,destinationKey:'site.example/submit',status:'registered'},{taskId:'next-site',runId:'run-next-site',profileId:'photo',url:'https://next.example/submit',destinationKey:'next.example/submit',status:'registered'}],batch={id:'batch',scope:'https://cloud.example|default',...freezeBatchConfig({cfgConcurrency:'2'}),status:'running',count:3,cursor:0,items};
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',false);store.set('activeWorkbenchBatch','batch');store.set('workbenchBatch:batch',batch);store.set('task:original',task);
 for(const item of items.slice(1))store.set('task:'+item.taskId,{id:item.taskId,runId:item.runId,profileId:item.profileId,url:item.url,status:'pending',profileSnapshot:profile});
 const runtime={store,controllerId:'executor',context:null,lease:async()=>{},synchronize:async()=>{},update(t,patch,type,extra){Object.assign(t,patch);store.transition(t,type,extra);}};
 const workerIdentity={id:'original',runId:'run-original',workbenchBatchId:'batch',profileId:'photo',profileRevision:16,profileSnapshot:structuredClone(profile),scope:'https://cloud.example|default',controllerId:'executor',configSha256:batch.configSha256,scopeSha256:batch.scopeSha256};
 return{store,runtime,task,batch,workerIdentity};
}

for(const marker of ['activeTaskId','workbenchTaskJobs'])test(`dispatch respects ${marker} when the worker has an owned boundary`,async()=>{
 const f=fixture();if(marker==='activeTaskId')f.runtime.activeTaskId='original';else f.runtime.workbenchTaskJobs=new Map([['original',Promise.resolve()]]);
 try{const next=await nextWorkbenchTask(f.runtime,{single:false});assert.equal(next.id,'next-site');const batch=f.store.get('workbenchBatch:batch');assert.equal(batch.items[0].status,'running');assert.equal(batch.items[0].result,undefined);assert.equal(batch.cursor,0);assert.equal(f.store.get('task:original').status,'submitting');assert.equal(f.store.get('task:same-site').status,'pending');}
 finally{f.store.close();}
});

test('an ended matching worker parks its unknown boundary and completes the item with a timestamp',()=>{
 const f=fixture();try{assert.equal(finishWorkbenchTask(f.runtime,'original'),false);assert.equal(f.store.get('task:original').status,'submitting');assert.equal(finishWorkbenchTask(f.runtime,'original',{workerCompleted:true,workerIdentity:f.workerIdentity}),true);const task=f.store.get('task:original'),item=f.store.get('workbenchBatch:batch').items[0];assert.equal(task.status,'submitted_unconfirmed');assert.equal(task.siteStatus,'sent_unconfirmed');assert.equal(task.attentionType,'unknown_receipt');assert.equal(task.attemptBoundary,'keep-original-boundary');assert.equal(task.targetId,'keep-original-page');assert.equal(task.controller,'executor');assert.equal(item.status,'complete');assert.equal(item.result,'sent_unconfirmed');assert.ok(item.completedAt);assert.equal(task.receipt,undefined);}
 finally{f.store.close();}
});

for(const mode of ['paused','connection-hold','changed-workspace','changed-run','changed-product','changed-controller','changed-batch-config'])test(`worker completion preserves ${mode} recovery ownership and status`,()=>{
 const f=fixture();try{
  if(mode==='paused'){f.store.set('paused',true);f.store.set('workbenchBatch:batch',{...f.batch,status:'paused',pauseReasonCode:'user_pause'});}
  if(mode==='connection-hold')f.store.set('connectionExecutionHold',{reason:'switching'});
  if(mode==='changed-workspace')f.store.set('pair',{endpoint:'https://different.example',workspaceId:'default'});
  if(mode==='changed-run')f.task.runId='new-run';
  if(mode==='changed-product')f.task.profileSnapshot={id:'photo',fields:{Name:'New product'}};
  if(mode==='changed-controller')f.task.controller='supervisor';
  if(mode==='changed-batch-config')f.store.set('workbenchBatch:batch',{...f.batch,configSha256:'different'});
  f.store.set('task:original',f.task);const before=f.store.get('task:original');assert.equal(finishWorkbenchTask(f.runtime,'original',{workerCompleted:true,workerIdentity:f.workerIdentity}),false);assert.deepEqual(f.store.get('task:original'),before);assert.equal(f.store.get('workbenchBatch:batch').items[0].status,'running');
 }finally{f.store.close();}
});

test('worker completion records an existing verified receipt without replacing terminal evidence',()=>{
 const f=fixture();try{f.task.status='finished';f.task.controller='executor';f.task.receipt={evidence:'Real retained receipt'};f.task.cloudVerified=true;f.store.set('task:original',f.task);const before=f.store.get('task:original');assert.equal(finishWorkbenchTask(f.runtime,'original',{workerCompleted:true,workerIdentity:f.workerIdentity}),true);assert.deepEqual(f.store.get('task:original'),before);assert.equal(f.store.get('workbenchBatch:batch').items[0].result,'received');}
 finally{f.store.close();}
});

test('the real runner records a boundary left submitting only after its worker promise returns',async()=>{
 const f=fixture();let release,started;const entered=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>release=resolve);
 f.runtime.context={};f.runtime.work=async({taskId})=>{if(taskId==='original'){started();await hold;}else f.runtime.update(f.store.get('task:'+taskId),{status:'finished',controller:'executor',receipt:{evidence:'Other-site receipt'},cloudVerified:true},'fixture_receipt');};
 // The original job first begins before recording its boundary.
 f.task.status='pending';f.task.siteStatus='not_submitted';f.task.controller='executor';delete f.task.attemptBoundary;f.store.set('task:original',f.task);f.batch.items[0].status='registered';f.batch.config.concurrency=1;f.batch.configSha256=freezeBatchConfig({cfgConcurrency:'1'}).configSha256;f.store.set('workbenchBatch:batch',f.batch);
 try{const running=runWorkbenchBatch(f.runtime);await entered;f.runtime.update(f.store.get('task:original'),{status:'submitting',controller:'ai',attemptBoundary:'keep-original-boundary'},'fixture_owned_boundary');assert.equal(f.store.get('workbenchBatch:batch').items[0].status,'running');assert.equal(f.runtime.activeTaskIds.has('original'),true);release();await running;const task=f.store.get('task:original'),batch=f.store.get('workbenchBatch:batch');assert.equal(task.status,'submitted_unconfirmed');assert.equal(task.attemptBoundary,'keep-original-boundary');assert.ok(batch.items[0].completedAt);assert.equal(batch.items[0].result,'sent_unconfirmed');assert.equal(f.store.get('task:same-site').status,'pending');assert.equal(f.store.get('task:next-site').receipt.evidence,'Other-site receipt');}
 finally{release?.();f.store.close();}
});

test('single-task tick can finish a legacy task without a saved profile snapshot',async()=>{
 const f=fixture();f.runtime.hydrated=true;f.task.status='pending';f.task.controller='executor';delete f.task.profileSnapshot;delete f.task.attemptBoundary;f.store.set('task:original',f.task);f.store.set('singleTaskId','original');
 f.runtime.work=async()=>f.runtime.update(f.store.get('task:original'),{status:'needs_manual',reason:'Original legacy blocker'},'fixture_legacy_blocker');
 try{assert.doesNotThrow(()=>Runtime.prototype.tick.call(f.runtime));await f.runtime.job;assert.equal(f.store.get('task:original').status,'needs_manual');assert.equal(f.store.get('workbenchBatch:batch').items[0].status,'complete');assert.equal(f.store.get('singleTaskId'),null);}
 finally{f.store.close();}
});
