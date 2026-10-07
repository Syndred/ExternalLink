import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {batchManifest,batchCheckpoint,batchScopeRows,batchRecoveryVersion,batchJson,maximumLibraryBatchCombinations} from '../../core/workbench-batch-recovery.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {originalUnattended as U} from '../../core/original-batch-config.mjs';
import {navigationBatchContinuation,navigationBudgetContinuation} from './original-navigation-rejudge.mjs';
const digest=value=>createHash('sha256').update(batchJson(value)).digest('hex');

export async function flushBatchTaskEvents(runtime,task,eventId) {
  const pending=()=>runtime.store.pendingSummary?.()||runtime.store.pending();
  const owns=event=>eventId?event.id===eventId:event.taskId===task.id;
  while(pending().some(owns)) {
    const before=pending().map(event=>event.id);
    await runtime.cloud.flush(runtime.store);
    const after=pending().map(event=>event.id);
    if(after.some(id=>before.includes(id))&&before.every(id=>after.includes(id)))throw Error('原批次参数或预算尚未取得云端事件回读，保持原任务暂停');
  }
}

// Called inside the existing task/outbox transaction. A consumed reservation
// cannot disappear while the original task event survives a crash.
export function checkpointTaskUpdate(runtime,task,patch,stateChanges={}) {
  const id=patch.workbenchBatchId||task.workbenchBatchId;
  const batch=id&&(stateChanges['workbenchBatch:'+id]||runtime.store.get('workbenchBatch:'+id));
  if(batch?.cloudRecoveryVersion!==batchRecoveryVersion) return {patch,stateChanges};
  if(!batch.items.some(item=>item.taskId===task.id))throw Error('检查点任务不属于原批次');
  const next={...batch,cloudCheckpointRevision:(batch.cloudCheckpointRevision||0)+1};
  return {patch:{...patch,workbenchBatchRecoveryVersion:batchRecoveryVersion,workbenchBatchScope:next.scope,workbenchBatchConfigSha256:next.configSha256,workbenchBatchScopeSha256:next.scopeSha256,workbenchBatchCheckpoint:batchCheckpoint(next),...(next.cloudManifestInTask&&next.cloudManifestTaskId===task.id?{workbenchBatchManifest:next.cloudManifest||batchManifest(next)}:{})},stateChanges:{...stateChanges,['workbenchBatch:'+id]:next}};
}

// Validate all recovered batches before touching local state. Recovery always
// requires an explicit resume; current global preferences are never substituted.
export function recoverCloudBatchRecords(runtime,runs,tasks) {
  const scope=workbenchScope(runtime.store.get('pair')),manifests=new Map(),checkpoints=new Map();
  for(const source of [...runs,...tasks]) {
    const manifest=source.workbenchBatchManifest;
    if(manifest) {
      if(manifest.cloudRecoveryVersion!==batchRecoveryVersion||manifest.scope!==scope||!Array.isArray(manifest.items)||manifest.count!==manifest.items.length||manifest.count<1||manifest.count>maximumLibraryBatchCombinations||manifest.configSha256!==digest(manifest.config)||manifest.scopeSha256!==digest(batchScopeRows(manifest))||new Set(manifest.items.map(i=>i.taskId)).size!==manifest.count) throw Error('云端原批次范围、参数或工作区校验失败');
      const previous=manifests.get(manifest.id);
      if(previous&&!isDeepStrictEqual(previous,manifest))throw Error('云端原批次清单存在不同内容，保持暂停');
      manifests.set(manifest.id,manifest);
    }
    const checkpoint=source.workbenchBatchCheckpoint;
    if(checkpoint) {
      if(source.workbenchBatchId!==checkpoint.id||checkpoint.scope!==scope||!Number.isSafeInteger(checkpoint.cloudCheckpointRevision)||checkpoint.cloudCheckpointRevision<1)throw Error('云端原批次检查点身份无效');
      const previous=checkpoints.get(checkpoint.id);
      if(previous?.cloudCheckpointRevision===checkpoint.cloudCheckpointRevision&&!isDeepStrictEqual(previous,checkpoint))throw Error('云端原批次检查点版本冲突');
      if(!previous||previous.cloudCheckpointRevision<checkpoint.cloudCheckpointRevision)checkpoints.set(checkpoint.id,checkpoint);
    }
  }
  const batches=[];
  for(const [id,manifest] of manifests) {
    const checkpoint=checkpoints.get(id);
    if(checkpoint&&(checkpoint.configSha256!==manifest.configSha256||checkpoint.scopeSha256!==manifest.scopeSha256||!Array.isArray(checkpoint.items)||checkpoint.items.length!==manifest.count||checkpoint.items.some((i,n)=>i.taskId!==manifest.items[n].taskId)))throw Error('云端原批次检查点改变了原范围');
    const items=manifest.items.map((item,index)=>({...item,profile:item.profile||manifest.profileSnapshots?.[item.profileId],...checkpoint?.items[index]})),batch={...manifest,...checkpoint,cloudManifest:manifest,items,status:checkpoint?.status==='stopped'?'stopped':'paused',reason:checkpoint?.status==='stopped'?'原批次已停止，范围和任务保留；需要明确重新开始':'已恢复云端原范围和参数，请核验原任务后继续',recoveredFromCloudAt:new Date().toISOString()};
    for(const item of items) {
      const task=tasks.find(t=>t.id===item.taskId)||runtime.store.get('task:'+item.taskId);
      if(task&&(task.runId!==item.runId||task.profileId!==item.profileId||task.url!==item.url||task.destinationKey!==item.destinationKey))throw Error('恢复任务与原批次身份不一致');
      if(task&&!isDeepStrictEqual(task.originalFreshRound,item.originalFreshRound))throw Error('恢复任务与原新一轮来源不一致');
      if(!task&&!['excluded','complete'].includes(item.status)) {item.status='registration_unknown';item.reason='云端原任务暂不可读，保留原编号，禁止替代注册';}
      if(task?.receipt||task?.attemptBoundary||task&&['needs_manual','submitted_unconfirmed','finished','failed','err','excluded','skip'].includes(task.status)){item.status='complete';item.result=task.receipt?(task.cloudVerified===true?'received':'received_pending_sync'):task.attemptBoundary?'sent_unconfirmed':task.status;item.reason=task.reason||'';}
    }
    // There may be more than one paused historical batch. Restore all of them,
    // then choose the latest only for the UI; no timer receives authorization.
    batch.cursor=0;while(batch.cursor<items.length&&['complete','excluded'].includes(items[batch.cursor].status))batch.cursor++;
    const local=runtime.store.get('workbenchBatch:'+id);
    if(local&&(local.scope!==scope||local.configSha256!==manifest.configSha256||local.scopeSha256!==manifest.scopeSha256))throw Error('本机原批次与云端清单冲突');
    if(!local||(checkpoint?.cloudCheckpointRevision||0)>(local.cloudCheckpointRevision||0))batches.push(batch);
  }
  return batches;
}
export function parkRestoredBatchTask(runtime,task) {
  if(!task.workbenchBatchId||task.receipt)return;
  const batch=runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
  if(!batch||batch.scope&&batch.scope!==workbenchScope(runtime.store.get('pair'))) {
    runtime.store.set('paused',true);
    if(['pending','opening','filling','submitting'].includes(task.status))runtime.update(task,{status:task.attemptBoundary?'submitted_unconfirmed':'needs_manual',attentionType:'batch_recovery_missing',reason:'原批次范围或参数尚未恢复，保留原任务并等待核验'},'batch_policy_missing');
    return;
  }
  if(['opening','filling','submitting'].includes(task.status)) {
    if(navigationBatchContinuation(task,batch)&&(!batch.config?.unattended||navigationBudgetContinuation(task,batch))){runtime.update(task,{status:'pending',reason:'已恢复原导航待重判检查点，原页及已用预算保留；请继续原批次'},'cloud_original_navigation_recovered');return;}
    const result=U.interruptedTaskStatus({status:'running',submissionAttempted:!!task.attemptBoundary});
    const item=batch.items.find(i=>i.taskId===task.id);if(!item)throw Error('中断任务不属于恢复的原范围');
    item.status='complete';item.result=task.attemptBoundary?'sent_unconfirmed':result.status;item.reason=result.reason;
    if(batch.config?.unattended)batch.unattendedState=U.addManualTodo(batch.unattendedState,task.id);
    batch.cursor=0;while(batch.cursor<batch.items.length&&['complete','excluded'].includes(batch.items[batch.cursor].status))batch.cursor++;
    runtime.update(task,{...result,siteStatus:task.attemptBoundary?'sent_unconfirmed':'not_submitted',attentionType:task.attemptBoundary?'unknown_receipt':'interrupted_task'},'cloud_batch_interrupted',{['workbenchBatch:'+batch.id]:batch});
  }
}
