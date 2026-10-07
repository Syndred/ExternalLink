import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {taskPageControlEligible,handleTaskPageMessage} from '../executor/src/task-page-controls.mjs';
import {batchJson} from '../core/workbench-batch-recovery.mjs';
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
function fixture(){
 const store=new Store(':memory:'),runtime=new Runtime(store,'unused-original-page-controls-test'),scope='https://cloud.example|original',task={id:'original-task',runId:'original-run',profileId:'original-product',profileRevision:3,profileSnapshot:{id:'original-product',fields:{Name:'Original product',Url:'https://original-product.example'}},targetId:'original-page',browserInstance:'original-browser',url:'https://directory.example/submit',status:'needs_manual',attentionType:'login',controller:'executor'};
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'original'});store.set('paused',true);store.set('task:'+task.id,task);store.set('run:'+task.runId,{id:task.runId,profile:task.profileSnapshot});runtime.host={startedAt:task.browserInstance};let leases=0;runtime.lease=async()=>{leases++;};const frame={url:()=>task.url,isDetached:()=>false},page={url:()=>task.url,isClosed:()=>false},binding={id:'original-control',taskId:task.id,profileId:task.profileId,scope,page,frame,pageUrl:task.url,frameUrl:task.url,engine:{documentId:27,isCurrentDocument:async()=>true},identity:{runId:task.runId,profileId:task.profileId,profileRevision:task.profileRevision,targetId:task.targetId,browserInstance:task.browserInstance,profileSha256:hash(task.profileSnapshot)}};
 binding.runProfileSha256=hash(task.profileSnapshot);binding.mediaManifestSha256=hash([]);binding.mediaDefaultsSha256=hash(null);runtime.taskPageControls=new Map([[task.id,binding]]);const message={action:'manualContinue',taskId:task.id,runId:task.runId,taskControlId:binding.id,executorDocumentId:27,executorFrameUrl:task.url,callbackSource:'manual_button'};
 return{store,runtime,task,message,binding,leases:()=>leases};
}
test('original page controls exclude receipts unknown attempts other controllers closed tabs stopped execution and conflicting target tasks',()=>{
 for(const mode of ['valid','receipt','attempt','controller','closed','stopped','hold','other-target-attempt']){const f=fixture();try{if(mode==='receipt')f.task.receipt={evidence:'Original receipt'};if(mode==='attempt')f.task.attemptBoundary='unknown-original';if(mode==='controller')f.task.controller='supervisor';if(mode==='closed')f.task.tabClosedAt='closed';if(mode==='stopped')f.store.set('executionStopped',{id:'stop'});if(mode==='hold')f.store.set('connectionExecutionHold',{id:'connection'});if(mode==='other-target-attempt')f.store.set('task:other',{...f.task,id:'other',status:'submitted_unconfirmed',attemptBoundary:'preserve-other-original'});f.store.set('task:'+f.task.id,f.task);assert.equal(taskPageControlEligible(f.runtime,f.task),mode==='valid');assert.equal(f.leases(),0);assert.equal(f.store.pendingCount(),0);}finally{f.store.close();}}
});
test('stale original page callbacks reject run task document frame scope product and browser replacements before lease or mutation',async()=>{
 for(const change of [f=>f.message.runId='other-run',f=>f.message.taskId='other-task',f=>f.message.taskControlId='old-control',f=>f.message.executorDocumentId=28,f=>f.message.executorFrameUrl='https://directory.example/next',f=>f.task.profileSnapshot.fields.Name='Replaced product',f=>f.task.browserInstance='replacement-browser',f=>f.store.set('pair',{endpoint:'https://other.example',workspaceId:'other'}),f=>f.store.set('run:'+f.task.runId,{id:f.task.runId,profile:f.task.profileSnapshot,mediaManifest:[{asset_id:'changed-original-media'}]}),f=>f.store.set('task:other',{...f.task,id:'other',status:'submitted_unconfirmed',attemptBoundary:'original-unknown'})]){const f=fixture();try{change(f);f.store.set('task:'+f.task.id,f.task);await assert.rejects(handleTaskPageMessage(f.runtime,f.message));assert.equal(f.leases(),0);assert.equal(f.store.pendingCount(),0);assert.equal(f.store.get('task:'+f.task.id).status,'needs_manual');}finally{f.store.close();}}
});
test('a page callback without its original private binding or recognized source cannot add permission or select a task',async()=>{
 for(const mode of ['unbound','automatic-manual-continue','unknown-action']){const f=fixture();try{if(mode==='unbound')f.runtime.taskPageControls.clear();if(mode==='automatic-manual-continue')f.message.callbackSource='form_detected';if(mode==='unknown-action')f.message.action='submit';await assert.rejects(handleTaskPageMessage(f.runtime,f.message));assert.equal(f.store.get('singleTaskId'),null);assert.equal(f.store.get('paused'),true);assert.equal(f.store.pendingCount(),0);assert.equal(f.leases(),0);}finally{f.store.close();}}
});

test('changed frozen default image selection invalidates original page buttons before a lease or any permission event',async()=>{
 const f=fixture();try{
  const run=f.store.get('run:'+f.task.runId);f.store.set('run:'+f.task.runId,{...run,originalMediaDefaults:{logo:'cloud-media://another-image'}});
  await assert.rejects(handleTaskPageMessage(f.runtime,f.message),/素材清单已变化/);assert.equal(f.leases(),0);assert.equal(f.store.pendingCount(),0);assert.equal(f.store.get('task:'+f.task.id).status,'needs_manual');assert.equal(f.store.get('paused'),true);
 }finally{f.store.close();}
});
test('rendered original page buttons polling navigation and failed readback retries reach native work while preserving permission and unknown boundaries',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-task-page-controls.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:45000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(evidence.results.length,11);assert.equal(evidence.posts,0);assert.equal(evidence.externalRequests,0);assert.equal(evidence.realModelCalls,0);assert.equal(evidence.productionWrites,0);assert.equal(evidence.results.find(row=>row.mode==='page-skip-lost-readback-and-original-request-retry').noDuplicateSkipEvent,true);assert.equal(evidence.results.find(row=>row.mode==='form-detected-fill-only').noNewConsent,true);assert.equal(evidence.results.find(row=>row.mode==='same-url-reload-during-confirmation').oldConfirmationRevoked,true);
});
