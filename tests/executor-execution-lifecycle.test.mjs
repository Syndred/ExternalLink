import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {runWorkbenchBatch} from '../executor/src/workbench-batch-scheduler.mjs';
import {nextWorkbenchTask,finishWorkbenchTask} from '../executor/src/workbench-features.mjs';
import {freezeBatchConfig,initializeBatchPolicy,releaseBatchTask,batchActionAllowed} from '../executor/src/workbench-batch-policy.mjs';
import {finalizeUserPause} from '../executor/src/execution-lifecycle.mjs';

const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function until(condition){for(let i=0;i<100;i++){if(condition())return;await new Promise(done=>setTimeout(done,5));}throw Error('fixture condition not reached');}
function fixture(options={}){
 const store=new Store(':memory:'),runtime=new Runtime(store,'isolated-lifecycle'),scope='https://cloud.example|default',items=[];
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});
 for(const profileId of ['p','q'])for(let n=0;n<2;n++){
  const id=profileId+n,item={taskId:id,runId:'run-'+id,profileId,url:'https://site'+n+'.example/form',destinationKey:'site'+n+'.example/form',status:'registered',profile:{id:profileId},profileRevision:2};items.push(item);
  store.set('task:'+id,{id,runId:item.runId,profileId,url:item.url,destinationKey:item.destinationKey,workbenchBatchId:'b',status:'pending',controller:'executor',controllerId:runtime.controllerId,profileRevision:2});
  store.set('run:'+item.runId,{id:item.runId,profileId,profile:item.profile});
 }
 const frozen=freezeBatchConfig({cfgConcurrency:'2',unattendedPreferences:{enabled:false,hours:8,tasks:1,manualTabs:20}},options);
 store.set('workbenchBatch:b',initializeBatchPolicy({id:'b',scope,status:'running',cursor:0,count:4,items,...frozen}));store.set('activeWorkbenchBatch','b');store.set('paused',false);
 const calls={ticks:0,closed:[]};runtime.tick=()=>{calls.ticks++;};runtime.context={pages:()=>[]};
 runtime.lease=async task=>{task.controllerId=runtime.controllerId;};
 const flush=async()=>{for(const event of store.pending())store.ack(event.id);};runtime.synchronize=flush;
 Object.defineProperty(runtime,'cloud',{value:{flush}});
 runtime.findPage=async task=>({url:()=>task.url,close:async()=>{assert.ok(store.get('task:'+task.id).recoveryCheckpoint);calls.closed.push(task.targetId);}});
 const input=id=>{const task=store.get('task:'+id);return{taskId:id,expectedRunId:task.runId,...(task.targetId?{expectedTargetId:task.targetId}:{})};};
 return{store,runtime,calls,input};
}

test('user pause returns while both original workers drain and resume preserves their original pages, range and claims',async()=>{
 const f=fixture(),holds=new Map(),started=[];let job;
 try{
  f.runtime.work=async({taskId})=>{started.push(taskId);const hold=gate();holds.set(taskId,hold);const task=f.store.get('task:'+taskId);f.runtime.update(task,{status:'filling',targetId:'target-'+taskId,browserInstance:'same-browser'},'fixture_filling');await hold.promise;finalizeUserPause(f.runtime,f.store.get('task:'+taskId));};
  job=runWorkbenchBatch(f.runtime);f.runtime.job=job;await until(()=>started.length===2);
  const originalIds=f.store.get('workbenchBatch:b').items.map(i=>i.taskId),paused=await f.runtime.control('pause',{});
  assert.equal(paused.paused,true);assert.equal(paused.busy,true);assert.equal(holds.size,2);assert.equal(f.store.get('workbenchBatch:b').status,'paused');
  for(const hold of holds.values())hold.resolve();await job;f.runtime.job=null;
  assert.deepEqual(started,['p0','p1']);assert.deepEqual(f.store.get('workbenchBatch:b').pausedTaskIds,['p0','p1']);
  for(const id of started){const task=f.store.get('task:'+id);assert.equal(task.status,'pending');assert.equal(task.pauseContinuation.targetId,'target-'+id);}
  await f.runtime.control('resume',{expectedBatchId:'b'});
  assert.equal(f.store.get('paused'),false);assert.equal(f.store.get('workbenchBatch:b').status,'running');assert.deepEqual(f.store.get('workbenchBatch:b').items.map(i=>i.taskId),originalIds);assert.equal(f.calls.closed.length,0);
  const next=await nextWorkbenchTask(f.runtime,{single:false});assert.equal(next.id,'p0');assert.equal(next.targetId,'target-p0');assert.equal(next.browserInstance,'same-browser');assert.equal(next.pauseContinuation,null);
 }finally{for(const hold of holds.values())hold.resolve();if(job)await job;f.store.close();}
});

test('the last claimed unattended task resumes without new task budget or deadline; new work remains denied',async()=>{
 const f=fixture({unattended:true});try{
  const task=await nextWorkbenchTask(f.runtime,{single:false}),original=f.store.get('workbenchBatch:b').unattendedState,deadline=task.taskDeadlineAt;
  f.runtime.activeTaskIds=new Set([task.id]);f.runtime.update(task,{status:'filling',targetId:'kept-target',browserInstance:'kept-browser'},'fixture_filling');
  await f.runtime.control('pause',{});finalizeUserPause(f.runtime,task);await f.runtime.control('resume',{expectedBatchId:'b'});f.runtime.activeTaskIds.clear();
  const resumed=await nextWorkbenchTask(f.runtime,{single:false});assert.equal(resumed.id,task.id);assert.equal(resumed.taskDeadlineAt,deadline);assert.equal(resumed.targetId,'kept-target');
  const state=f.store.get('workbenchBatch:b').unattendedState;assert.equal(state.taskBudgetUsed,1);assert.equal(state.runDeadlineAt,original.runDeadlineAt);assert.equal(state.modelCallsUsed,original.modelCallsUsed);
  f.runtime.update(resumed,{status:'finished',receipt:{evidence:'fixture receipt'}},'fixture_received');finishWorkbenchTask(f.runtime,resumed.id);
  assert.equal(await nextWorkbenchTask(f.runtime,{single:false}),null);assert.equal(f.store.get('workbenchBatch:b').pauseReasonCode,'task_budget');assert.equal(f.store.get('task:q0').status,'pending');assert.equal(f.store.get('workbenchBatch:b').count,4);
 }finally{f.store.close();}
});

test('expired paused task is parked with original budget while expired run, changed scope and stopped state cannot resume',async()=>{
 const f=fixture({unattended:true});try{
  const task=await nextWorkbenchTask(f.runtime,{single:false});f.runtime.activeTaskIds=new Set([task.id]);await f.runtime.control('pause',{});task.taskDeadlineAt=Date.now()-1;f.runtime.update(task,{status:'filling',taskDeadlineAt:task.taskDeadlineAt},'fixture_expired');finalizeUserPause(f.runtime,task);f.runtime.activeTaskIds.clear();await f.runtime.control('resume',{});
  assert.equal(await nextWorkbenchTask(f.runtime,{single:false}),null);assert.equal(f.store.get('task:'+task.id).status,'needs_manual');assert.equal(f.store.get('workbenchBatch:b').unattendedState.taskBudgetUsed,1);
 }finally{f.store.close();}
 for(const mode of ['run_expired','scope','identity','stopped']){const f=fixture({unattended:true});try{
  await f.runtime.control('pause',{});const batch=f.store.get('workbenchBatch:b');
  if(mode==='run_expired'){batch.unattendedState.runDeadlineAt=Date.now()-1;f.store.set('workbenchBatch:b',batch);}
  if(mode==='scope')f.store.set('pair',{endpoint:'https://different.example',workspaceId:'default'});
  if(mode==='stopped')f.store.set('executionStopped',{status:'stopped'});
  await assert.rejects(f.runtime.control('resume',{expectedBatchId:mode==='identity'?'other':'b'}));assert.equal(f.store.get('paused'),true);assert.equal(f.store.get('workbenchBatch:b').unattendedState.taskBudgetUsed,0);
 }finally{f.store.close();}}
});

test('skipping the second concurrent worker cancels only it and advances its destination without pausing the first',async()=>{
 const f=fixture(),holds=new Map(),started=[];let job,skipping;
 try{
  f.runtime.work=async({taskId})=>{started.push(taskId);const hold=gate();holds.set(taskId,hold);f.runtime.update(f.store.get('task:'+taskId),{status:'filling'},'fixture_filling');await hold.promise;if(batchActionAllowed(f.runtime,f.store.get('task:'+taskId)))f.runtime.update(f.store.get('task:'+taskId),{status:'finished',cloudVerified:true,receipt:{evidence:'fixture receipt'}},'fixture_receipt');};
  job=runWorkbenchBatch(f.runtime);f.runtime.job=job;await until(()=>started.length===2);skipping=f.runtime.control('manualSkip',f.input('p1'));await until(()=>!!f.store.get('manualSkipPending:p1'));
  assert.equal(batchActionAllowed(f.runtime,f.store.get('task:p1')),false);assert.equal(batchActionAllowed(f.runtime,f.store.get('task:p0')),true);assert.equal(f.store.get('paused'),false);
  holds.get('p1').resolve();const result=await skipping;assert.equal(result.skipped,true);assert.equal(result.isolated,true);assert.equal(f.store.get('task:p1').attemptBoundary,undefined);assert.equal(f.store.get('paused'),false);
  // The scheduler returns when its only live worker is held; a tick may dispatch
  // after the skip's independent proof. Both paths keep the exact same range.
  if(!started.includes('q1')){holds.get('p0').resolve();await until(()=>started.includes('q1'));}
  assert.ok(started.includes('q1'));for(const hold of holds.values())hold.resolve();await until(()=>started.includes('q0'));for(const hold of holds.values())hold.resolve();await job;
  assert.equal(f.store.get('workbenchBatch:b').count,4);assert.equal(f.store.get('workbenchBatch:b').items.find(i=>i.taskId==='p1').manualSkipped,true);
 }finally{for(const hold of holds.values())hold.resolve();if(skipping)await skipping;if(job)await job;f.store.close();}
});

test('a failed skip keeps its destination and last batch pointer reserved; retry reuses one durable request',async()=>{
 const f=fixture();try{
  const batch=f.store.get('workbenchBatch:b');batch.items=batch.items.slice(0,1);batch.count=1;f.store.set('workbenchBatch:b',batch);
  const originalSync=f.runtime.synchronize;f.runtime.synchronize=async()=>{throw Error('proof unavailable');};
  const failed=await f.runtime.control('manualSkip',f.input('p0'));assert.equal(failed.skipped,true);assert.match(failed.syncError,/proof/);const request=f.store.get('manualSkipPending:p0');
  f.runtime.synchronize=originalSync;assert.equal(await nextWorkbenchTask(f.runtime,{single:false}),null);assert.equal(f.store.get('activeWorkbenchBatch'),'b');assert.equal(f.store.get('workbenchBatch:b').status,'running');
  const retried=await f.runtime.control('manualSkip',f.input('p0'));assert.equal(retried.syncError,'');assert.equal(f.store.get('manualSkipPending:p0'),null);assert.equal(f.store.get('task:p0').manualDisposition.requestId,request.id);assert.equal(f.store.logs({scope:batch.scope}).entries.filter(e=>e.type==='manual_skip').length,1);
  await nextWorkbenchTask(f.runtime,{single:false});assert.equal(f.store.get('workbenchBatch:b').status,'complete');assert.equal(f.store.get('activeWorkbenchBatch'),null);
 }finally{f.store.close();}
});

test('selected skip preserves unknown receipt boundaries and manual targets while cleaning only its own automatic page',async()=>{
 for(const mode of ['automatic','last','manual','unknown','received','lease_error']){const f=fixture();try{
  const task=f.store.get('task:p0');task.targetId='original-target';task.status='needs_manual';
  if(mode==='last')f.store.set('task:q0',{...f.store.get('task:q0'),status:'finished',receipt:{evidence:'Previously received sibling'}});if(mode==='manual')task.pageOwnership='manual';if(mode==='unknown'){task.attemptBoundary='original-attempt';task.status='submitted_unconfirmed';}if(mode==='received'){task.receipt={evidence:'original-receipt'};task.status='finished';}f.store.set('task:p0',task);
  if(mode==='lease_error')f.runtime.lease=async()=>{throw Error('lease denied');};
  const result=await f.runtime.control('manualSkip',f.input('p0'));
  assert.equal(result.skipped,mode!=='lease_error');assert.equal(f.store.get('paused'),false);assert.equal(f.store.get('task:p0').attemptBoundary,task.attemptBoundary);assert.deepEqual(f.store.get('task:p0').receipt,task.receipt);assert.deepEqual(f.calls.closed,mode==='last'?['original-target']:[]);if(mode==='automatic')assert.equal(f.store.get('task:p0').originalGroupAdvance.status,'awaiting_next');
 }finally{f.store.close();}}
});

test('unattended stop parks every actual in-flight original worker and retains pending combinations and pages',async()=>{
 const f=fixture({unattended:true});try{
  f.runtime.activeTaskIds=new Set(['p0','p1']);for(const id of ['p0','p1'])f.runtime.update(f.store.get('task:'+id),{status:'filling',targetId:'target-'+id},'fixture_filling');
  const before=JSON.stringify(f.store.get('workbenchBatch:b').unattendedState),result=await f.runtime.control('stop',{});
  assert.equal(result.stopped,true);assert.equal(f.store.get('workbenchBatch:b').status,'stopped');assert.equal(f.store.get('workbenchBatch:b').count,4);for(const id of ['p0','p1'])assert.equal(f.store.get('task:'+id).status,'needs_manual');assert.equal(f.store.get('task:q0').status,'pending');assert.equal(f.store.get('task:q1').status,'pending');assert.deepEqual(f.calls.closed,[]);assert.equal(f.store.get('workbenchBatch:b').unattendedState.taskBudgetUsed,JSON.parse(before).taskBudgetUsed);await assert.rejects(f.runtime.control('resume',{}),/停止/);
 }finally{f.store.close();}
});

test('repeated pause retains the same explicitly selected run and never enables unrelated historical work',async()=>{
 const f=fixture();try{
  f.store.set('activeWorkbenchBatch',null);f.store.set('manualResumeRunId','run-p0');f.runtime.activeTaskId='p0';await f.runtime.control('pause',{});f.runtime.activeTaskId=null;await f.runtime.control('pause',{});
  assert.equal(f.store.get('executionPaused').kind,'run');assert.equal(f.store.get('executionPaused').id,'run-p0');await f.runtime.control('resume',{});assert.equal(f.store.get('manualResumeRunId'),'run-p0');assert.equal(f.store.get('paused'),false);
 }finally{f.store.close();}
});

test('fixed batch resume restores only its frozen batch and refuses changed execution identity',async()=>{
 for(const changed of [false,true]){const f=fixture();try{
  f.store.set('activeWorkbenchBatch',null);f.store.set('paused',true);f.store.set('acceptance:fixed',{id:'fixed',sha256:'frozen',count:2});f.store.set('acceptanceExecution:fixed',{scopeSha256:changed?'changed':'frozen'});f.store.set('acceptanceBatch',{id:'fixed',status:'paused',scopeSha256:'frozen',count:2,cursor:1,attempts:{original:'retained'}});
  if(changed)await assert.rejects(f.runtime.control('resume',{expectedBatchId:'fixed'}),/校验失败/);else{await f.runtime.control('resume',{expectedBatchId:'fixed'});assert.equal(f.store.get('acceptanceBatch').status,'running');assert.equal(f.store.get('acceptanceBatch').cursor,1);assert.deepEqual(f.store.get('acceptanceBatch').attempts,{original:'retained'});assert.equal(f.store.get('paused'),false);}
 }finally{f.store.close();}}
});
