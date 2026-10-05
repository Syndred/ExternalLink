import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {startAcceptanceBatch} from '../executor/src/acceptance-batch.mjs';
import {stopTabDisposition} from '../executor/src/manual-controls.mjs';

function fixture(){
 const store=new Store(':memory:'),runtime=new Runtime(store,'unused-test-home');
 const profile={id:'p',name:'Frozen Product',fields:{Name:'Frozen Product',Url:'https://product.example'}},task={id:'original',runId:'run',profileId:'p',url:'https://target.example/submit',status:'needs_manual',controller:'executor',targetId:'target',browserInstance:'original-browser',profileSnapshot:profile,profileRevision:2};
 store.set('paused',true);store.set('pair',{endpoint:'https://cloud.example',workspaceId:'test'});store.set('task:'+task.id,task);store.set('run:run',{id:'run',profile});
 const calls={ticks:0,leases:[],closed:[]};runtime.tick=()=>{calls.ticks++;};runtime.lease=async(t)=>{calls.leases.push(t.id);};
 runtime.findPage=async t=>({url:()=>t.url,close:async()=>{assert.ok(store.get('task:'+t.id).recoveryCheckpoint);assert.equal(store.get('paused'),true);calls.closed.push(t.targetId);}});
 Object.defineProperty(runtime,'cloud',{value:{request:async()=>({documents:{siteProfiles:{p:{...profile,name:'Latest Product',fields:{Name:'Latest Product'}}},submissionRecords:{}},revisions:{siteProfiles:5}})}});
 runtime.synchronize=async()=>{for(const event of store.pending())store.ack(event.id);};
 return{runtime,store,task,profile,calls,input:{taskId:task.id,expectedRunId:task.runId,expectedTargetId:task.targetId}};
}
function fixed(f,status='paused'){
 f.store.set('acceptance:frozen',{id:'frozen',sha256:'unchanged',count:2,combinations:[{identity:'first',existingTaskId:'original'},{identity:'second',existingTaskId:'other'}]});
 f.store.set('acceptanceExecution:frozen',{scopeSha256:'unchanged',items:{first:{taskId:'original'},second:{taskId:'other'}}});
 f.store.set('acceptanceBatch',{id:'frozen',scopeSha256:'unchanged',count:2,cursor:0,attempts:{},status});
}
test('manual skip advances the original frozen range and retains unknown attempts and receipts',async()=>{
 for(const result of [{},{attemptBoundary:'unknown',status:'submitted_unconfirmed',reason:'Original pending result'},{receipt:{evidence:'Real receipt'},status:'finished',siteStatus:'accepted'}]){
  const f=fixture();try{fixed(f);f.store.set('task:original',{...f.task,...result});const before=JSON.stringify(f.store.get('acceptance:frozen'));const skipped=await f.runtime.control('manualSkip',f.input);const task=f.store.get('task:original');assert.equal(f.store.get('acceptanceBatch').cursor,1);assert.equal(f.store.get('acceptanceBatch').count,2);assert.equal(JSON.stringify(f.store.get('acceptance:frozen')),before);assert.deepEqual(task.receipt,result.receipt);assert.equal(task.attemptBoundary,result.attemptBoundary);assert.equal(f.store.get('paused'),true);assert.equal(skipped.skipped,true);assert.equal(task.status,result.status||'skip');assert.equal(f.store.logs({scope:'https://cloud.example|test'}).entries[0].type,'manual_skip');}finally{f.store.close();}
 }
});
test('running skip resumes only the saved original range; failed sync and stale identity stay paused',async()=>{
 const f=fixture();try{fixed(f,'running');f.store.set('paused',false);f.store.set('singleTaskId','original');await assert.rejects(f.runtime.control('manualSkip',{...f.input,expectedRunId:'new-run'}),/批次/);assert.equal(f.store.get('paused'),false);await f.runtime.control('manualSkip',f.input);assert.equal(f.store.get('paused'),false);assert.equal(f.store.get('acceptanceBatch').status,'running');assert.equal(f.store.get('singleTaskId'),null);assert.equal(f.store.get('acceptanceBatch').cursor,1);}finally{f.store.close();}
 const offline=fixture();try{fixed(offline,'running');offline.store.set('paused',false);offline.store.set('singleTaskId','original');offline.runtime.synchronize=async()=>{throw Error('Readback unavailable');};const result=await offline.runtime.control('manualSkip',offline.input);assert.match(result.syncError,/Readback/);assert.equal(offline.store.get('paused'),true);assert.equal(offline.store.pendingCount(),1);assert.equal(offline.store.get('acceptanceBatch').count,2);}finally{offline.store.close();}
 const simple=fixture();try{simple.store.set('paused',false);simple.store.set('singleTaskId','original');await simple.runtime.control('manualSkip',simple.input);assert.equal(simple.store.get('manualResumeRunId'),'run');assert.equal(simple.store.get('paused'),false);}finally{simple.store.close();}
});
test('manual continue keeps frozen profile and original tab, releases one task only after acknowledgement',async()=>{
 const f=fixture();try{await assert.rejects(f.runtime.control('manualSubmit',f.input),/确认/);await assert.rejects(f.runtime.control('manualSubmit',{...f.input,expectedTargetId:'replaced',ordinaryPermissionsAuthorized:true}),/标签页/);const result=await f.runtime.control('manualSubmit',{...f.input,ordinaryPermissionsAuthorized:true});assert.equal(result.taskId,'original');assert.deepEqual(f.store.get('task:original').profileSnapshot,f.profile);assert.equal(f.store.get('task:original').profileRevision,2);assert.equal(f.store.get('task:original').targetId,'target');assert.equal(f.store.get('singleTaskId'),'original');assert.equal(f.store.get('paused'),false);assert.equal(f.store.pendingCount(),0);assert.equal(f.calls.ticks,1);assert.equal(f.store.get('task:original').attemptBoundary,undefined);}finally{f.store.close();}
 const offline=fixture();try{offline.runtime.synchronize=async()=>{throw Error('Readback unavailable');};await assert.rejects(offline.runtime.control('manualSubmit',{...offline.input,ordinaryPermissionsAuthorized:true}),/Readback/);assert.equal(offline.store.get('paused'),true);assert.equal(offline.store.get('singleTaskId'),null);assert.equal(offline.calls.ticks,0);assert.equal(offline.store.pendingCount(),1);}finally{offline.store.close();}
});
test('manual continue rejects archived or already received product, missing run and attempted original task',async()=>{
 for(const mode of ['archived','received','missing_run','attempted','stopped']){const f=fixture();try{
  if(mode==='archived')f.runtime.cloud.request=async()=>({documents:{siteProfiles:{p:{archived:true}},submissionRecords:{}}});
  if(mode==='received')f.runtime.cloud.request=async()=>({documents:{siteProfiles:{p:f.profile},submissionRecords:{'target.example::p':{profileId:'p',status:'success',destinationUrl:'https://target.example/other'}}}});
  if(mode==='missing_run')f.store.db.prepare('DELETE FROM state WHERE id=?').run('run:run');
  if(mode==='attempted')f.store.set('task:original',{...f.task,attemptBoundary:'unknown'});
  if(mode==='stopped')f.store.set('executionStopped',{status:'stopped'});
  await assert.rejects(f.runtime.control('manualSubmit',{...f.input,ordinaryPermissionsAuthorized:true}));assert.equal(f.store.get('paused'),true);assert.equal(f.calls.ticks,0);assert.equal(f.store.pendingCount(),0);
 }finally{f.store.close();}}
});
test('stop closes automatic original tabs with durable checkpoint, preserves manual and unknown targets and disables resume',async()=>{
 const f=fixture();try{fixed(f,'running');f.store.set('paused',false);f.store.set('singleTaskId','original');f.store.set('task:original',{...f.task,status:'pending'});
  const variants=[{id:'unknown',targetId:'unknown-target',attemptBoundary:'unknown',status:'submitted_unconfirmed'},{id:'manual',targetId:'manual-target',status:'needs_manual'},{id:'attached',targetId:'attached-target',status:'pending',pageOwnership:'manual'},{id:'automatic',targetId:'automatic-target',status:'pending'}];
  for(const variant of variants)f.store.set('task:'+variant.id,{...f.task,...variant});f.store.set('task:unrelated',{...f.task,id:'unrelated',runId:'unrelated-run',targetId:'unrelated-target',status:'pending'});
  const result=await f.runtime.control('stop',{});assert.deepEqual(f.calls.closed.sort(),['automatic-target','target']);assert.equal(result.stopped,true);assert.equal(f.store.get('acceptanceBatch').status,'stopped');assert.equal(f.store.get('acceptanceBatch').count,2);assert.equal(f.store.get('paused'),true);assert.equal(f.store.get('singleTaskId'),null);assert.equal(f.store.get('task:unknown').attemptBoundary,'unknown');assert.equal(f.store.get('task:manual').status,'needs_manual');assert.equal(f.store.get('task:unrelated').tabClosedAt,undefined);assert.ok(f.store.get('task:automatic').recoveryCheckpoint);await assert.rejects(f.runtime.control('resume',{}),/停止/);await assert.rejects(f.runtime.control('manualSubmit',{...f.input,ordinaryPermissionsAuthorized:true}),/停止/);
  startAcceptanceBatch(f.runtime,'frozen');assert.equal(f.store.get('executionStopped'),null);assert.equal(f.store.get('paused'),false);assert.equal(f.store.get('acceptanceBatch').count,2);
 }finally{f.store.close();}
});
test('stop survives sync failure and never closes a target shared with an unrelated manual task',async()=>{
 const f=fixture();try{f.store.set('singleTaskId','original');f.store.set('task:original',{...f.task,status:'pending'});f.store.set('task:protected',{...f.task,id:'protected',runId:'different',status:'needs_manual'});f.runtime.synchronize=async()=>{throw Error('Cloud down');};const result=await f.runtime.control('stop',{});assert.equal(result.syncError,'Cloud down');assert.equal(f.store.get('executionStopped').status,'stopped');assert.equal(f.store.get('paused'),true);assert.deepEqual(f.calls.closed,[]);assert.equal(stopTabDisposition({status:'pending',pageOwnership:'manual'}),'preserve_manual');}finally{f.store.close();}
});

test('Product Hunt creation consent requires the original ready task and never follows a replaced page or scope',async()=>{
 for(const mode of ['ordinary','unready','stale_target','scope_changed','readiness_changed','explicit','plain_continue']){const f=fixture();try{
  f.store.set('task:original',{...f.task,url:mode==='ordinary'?f.task.url:'https://www.producthunt.com/posts/new',productHunt:{readyToCreate:mode!=='unready'},productHuntCreationConsent:{targetId:'old-consent'}});
  if(['scope_changed','readiness_changed'].includes(mode))f.runtime.cloud.request=async()=>{if(mode==='scope_changed')f.store.set('pair',{endpoint:'https://other.example',workspaceId:'other'});else f.store.set('task:original',{...f.store.get('task:original'),productHunt:{readyToCreate:false}});return{documents:{siteProfiles:{p:f.profile},submissionRecords:{}},revisions:{siteProfiles:2}};};
  const input={...f.input,ordinaryPermissionsAuthorized:true,confirmProductHuntCreate:mode!=='plain_continue',...(mode==='stale_target'?{expectedTargetId:'different-target'}:{})};
  if(['explicit','plain_continue'].includes(mode)){await f.runtime.control('manualSubmit',input);const saved=f.store.get('task:original');assert.deepEqual(saved.profileSnapshot,f.profile);if(mode==='explicit')assert.deepEqual(Object.fromEntries(['runId','profileId','targetId','profileRevision','browserInstance'].map(k=>[k,saved.productHuntCreationConsent[k]])),{runId:'run',profileId:'p',targetId:'target',profileRevision:2,browserInstance:'original-browser'});else assert.equal(saved.productHuntCreationConsent,null);assert.equal(f.calls.ticks,1);}
  else{await assert.rejects(f.runtime.control('manualSubmit',input));assert.equal(f.calls.ticks,0);assert.equal(f.store.get('paused'),true);assert.equal(f.store.pendingCount(),0);}
 }finally{f.store.close();}}
 const duringSync=fixture();try{duringSync.store.set('task:original',{...duringSync.task,url:'https://www.producthunt.com/posts/new',productHunt:{readyToCreate:true}});duringSync.runtime.synchronize=async()=>{duringSync.store.set('task:original',{...duringSync.store.get('task:original'),targetId:'new-target'});};await assert.rejects(duringSync.runtime.control('manualSubmit',{...duringSync.input,ordinaryPermissionsAuthorized:true,confirmProductHuntCreate:true}),/变化/);assert.equal(duringSync.store.get('paused'),true);assert.equal(duringSync.calls.ticks,0);assert.equal(duringSync.store.get('singleTaskId'),null);}finally{duringSync.store.close();}
});
