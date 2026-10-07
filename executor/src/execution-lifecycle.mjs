import {workbenchScope} from './workbench-sync.mjs';
import {assertBatchPolicy,batchConfig,pauseBatchPolicy} from './workbench-batch-policy.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {batchJson,batchScopeRows} from '../../core/workbench-batch-recovery.mjs';
import {originalUnattended as U} from '../../core/original-batch-config.mjs';
import {createHash} from 'node:crypto';
import {closeAcceptanceTask} from './acceptance-cleanup.mjs';
import {captureParkedResumeRequests,pausedParkedResumeTasks} from './parked-task-resume.mjs';
import {navigationBudgetContinuation} from './original-navigation-rejudge.mjs';
const now=()=>new Date().toISOString();
const activeIds=runtime=>[...new Set([...(runtime.activeTaskIds||[]),runtime.activeTaskId,runtime.store.get('singleTaskId')].filter(Boolean))];
export function assertOriginalBatch(runtime,batch) {
  assertBatchPolicy(runtime,batch);
  if(batch.scopeSha256){const bytes=batch.cloudRecoveryVersion===1?batchJson(batchScopeRows(batch)):JSON.stringify(batchScopeRows(batch));if(createHash('sha256').update(bytes).digest('hex')!==batch.scopeSha256)throw Error('原批次范围已变化，保持暂停');}
}
export function requestExecutionPause(runtime,reason='用户暂停') {
  const ids=activeIds(runtime),id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id),fixed=runtime.store.get('acceptanceBatch'),plan=runtime.store.get('libraryPlan');
  const scope=workbenchScope(runtime.store.get('pair')),prior=runtime.store.get('executionPaused'),wasPaused=runtime.store.get('paused')===true;
  runtime.store.set('paused',true);
  const single=ids.map(id=>runtime.store.get('task:'+id)).filter(Boolean),runIds=[...new Set(single.map(task=>task.runId).filter(Boolean))];
  const runId=runtime.store.get('manualResumeRunId')||(wasPaused&&prior?.scope===scope&&prior.kind==='run'?prior.id:null);if(!runIds.length&&runId&&runtime.store.get('run:'+runId))runIds.push(runId);
  runtime.store.set('executionPaused',{scope:workbenchScope(runtime.store.get('pair')),at:now(),reason,taskIds:ids,...(batch?{kind:'workbench',id:batch.id}:fixed?.status==='running'?{kind:'fixed',id:fixed.id}:plan?.status==='active'?{kind:'library',id:plan.id}:runIds.length===1?{kind:'run',id:runIds[0]}:{kind:'idle'})});
  if(batch?.status==='running'){assertOriginalBatch(runtime,batch);runtime.store.set('workbenchBatch:'+id,{...batch,status:'paused',reason,pauseReasonCode:'user_pause',pausedAt:now(),pausedTaskIds:ids.filter(taskId=>batch.items.some(item=>item.taskId===taskId)),pausedParkedResumes:captureParkedResumeRequests(runtime,batch),resumingPausedTaskIds:[]});}
  if(fixed?.status==='running')runtime.store.set('acceptanceBatch',{...fixed,status:'paused',reason,pausedAt:now()});
}
export function finalizeUserPause(runtime,task) {
  const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
  if(batch?.status!=='paused'||batch.pauseReasonCode!=='user_pause'||!batch.pausedTaskIds?.includes(task.id)||task.receipt)return;
  if(!['pending','opening','filling','submitting'].includes(task.status))return;
  const patch=task.attemptBoundary?{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attentionType:'unknown_receipt',reason:'暂停时原提交边界已保留，请先核验'}:{status:'pending',pauseContinuation:{scope:batch.scope,batchId:batch.id,at:batch.pausedAt,targetId:task.targetId,browserInstance:task.browserInstance,taskDeadlineAt:task.taskDeadlineAt,profileRevision:task.profileRevision},reason:'原任务已暂停，原页及预算保留'};
  runtime.update(task,patch,'user_pause_task_checkpoint');
}
export async function persistBatchLifecycle(runtime,batch,type) {
  if(!batch?.items)return;
  let task=batch.items.map(item=>runtime.store.get('task:'+item.taskId)).find(task=>task&&(!task.controller||task.controller==='executor')&&(!runtime.job||task.controllerId===runtime.controllerId));
  if(!task)return;
  if(!runtime.job)await runtime.lease(task,{online:true});assertOriginalBatch(runtime,batch);task=runtime.store.get('task:'+task.id);
  runtime.update(task,{},type,{['workbenchBatch:'+batch.id]:runtime.store.get('workbenchBatch:'+batch.id)||batch});
  await flushBatchTaskEvents(runtime,task);
}
export async function resumeExecution(runtime,input={}) {
  if(runtime.store.get('executionStopped'))throw Error('本次执行已经停止，请明确重新开始原范围');
  if(runtime.store.get('paused')!==true)throw Error('当前没有已暂停的原批次');
  if(runtime.job)await runtime.job;
  const scope=workbenchScope(runtime.store.get('pair')),id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id),fixed=runtime.store.get('acceptanceBatch'),paused=runtime.store.get('executionPaused'),plan=runtime.store.get('libraryPlan');
  const check=()=>{if(scope!==workbenchScope(runtime.store.get('pair'))||id!==runtime.store.get('activeWorkbenchBatch')||runtime.store.get('executionStopped')||runtime.store.get('paused')!==true)throw Error('工作区或原执行状态已变化，保持暂停');};
  if(input.expectedBatchId!==undefined&&input.expectedBatchId!==(batch?.id||fixed?.id))throw Error('原批次已变化，请刷新后继续');
  if(batch){
    if(batch.status!=='paused')throw Error('请从原批次范围处理待人工或停止的任务');assertOriginalBatch(runtime,batch);
    if(batchConfig(batch).unattended&&U.isExpired(batch.unattendedState)){pauseBatchPolicy(runtime,batch,'deadline');throw Error('无人值守截止时间已到，原任务和预算保留');}
    const continuations=(batch.pausedTaskIds||[]).filter(taskId=>{const task=runtime.store.get('task:'+taskId),saved=task?.pauseContinuation;return task?.status==='pending'&&!task.attemptBoundary&&!task.receipt&&saved?.batchId===batch.id&&saved.scope===scope&&['targetId','browserInstance','taskDeadlineAt','profileRevision'].every(key=>saved[key]===task[key]);});
    const parked=pausedParkedResumeTasks(runtime,batch);
    const navigation=batch.items.filter(item=>!['complete','excluded'].includes(item.status)).map(item=>runtime.store.get('task:'+item.taskId)).filter(task=>task?.status==='pending'&&navigationBudgetContinuation(task,batch));
    if(batchConfig(batch).unattended&&!continuations.length&&!parked.length&&!navigation.length&&batch.items.some(item=>!['complete','excluded'].includes(item.status))){const decision=U.canStartTask(batch.unattendedState);if(!decision.ok){pauseBatchPolicy(runtime,batch,decision.reason);throw Error('原无人值守预算已达到上限，未开始新组合');}}
    await runtime.synchronize();check();assertOriginalBatch(runtime,runtime.store.get('workbenchBatch:'+id));
    const next={...runtime.store.get('workbenchBatch:'+id),status:'running',reason:'',resumedAt:now(),resumingPausedTaskIds:continuations};runtime.store.set('workbenchBatch:'+id,next);
    try{for(const task of parked){const current=runtime.store.get('task:'+task.id);if(!pausedParkedResumeTasks(runtime,next).some(saved=>saved.id===current.id))throw Error('原待人工接续任务已变化，保持暂停');runtime.update(current,{originalResume:{...current.originalResume,pauseAt:paused?.at||''}},'parked_task_user_resumed');}await persistBatchLifecycle(runtime,next,'workbench_run_resumed');check();}catch(error){const current=runtime.store.get('workbenchBatch:'+id);if(current)runtime.store.set('workbenchBatch:'+id,{...current,status:'paused',reason:error.message});throw error;}
  }else if(fixed?.status==='paused'){
    const frozen=runtime.store.get('acceptance:'+fixed.id),execution=runtime.store.get('acceptanceExecution:'+fixed.id);if(frozen?.sha256!==fixed.scopeSha256||execution?.scopeSha256!==frozen?.sha256||frozen?.count!==fixed.count)throw Error('原固定批次范围校验失败');
    const taskIds=[...(frozen.combinations||[]).map(item=>item.existingTaskId),...Object.values(execution.items||{}).map(item=>item.taskId)].filter(Boolean);
    await runtime.synchronize();check();runtime.store.recover({taskIds});await runtime.synchronize();check();runtime.store.set('acceptanceBatch',{...fixed,status:'running',reason:'',resumedAt:now()});
  }else if(paused?.scope===scope&&paused.kind==='run'&&runtime.store.get('run:'+paused.id)){
    await runtime.synchronize();check();runtime.store.recover({taskIds:runtime.store.values('task:').filter(task=>task.runId===paused.id).map(task=>task.id)});await runtime.synchronize();check();runtime.store.set('manualResumeRunId',paused.id);
  }else if(plan?.status==='active'&&(!paused||paused.scope===scope&&paused.kind==='library'&&paused.id===plan.id)){
    const taskIds=[...(plan.initialPending||[]),...(plan.batches||[]).flatMap(batch=>batch.taskIds||[]),...runtime.store.values('task:').filter(task=>task.libraryPlanId===plan.id).map(task=>task.id)];
    await runtime.synchronize();check();runtime.store.recover({taskIds});await runtime.synchronize();check();runtime.store.set('libraryPlan',{...runtime.store.get('libraryPlan'),globalPause:null});
  }else throw Error('没有可继续的原范围，请查看原任务');
  check();runtime.store.set('singleTaskId',null);runtime.store.set('paused',false);
  try{if(batch)for(const taskId of batch.pausedTaskIds||[]){const task=runtime.store.get('task:'+taskId);if(task)await closeAcceptanceTask(runtime,task);}}catch(error){runtime.store.set('paused',true);const current=runtime.store.get('workbenchBatch:'+id);if(current)runtime.store.set('workbenchBatch:'+id,{...current,status:'paused',reason:error.message});throw error;}
  runtime.tick();return runtime.status();
}
