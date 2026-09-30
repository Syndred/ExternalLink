import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeTaskTab,archiveDeferredTabs,recoveryStage } from '../executor/src/tab-cleanup.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
function setup() {
  const bytes = Buffer.from('receipt screenshot');
  const task = { id:'task', targetId:'product-target', browserInstance:'host', destinationKey:'site', profileId:'product',
    status:'finished', siteStatus:'accepted', cloudVerified:true, screenshot:'file', artifactRef:'ref',
    artifactSha256:createHash('sha256').update(bytes).digest('hex'), actualSubmission:{fields:[{value:'JevPlay'}]},
    profileRevision:154, receipt:{evidence:'Submission received',url:'https://site/submit'} };
  const calls = []; let remote = structuredClone(task);
  const runtime = { job:null, store:{get:()=>true,pending:()=>[]}, cloud:{async request(route) {
    calls.push(route);
    if (route==='runs') return {tasks:[structuredClone(remote)]};
    if (route==='snapshot') return {revisions:{submissionRecords:9},documents:{submissionRecords:{'site::product':{taskId:task.id,evidence:task.receipt.evidence,actualSubmission:task.actualSubmission}}}};
    return {dataUrl:'data:image/png;base64,'+bytes.toString('base64')};
  }}, async synchronize(){calls.push('sync');remote=structuredClone(task);},
    async lease(){},update(t,p,type){calls.push(type);Object.assign(t,p);},status(){return task;},
    async findPage(){return {url:()=>task.receipt.url,async close(){calls.push('CLOSE');}}} };
  return {runtime,task,calls,input:{expectedTargetId:task.targetId}};
}
test('close is after registration sync and independent readback; closure is then persisted', async()=>{
  const s=setup(); await closeTaskTab(s.runtime,s.task,s.input);
  const close=s.calls.indexOf('CLOSE'), registered=s.calls.indexOf('tab_closure_registered');
  assert.ok(close>registered);
  assert.deepEqual(s.calls.slice(registered+1,close),['sync','runs']);
  assert.equal(s.task.tabHistory[0].disposition,'closed');
  assert.ok(s.task.tabClosedAt);
});

test('continuous cleanup is restricted to the currently owned completed task',async()=>{
 const s=setup();s.runtime.job=Promise.resolve();s.runtime.store.get=key=>key==='paused'?false:key==='libraryPlan'?{id:'plan',status:'active'}:null;
 s.runtime.activeTaskId=s.task.id;s.task.libraryPlanId='plan';
 await closeTaskTab(s.runtime,s.task,s.input,{continuous:true});assert.ok(s.calls.includes('CLOSE'));
 const other=setup();other.runtime.job=Promise.resolve();other.runtime.activeTaskId='other';other.task.libraryPlanId='plan';other.runtime.store.get=s.runtime.store.get;
 await assert.rejects(closeTaskTab(other.runtime,other.task,other.input,{continuous:true}));assert.ok(!other.calls.includes('CLOSE'));
});

test('continuous finalization reloads independently verified state instead of stale pre-sync fields',async()=>{
 const s=setup();s.runtime.job=Promise.resolve();s.runtime.activeTaskId=s.task.id;s.task.libraryPlanId='plan';
 s.runtime.store.get=key=>key==='task:'+s.task.id?s.task:key==='libraryPlan'?{id:'plan',status:'active'}:false;
 await Runtime.prototype.finalizeContinuousTask.call(s.runtime,{...s.task,artifactRef:'',cloudVerified:false});
 assert.ok(s.calls.includes('CLOSE'));assert.equal(s.task.cloudVerified,true);assert.equal(s.task.tabHistory[0].disposition,'closed');
});

test('only overflowed new unsubmitted challenge pages can be archived with explicit recovery limitations',async()=>{
 const s=setup();Object.assign(s.task,{libraryPlanId:'plan',status:'needs_manual',siteStatus:'not_submitted',receipt:null,cloudVerified:false,attentionType:'human_verification',reason:'CAPTCHA'});
 s.runtime.job=Promise.resolve();s.runtime.activeTaskId=s.task.id;
 s.runtime.store.get=key=>key==='libraryPlan'?{id:'plan',status:'active',retainedTabLimit:12}:false;
 s.runtime.store.values=()=>Array.from({length:13},(_,i)=>({...s.task,id:'captcha-'+i}));
 const request=s.runtime.cloud.request;s.runtime.cloud.request=async route=>route==='snapshot'?{revisions:{submissionRecords:9},documents:{submissionRecords:{}}}:request(route);
 s.runtime.findPage=async()=>({url:()=> 'https://site/submit',close:async()=>s.calls.push('CLOSE')});
 await closeTaskTab(s.runtime,s.task,{...s.input,closeBlocked:true},{continuous:true,archiveDeferred:true});
 assert.ok(s.calls.includes('CLOSE'));assert.equal(s.task.deferredRecovery.requiresFreshCaptcha,true);
 const ordinary=setup();Object.assign(ordinary.task,{status:'needs_manual',siteStatus:'not_submitted',attentionType:'human_verification',receipt:null});
 await assert.rejects(closeTaskTab(ordinary.runtime,ordinary.task,ordinary.input,{archiveDeferred:true}));assert.ok(!ordinary.calls.includes('CLOSE'));
});
test('unknown result or wrong target cannot close a page',async()=>{
  for(const patch of [{siteStatus:'sent_unconfirmed'},{receipt:null},{targetId:'different'},{cloudVerified:false}]) {
    const s=setup();Object.assign(s.task,patch);await assert.rejects(closeTaskTab(s.runtime,s.task,s.input));assert.ok(!s.calls.includes('CLOSE'));
  }
});
test('failure to independently read registration leaves page open',async()=>{
  const s=setup();let reads=0,request=s.runtime.cloud.request;
  s.runtime.cloud.request=async route=> route==='runs' && ++reads===2 ? {tasks:[]} : request(route);
  await assert.rejects(closeTaskTab(s.runtime,s.task,s.input),/登记/);
  assert.ok(!s.calls.includes('CLOSE'));
});
test('lost original target is recorded without closing a replacement page',async()=>{
  const s=setup();s.runtime.findPage=async()=>{throw new Error('原浏览器宿主已变化');};
  await closeTaskTab(s.runtime,s.task,s.input);assert.ok(!s.calls.includes('CLOSE'));
  assert.equal(s.task.tabHistory[0].disposition,'original_target_unavailable');
});
test('JSON serialization omits absent profile revisions without preventing readback',async()=>{
  const s=setup();delete s.task.profileRevision;
  const request=s.runtime.cloud.request;
  s.runtime.cloud.request=async route=>JSON.parse(JSON.stringify(await request(route)));
  await closeTaskTab(s.runtime,s.task,s.input);assert.ok(s.calls.includes('CLOSE'));
});
test('a resolved unpaid blocker closes only after the same independent registration readback',async()=>{
 const s=setup();Object.assign(s.task,{status:'needs_manual',siteStatus:'not_submitted',receipt:null,cloudVerified:false,attentionType:'payment',reason:'Required listing fee, no free plan'});
 const request=s.runtime.cloud.request;s.runtime.cloud.request=async route=>route==='snapshot'?{revisions:{submissionRecords:9},documents:{submissionRecords:{}}}:request(route);
 s.runtime.findPage=async()=>({url:()=> 'https://site/submit',close:async()=>s.calls.push('CLOSE')});
 await closeTaskTab(s.runtime,s.task,{...s.input,closeBlocked:true});assert.equal(s.task.siteStatus,'not_submitted');assert.equal(s.task.tabHistory[0].disposition,'closed');assert.match(s.task.tabHistory[0].reason,/Required listing fee/);assert.ok(s.calls.indexOf('CLOSE')>s.calls.indexOf('tab_closure_registered'));
});
test('blocker closure never closes captcha, login, or a submitted unknown page',async()=>{
 for(const patch of [{attentionType:'human_verification'},{attentionType:'login'},{attentionType:'payment',attemptBoundary:'attempt'},{attentionType:'payment',siteStatus:'sent_unconfirmed'}]){
 const s=setup();Object.assign(s.task,{status:'needs_manual',siteStatus:'not_submitted',receipt:null,cloudVerified:false,...patch});await assert.rejects(closeTaskTab(s.runtime,s.task,{...s.input,closeBlocked:true}));assert.ok(!s.calls.includes('CLOSE'));
 }
});
test('terminal navigation failures close only after a timed evidence retry or an explicit local evidence gap',async()=>{
 const s=setup(),events=[];Object.assign(s.task,{libraryPlanId:'plan',status:'needs_manual',siteStatus:'not_submitted',cloudVerified:false,
   screenshot:'',artifactRef:'',receipt:null,attentionType:'site_unavailable',reason:'page.goto: Timeout 45000ms exceeded'});
 s.runtime.store.get=key=>key==='offlineMode'?{enabled:true}:key==='libraryPlan'?{id:'plan',status:'active'}:key==='paused'?true:null;
 s.runtime.store.pending=()=>[{id:'outbox-kept'}];s.runtime.home='C:/temp';
 const page={url:()=> 'https://site.example/submit',screenshot:async()=>{throw new Error('Timeout 10000ms exceeded');},async close(){events.push('CLOSE');}};
 s.runtime.context={newCDPSession:async()=>({send:async route=>route==='Page.getFrameTree'?{frameTree:{frame:{url:page.url()}}}:new Promise(()=>{}),detach:async()=>{}})};
 s.runtime.findPage=async()=>page;s.runtime.synchronize=async()=>events.push('sync');s.runtime.update=(task,patch,type)=>{events.push(type);Object.assign(task,patch);};
 await closeTaskTab(s.runtime,s.task,{...s.input,closeBlocked:true,allowEvidenceGap:true,evidenceCaptureTimeoutMs:100});
 assert.ok(events.includes('terminal_evidence_gap_registered'));assert.ok(events.includes('tab_closure_registered_offline'));assert.ok(events.includes('CLOSE'));
 assert.equal(s.task.evidenceCaptureFailure.source,'terminal_page_cleanup');assert.equal(s.task.tabHistory[0].evidenceGap,true);assert.equal(s.task.tabHistory[0].disposition,'closed');
 const unknown=setup();Object.assign(unknown.task,{libraryPlanId:'plan',status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',screenshot:'',artifactRef:'',attemptBoundary:'attempt',receipt:null,attentionType:'site_unavailable',reason:'Timeout'});
 unknown.runtime.store.get=key=>key==='offlineMode'?{enabled:true}:key==='libraryPlan'?{id:'plan',status:'active'}:key==='paused'?true:null;
 unknown.runtime.store.pending=()=>[];await assert.rejects(closeTaskTab(unknown.runtime,unknown.task,{...unknown.input,closeBlocked:true,allowEvidenceGap:true}));assert.ok(!unknown.calls.includes('CLOSE'));
});

test('offline login and CAPTCHA pages are archived with precise same-task recovery checkpoints while unknown receipts remain open',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'el-recovery-'));
 try{
  const tasks=[
   {id:'login-task',libraryPlanId:'plan',profileId:'JevPlay',profileSnapshot:{fields:{Url:'https://jevplay.com'}},profileRevision:188,url:'https://login.example/submit',
    targetId:'login-target',browserInstance:'host',status:'needs_manual',siteStatus:'not_submitted',attentionType:'login',reason:'登录入口要求登录',actualSubmission:{fields:[]}},
   {id:'captcha-task',libraryPlanId:'plan',profileId:'JevPlay',profileSnapshot:{fields:{Url:'https://jevplay.com'}},profileRevision:188,url:'https://captcha.example/submit',
    targetId:'captcha-target',browserInstance:'host',status:'needs_manual',siteStatus:'not_submitted',attentionType:'human_verification',reason:'等待验证码',
    actualSubmission:{fields:[{name:'toolName',label:'Name',value:'JevPlay'}]},validation:{emptyCount:0}},
   {id:'unknown-task',libraryPlanId:'plan',profileId:'JevPlay',url:'https://unknown.example/submit',targetId:'unknown-target',browserInstance:'host',
    status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attentionType:'unknown_receipt',attemptBoundary:'clicked',actualSubmission:{fields:[]}}
  ];
  const pages=new Map(),closed=[];
  for(const task of tasks)pages.set(task.targetId,{targetId:task.targetId,isClosed:()=>false,url:()=>task.url,bringToFront:async()=>{},screenshot:async options=>{const bytes=Buffer.from('fresh evidence '+task.id);await writeFile(options.path,bytes);return bytes;},close:async()=>closed.push(task.targetId)});
  const runtime={home,job:null,activeTaskId:null,host:{startedAt:'host'},context:{pages:()=>[...pages.values()],newCDPSession:async page=>({send:async()=>({targetInfo:{targetId:page.targetId}}),detach:async()=>{}})},
   store:{get:key=>key==='libraryPlan'?{id:'plan',status:'active',retainedTabLimit:0}:key==='offlineMode'?{enabled:true}:key==='paused'?true:null,
    pending:()=>[],values:prefix=>prefix==='task:'?tasks:[]},
   async synchronize(){},async findPage(task){const page=pages.get(task.targetId);if(!page)throw new Error('original target missing');return page;},
   update(task,patch){Object.assign(task,patch);},status(){return {ok:true,paused:true};}};
  const result=await archiveDeferredTabs(runtime);
  assert.equal(result.cleanup.examined,2);assert.equal(result.cleanup.closed.length,2);
  assert.deepEqual(closed,['login-target','captcha-target']);
  assert.equal(tasks[0].recoveryCheckpoint.stage,'login_required');
  assert.equal(tasks[0].recoveryCheckpoint.profileRevision,188);
  assert.equal(tasks[0].recoveryCheckpoint.formRecoverability,'unknown_requires_reentry');
  assert.equal(tasks[1].recoveryCheckpoint.stage,'final_captcha');
  assert.match(tasks[1].recoveryCheckpoint.nextStep,/新的验证码/);
  assert.equal(tasks[1].recoveryCheckpoint.completedFieldCount,1);
  assert.ok(tasks[1].tabHistory[0].closedAt);assert.equal(tasks[1].tabHistory[0].targetId,'captcha-target');
  assert.equal(tasks[2].tabClosedAt,undefined,'unknown submission page remains open for original-page verification');
  assert.equal(tasks[2].recoveryCheckpoint.stage,'receipt_verification');
  assert.equal(tasks[2].recoveryCheckpoint.formRecoverability,'original_page_verification_only_no_repost');
  assert.match(tasks[2].recoveryCheckpoint.nextStep,/不要再次提交/);
  assert.ok(!closed.includes('unknown-target'));
 }finally{await rm(home,{recursive:true,force:true});}
});
test('offline recovery records login gates from older plans when their original browser target is unavailable',async()=>{
 const task={id:'older-login',libraryPlanId:'old-plan',profileId:'JevPlay',profileSnapshot:{fields:{Url:'https://jevplay.com'}},profileRevision:177,
  url:'https://login.example/submit',targetId:'old-target',browserInstance:'old-host',status:'needs_manual',siteStatus:'not_submitted',attentionType:'login',
  reason:'Google 登录需要用户验证',actualSubmission:{fields:[]},loginLinkRequest:{boundary:'mail-link-requested'}};
 const live={targetId:'homepage',isClosed:()=>false,url:()=> 'https://jevplay.com/'};
 const runtime={home:'.',job:null,activeTaskId:null,host:{startedAt:'current-host'},context:{pages:()=>[live],newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'homepage'}}),detach:async()=>{}})},
  store:{get:key=>key==='libraryPlan'?{id:'current-plan',profileId:'JevPlay',status:'active',retainedTabLimit:5}:key==='offlineMode'?{enabled:true}:key==='paused'?true:null,
   pending:()=>[],values:prefix=>prefix==='task:'?[task]:[]},update(row,patch){Object.assign(row,patch);},status(){return{ok:true,paused:true};}};
 const result=await archiveDeferredTabs(runtime);
 assert.equal(result.cleanup.recoveryCheckpointUpdates.length,1);
 assert.equal(task.recoveryCheckpoint.stage,'login_required');
 assert.equal(task.recoveryCheckpoint.sourceTargetId,'old-target');
 assert.ok(task.deferredRecovery.targetUnavailableAt);
 assert.equal(task.deferredRecovery.originalTaskOnly,true);
 assert.equal(task.loginLinkRequest.boundary,'mail-link-requested','the pending magic-link history is preserved');
});
test('recovery priority never treats a directory search box as completed product fields',()=>{
 const search={attentionType:'missing_fields',actualSubmission:{fields:[{name:'q',label:'Search for product or website',value:'AI tools'}]}};
 assert.equal(recoveryStage(search),'not_filled');
 assert.equal(recoveryStage({attentionType:'human_verification',validation:{emptyCount:0},actualSubmission:{fields:[{label:'Tool Name',value:'JevPlay'}]}}),'final_captcha');
});
