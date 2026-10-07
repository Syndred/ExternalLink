import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {workbenchScope} from './workbench-sync.mjs';
import {originalGroup,frozenGroup} from './original-destination-disposition.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import '../../extension/lib/batch-controls.js';

export const originalReadinessLimits=Object.freeze({timeoutMs:30000,pollMs:500,stableChecks:globalThis.ExtLinkBatchControls.REQUIRED_STABLE_CHECKS});
export function originalNavigationSnapshotError(error){return /snapshot unavailable|receiving end does not exist|could not establish connection|no tab with id|frame was removed|extension context invalidated/i.test(error?.message||'');}
export function nativeNavigationSnapshotError(error){
 if(error?.originalTaskSyncFailure||error?.batchPaused||error?.unattendedBudget||[401,403,409].includes(error?.status)||error?.staleTask&&!error?.originalDocumentChanged)return false;
 return originalNavigationSnapshotError(error)||error?.originalDocumentChanged===true||/Execution context was destroyed|Cannot find context|Inspected target navigated|Frame was detached/i.test(error?.message||'');
}
export const pendingNavigationMarker=task=>task.aiTakeover?.originalVisual?.pendingRejudge;
export const hasPendingNavigation=task=>['waiting_navigation','ready','rejudging'].includes(pendingNavigationMarker(task)?.status);
const groupDigest=group=>{let frozen=frozenGroup(group);if(group.key==='acceptanceBatch')frozen={...frozen,identities:frozen.identities.map(({combo,entry,id})=>({combo,id,runId:entry?.runId}))};return frozen&&createHash('sha256').update(batchJson(frozen)).digest('hex');};
export function navigationScope(runtime,task){const group=originalGroup(runtime,task);if(!group.key)throw Object.assign(Error('原待重判缺少持久运行组'),{staleTask:true});return JSON.parse(batchJson({scope:workbenchScope(runtime.store.get('pair')),groupKey:group.key,groupSha256:groupDigest(group),identity:Object.fromEntries(['id','runId','profileId','profileRevision','targetId','browserInstance','taskDeadlineAt'].map(key=>[key,task[key]])),profileSnapshot:structuredClone(task.profileSnapshot),...(task.workbenchBatchId?{workbenchBatchId:task.workbenchBatchId,scopeSha256:group.record.scopeSha256,configSha256:group.record.configSha256}:{})}));}
export function assertNavigationScope(runtime,task,marker){
 if(!marker||!isDeepStrictEqual(navigationScope(runtime,task),marker.navigationScope)||task.attemptBoundary||task.receipt||task.syncConflict||task.originalFreshRoundSuccessorTaskId||task.controller!=='executor'||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold'))throw Object.assign(Error('原待重判任务、范围、产品或控制状态已变化'),{staleTask:true});
}
export function navigationBatchContinuation(task,batch){
 const marker=pendingNavigationMarker(task),scope=marker?.navigationScope;
 return !!(hasPendingNavigation(task)&&marker.id&&['executor','ai'].includes(task.controller)&&scope?.workbenchBatchId===batch.id&&scope.groupKey==='workbenchBatch:'+batch.id&&scope.scope===batch.scope&&scope.scopeSha256===batch.scopeSha256&&scope.configSha256===batch.configSha256&&scope.groupSha256===groupDigest({key:'workbenchBatch:'+batch.id,record:batch})&&scope.identity?.id===task.id&&scope.identity?.targetId&&scope.identity?.browserInstance&&['id','runId','profileId','profileRevision','targetId','browserInstance','taskDeadlineAt'].every(key=>task[key]===scope.identity[key])&&isDeepStrictEqual(scope.profileSnapshot,task.profileSnapshot)&&!task.attemptBoundary&&!task.receipt&&!task.syncConflict&&!task.originalFreshRoundSuccessorTaskId);
}
export const navigationBudgetContinuation=(task,batch)=>navigationBatchContinuation(task,batch)&&task.unattendedClaimed===true&&task.unattendedBatchId===batch.id;
export function originalReadinessSignature({snapshot={},detection={}},initialMode='unknown'){
 const text=String(snapshot.text||'').replace(/\s+/g,' ').trim();
 return JSON.stringify({url:snapshot.url||'',title:String(snapshot.title||'').trim(),textLength:text.length,textHead:text.slice(0,160),textTail:text.slice(-160),contentShape:globalThis.ExtLinkBatchControls.contentFingerprint({forms:snapshot.forms||[],fields:snapshot.fields||[],buttons:snapshot.buttons||[]}),platform:detection.platform||initialMode,fieldCount:Number(detection.formFieldCount||snapshot.meta?.fieldCount||0),buttonCount:Number(snapshot.meta?.buttonCount||0),operable:detection.operable===true});
}

// Original waitForTabContentReady: reads only, two matching stable snapshots,
// 30 seconds, then manual attention. No action or model result is replayed.
export async function waitForOriginalNavigation(runtime,{task,marker,assertCurrent,probe,wait,now=Date.now}){
 const started=now(),deadline=started+originalReadinessLimits.timeoutMs;let signature='',stableChecks=0,lastError='';
 const check=async()=>{await assertCurrent();const current=runtime.store.get('task:'+task.id);if(!isDeepStrictEqual(JSON.parse(batchJson(current)),JSON.parse(batchJson(task)))||pendingNavigationMarker(current)?.id!==marker.id)throw Object.assign(Error('原待重判检查点已变化'),{staleTask:true});assertNavigationScope(runtime,current,marker);};
 const flush=async()=>{try{await flushBatchTaskEvents(runtime,task);}catch(error){if(!error.staleTask&&!error.batchPaused&&!error.unattendedBudget)error.originalTaskSyncFailure=true;throw error;}};
 await check();await flush();await check();
 while(now()<deadline){
  await check();let observed;
  try{observed=await probe();}catch(error){if(!nativeNavigationSnapshotError(error))throw error;lastError=error.message;}
  await check();
  if(observed){
   const ready=globalThis.ExtLinkBatchControls.hasContentReadySignal(observed),next=originalReadinessSignature(observed);
   stableChecks=ready&&next===signature?stableChecks+1:ready?1:0;signature=next;
   if(globalThis.ExtLinkBatchControls.isStableContentReady({tabStatus:observed.tabStatus,contentReady:ready,stableChecks,requiredStableChecks:originalReadinessLimits.stableChecks})){
    const state=structuredClone(task.aiTakeover);state.originalVisual.pendingRejudge={...marker,status:'ready',stableChecks,readyAt:new Date(now()).toISOString(),readyUrl:observed.snapshot.url,readyDocumentTimeOrigin:observed.documentTimeOrigin};
    runtime.update(task,{aiTakeover:state},'original_navigation_ready');await flush();await check();return{ok:true,observed};
   }
  }
  await wait(originalReadinessLimits.pollMs);
 }
 await check();const state=structuredClone(task.aiTakeover);state.originalVisual.pendingRejudge={...marker,status:'readiness_timeout',stableChecks,reason:lastError||'页面内容尚未稳定',at:new Date(now()).toISOString()};runtime.update(task,{aiTakeover:state},'original_navigation_readiness_timeout');return{ok:false,needs_manual:true,originalReadinessTimeout:true,reason:'页面加载或内容尚未稳定，已等待30秒；保留原页面，等待人工核验'};
}
