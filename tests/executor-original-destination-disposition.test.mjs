import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {queue} from '../executor/src/shared.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {freezeBatchConfig,initializeBatchPolicy} from '../executor/src/workbench-batch-policy.mjs';
import {batchJson,batchScopeRows,batchManifest} from '../core/workbench-batch-recovery.mjs';
import {recoverCloudBatchRecords} from '../executor/src/workbench-batch-recovery.mjs';
import {finishWorkbenchTask} from '../executor/src/workbench-features.mjs';
import {freezeAcceptance} from '../executor/src/acceptance-freeze.mjs';
import {originalDeadEndDisposition,applyOriginalDestinationDisposition} from '../executor/src/original-destination-disposition.mjs';
const digest=value=>createHash('sha256').update(batchJson(value)).digest('hex');

function fixture({offline=true,file=':memory:'}={}){
 const store=new Store(file);store.set('pair',{endpoint:'https://cloud.example',workspaceId:'original'});store.set('paused',false);store.set('offlineMode',{enabled:offline});
 const tasks=Array.from({length:6},(_,n)=>({id:'t'+n,runId:'r'+n,profileId:'p'+n,url:n<3?'https://same.example/submit':'https://other'+n+'.example/submit',status:n===0?'filling':'pending',version:1,controller:'executor',workbenchBatchId:'b',profileRevision:7,profileSnapshot:{id:'p'+n,fields:{Name:'Original '+n,Url:'https://product'+n+'.example'}}}));
 for(const task of tasks){task.destinationKey=queue.normalizeDestinationKey(task.url);store.set('task:'+task.id,task);}
 const batch=initializeBatchPolicy({id:'b',scope:workbenchScope(store.get('pair')),...freezeBatchConfig({}, {unattended:true}),count:tasks.length,cursor:0,status:'running',cloudRecoveryVersion:1,cloudCheckpointRevision:1,items:tasks.map(task=>({identity:task.destinationKey+'::'+task.profileId,taskId:task.id,runId:task.runId,profileId:task.profileId,url:task.url,destinationKey:task.destinationKey,profileRevision:task.profileRevision,profile:task.profileSnapshot,status:task.id==='t0'?'running':'registered'}))});
 batch.configSha256=digest(batch.config);batch.scopeSha256=digest(batchScopeRows(batch));batch.unattendedState.taskBudgetUsed=1;batch.unattendedState.modelCallsUsed=4;batch.unattendedState.manualTodoIds=['t0','t1'];batch.cloudManifest=batchManifest(batch);
 store.set('workbenchBatch:b',batch);store.set('activeWorkbenchBatch','b');
 const remote=new Map(tasks.map(task=>[task.id,structuredClone(task)])),calls=[];
 const runtime={store,controllerId:'original-controller',activeTaskIds:new Set(['t0']),cloud:{async request(route,input){calls.push({route,input});if(route.startsWith('runs?runId='))return{tasks:[structuredClone([...remote.values()].find(task=>task.runId===decodeURIComponent(route.split('=')[1])))]};if(route==='lease'){const task=remote.get(input.taskId);assert.equal(input.version,task.version);task.version++;task.controllerId=input.controllerId;return{version:task.version};}throw Error('Unexpected cloud route '+route);}}};
 return{store,runtime,task:tasks[0],batch,remote,calls};
}
const apply=(f,status='broken',result={blocked:true,reason:'Cannot submit'})=>applyOriginalDestinationDisposition(f.runtime,{task:f.task,result,classification:{status},assertCurrent:async()=>{assert.equal(workbenchScope(f.store.get('pair')),f.batch.scope);}});

test('native dead-end outcomes match original markTaskNeedsManual and markTaskBlocked functions',async()=>{
 const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
 const functions=source.slice(source.indexOf('function cancelRemainingDestinationTasks('),source.indexOf('async function getTabUrlSafe('));
 for(const status of ['deleted','skip','broken','paid'])for(const blocked of [false,true]){
  const task={index:0,url:'https://same.example/submit',status:'filling'},sibling={index:1,status:'pending'},finished={index:2,status:'ok'};
  const sandbox=vm.createContext({self:{ExtLinkQueue:queue,ExtLinkBatchControls:{shouldAutoSkipGate:()=>false,parkedTaskStatus:()=> 'needs_manual'}},state:{config:{}},findGroupForTask:()=>({tasks:[task,sibling,finished]}),autoClassifySite:async()=>({status}),bumpEntryRunId(){},clearManualWaitTimer(){},clearEntryTimeout(){},broadcastTaskUpdate(){},log(){},parkTaskEntry(){}});
  vm.runInContext(functions,sandbox);sandbox.task=task;sandbox.entry={};vm.runInContext(blocked?'markTaskBlocked(null,task,entry,"Original reason")':'markTaskNeedsManual(null,task,entry,"Original reason")',sandbox);await new Promise(resolve=>setImmediate(resolve));
  const disposition=originalDeadEndDisposition(blocked?{blocked:true,reason:'Original reason'}:{needs_manual:true,reason:'Original reason'},status);
  assert.equal(disposition.taskStatus,task.status);assert.equal(disposition.reason,task.skipReason);assert.equal(sibling.status,'skip');assert.equal(sibling.skipReason,'blocked_by_destination:'+status+':Original reason');assert.equal(finished.status,'ok');
 }
 for(const result of [{semanticReview:true},{uncertain:true},{payment_uncertain:true},{matched:true},{humanGate:'payment_uncertain'}])assert.equal(originalDeadEndDisposition(result,'paid'),null);
 assert.equal(originalDeadEndDisposition({blocked:true},'needs_login'),null);
});

test('dead-end cancels only pending products in the frozen destination and retains denominator, budgets and durable checkpoints',async()=>{
 const f=fixture();try{
  const original=structuredClone(f.batch);await apply(f);const batch=f.store.get('workbenchBatch:b');
  assert.equal(f.task.status,'err');assert.equal(f.task.siteStatus,'not_submitted');assert.deepEqual(f.task.originalDestinationDisposition.cancelledTaskIds,['t1','t2']);
  for(const id of ['t1','t2']){const task=f.store.get('task:'+id);assert.equal(task.status,'skip');assert.equal(task.reason,'blocked_by_destination:broken:Cannot submit');assert.equal(task.receipt,undefined);assert.equal(task.attemptBoundary,undefined);assert.equal(task.hasActivity,true);assert.equal(task.workbenchBatchCheckpoint.items.find(i=>i.taskId===id).result,'skip');}
  assert.equal(f.store.get('task:t3').status,'pending');assert.equal(batch.count,6);assert.equal(batch.scopeSha256,original.scopeSha256);assert.deepEqual(batch.items.map(i=>i.taskId),original.items.map(i=>i.taskId));assert.equal(batch.cursor,3);assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.equal(batch.unattendedState.modelCallsUsed,4);assert.equal(batch.unattendedState.consecutiveFailures,1);assert.deepEqual(batch.unattendedState.manualTodoIds,[]);assert.equal(f.store.pendingCount(),3);
  finishWorkbenchTask(f.runtime,'t0');assert.equal(f.store.get('workbenchBatch:b').unattendedState.consecutiveFailures,1);
  const events=f.store.pending();const recovered=recoverCloudBatchRecords(f.runtime,[{workbenchBatchManifest:original.cloudManifest}],events.map(event=>event.state));assert.equal(recovered.length,0);
  const fresh=new Store(':memory:');try{fresh.set('pair',f.store.get('pair'));const restored=recoverCloudBatchRecords({store:fresh},[{workbenchBatchManifest:original.cloudManifest}],events.map(event=>event.state));assert.equal(restored[0].count,6);assert.equal(restored[0].cursor,3);assert.equal(restored[0].status,'paused');assert.equal(restored[0].items[1].result,'skip');assert.equal(restored[0].unattendedState.consecutiveFailures,1);}finally{fresh.close();}
 }finally{f.store.close();}
});

test('duplicate dead-end observation keeps first cancellation history and does not count failures again',async()=>{
 const f=fixture();try{await apply(f);const disposition=structuredClone(f.task.originalDestinationDisposition),count=f.store.pendingCount();await apply(f);assert.deepEqual(f.task.originalDestinationDisposition,disposition);assert.equal(f.store.pendingCount(),count);assert.equal(f.store.get('workbenchBatch:b').unattendedState.consecutiveFailures,1);}finally{f.store.close();}
});

test('an explicit fresh retry is counted even when the previous dead-end history remains on the original task',async()=>{
 const f=fixture();try{await apply(f);const batch=f.store.get('workbenchBatch:b');batch.items[0].status='running';batch.items[1].status='registered';batch.cursor=0;f.store.set('workbenchBatch:b',batch);f.task.status='filling';f.store.set('task:t0',f.task);f.store.set('task:t1',{...f.store.get('task:t1'),status:'pending'});await apply(f);assert.equal(f.store.get('workbenchBatch:b').unattendedState.consecutiveFailures,2);assert.equal(f.store.get('workbenchBatch:b').count,6);assert.deepEqual(f.task.originalDestinationDisposition.cancelledTaskIds,['t1','t2']);assert.equal(f.store.get('task:t1').status,'skip');}finally{f.store.close();}
});

test('unknown attempts, receipts, active tasks and foreign controllers are never cancelled',async()=>{
 for(const patch of [{attemptBoundary:'unknown',status:'pending'},{receipt:{evidence:'received'},status:'pending'},{status:'needs_manual'},{controller:'supervisor'},{controller:'ai'}]){const f=fixture();try{const before={...f.store.get('task:t1'),...patch};f.store.set('task:t1',before);f.runtime.activeTaskIds.add('t2');await apply(f);assert.deepEqual(f.store.get('task:t1'),before);assert.equal(f.store.get('task:t2').status,'pending');assert.equal(f.store.pendingCount(),1);}finally{f.store.close();}}
 const f=fixture();try{f.task.attemptBoundary='original-boundary';f.task.status='submitted_unconfirmed';f.task.siteStatus='sent_unconfirmed';f.store.set('task:t0',f.task);await apply(f,'paid',{blocked:true,reason:'Requires payment'});assert.equal(f.task.status,'submitted_unconfirmed');assert.equal(f.task.attemptBoundary,'original-boundary');assert.equal(f.task.siteStatus,'sent_unconfirmed');assert.equal(f.store.get('task:t1').status,'skip');assert.equal(f.task.receipt,undefined);}finally{f.store.close();}
});

test('cloud lease and independent task readback precede cancellation; unrelated group completion remains saved',async()=>{
 const f=fixture({offline:false});try{const request=f.runtime.cloud.request;f.runtime.cloud.request=async(route,input)=>{const result=await request(route,input);if(route==='lease'&&input.taskId==='t1'){const batch=f.store.get('workbenchBatch:b');batch.items[3].status='complete';batch.items[3].result='received';batch.unattendedState.modelCallsUsed=8;f.store.set('workbenchBatch:b',batch);}return result;};await apply(f);assert.equal(f.store.get('task:t1').version,2);assert.equal(f.store.get('task:t1').controllerId,f.runtime.controllerId);assert.equal(f.store.get('workbenchBatch:b').items[3].result,'received');assert.equal(f.store.get('workbenchBatch:b').unattendedState.modelCallsUsed,8);assert.deepEqual(f.calls.map(c=>c.route),['runs?runId=r1','lease','runs?runId=r2','lease']);}finally{f.store.close();}
});

test('cloud unknown or missing sibling and local changes during lease preserve every terminal state',async()=>{
 for(const change of ['remote-unknown','remote-version','remote-missing','local-unknown','foreign-scope','range']){const f=fixture({offline:false});try{const request=f.runtime.cloud.request;f.runtime.cloud.request=async(route,input)=>{if(route==='runs?runId=r1'){if(change==='remote-unknown')f.remote.get('t1').attemptBoundary='late-unknown';if(change==='remote-version')f.remote.get('t1').version++;if(change==='remote-missing')return{tasks:[]};}const result=await request(route,input);if(route==='lease'&&input.taskId==='t1'){if(change==='local-unknown')f.store.set('task:t1',{...f.store.get('task:t1'),attemptBoundary:'late-unknown',status:'submitted_unconfirmed'});if(change==='foreign-scope')f.store.set('pair',{endpoint:'https://new.example',workspaceId:'foreign'});if(change==='range'){const b=f.store.get('workbenchBatch:b');b.items[1].profile.fields.Name='Changed frozen profile';f.store.set('workbenchBatch:b',b);}}return result;};await assert.rejects(()=>apply(f));assert.equal(f.store.get('task:t0').status,'filling');assert.equal(f.store.get('task:t2').status,'pending');assert.equal(f.store.pendingCount(),0);if(change==='local-unknown')assert.equal(f.store.get('task:t1').attemptBoundary,'late-unknown');else assert.equal(f.store.get('task:t1').status,'pending');}finally{f.store.close();}}
});

test('a reused sibling in another batch or altered immutable identity stops cancellation',async()=>{
 for(const patch of [{workbenchBatchId:'different-batch'},{profileId:'foreign-product'},{runId:'new-run'},{url:'https://same.example/different-path'}]){const f=fixture();try{f.store.set('task:t1',{...f.store.get('task:t1'),...patch});await assert.rejects(()=>apply(f),/原批次/);assert.equal(f.store.get('task:t0').status,'filling');assert.equal(f.store.get('task:t2').status,'pending');assert.equal(f.store.pendingCount(),0);}finally{f.store.close();}}
});

test('atomic cancellation rolls back tasks, outbox, audit, checkpoint and global pause and survives reopening',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'original-destination-')),file=join(directory,'state.sqlite'),f=fixture({file});try{
  const before=structuredClone(f.batch),b=f.store.get('workbenchBatch:b');b.unattendedState.consecutiveFailures=b.unattendedState.maxConsecutiveFailures-1;f.store.set('workbenchBatch:b',b);const log=f.store.appendLog.bind(f.store);f.store.appendLog=entry=>{if(entry.taskId==='t2')throw Error('Original disk failure');return log(entry);};await assert.rejects(()=>apply(f),/disk failure/);f.store.appendLog=log;
  assert.equal(f.store.pendingCount(),0);assert.equal(f.store.logs({scope:before.scope}).entries.length,0);assert.equal(f.store.get('paused'),false);assert.equal(f.store.get('workbenchBatch:b').cloudCheckpointRevision,1);assert.equal(f.store.get('task:t1').status,'pending');assert.equal(f.task.status,'filling');
  await apply(f);assert.equal(f.store.get('paused'),true);assert.equal(f.store.get('workbenchBatch:b').status,'paused');f.store.close();const reopened=new Store(file);try{assert.equal(reopened.get('task:t1').status,'skip');assert.equal(reopened.get('workbenchBatch:b').count,6);assert.equal(reopened.pendingCount(),3);assert.equal(reopened.logs({scope:before.scope}).entries.length,3);assert.equal(reopened.get('paused'),true);}finally{reopened.close();}
 }finally{try{f.store.close();}catch{}const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep));rmSync(absolute,{recursive:true,force:true});}
});

test('fixed acceptance cancellation keeps its frozen denominator and current cursor and rejects tampered scope',async()=>{
 const f=fixture();try{
  const products=Object.fromEntries([0,1,2].map(n=>['p'+n,f.store.get('task:t'+n).profileSnapshot]));const frozen=freezeAcceptance(f.store,{id:'fixed',products,profileRevision:7,sites:[f.task.url],count:3}),items={};
  frozen.combinations.forEach((combo,n)=>{items[combo.identity]={taskId:'t'+n,runId:'r'+n};const task=f.store.get('task:t'+n);delete task.workbenchBatchId;task.acceptanceId='fixed';f.store.set('task:t'+n,task);});Object.assign(f.task,f.store.get('task:t0'));delete f.task.workbenchBatchId;
  f.store.set('acceptanceExecution:fixed',{scopeSha256:frozen.sha256,items});f.store.set('acceptanceBatch',{id:'fixed',scopeSha256:frozen.sha256,count:3,cursor:0,attempts:{}});
  await apply(f);const batch=f.store.get('acceptanceBatch');assert.equal(batch.cursor,0);assert.equal(batch.count,3);assert.equal(batch.attempts[frozen.combinations[1].identity].status,'skip');assert.equal(f.store.get('acceptance:fixed').sha256,frozen.sha256);
  const changed=f.store.get('acceptance:fixed');changed.combinations[1].profileId='changed';f.store.set('acceptance:fixed',changed);await assert.rejects(()=>apply(f),/固定范围/);
 }finally{f.store.close();}
});

test('standalone run cancellation excludes other destinations and rejects a sibling reassigned to another run',async()=>{
 for(const moved of [false,true]){const f=fixture();try{for(const id of ['t0','t1','t2','t3']){const task=f.store.get('task:'+id);delete task.workbenchBatchId;task.runId='original-run';task.profileId='p0';f.store.set('task:'+id,task);}f.task=f.store.get('task:t0');f.store.set('run:original-run',{id:'original-run',profileId:'p0',profile:f.task.profileSnapshot,tasks:['t0','t1','t2','t3']});if(moved)f.store.set('task:t1',{...f.store.get('task:t1'),runId:'other-run'});if(moved){await assert.rejects(()=>apply(f),/运行组/);assert.equal(f.store.pendingCount(),0);}else{await apply(f);assert.equal(f.store.get('task:t1').status,'skip');assert.equal(f.store.get('task:t3').status,'pending');}}finally{f.store.close();}}
});
