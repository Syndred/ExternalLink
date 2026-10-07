import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime,findUnambiguousOfflineRun,ownedTaskTargetIds,liveOwnedTaskTargetIds,classifyPauseFailure} from '../executor/src/runtime.mjs';
import {Store} from '../executor/src/store.mjs';
import {createHash} from 'node:crypto';

test('a prior unknown task excludes another submit path on the same host',async()=>{
 const store=new Store(':memory:');
 const snapshot={revisions:{siteProfiles:154},documents:{siteProfiles:{JevPlay:{fields:{Url:'https://jevplay.com'}}},sheetTableData:{entries:[{link:'https://same.example/new-submit'},{link:'https://fresh.example/submit'}]},siteAnnotations:{},submissionRecords:{}}};
 const runtime={store,cloud:{request:async route=>route==='snapshot'?snapshot:{tasks:[{destinationKey:'same.example/old-submit',url:'https://same.example/old-submit',profileId:'JevPlay',status:'submitted_unconfirmed'}]}}};
 const r=await Runtime.prototype.preview.call(runtime,{profileId:'JevPlay'});
 assert.deepEqual(Array.from(r.preview.tasks,t=>t.url),['https://fresh.example/submit']);store.close();
});

test('lost batch response is reconciled by its durable identity without a second POST',async()=>{
 const store=new Store(':memory:');
 const run={id:'stable-run',profileId:'JevPlay',profileRevision:154,tasks:[{id:'stable-task',url:'https://fresh.example/submit',destinationKey:'fresh.example/submit'}]};
 store.set('libraryPlan',{id:'plan',status:'active',profileId:'JevPlay',cursor:0,candidates:run.tasks,batches:[],runtimeExclusions:[],pendingBatch:{run,nextCursor:1,missing:[]}});
 let posts=0,saved=false;const task={...run.tasks[0],runId:run.id,profileId:'JevPlay',status:'pending'};
 const runtime={store,cloud:{request:async(route,body)=>{if(body){posts++;saved=true;throw new Error('reply lost after storage');}return{runs:saved?[{...run,tasks:[task.id]}]:[],tasks:saved?[task]:[]};}}};
 await Runtime.prototype.queueLibraryBatch.call(runtime);
 assert.equal(posts,1);assert.equal(store.get('libraryPlan').cursor,1);assert.equal(store.get('task:stable-task').status,'pending');
 await Runtime.prototype.queueLibraryBatch.call(runtime);assert.equal(posts,1);assert.equal(store.get('libraryPlan').status,'complete');store.close();
});

test('restart uses an already registered pending batch and never posts it again',async()=>{
 const store=new Store(':memory:'),run={id:'saved',tasks:[{id:'task',url:'https://fresh.example',destinationKey:'fresh.example'}]};
 store.set('libraryPlan',{id:'plan',status:'active',profileId:'JevPlay',cursor:0,candidates:run.tasks,batches:[],runtimeExclusions:[],pendingBatch:{run,nextCursor:1,missing:[]}});
 const task={...run.tasks[0],runId:'saved',profileId:'JevPlay'};let posts=0;
 await Runtime.prototype.queueLibraryBatch.call({store,cloud:{request:async(route,body)=>{if(body)posts++;return{runs:[run],tasks:[task]};}}});
 assert.equal(posts,0);assert.equal(store.get('libraryPlan').cursor,1);assert.equal(store.get('libraryPlan').pendingBatch,null);store.close();
});

test('cloud failure pauses continuous execution rather than starting another site',async()=>{
 const store=new Store(':memory:');store.set('pair',{});store.set('paused',false);store.set('libraryPlan',{status:'active'});store.set('task:pending',{status:'pending'});
 const runtime={store,hydrated:true,work:async()=>{throw Object.assign(new Error('cloud offline'),{cloudNetwork:true});}};
 Runtime.prototype.tick.call(runtime);await runtime.job;
 assert.equal(store.get('paused'),true);assert.match(runtime.cloudError,/cloud offline/);store.close();
});
test('stale CDP page references are classified as browser failures, separate from Neon cloud failures',async()=>{
 assert.deepEqual(classifyPauseFailure(new Error('browserContext.newCDPSession: page: no object with guid page@expired')),
  {attentionType:'browser_connection',resumeEligible:false});
 assert.deepEqual(classifyPauseFailure(Object.assign(new Error('Neon request failed'),{status:402,cloudFailure:true,cloudQuota:true})),
  {attentionType:'cloud_quota',resumeEligible:false});
 assert.deepEqual(classifyPauseFailure(Object.assign(new Error('cloud offline'),{cloudNetwork:true,cloudFailure:true,status:502})),
  {attentionType:'cloud_connection',resumeEligible:true});
 const store=new Store(':memory:');store.set('pair',{});store.set('paused',false);store.set('libraryPlan',{status:'active'});
 const runtime={store,hydrated:true,work:async()=>{throw new Error('browserContext.newCDPSession: page: no object with guid page@expired');}};
 Runtime.prototype.tick.call(runtime);await runtime.job;
 assert.equal(store.get('paused'),true);assert.equal(store.get('libraryPlan').globalPause.attentionType,'browser_connection');
 assert.equal(store.pending().length,0);store.close();
});
test('an exhausted cloud quota preserves outbox and stops timer retries and next-site execution',async()=>{
 const store=new Store(':memory:');store.set('pair',{});store.set('paused',false);store.set('libraryPlan',{status:'active'});
 let calls=0;const runtime={store,hydrated:true,work:async()=>{throw Object.assign(new Error('Neon quota'),{status:500,cloudQuota:true});},synchronize:async()=>{calls++;}};
 Runtime.prototype.tick.call(runtime);await runtime.job;
 const gate=store.get('libraryPlan').globalPause;
 assert.equal(gate.resumeEligible,false);assert.equal(gate.attentionType,'cloud_quota');
 store.transition({id:'task'},'unsynced');
 Runtime.prototype.tick.call(runtime);assert.equal(calls,0);assert.equal(store.pending().length,1);store.close();
});
test('offline resume labels the quota pause as historical while the queue is actively running',()=>{
 const store=new Store(':memory:');store.set('paused',false);store.set('offlineMode',{enabled:true});store.set('libraryPlan',{id:'plan',status:'active',initialPending:[],candidates:[],batches:[],exclusions:[],runtimeExclusions:[],globalPause:{reason:'Neon quota exceeded'}});
 const result=Runtime.prototype.status.call({store,job:Promise.resolve(),cloudError:'Neon quota exceeded',activeTaskId:null,host:null});
 assert.equal(result.paused,false);assert.equal(result.libraryPlan.globalPause.active,false);assert.equal(result.libraryPlan.globalPause.historical,true);assert.equal(result.cloudError,'');store.close();
});

test('prior-task finalization clears the active task guard even when cleanup throws',async()=>{
 const task={id:'closed-site-task'};const runtime={activeTaskId:null,finalizeContinuousTask:async()=>{throw new Error('cleanup failed after page close');}};
 await assert.rejects(Runtime.prototype.finalizePriorContinuousTask.call(runtime,task),/cleanup failed after page close/);
 assert.equal(runtime.activeTaskId,null);
});

test('continuous plan gets its next durable batch after the prior batch only has gates',async()=>{
 const store=new Store(':memory:');store.set('pair',{});store.set('paused',false);store.set('libraryPlan',{status:'active',cursor:0,candidates:[{url:'https://next.example'}]});store.set('task:captcha',{status:'needs_manual',attentionType:'human_verification'});
 let calls=0;const runtime={store,hydrated:true,work:async()=>{calls++;}};
 Runtime.prototype.tick.call(runtime);await runtime.job;
 assert.equal(calls,1);assert.equal(store.get('paused'),false);store.close();
});

test('one site gate releases its slot and the next site runs without resume',async()=>{
 const store=new Store(':memory:');store.set('pair',{});store.set('paused',false);
 store.set('task:a',{status:'pending'});store.set('task:b',{status:'pending'});
 const visited=[];const runtime={store,hydrated:true,work:async()=>{const [id]=['a','b'].filter(id=>store.get('task:'+id).status==='pending');visited.push(id);store.set('task:'+id,{status:'needs_manual',attentionType:'human_verification'});}};
 Runtime.prototype.tick.call(runtime);await runtime.job;Runtime.prototype.tick.call(runtime);await runtime.job;
 assert.deepEqual(visited,['a','b']);assert.equal(store.get('paused'),false);store.close();
});

test('a network pause probes recovery while a deliberate user pause stays paused',async()=>{
 for(const enabled of [true,false]){
  const store=new Store(':memory:');store.set('pair',{});store.set('paused',true);store.set('libraryPlan',{status:'active',globalPause:{resumeEligible:enabled,nextProbeAt:0}});
  let probes=0;const runtime={store,hydrated:true,recoverContinuousConnection:async()=>{probes++;}};
  Runtime.prototype.tick.call(runtime);await runtime.job;assert.equal(probes,enabled?1:0);store.close();
 }
});

test('resumption recovers a pre-submit interruption but preserves an in-flight submission boundary',async()=>{
 const store=new Store(':memory:');store.set('paused',true);
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('run:original-run',{id:'original-run'});store.set('executionPaused',{scope:'https://cloud.example|default',kind:'run',id:'original-run'});
 store.set('task:opening',{id:'opening',runId:'original-run',version:1,status:'opening'});
 store.set('task:sent',{id:'sent',runId:'original-run',version:1,status:'submitting',attemptBoundary:'original-boundary'});
 store.set('task:unrelated',{id:'unrelated',runId:'other-run',version:1,status:'opening'});
 const runtime={store,synchronize:async()=>{for(const e of store.pending())store.ack(e.id);},tick(){},status:()=>({})};
 await Runtime.prototype.control.call(runtime,'resume',{});
 assert.equal(store.get('task:opening').status,'pending');assert.equal(store.get('task:sent').status,'submitted_unconfirmed');
 assert.equal(store.get('task:sent').attemptBoundary,'original-boundary');assert.equal(store.get('task:unrelated').status,'opening');assert.equal(store.get('manualResumeRunId'),'original-run');store.close();
});

test('offline batches use the frozen profile, isolate existing host boundaries, and survive restart without reposting',async()=>{
 const {mkdtempSync}=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const file=path.join(mkdtempSync(path.join(os.tmpdir(),'el-offline-')),'state.db');let store=new Store(file);
 const candidates=[{url:'https://known.example/submit',destinationKey:'known.example/submit'},{url:'https://fresh.example/submit',destinationKey:'fresh.example/submit'}];
 const profile={id:'JevPlay',fields:{Url:'https://jevplay.com'}};
 store.set('offlineMode',{enabled:true,candidateSnapshotAt:'2026-09-28T12:47:49.250Z'});store.set('preview',{at:1790599669250,profileId:'JevPlay',profileRevision:154,profile,total:2915,tasks:candidates});
 store.set('libraryPlan',{id:'fc7a2ae1-d2cf-4684-90cf-170ce81ca012',status:'active',profileId:'JevPlay',profileRevision:154,cursor:0,candidates,batchSize:2,batches:[],runtimeExclusions:[],scopeHash:'frozen'});
 store.set('task:old',{id:'old',profileId:'JevPlay',url:'https://known.example/old',status:'submitted_unconfirmed',attemptBoundary:'unknown'});
 let requests=0;await Runtime.prototype.queueLibraryBatch.call({store,cloud:{request:async()=>{requests++;throw new Error('cloud touched');}}});
 assert.equal(requests,0);assert.equal(store.get('libraryPlan').cursor,2);assert.equal(store.get('libraryPlan').runtimeExclusions.length,1);
 const batch=store.values('run:').find(r=>r.offlineSnapshotAt);assert.equal(batch.tasks.length,1);const task=batch.tasks[0];
 assert.equal(task.runId,batch.id);
 store.transition({...task,status:'submitting',attemptBoundary:'offline-attempt'},'attempt_boundary');const eventIds=store.pending().map(e=>e.id);store.close();
 store=new Store(file);const recovered=new Runtime(store,os.tmpdir());
 assert.equal(recovered.hydrated,true);assert.equal(store.get(`task:${task.id}`).status,'submitted_unconfirmed');
 assert.ok(eventIds.every(id=>store.pending().some(e=>e.id===id)));assert.equal(store.pending().length,eventIds.length+1);assert.equal(store.get('libraryPlan').batches.length,1);
 await Runtime.prototype.queueLibraryBatch.call({store,cloud:{request:async()=>{requests++;throw new Error('cloud touched after restart');}}});
 assert.equal(requests,0);assert.equal(store.values('run:').filter(r=>r.offlineSnapshotAt).length,1);store.close();
});

test('a lost runId is recovered only from one matching offline run before any submission boundary',()=>{
 const store=new Store(':memory:');const task={id:'offline-task',profileId:'JevPlay',libraryPlanId:'plan',status:'pending'};
 const run={id:'offline-run',profileId:'JevPlay',libraryPlanId:'plan',offlineSnapshotAt:'2026-09-28T12:47:49.250Z',tasks:[{id:task.id}]};store.set('run:'+run.id,run);
 assert.equal(findUnambiguousOfflineRun(store,task).id,run.id);
 const ambiguous={get:()=>null,values:()=>[run,{...run,id:'second'}]};assert.equal(findUnambiguousOfflineRun(ambiguous,task),null);
 assert.equal(findUnambiguousOfflineRun(store,{...task,attemptBoundary:'unknown'}),null);
 assert.equal(findUnambiguousOfflineRun(store,{...task,receipt:{}}),null);store.close();
});

test('task tab backpressure counts only unique targets owned by this plan and browser',()=>{
 const store=new Store(':memory:');store.set('task:a',{id:'a',libraryPlanId:'plan',browserInstance:'host',targetId:'same',authTargetId:'auth-a'});
 store.set('task:b',{id:'b',libraryPlanId:'plan',browserInstance:'host',targetId:'same',authPages:[{targetId:'auth-b'}]});
 store.set('task:c',{id:'c',libraryPlanId:'other',browserInstance:'host',targetId:'other'});
 store.set('task:d',{id:'d',libraryPlanId:'plan',browserInstance:'other-host',targetId:'other-host'});
 store.set('task:e',{id:'e',libraryPlanId:'plan',browserInstance:'host',targetId:'closed',tabClosedAt:'now'});
 assert.deepEqual([...ownedTaskTargetIds(store,'plan','host')].sort(),['auth-a','auth-b','same']);store.close();
});
test('live page backpressure drops stale target IDs and counts task-owned OAuth popups by opener',async()=>{
 const store=new Store(':memory:');store.set('task:live',{id:'live',libraryPlanId:'plan',browserInstance:'host',targetId:'task-page',status:'pending'});
 store.set('task:stale',{id:'stale',libraryPlanId:'plan',browserInstance:'host',targetId:'expired-page',status:'needs_manual'});
 const pages=[{isClosed:()=>false},{isClosed:()=>false},{isClosed:()=>false}];const ids=[{targetId:'task-page'},{targetId:'oauth-popup',openerId:'task-page'},{targetId:'unrelated-popup',openerId:'personal-page'}];
 const runtime={store,context:{pages:()=>pages,newCDPSession:async page=>({send:async()=>({targetInfo:ids[pages.indexOf(page)]}),detach:async()=>{}})}};
 assert.deepEqual([...await liveOwnedTaskTargetIds(runtime,'plan','host')].sort(),['oauth-popup','task-page']);store.close();
});

test('offline resume is explicitly durable and preserves the pre-existing outbox identities',async()=>{
 const store=new Store(':memory:');const profile={id:'JevPlay',name:'JevPlay',url:'https://jevplay.com',fields:{Name:'JevPlay',Url:'https://jevplay.com'}};
 const event=store.transition({id:'old',runId:'r',profileId:'JevPlay',destinationKey:'old.example',version:1,status:'pending'},'old_event');
 const candidates=Array(2603).fill({url:'https://x.example',destinationKey:'x.example'}),initialPending=Array(21).fill('x');
 store.set('paused',true);store.set('preview',{at:1790599669250,profileId:'JevPlay',profileRevision:154,profile,total:2915,tasks:candidates});
 store.set('libraryPlan',{id:'fc7a2ae1-d2cf-4684-90cf-170ce81ca012',status:'active',profileId:'JevPlay',profileRevision:154,candidates,initialPending,cursor:100,scopeHash:createHash('sha256').update(JSON.stringify({pending:initialPending,candidates})).digest('hex'),globalPause:{reason:'Neon quota exceeded',attentionType:'cloud_quota',resumeEligible:false}});
 const runtime={store,job:null,cloudError:'',hydrated:false,controllerId:'local',tick(){},status:()=>({ok:true})};
 await Runtime.prototype.resumeOffline.call(runtime,{});assert.equal(store.get('paused'),false);assert.equal(store.get('offlineMode').enabled,true);assert.equal(store.get('libraryPlan').offlineSnapshotAt,'2026-09-28T12:47:49.250Z');
 assert.equal(store.get('offlineMode').submissionRecordsRevision,150);assert.deepEqual(store.pending().map(e=>e.id),[event.id]);
 assert.equal(store.get('libraryPlan').globalPause.reason,'Neon quota exceeded');assert.equal(store.get('libraryPlan').offlineResumeValidation.initialOutboxIdsPresent,true);store.close();
});
test('offline resume reclassifies the saved stale CDP pause without changing its cause or outbox',async()=>{
 const store=new Store(':memory:'),profile={id:'JevPlay',name:'JevPlay',url:'https://jevplay.com',fields:{Name:'JevPlay',Url:'https://jevplay.com'}};
 const candidates=Array(2603).fill({url:'https://x.example/submit',destinationKey:'x.example/submit'}),initialPending=Array(21).fill('pending');
 const scopeHash=createHash('sha256').update(JSON.stringify({pending:initialPending,candidates})).digest('hex');
 store.set('paused',true);store.set('offlineMode',{enabled:true,profileRevision:154,scopeHash,initialOutboxIds:[]});
 store.set('preview',{at:1790599669250,profileId:'JevPlay',profileRevision:154,profile,total:2915,tasks:candidates});
 store.set('libraryPlan',{id:'fc7a2ae1-d2cf-4684-90cf-170ce81ca012',status:'active',profileId:'JevPlay',profileRevision:154,candidates,initialPending,cursor:600,scopeHash,
  globalPause:{at:'2026-09-29T04:01:52.028Z',reason:'browserContext.newCDPSession: page: no object with guid page@expired',attentionType:'cloud_connection',resumeEligible:false}});
 const runtime={store,job:null,cloudError:'',tick(){},status:()=>({ok:true})};
 await Runtime.prototype.resumeOffline.call(runtime,{});
 const plan=store.get('libraryPlan');assert.equal(store.get('paused'),false);assert.equal(plan.cursor,600);
 assert.equal(plan.globalPause.reason,'browserContext.newCDPSession: page: no object with guid page@expired');
 assert.equal(plan.globalPause.attentionType,'browser_connection');assert.equal(plan.globalPause.previousAttentionType,'cloud_connection');
 assert.equal(plan.offlineResumeValidation.reclassifiedAsBrowserFailure,true);assert.equal(store.pending().length,0);store.close();
});

test('offline resume accepts content edits but rejects changed product identity or scope without clearing the pause',async()=>{
 const profile={id:'JevPlay',name:'JevPlay',url:'https://jevplay.com',fields:{Name:'JevPlay',Url:'https://jevplay.com',Title:'Updated copy'}};
 const candidates=Array(2603).fill({url:'https://x.example',destinationKey:'x.example'}),initialPending=[];
 const make=()=>{const store=new Store(':memory:');const scopeHash=createHash('sha256').update(JSON.stringify({pending:initialPending,candidates})).digest('hex');store.set('paused',true);store.set('preview',{at:1790599669250,profileId:'JevPlay',profileRevision:154,profile,total:2915,tasks:candidates});
  store.set('offlineMode',{enabled:true,profileRevision:154,scopeHash,initialOutboxIds:[]});
  store.set('libraryPlan',{id:'fc7a2ae1-d2cf-4684-90cf-170ce81ca012',status:'active',profileId:'JevPlay',profileRevision:154,candidates,initialPending,cursor:0,scopeHash,globalPause:{reason:'identity check',resumeEligible:false}});
  return store;};
 const store=make(),runtime={store,job:null,cloudError:'Neon quota exceeded',tick(){},status:()=>({ok:true})};
 await Runtime.prototype.resumeOffline.call(runtime,{});assert.equal(store.get('paused'),false);assert.equal(store.get('libraryPlan').globalPause.reason,'identity check');store.close();
 for(const change of [{id:'Other'},{name:'Other'},{url:'https://other.example'},{fields:{...profile.fields,Name:'Other'}},{fields:{...profile.fields,Url:'https://other.example'}}]){
  const blocked=make(),candidate={...profile,...change};blocked.set('preview',{...blocked.get('preview'),profile:candidate});
  await assert.rejects(Runtime.prototype.resumeOffline.call({store:blocked,job:null,cloudError:'Neon quota exceeded',tick(){}},{}),/身份、资料修订、冻结范围/);
  assert.equal(blocked.get('paused'),true);assert.equal(blocked.get('libraryPlan').globalPause.reason,'identity check');blocked.close();
 }
 const tampered=make(),changedCandidates=[...tampered.get('libraryPlan').candidates];changedCandidates[0]={...changedCandidates[0],url:'https://changed.example'};tampered.set('libraryPlan',{...tampered.get('libraryPlan'),candidates:changedCandidates});
 await assert.rejects(Runtime.prototype.resumeOffline.call({store:tampered,job:null,cloudError:'Neon quota exceeded',tick(){}},{}),/身份、资料修订、冻结范围/);
 assert.equal(tampered.get('paused'),true);tampered.close();
});

test('offline sync registers a locally durable batch before replaying its events',async()=>{
 const store=new Store(':memory:'),task={id:'offline-task',runId:'offline-run',profileId:'JevPlay',url:'https://fresh.example/submit',destinationKey:'fresh.example/submit',status:'finished',version:1,profileRevision:154};
 store.set('libraryPlan',{id:'plan',status:'active',profileId:'JevPlay',profileRevision:154});
 store.set('offlineMode',{enabled:false,syncStartedAt:new Date().toISOString()});
 store.set('task:'+task.id,task);store.set('run:'+task.runId,{id:task.runId,profileId:'JevPlay',profileRevision:154,libraryPlanId:'plan',offlineSnapshotAt:'2026-09-28T12:47:49.250Z',tasks:[task]});
 let registered=false,posted=0;
 const runtime={store,cloud:{request:async(route,body)=>{
   if(route==='snapshot')return{revisions:{siteProfiles:154},documents:{siteProfiles:{JevPlay:{fields:{Url:'https://jevplay.com'}},},submissionRecords:{}}};
   if(route.startsWith('runs?runId='))return registered?{runs:[{id:task.runId}],tasks:[{id:task.id,url:task.url,destinationKey:task.destinationKey}]}:{runs:[],tasks:[]};
   if(route==='runs'&&body){posted++;registered=true;assert.deepEqual(body.run.tasks.map(t=>t.id),[task.id]);return{run:{...body.run,profile:{id:'JevPlay'}}};}
   throw new Error('unexpected cloud route '+route);
 }}};
 await Runtime.prototype.reconcileOfflineRuns.call(runtime);
 assert.equal(posted,1);assert.ok(store.get('run:'+task.runId).remoteRegisteredAt);assert.equal(store.get('task:'+task.id).status,'finished');store.close();
});
