import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {workbenchScope} from './workbench-sync.mjs';
import {queue,plain} from './shared.mjs';
import {submissionQueue} from './submission-queue.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {capturePageEvidence} from './page-evidence.mjs';
import {recoveryCheckpoint} from './tab-cleanup.mjs';
import {cancelVisitWork} from './single-page.mjs';

const key=page=>'submissionQueuePage:'+page.browserInstance+':'+page.targetId;
const proof=task=>plain({id:task.id,profileId:task.profileId,profileRevision:task.profileRevision,profileSnapshot:task.profileSnapshot,version:task.version,controller:task.controller,controllerId:task.controllerId,targetId:task.targetId,browserInstance:task.browserInstance,attemptBoundary:task.attemptBoundary,actualSubmission:task.actualSubmission,receipt:task.receipt});
const equal=(a,b)=>isDeepStrictEqual(a===undefined?a:plain(a),b===undefined?b:plain(b));
export function rememberSubmissionQueuePage(runtime,page){
 const owned={...page,id:randomUUID(),scope:workbenchScope(runtime.store.get('pair')),status:'owned'};
 runtime.store.set(key(page),owned);return owned;
}
export function singlePageReceiptState(runtime){
 const panel=runtime.store.get('singlePagePanel');
 if(panel?.scope!==workbenchScope(runtime.store.get('pair')))return{ok:true,panel:null};
 const owned=runtime.store.get(key({browserInstance:runtime.host?.startedAt,targetId:panel.selectedTargetId}));
 return{ok:true,panel,completion:owned?.scope===panel.scope?{status:owned.status,error:owned.error||''}:null};
}

// Called by the existing serialized manual-receipt scheduler. A receipt never
// grants permission to navigate a user page or a different panel selection.
export async function completeSinglePageReceiptQueue(runtime){
 if(!runtime.context||runtime.job||runtime.singlePageFill||runtime.store.get('paused')!==true||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold'))return;
 const panel=singlePageReceiptState(runtime).panel;if(!panel?.open)return;
 let owned=runtime.store.get(key({browserInstance:runtime.host?.startedAt,targetId:panel.selectedTargetId}));
 if(!owned){const previous=runtime.store.get('submissionQueue');if(previous?.scope===panel.scope&&previous.opening!==true&&!previous.error&&previous.page?.targetId===panel.selectedTargetId&&previous.page.browserInstance===runtime.host?.startedAt)owned=rememberSubmissionQueuePage(runtime,previous.page);}
 if(!owned||owned.scope!==panel.scope||owned.status==='completed')return;
 const candidates=runtime.store.values('task:').filter(task=>task.targetId===owned.targetId&&task.browserInstance===owned.browserInstance&&task.profileId===panel.profileId&&task.pageOwnership==='manual'&&(!task.controller||task.controller==='executor')&&(!task.controllerId||task.controllerId===runtime.controllerId)&&!task.syncConflict&&task.status==='finished'&&task.receipt&&task.cloudVerified===true);
 if(candidates.length!==1)return;
 let task=candidates[0],expectedTask=structuredClone(task),expectedPanel=structuredClone(panel),expectedOwned=structuredClone(owned),expectedQueue=runtime.store.get('submissionQueue');
 const check=()=>{if(workbenchScope(runtime.store.get('pair'))!==owned.scope||runtime.host?.startedAt!==owned.browserInstance||runtime.job||runtime.singlePageFill||runtime.store.get('paused')!==true||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||!equal(runtime.store.get('task:'+task.id),expectedTask)||!equal(runtime.store.get('singlePagePanel'),expectedPanel)||!equal(runtime.store.get(key(owned)),expectedOwned)||!equal(runtime.store.get('submissionQueue'),expectedQueue)||runtime.store.values('task:').some(other=>other.id!==task.id&&other.targetId===owned.targetId&&other.browserInstance===owned.browserInstance&&!other.tabClosedAt))throw Error('原单页、产品、队列或控制状态已变化，停止继续队列');};
 const save=patch=>{check();Object.assign(owned,patch);runtime.store.set(key(owned),owned);expectedOwned=structuredClone(owned);};
 const update=patch=>{check();runtime.update(task,patch,'single_page_receipt_completion');expectedTask=structuredClone(task);};
 const find=async targetId=>{for(const page of runtime.context.pages()){const info=await getTargetInfo(runtime.context,page);check();if(info?.targetId===targetId)return page;}return null;};
 try{
  check();
  if(!owned.completion){
   if(queue.normalizeUrlKey(task.url)!==queue.normalizeUrlKey(owned.url))return;
   const page=await find(owned.targetId);if(!page||queue.normalizeUrlKey(page.url())!==queue.normalizeUrlKey(owned.url))return;
   if(runtime.store.values('task:').some(other=>other.id!==task.id&&other.targetId===owned.targetId&&other.browserInstance===owned.browserInstance&&!other.tabClosedAt))return;
   // Use the refreshed original queue and its original cursor policy. If the
   // completed group still contains another product, advance past that group.
   const pending=await submissionQueue(runtime,{url:owned.url},false,{assertCurrent:check});expectedQueue=runtime.store.get('submissionQueue');check();
   const stillQueued=queue.findSubmissionIndex(owned.url,pending.tasks)>=0;
   const nextIndex=pending.tasks.length?(pending.index+(stillQueued?1:0))%pending.tasks.length:0,next=pending.tasks[nextIndex]||null;
   save({status:'closing',completion:{id:randomUUID(),taskId:task.id,profileId:task.profileId,panelId:panel.id,panelGeneration:panel.generation,receipt:structuredClone(task.receipt),taskProof:proof(task),next:next?{key:next.key,url:next.url,index:nextIndex}:null,at:new Date().toISOString()}});
  }
  const completion=owned.completion;
  if(completion.taskId!==task.id||completion.profileId!==panel.profileId||completion.panelId!==panel.id||completion.panelGeneration!==panel.generation||!equal(completion.receipt,task.receipt)||!equal(completion.taskProof,proof(task)))throw Error('原队列收尾记录与当前回执或面板不一致');
  if(owned.status==='closing'){
   const page=await find(owned.targetId);if(!page||queue.normalizeUrlKey(page.url())!==queue.normalizeUrlKey(owned.url))throw Error('原完成页已关闭或跳转，保留队列收尾记录');
   if(!task.screenshot){const screenshot=join(runtime.home,'single-receipt-'+randomUUID()+'.png');await capturePageEvidence(runtime.context,page,{path:screenshot,timeoutMs:15000});check();update({screenshot});}
   const bytes=await readFile(task.screenshot);check();const at=new Date().toISOString(),checkpoint={...recoveryCheckpoint(task,page,task.screenshot,at),screenshotSha256:createHash('sha256').update(bytes).digest('hex'),cloudSyncPending:!task.artifactRef};
   update({recoveryCheckpoint:checkpoint});await page.close();check();
   update({tabClosedAt:at,closedTargetIds:[owned.targetId],closeReason:'单页云端收件已确认，继续原投稿队列'});save({status:'closed'});
  }
  await runtime.cloud.flush(runtime.store);check();
  if(completion.next){
   let page;
   if(completion.nextPage){page=await find(completion.nextPage.targetId);if(!page)throw Error('已打开的下一站页签已关闭，未重复打开');}
   else{
    page=await runtime.context.newPage();check();const info=await getTargetInfo(runtime.context,page);check();if(!info)throw Error('下一站网页编号不可读，保留原队列收尾记录');
    save({status:'opening',completion:{...completion,nextPage:{targetId:info.targetId,browserInstance:owned.browserInstance,url:completion.next.url}}});
   }
   if(page.url()!==completion.next.url){if(page.url()!=='about:blank')throw Error('下一站页签已被更改，未重新导航');await page.goto(completion.next.url,{waitUntil:'domcontentloaded',timeout:30000});check();}
   await page.bringToFront();check();
   const nextPage=owned.completion.nextPage;rememberSubmissionQueuePage(runtime,nextPage);
   runtime.store.set('submissionQueue',{...expectedQueue,key:completion.next.key,index:completion.next.index,page:nextPage,opening:false});expectedQueue=runtime.store.get('submissionQueue');
   cancelVisitWork(runtime,'云端收件已确认，切换到原队列下一站');
   runtime.store.set('singlePagePanel',{...panel,selectedTargetId:nextPage.targetId,generation:panel.generation+1,receiptCompletion:{id:completion.id,taskId:task.id,nextPage,at:new Date().toISOString()}});expectedPanel=runtime.store.get('singlePagePanel');
  }else{
   cancelVisitWork(runtime,'单页收件已确认，原待投稿队列已完成');
   runtime.store.set('singlePagePanel',{...panel,receiptCompletion:{id:completion.id,taskId:task.id,queueComplete:true,at:new Date().toISOString()}});expectedPanel=runtime.store.get('singlePagePanel');
  }
  save({status:'completed',error:'',completedAt:new Date().toISOString()});
 }catch(error){
  // Do not overwrite a new user selection or a newer receipt while handling
  // an older awaited browser/cloud operation.
  if(equal(runtime.store.get(key(owned)),expectedOwned)&&workbenchScope(runtime.store.get('pair'))===owned.scope)runtime.store.set(key(owned),{...owned,error:error.message});
 }
}
