import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {closeAcceptanceTask} from '../executor/src/acceptance-cleanup.mjs';
import {freezeBatchConfig,initializeBatchPolicy,retainBatchManualPage} from '../executor/src/workbench-batch-policy.mjs';
import {finishWorkbenchTask,nextWorkbenchTask} from '../executor/src/workbench-features.mjs';

async function fixture({config={},taskPatch={}}={}){
 const home=await mkdtemp(join(tmpdir(),'el-unattended-cleanup-')),screenshot=join(home,'blocker.png');await writeFile(screenshot,'saved blocker screenshot');
 const store=new Store(':memory:'),task={id:'blocked',runId:'run-blocked',profileId:'photo',profileRevision:16,profileSnapshot:{id:'photo',fields:{Name:'OldPhoto',Url:'https://photo.example'}},version:1,controller:'executor',url:'https://blocked.example/submit',workbenchBatchId:'batch',targetId:'owned',browserInstance:'browser',status:'needs_manual',siteStatus:'not_submitted',attentionType:'human_verification',reason:'Captcha needs user input',screenshot,...taskPatch};
 const next={id:'next',runId:'run-next',profileId:'photo',url:'https://next.example/submit',profileSnapshot:task.profileSnapshot,status:'pending'};
 const batch=initializeBatchPolicy({id:'batch',scope:'https://cloud.example|default',...freezeBatchConfig({unattendedPreferences:{enabled:true,hours:1,tasks:10,manualTabs:1}},{unattended:true,...config}),status:'running',count:2,cursor:0,items:[task,next].map(t=>({taskId:t.id,profileId:t.profileId,url:t.url,destinationKey:new URL(t.url).hostname,status:t.id===task.id?'running':'registered'}))});
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',false);store.set('workbenchBatch:batch',batch);store.set('activeWorkbenchBatch','batch');store.set('task:'+task.id,task);store.set('task:'+next.id,next);const oldAcceptance={status:'paused',cursor:3,count:50};store.set('acceptanceBatch',oldAcceptance);
 const closed=[];let closedOwned=false;const owned={url:()=>task.url,isClosed:()=>closedOwned,close:async()=>{
  const saved=store.get('task:blocked');assert.ok(saved.recoveryCheckpoint?.screenshotSha256,'recovery evidence must be persisted before close');assert.ok(saved.recoveryCheckpoint.recordedAt);assert.equal(saved.recoveryCheckpoint.blockedReason,task.reason);assert.equal(saved.recoveryCheckpoint.profileRevision,16);closed.push('owned');closedOwned=true;
 }},foreign={url:()=> 'https://personal.example',isClosed:()=>false,close:async()=>{closed.push('foreign');}};
 const runtime={store,home,host:{startedAt:'browser'},lease:async()=>{},findPage:async()=>owned,update(t,patch,type,extra){Object.assign(t,patch);store.transition(t,type,extra);},context:{pages:()=>[owned,foreign],newCDPSession:async page=>({detach:async()=>{},send:async()=>({targetInfo:{targetId:page===owned?'owned':'foreign'}})})}};
 return{store,task,next,batch,runtime,closed,oldAcceptance,async close(){store.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-unattended-cleanup-'));await rm(absolute,{recursive:true,force:true});}};
}

// Regressions for the blanket unattended retention guard. Closing here uses the
// real cleanup workflow; only browser IO and the screenshot bytes are local.
for(const attentionType of ['human_verification','login','missing_fields'])test(`unattended ${attentionType} saves its recovery checkpoint, closes and releases the next site`,async()=>{
 const f=await fixture({taskPatch:{attentionType,reason:'Original blocker: '+attentionType}});
 try{await closeAcceptanceTask(f.runtime,f.task);assert.deepEqual(f.closed,['owned']);assert.ok(f.task.tabClosedAt);assert.equal(f.task.attemptBoundary,undefined);assert.equal(f.task.receipt,undefined);assert.equal(f.task.status,'needs_manual');assert.equal(retainBatchManualPage(f.runtime,f.task),false);assert.equal(finishWorkbenchTask(f.runtime,f.task.id),true);f.store.set('singleTaskId',null);const next=await nextWorkbenchTask(f.runtime);assert.equal(next.id,'next');assert.equal(f.store.get('workbenchBatch:batch').unattendedState.manualTabCount,0);assert.deepEqual(f.store.get('acceptanceBatch'),f.oldAcceptance);assert.match(f.task.recoveryCheckpoint.nextStep,/同一任务/);}
 finally{await f.close();}
});

for(const [name,options]of [
 ['fill-only prepared form',{config:{fillOnly:true},taskPatch:{attentionType:'fill_only'}}],
 ['unknown final post',{taskPatch:{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:'keep-original-boundary'}}],
 ['needs-manual after an uncertain click',{taskPatch:{attemptBoundary:'keep-original-boundary'}}],
 ['unknown result without a recorded boundary',{taskPatch:{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed'}}],
 ['sent-unconfirmed status without a recorded boundary',{taskPatch:{siteStatus:'sent_unconfirmed'}}],
 ])test(`${name} retains the original unattended page and result`,async()=>{
 const f=await fixture(options);try{assert.equal(retainBatchManualPage(f.runtime,f.task),true);await closeAcceptanceTask(f.runtime,f.task);assert.deepEqual(f.closed,[]);assert.equal(f.task.tabClosedAt,undefined);assert.equal(f.task.attemptBoundary,options.taskPatch?.attemptBoundary);assert.deepEqual(f.store.get('acceptanceBatch'),f.oldAcceptance);}finally{await f.close();}
 });

test('an explicit user pause preserves its original unattended blocker page',async()=>{
 const f=await fixture();try{const batch=f.store.get('workbenchBatch:batch');f.store.set('workbenchBatch:batch',{...batch,status:'paused',pauseReasonCode:'user_pause',pausedTaskIds:['blocked']});f.store.set('paused',true);await closeAcceptanceTask(f.runtime,f.task);assert.deepEqual(f.closed,[]);assert.equal(f.task.tabClosedAt,undefined);}finally{await f.close();}
});
