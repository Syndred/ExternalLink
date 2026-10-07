import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {runOriginalAgentPreparation} from '../executor/src/original-agent-flow.mjs';
import {navigationScope,assertNavigationScope,pendingNavigationMarker,originalNavigationSnapshotError,nativeNavigationSnapshotError,waitForOriginalNavigation,navigationBudgetContinuation,originalReadinessSignature} from '../executor/src/original-navigation-rejudge.mjs';
import {freezeBatchConfig,initializeBatchPolicy,releaseBatchTask} from '../executor/src/workbench-batch-policy.mjs';
import {nextWorkbenchTask} from '../executor/src/workbench-features.mjs';
import {resumeExecution} from '../executor/src/execution-lifecycle.mjs';
import {freezeAcceptance} from '../executor/src/acceptance-freeze.mjs';

const original=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
function fixture(file=':memory:'){
 const store=new Store(file),runtime=new Runtime(store,'isolated-navigation'),profile={id:'p',fields:{Name:'Original',Url:'https://product.example'}},scope='https://cloud.example|default';
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',false);
 const task={id:'t',runId:'r',profileId:'p',profileRevision:2,profileSnapshot:profile,url:'https://directory.example/submit',targetId:'original-target',browserInstance:'original-browser',controller:'executor',controllerId:runtime.controllerId,version:1,status:'filling',workbenchBatchId:'b',unattendedBatchId:'b',unattendedClaimed:true,taskDeadlineAt:Date.now()+120000};
 const item={taskId:'t',runId:'r',profileId:'p',profile,profileRevision:2,url:task.url,status:'running'};
 const batch=initializeBatchPolicy({id:'b',scope,count:1,cursor:0,status:'running',items:[item],...freezeBatchConfig({}, {unattended:true,unattendedMaxTasks:1})});batch.unattendedState.taskBudgetUsed=1;batch.unattendedState.modelCallsUsed=3;
 store.set('workbenchBatch:b',batch);store.set('activeWorkbenchBatch','b');store.set('run:r',{id:'r',profileId:'p',profile,tasks:[task.id]});store.set('task:t',task);
 task.aiTakeover={id:'takeover',calls:3,actions:1,history:[{type:'click',selector:'#continue'}],originalVisual:{loops:1,history:[],pendingRejudge:{id:'nav',status:'waiting_navigation',navigationScope:navigationScope(runtime,task)}}};store.set('task:t',task);
 let probes=0,time=0;const flush=async()=>{for(const event of store.pending())store.ack(event.id);};Object.defineProperty(runtime,'cloud',{value:{flush}});
 runtime.synchronize=flush;runtime.lease=async()=>{};runtime.tick=()=>{};
 const stable={tabStatus:'complete',snapshot:{url:task.url,title:'Form',text:'Stable original form',fields:[{id:'name'}],forms:[],buttons:[]},detection:{operable:true,formFieldCount:1,platform:'directory'}};
 const check=async()=>{if(store.get('paused')!==false)throw Object.assign(Error('user paused'),{batchPaused:true});};
 const wait=options=>waitForOriginalNavigation(runtime,{task,marker:pendingNavigationMarker(task),assertCurrent:check,probe:async()=>{probes++;return structuredClone(stable);},wait:async ms=>{time+=ms;},now:()=>time,...options});
 return{store,runtime,task,batch,stable,wait,count:()=>({probes,time}),flush};
}

test('navigation error matching retains original source semantics and rejects protected native errors',()=>{
 const start=original.indexOf('function isNavigationSnapshotError('),end=original.indexOf('\nfunction nextEntryRunId(',start),sandbox=vm.createContext({});vm.runInContext(original.slice(start,end),sandbox);
 for(const message of ['snapshot unavailable','Receiving end does not exist','Could not establish connection','No tab with id 12','frame was removed','Extension context invalidated','model unavailable','cloud quota','ordinary failure'])assert.equal(originalNavigationSnapshotError(Error(message)),sandbox.isNavigationSnapshotError(Error(message)));
 for(const flags of [{originalTaskSyncFailure:true},{batchPaused:true},{unattendedBudget:true},{staleTask:true},{status:401},{status:403},{status:409}])assert.equal(nativeNavigationSnapshotError(Object.assign(Error('snapshot unavailable'),flags)),false);
 assert.equal(nativeNavigationSnapshotError(Object.assign(Error('document changed'),{staleTask:true,originalDocumentChanged:true})),true);
});

test('readiness signature matches the original condensed text and form shape rather than volatile middle text',()=>{
 const start=original.indexOf('    const signature = JSON.stringify({',original.indexOf('async function waitForTabContentReady(')),end=original.indexOf('\n    if (contentReady',start);
 const f=fixture();try{for(const observed of [f.stable,{...f.stable,snapshot:{...f.stable.snapshot,text:'  text \n spaces  ',meta:{fieldCount:3,buttonCount:4}},detection:{}},{snapshot:{},detection:{}}]){
  const {snapshot,detection}=observed,text=String(snapshot.text||'').replace(/\s+/g,' ').trim(),sandbox=vm.createContext({snapshot,detection,text,title:String(snapshot.title||'').trim(),tab:{url:snapshot.url||''},initialData:{},self:{ExtLinkBatchControls:globalThis.ExtLinkBatchControls}});
  const signature=vm.runInContext(original.slice(start,end)+'\nsignature',sandbox);assert.equal(originalReadinessSignature(observed),signature);
 }
 const head='a'.repeat(160),tail='z'.repeat(160),a={...f.stable,snapshot:{...f.stable.snapshot,text:head+'volatile 1'+tail}},b={...a,snapshot:{...a.snapshot,text:head+'volatile 2'+tail}};assert.equal(originalReadinessSignature(a),originalReadinessSignature(b));
 }finally{f.store.close();}
});

test('post-action navigation waits on the same task, persists one action and resumes deterministic filling before models',async()=>{
 const f=fixture();try{
  delete f.task.aiTakeover;f.store.set('task:t',f.task);let observations=0,models=0,actions=0;
  const io={assertCurrent:async()=>{},canRelease:current=>current.version===f.task.version,observe:async()=>{if(++observations===2)throw Error('snapshot unavailable');return{url:f.task.url,domHash:'same'};},ready:async()=>false,navigationScope:()=>navigationScope(f.runtime,f.task),model:async kind=>{models++;return kind==='judge'?{status:'incomplete'}:{status:'act',actions:[{type:'click',selector:'#continue'}]};},act:async()=>{actions++;return{ok:true};},settle:async()=>{}};
  const first=await runOriginalAgentPreparation(f.runtime,{task:f.task,io});assert.equal(first.pendingRejudge,true);assert.equal(f.task.controller,'executor');assert.equal(f.task.aiTakeover.calls,2);assert.equal(f.task.aiTakeover.actions,1);
  await f.wait();io.ready=async()=>true;const resumed=await runOriginalAgentPreparation(f.runtime,{task:f.task,io});assert.equal(resumed.ok,true);assert.equal(models,2);assert.equal(actions,1);assert.equal(f.task.aiTakeover.originalVisual.pendingRejudge.status,'completed');assert.equal(f.task.aiTakeover.originalVisual.loops,1);assert.equal(f.task.receipt,undefined);assert.equal(f.task.attemptBoundary,undefined);
 }finally{f.store.close();}
});

test('initial snapshot, model, action, sync and late control failures cannot enter navigation rejudge',async()=>{
 for(const stage of ['initial','model','action','sync','late']){const f=fixture();try{
  delete f.task.aiTakeover;f.store.set('task:t',f.task);let observations=0;
  const io={assertCurrent:async()=>{if(f.store.get('task:t').controller==='supervisor')throw Object.assign(Error('foreign owner'),{staleTask:true});},canRelease:current=>current.controller!=='supervisor',observe:async()=>{if(stage==='initial'||++observations===2)throw Object.assign(Error('snapshot unavailable'),stage==='sync'?{originalTaskSyncFailure:true}:{});return{domHash:'same'};},ready:async()=>false,model:async kind=>{if(stage==='model')throw Error('snapshot unavailable');return kind==='judge'?{status:'incomplete'}:{status:'act',actions:[{type:'click',selector:'#next'}]};},act:async()=>{if(stage==='action')throw Error('snapshot unavailable');if(stage==='late')f.store.set('task:t',{...f.store.get('task:t'),controller:'supervisor',reason:'keep foreign'});return{ok:true};},settle:async()=>{}};
  const result=await runOriginalAgentPreparation(f.runtime,{task:f.task,io});assert.equal(result.pendingRejudge,undefined,stage);assert.equal(pendingNavigationMarker(f.task),undefined,stage);if(stage==='sync')assert.equal(result.originalTaskSyncFailure,true);if(stage==='late')assert.equal(f.store.get('task:t').reason,'keep foreign');
 }finally{f.store.close();}}
});

test('a resumed original invocation gets eight further loops while cumulative model and action usage remains intact',async()=>{
 const f=fixture();try{pendingNavigationMarker(f.task).status='ready';f.store.set('task:t',f.task);let plans=0;
  const io={assertCurrent:async()=>{},canRelease:()=>true,observe:async()=>({url:f.task.url,domHash:'same'}),ready:async()=>false,model:async kind=>{if(kind==='judge')return{status:'incomplete'};plans++;return{status:'act',actions:[{type:'wait',timeout_ms:1}]};},act:async()=>({ok:true}),settle:async()=>{}};
  const result=await runOriginalAgentPreparation(f.runtime,{task:f.task,io});assert.equal(result.needs_manual,true);assert.equal(plans,8);assert.equal(f.task.aiTakeover.originalVisual.loops,9);assert.equal(f.task.aiTakeover.calls,20);assert.equal(f.task.aiTakeover.actions,9);assert.equal(f.task.aiTakeover.history[0].selector,'#continue');assert.equal(pendingNavigationMarker(f.task).status,'finished');assert.equal(f.task.receipt,undefined);
 }finally{f.store.close();}
});

test('readiness requires two matching original ready probes after transient failure or loading, without spending budget',async()=>{
 const f=fixture();try{let i=0;const saved=structuredClone(f.batch.unattendedState);const result=await f.wait({probe:async()=>{i++;if(i===1)throw Error('frame was removed');if(i===2)return{...f.stable,snapshot:{...f.stable.snapshot,title:'Loading'}};return f.stable;}});assert.equal(result.ok,true);assert.equal(i,4);assert.equal(f.count().time,1500);assert.equal(pendingNavigationMarker(f.task).stableChecks,2);assert.deepEqual(f.store.get('workbenchBatch:b').unattendedState,saved);assert.equal(f.task.aiTakeover.calls,3);assert.equal(f.task.aiTakeover.actions,1);assert.equal(f.store.pendingCount(),0);}finally{f.store.close();}
});

test('readiness times out after the original 30 seconds and keeps target, checkpoint and action history',async()=>{
 const f=fixture();try{const result=await f.wait({probe:async()=>({...f.stable,snapshot:{...f.stable.snapshot,title:'Please wait'}})});assert.equal(result.originalReadinessTimeout,true);assert.equal(f.count().time,30000);assert.equal(pendingNavigationMarker(f.task).status,'readiness_timeout');assert.equal(f.task.targetId,'original-target');assert.equal(f.task.aiTakeover.actions,1);assert.equal(f.task.receipt,undefined);}finally{f.store.close();}
});

test('standalone and fixed original groups keep navigation scope stable across mutable execution progress',async()=>{
 for(const mode of ['standalone','fixed']){const f=fixture();try{delete f.task.workbenchBatchId;delete f.task.unattendedBatchId;delete f.task.unattendedClaimed;
  if(mode==='fixed'){f.task.acceptanceId='fixed';const frozen=freezeAcceptance(f.store,{id:'fixed',products:{p:f.task.profileSnapshot},profileRevision:2,sites:[f.task.url],tasks:[f.task],count:1}),identity=frozen.combinations[0].identity;f.store.set('acceptanceBatch',{id:'fixed',scopeSha256:frozen.sha256,count:1,cursor:0,status:'running'});f.store.set('acceptanceExecution:fixed',{scopeSha256:frozen.sha256,items:{[identity]:{taskId:f.task.id,runId:f.task.runId,status:'opening'}}});}
  const scope=navigationScope(f.runtime,f.task);pendingNavigationMarker(f.task).navigationScope=scope;f.store.set('task:t',f.task);
  if(mode==='fixed'){const execution=f.store.get('acceptanceExecution:fixed');Object.values(execution.items)[0].status='filling';f.store.set('acceptanceExecution:fixed',execution);}
  assert.deepEqual(navigationScope(f.runtime,f.task),scope);assert.equal((await f.wait()).ok,true);assert.equal(f.task.aiTakeover.actions,1);assert.equal(f.task.targetId,'original-target');
 }finally{f.store.close();}}
});

test('pause, changed scope, deadline identity, unknown attempt or late product cannot continue after a probe',async()=>{
 for(const change of ['pause','scope','deadline','unknown','profile','owner']){const f=fixture();try{await assert.rejects(()=>f.wait({probe:async()=>{if(change==='pause')f.store.set('paused',true);else if(change==='scope')f.store.set('pair',{endpoint:'https://other.example'});else{const current=f.store.get('task:t');Object.assign(current,change==='deadline'?{taskDeadlineAt:Date.now()+99999}:change==='unknown'?{attemptBoundary:'unknown',status:'submitted_unconfirmed'}:change==='profile'?{profileSnapshot:{id:'other'}}:{controller:'supervisor'});f.store.set('task:t',current);}return f.stable;}}));assert.equal(pendingNavigationMarker(f.store.get('task:t')).status,'waiting_navigation');assert.equal(f.task.aiTakeover.actions,1);}finally{f.store.close();}}
});

test('failed ready-event synchronization remains a sync interruption and resumes only after independent event acknowledgement',async()=>{
 const f=fixture();try{f.runtime.cloud.flush=async()=>{throw Error('snapshot unavailable on cloud write');};await assert.rejects(()=>f.wait(),error=>error.originalTaskSyncFailure===true);assert.equal(pendingNavigationMarker(f.task).status,'ready');assert.equal(f.store.pendingCount(),1);assert.equal(f.task.aiTakeover.calls,3);f.runtime.cloud.flush=f.flush;assert.equal((await f.wait()).ok,true);assert.equal(f.store.pendingCount(),0);assert.equal(f.task.aiTakeover.actions,1);}finally{f.store.close();}
});

test('SQLite restart restores pending navigation and explicit resume continues the claimed task at the original task cap',async()=>{
 const home=mkdtempSync(join(tmpdir(),'el-navigation-restart-')),file=join(home,'outbox.sqlite');let store;
 try{const f=fixture(file);const deadline=f.task.taskDeadlineAt,scope=structuredClone(pendingNavigationMarker(f.task).navigationScope);f.store.close();store=new Store(file);store.set('paused',true);const runtime=new Runtime(store,home);runtime.tick=()=>{};runtime.lease=async()=>{};const flush=async()=>{for(const event of store.pending())store.ack(event.id);};runtime.synchronize=flush;Object.defineProperty(runtime,'cloud',{value:{flush}});
  const task=store.get('task:t'),batch=store.get('workbenchBatch:b');assert.equal(task.status,'pending');assert.equal(batch.items[0].status,'running');assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.deepEqual(pendingNavigationMarker(task).navigationScope,scope);assert.equal(navigationBudgetContinuation(task,batch),true);
  batch.status='paused';store.set('workbenchBatch:b',batch);await resumeExecution(runtime,{expectedBatchId:'b'});const selected=await nextWorkbenchTask(runtime);assert.equal(selected.id,'t');assert.equal(selected.targetId,'original-target');assert.equal(selected.taskDeadlineAt,deadline);assert.equal(store.get('workbenchBatch:b').unattendedState.taskBudgetUsed,1);assert.equal(store.get('workbenchBatch:b').unattendedState.modelCallsUsed,3);
 }finally{store?.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-navigation-restart-'));rmSync(home,{recursive:true,force:true});}
});

test('navigation continuation never renews elapsed deadlines or admits forged and changed task scopes',()=>{
 for(const mode of ['task-deadline','run-deadline','profile','target','scope','forged','unknown']){const f=fixture();try{
  if(mode==='task-deadline'){f.task.taskDeadlineAt=Date.now()-1;pendingNavigationMarker(f.task).navigationScope=navigationScope(f.runtime,f.task);}
  else if(mode==='run-deadline')f.batch.unattendedState.runDeadlineAt=Date.now()-1;
  else if(mode==='profile')f.task.profileSnapshot={id:'other'};
  else if(mode==='target')f.task.targetId='different-target';
  else if(mode==='scope')f.batch.scope='https://other.example|default';
  else if(mode==='forged')pendingNavigationMarker(f.task).navigationScope.identity={};
  else f.task.attemptBoundary='unknown';
  f.store.set('task:t',f.task);f.store.set('workbenchBatch:b',f.batch);
  if(mode==='scope')assert.throws(()=>releaseBatchTask(f.runtime,f.batch,f.task,{}));else assert.equal(releaseBatchTask(f.runtime,f.batch,f.task,{}),false,mode);
  assert.equal(f.store.get('workbenchBatch:b').unattendedState.taskBudgetUsed,1);assert.equal(f.task.targetId,mode==='target'?'different-target':'original-target');
 }finally{f.store.close();}}
});


test('only the live original submission invocation may observe its boundary; persisted unknown navigation cannot authorize a retry',async()=>{
 const f=fixture();try{const marker={id:'visual-navigation',status:'waiting_navigation',submissionPhase:true,navigationScope:navigationScope(f.runtime,f.task)};f.runtime.update(f.task,{attemptBoundary:'live-boundary',aiTakeover:{id:'visual-agent',calls:2,actions:1,originalVisual:{loops:1,pendingRejudge:marker}}},'fixture_visual_navigation');
  assert.throws(()=>assertNavigationScope(f.runtime,f.task,marker),error=>error.staleTask===true);assert.throws(()=>assertNavigationScope(f.runtime,f.task,marker,{liveAttemptBoundary:'foreign'}),error=>error.staleTask===true);assertNavigationScope(f.runtime,f.task,marker,{liveAttemptBoundary:'live-boundary'});let time=0;await waitForOriginalNavigation(f.runtime,{task:f.task,marker,liveAttemptBoundary:'live-boundary',assertCurrent:async()=>{},probe:async()=>f.stable,wait:async ms=>{time+=ms;},now:()=>time});assert.equal(pendingNavigationMarker(f.task).status,'ready');assert.equal(f.task.attemptBoundary,'live-boundary');assert.equal(f.task.aiTakeover.actions,1);assert.equal(f.task.aiTakeover.calls,2);assert.equal(navigationBudgetContinuation(f.task,f.runtime.store.get('workbenchBatch:b')),false);
 }finally{f.store.close();}
});
