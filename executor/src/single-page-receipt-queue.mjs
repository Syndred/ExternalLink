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
import {existingSinglePageReceipt,verifyExistingSinglePageReceipt,existingReceiptTaskConflict} from './existing-single-page-receipt.mjs';
import {cloudDigest} from './cloud-sync-state.mjs';
import {refillReceiptState} from './refill-receipt-watch.mjs';

const key=page=>'submissionQueuePage:'+page.browserInstance+':'+page.targetId;
const proof=task=>plain({id:task.id,profileId:task.profileId,profileRevision:task.profileRevision,profileSnapshot:task.profileSnapshot,version:task.version,controller:task.controller,controllerId:task.controllerId,targetId:task.targetId,browserInstance:task.browserInstance,attemptBoundary:task.attemptBoundary,actualSubmission:task.actualSubmission,receipt:task.receipt,originalFormContinuation:task.originalFormContinuation,attemptHistory:task.attemptHistory});
const equal=(a,b)=>isDeepStrictEqual(a===undefined?a:plain(a),b===undefined?b:plain(b));
const refillGate=(task,panel)=>{const state=task.originalFormContinuation,gate=state?.gate;return task.status==='needs_manual'&&!task.receipt&&!task.attemptBoundary&&state?.phase==='gate'&&gate?.advance!==false&&(gate?.needs_manual||gate?.captcha||gate?.blocked)&&equal(state.panelContext,{id:panel.id,generation:panel.generation,profileId:panel.profileId,selectedTargetId:panel.selectedTargetId});};
export function rememberSubmissionQueuePage(runtime,page){
 const owned={...page,id:randomUUID(),scope:workbenchScope(runtime.store.get('pair')),status:'owned'};
 runtime.store.set(key(page),owned);return owned;
}
export async function prepareExistingSinglePageReceipt(runtime,{snapshot,input,url,assertCurrent,advanceOnVerified=true}){
 const panel=runtime.store.get('singlePagePanel'),state=existingSinglePageReceipt(runtime,snapshot,input.profileId,url,panel),pageKey=key({browserInstance:runtime.host?.startedAt,targetId:input.targetId});
 let owned=runtime.store.get(pageKey);if(!owned){const previous=runtime.store.get('submissionQueue');if(previous?.scope===panel.scope&&!previous.opening&&!previous.error&&previous.page?.targetId===input.targetId&&previous.page.browserInstance===runtime.host?.startedAt)owned=rememberSubmissionQueuePage(runtime,previous.page);}
 if(owned?.scope!==panel.scope||queue.normalizeUrlKey(owned.url)!==queue.normalizeUrlKey(input.expectedUrl))owned=null;
 if(owned){if(owned.completion)throw Error('原网页已有队列收尾记录，请先完成原核验');owned={...owned,existingReceipt:state,error:''};runtime.store.set(pageKey,owned);}
 const expected=structuredClone(owned),check=()=>{assertCurrent();if(owned&&!equal(runtime.store.get(pageKey),expected))throw Error('原网页队列归属已变化');};
 try{const result=await verifyExistingSinglePageReceipt(runtime,state,check);check();if(owned&&!advanceOnVerified)runtime.store.set(pageKey,{...owned,existingReceipt:{...state,advance:false},error:''});return {...result,queueContinuation:!!owned&&advanceOnVerified};}
 catch(error){check();if(owned)runtime.store.set(pageKey,{...owned,error:error.message});return{ok:true,existingSubmission:true,submitted:false,cloudSynced:false,queueContinuation:!!owned,reason:'已有收件，云端核验待完成：'+error.message};}
}
export function singlePageReceiptState(runtime){
 const panel=runtime.store.get('singlePagePanel');
 if(panel?.scope!==workbenchScope(runtime.store.get('pair')))return{ok:true,panel:null};
 const owned=runtime.store.get(key({browserInstance:runtime.host?.startedAt,targetId:panel.selectedTargetId}));
 return{ok:true,panel,refill:refillReceiptState(runtime,panel),completion:owned?.scope===panel.scope?{status:owned.status,kind:owned.completion?.kind||(owned.existingReceipt?'existing':'receipt'),error:owned.error||''}:null};
}

// Called by the existing serialized manual-receipt scheduler. A receipt never
// grants permission to navigate a user page or a different panel selection.
export async function completeSinglePageReceiptQueue(runtime){
 if(!runtime.context||runtime.job||runtime.singlePageFill||runtime.store.get('paused')!==true||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold'))return;
 const panel=singlePageReceiptState(runtime).panel;if(!panel?.open)return;
 let owned=runtime.store.get(key({browserInstance:runtime.host?.startedAt,targetId:panel.selectedTargetId}));
 if(!owned){const previous=runtime.store.get('submissionQueue');if(previous?.scope===panel.scope&&previous.opening!==true&&!previous.error&&previous.page?.targetId===panel.selectedTargetId&&previous.page.browserInstance===runtime.host?.startedAt)owned=rememberSubmissionQueuePage(runtime,previous.page);}
 if(!owned||owned.scope!==panel.scope||owned.status==='completed'&&owned.completion?.kind!=='gate')return;
 const candidates=runtime.store.values('task:').filter(task=>task.targetId===owned.targetId&&task.browserInstance===owned.browserInstance&&task.profileId===panel.profileId&&task.pageOwnership==='manual'&&(!task.controller||task.controller==='executor')&&(!task.controllerId||task.controllerId===runtime.controllerId)&&!task.syncConflict&&(task.status==='finished'&&task.receipt&&task.cloudVerified===true||refillGate(task,panel)));
 const existing=owned.existingReceipt;if(existing&&!equal(existing.panel,{id:panel.id,generation:panel.generation,profileId:panel.profileId,selectedTargetId:panel.selectedTargetId}))return;
 if(existing?candidates.length>0:candidates.length!==1)return;
 if(owned.status==='completed'){
  if(!candidates[0].receipt||candidates[0].cloudVerified!==true)return;
  // Returning to a retained gate page may confirm its eventual receipt. The
  // earlier gate advanced once, but never surrendered ownership of this tab.
  owned={...owned,status:'owned',completion:null,error:''};runtime.store.set(key(owned),owned);
 }
 let task=existing?{url:owned.url,profileId:existing.profileId,receipt:existing.record}:candidates[0],expectedTask=structuredClone(task),expectedPanel=structuredClone(panel),expectedOwned=structuredClone(owned),expectedQueue=runtime.store.get('submissionQueue');const kind=existing?'existing':refillGate(task,panel)?'gate':'receipt';
 const check=()=>{if(workbenchScope(runtime.store.get('pair'))!==owned.scope||existing&&existing.connection!==cloudDigest(runtime.store.get('pair'))||runtime.host?.startedAt!==owned.browserInstance||runtime.job||runtime.singlePageFill||runtime.store.get('paused')!==true||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||!existing&&!equal(runtime.store.get('task:'+task.id),expectedTask)||!equal(runtime.store.get('singlePagePanel'),expectedPanel)||!equal(runtime.store.get(key(owned)),expectedOwned)||!equal(runtime.store.get('submissionQueue'),expectedQueue)||runtime.store.values('task:').some(other=>existing?existingReceiptTaskConflict(other,existing,owned.browserInstance):other.id!==task.id&&other.targetId===owned.targetId&&other.browserInstance===owned.browserInstance&&!other.tabClosedAt))throw Error('原单页、产品、队列或控制状态已变化，停止继续队列');};
 const save=patch=>{check();Object.assign(owned,patch);runtime.store.set(key(owned),owned);expectedOwned=structuredClone(owned);};
 const update=patch=>{check();runtime.update(task,patch,'single_page_receipt_completion');expectedTask=structuredClone(task);};
 const find=async targetId=>{for(const page of runtime.context.pages()){const info=await getTargetInfo(runtime.context,page);check();if(info?.targetId===targetId)return page;}return null;};
 try{
  check();
  if(existing)await verifyExistingSinglePageReceipt(runtime,existing,check);
  if(!owned.completion){
   if(queue.normalizeUrlKey(task.url)!==queue.normalizeUrlKey(owned.url))return;
   const page=await find(owned.targetId);if(!page||queue.normalizeUrlKey(page.url())!==queue.normalizeUrlKey(owned.url))return;
   if(runtime.store.values('task:').some(other=>other.id!==task.id&&other.targetId===owned.targetId&&other.browserInstance===owned.browserInstance&&!other.tabClosedAt))return;
   // Use the refreshed original queue and its original cursor policy. If the
   // completed group still contains another product, advance past that group.
   const pending=await submissionQueue(runtime,{url:owned.url},false,{assertCurrent:check});expectedQueue=runtime.store.get('submissionQueue');check();
   const stillQueued=queue.findSubmissionIndex(owned.url,pending.tasks)>=0;
   const verifiedOnly=existing?.advance===false,nextIndex=pending.tasks.length?(pending.index+(kind==='gate'||stillQueued?1:0))%pending.tasks.length:0,next=verifiedOnly?null:pending.tasks[nextIndex]||null;
   save({status:kind==='gate'?'retaining':'closing',completion:{id:randomUUID(),kind,verifiedOnly,taskId:task.id,profileId:task.profileId,panelId:panel.id,panelGeneration:panel.generation,receipt:structuredClone(task.receipt),taskProof:proof(task),next:next?{key:next.key,url:next.url,index:nextIndex}:null,at:new Date().toISOString()}});
  }
  const completion=owned.completion;
  if(completion.taskId!==task.id||completion.profileId!==panel.profileId||completion.panelId!==panel.id||completion.panelGeneration!==panel.generation||!equal(completion.receipt,task.receipt)||!equal(completion.taskProof,proof(task)))throw Error('原队列收尾记录与当前回执或面板不一致');
  if(owned.status==='closing'||owned.status==='retaining'){
   const page=await find(owned.targetId);if(!page||queue.normalizeUrlKey(page.url())!==queue.normalizeUrlKey(owned.url))throw Error('原完成页已关闭或跳转，保留队列收尾记录');
   let screenshot=existing?owned.screenshot:task.screenshot;if(!screenshot){screenshot=join(runtime.home,'single-receipt-'+randomUUID()+'.png');await capturePageEvidence(runtime.context,page,{path:screenshot,timeoutMs:15000});check();if(existing)save({screenshot});else update({screenshot});}
   const bytes=await readFile(screenshot);check();const at=new Date().toISOString(),checkpoint={...(existing?{stage:'existing_receipt_verified',recordedAt:at,recordKey:existing.recordKey,record:existing.record,url:page.url(),profileId:existing.profileId,targetId:owned.targetId,browserInstance:owned.browserInstance,screenshot,nextStep:'原收件和历史动态已核验，只继续队列，不再投稿'}:recoveryCheckpoint(task,page,screenshot,at)),screenshotSha256:createHash('sha256').update(bytes).digest('hex'),cloudSyncPending:existing?false:!task.artifactRef};
   if(existing)save({recoveryCheckpoint:checkpoint});else update({recoveryCheckpoint:checkpoint});
   if(kind!=='gate'){if(existing)await verifyExistingSinglePageReceipt(runtime,existing,check);await page.close();check();if(!existing)update({tabClosedAt:at,closedTargetIds:[owned.targetId],closeReason:'单页云端收件已确认，继续原投稿队列'});save({status:'closed'});}
   else save({status:'retained'});
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
   cancelVisitWork(runtime,kind==='gate'?'原补填页留待人工，切换到队列下一站':'云端收件已确认，切换到原队列下一站');
   runtime.store.set('singlePagePanel',{...panel,selectedTargetId:nextPage.targetId,generation:panel.generation+1,receiptCompletion:{id:completion.id,kind,taskId:task.id,nextPage,at:new Date().toISOString()}});expectedPanel=runtime.store.get('singlePagePanel');
  }else{
   cancelVisitWork(runtime,completion.verifiedOnly?'原旧收件已核验，仅关闭完成页':'单页收件已确认，原待投稿队列已完成');
   runtime.store.set('singlePagePanel',{...panel,receiptCompletion:{id:completion.id,kind,taskId:task.id,...(completion.verifiedOnly?{verifiedOnly:true}:{queueComplete:true}),at:new Date().toISOString()}});expectedPanel=runtime.store.get('singlePagePanel');
  }
  save({status:'completed',error:'',completedAt:new Date().toISOString()});
 }catch(error){
  // Do not overwrite a new user selection or a newer receipt while handling
  // an older awaited browser/cloud operation.
  if(equal(runtime.store.get(key(owned)),expectedOwned)&&workbenchScope(runtime.store.get('pair'))===owned.scope)runtime.store.set(key(owned),{...owned,error:error.message});
 }
}
