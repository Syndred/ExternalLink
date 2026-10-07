import {createHash} from 'node:crypto';
import {originalBatchConfig,originalUnattended as U} from '../../core/original-batch-config.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {hasManualSubmissionConsent} from './submission-preferences.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reasons={deadline:'无人值守运行已达到截止时间，已暂停并保留原任务',task_budget:'无人值守项目组合上限已达到，原范围和未完成项保留',model_budget:'无人值守模型调用预算已达到，原任务待核验',task_deadline:'无人值守单个任务超过时限，原任务保留待核验',consecutive_failures:'无人值守连续失败达到上限，原范围保留'};
export function batchConfig(batch){return batch.config||originalBatchConfig({},{});}
export function freezeBatchConfig(documents,options={}){const config=originalBatchConfig(documents,options);return{config,configSha256:digest(config)};}
export function assertBatchPolicy(runtime,batch){
 if(batch.scope&&batch.scope!==workbenchScope(runtime.store.get('pair')))throw Error('原批次属于其他工作区');
 if(batch.configSha256&&batch.configSha256!==(batch.cloudRecoveryVersion===1?createHash('sha256').update(batchJson(batch.config)).digest('hex'):digest(batch.config)))throw Error('原批次参数校验不一致，请重新预览');
}
export function initializeBatchPolicy(batch,now=Date.now()){
 if(batchConfig(batch).unattended)batch.unattendedState=U.createCheckpoint(batchConfig(batch),now,batch.unattendedState||{});
 return batch;
}
export function recoverBatchTasks(runtime){
 const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id);if(!batch?.config)return;
 try{assertBatchPolicy(runtime,batch);}catch(error){runtime.store.set('paused',true);runtime.cloudError=error.message;return;}
 initializeBatchPolicy(batch);
 for(const item of batch.items){const task=runtime.store.get('task:'+item.taskId);if(!task||task.receipt||!['opening','filling','submitting'].includes(task.status))continue;
  const result=U.interruptedTaskStatus({status:'running',submissionAttempted:!!task.attemptBoundary});
  runtime.update(task,{...result,siteStatus:task.attemptBoundary?'sent_unconfirmed':'not_submitted',attentionType:task.attemptBoundary?'unknown_receipt':'interrupted_task'},'workbench_interrupted_recovered');
  item.status='complete';item.result=task.attemptBoundary?'sent_unconfirmed':result.status;item.reason=result.reason;
  if(batchConfig(batch).unattended)batch.unattendedState=U.addManualTodo(batch.unattendedState,task.id);
 }
 while(batch.cursor<batch.items.length&&['complete','excluded'].includes(batch.items[batch.cursor].status))batch.cursor++;
 save(runtime,batch);if(U.isExpired(batch.unattendedState))pauseBatchPolicy(runtime,batch,'deadline');
}
function save(runtime,batch){runtime.store.set('workbenchBatch:'+batch.id,batch);}
export function pauseBatchPolicy(runtime,batch,reason,taskId){
 const current=runtime.store.get('workbenchBatch:'+batch.id)||batch,at=Date.now();
 const next={...current,status:'paused',reason:reasons[reason]||reason,pauseReasonCode:reason,unattendedState:{...current.unattendedState,stopReason:reasons[reason]||reason,lastWatchdogAt:at},...(taskId?{interruptedTasks:{...current.interruptedTasks,[taskId]:at}}:{})};save(runtime,next);runtime.store.set('paused',true);return next;
}
function interruptBatchTask(runtime,batch,taskId){
 const current=runtime.store.get('workbenchBatch:'+batch.id)||batch;if(current.interruptedTasks?.[taskId])return;
 const at=Date.now();save(runtime,{...current,interruptedTasks:{...current.interruptedTasks,[taskId]:at},taskInterruptionReasons:{...current.taskInterruptionReasons,[taskId]:'task_deadline'},unattendedState:{...current.unattendedState,lastWatchdogAt:at}});
}
export async function refreshBatchManualCapacity(runtime,batch){
 if(!batchConfig(batch).unattended)return batch;
 let liveTargets=null;
 if(runtime.context){liveTargets=new Set();for(const page of runtime.context.pages()){if(page.isClosed()||!/^https?:\/\//.test(page.url()))continue;const info=await getTargetInfo(runtime.context,page);if(info?.targetId)liveTargets.add(info.targetId);}}
 const current=runtime.store.get('workbenchBatch:'+batch.id);if(!current||current.status!=='running')return current||batch;assertBatchPolicy(runtime,current);
 const scope=workbenchScope(runtime.store.get('pair')),manual=runtime.store.values('task:').filter(task=>{const source=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);return source&&(!source.scope||source.scope===scope)&&task.targetId&&!task.tabClosedAt&&!task.receipt&&['needs_manual','submitted_unconfirmed'].includes(task.status)&&(!liveTargets||liveTargets.has(task.targetId)&&(!runtime.host?.startedAt||task.browserInstance===runtime.host.startedAt));});
 const todo=manual.map(task=>task.id),targets=new Set(manual.map(task=>task.targetId));
 const state=U.noteManualCapacity({...current.unattendedState,manualTodoIds:todo},targets.size,Date.now());
 if(JSON.stringify(state)!==JSON.stringify(current.unattendedState))save(runtime,{...current,unattendedState:state});return{...current,unattendedState:state};
}
export function releaseBatchTask(runtime,batch,task,patch,index=batch.cursor){
 assertBatchPolicy(runtime,batch);const config=batchConfig(batch),changes={...patch,fillOnlyRun:config.fillOnly===true,manualSubmissionConsent:null};let next={...batch};
 if(batch.status!=='running'||runtime.store.get('paused')!==false)return false;
 const resuming=batch.resumingPausedTaskIds?.includes(task.id)&&task.pauseContinuation?.batchId===batch.id&&task.pauseContinuation?.scope===batch.scope&&!task.attemptBoundary&&!task.receipt&&['targetId','browserInstance','taskDeadlineAt','profileRevision'].every(key=>task.pauseContinuation[key]===task[key]);
 if(config.unattended){
  const state=U.createCheckpoint(config,Date.now(),batch.unattendedState),decision=U.canStartTask(state,Date.now());
  if(!decision.ok&&(!resuming||decision.reason==='deadline')){pauseBatchPolicy(runtime,batch,decision.reason);return false;}
  if(resuming&&task.taskDeadlineAt&&Date.now()>=task.taskDeadlineAt){const result=U.interruptedTaskStatus({status:'running'});next.items[index].status='complete';next.items[index].result=result.status;next.items[index].reason=reasons.task_deadline;next.unattendedState=U.addManualTodo(state,task.id);next.resumingPausedTaskIds=next.resumingPausedTaskIds.filter(id=>id!==task.id);runtime.update(task,{...result,reason:reasons.task_deadline,attentionType:'unattended_timeout',pauseContinuation:null},'paused_task_deadline',{['workbenchBatch:'+batch.id]:next});return false;}
  const already=task.unattendedClaimed===true&&task.unattendedBatchId===batch.id;
  const claim=already?{ok:true,next:state}:U.claimTask(state,Date.now());if(!claim.ok){pauseBatchPolicy(runtime,batch,claim.reason);return false;}
  next.unattendedState=claim.next;changes.unattendedBatchId=batch.id;changes.unattendedClaimed=true;changes.taskDeadlineAt=resuming?task.taskDeadlineAt:U.taskDeadline(claim.next,Date.now());
 }
 if(resuming){next.resumingPausedTaskIds=next.resumingPausedTaskIds.filter(id=>id!==task.id);changes.pauseContinuation=null;}
 const item=next.items[index];if(item?.taskId!==task.id)throw Error('原批次任务身份已变化');item.status='running';item.startedAt=item.startedAt||new Date().toISOString();
 runtime.update(task,changes,'workbench_task_released',{['workbenchBatch:'+batch.id]:next});return true;
}
export function reserveBatchModelCall(runtime,task){
 const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(!batch||!batchConfig(batch).unattended)return;
 if(hasManualSubmissionConsent(runtime,task))return;
 assertBatchPolicy(runtime,batch);const result=U.reserveModelCall(U.createCheckpoint(batchConfig(batch),Date.now(),batch.unattendedState),Date.now());
 if(!result.ok){pauseBatchPolicy(runtime,batch,result.reason,task.id);throw Error(reasons[result.reason]||'无人值守调用预算不足');}
 if(batch.status!=='running'||runtime.store.get('paused')!==false)throw Error('原无人值守批次已暂停，未调用模型');save(runtime,{...batch,unattendedState:result.next});
}
export function batchActionAllowed(runtime,task){
 const skip=runtime.store.get('manualSkipPending:'+task.id);if(skip?.scope===workbenchScope(runtime.store.get('pair')))return false;
 const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(!batch)return !task.workbenchBatchId||hasManualSubmissionConsent(runtime,task);
 assertBatchPolicy(runtime,batch);if(hasManualSubmissionConsent(runtime,task)||!batchConfig(batch).unattended)return true;if(batch.status!=='running')return false;
 if(batchConfig(batch).unattended){const now=Date.now();if(U.isExpired(batch.unattendedState,now)){pauseBatchPolicy(runtime,batch,'deadline',task.id);return false;}if(task.taskDeadlineAt&&now>=task.taskDeadlineAt){interruptBatchTask(runtime,batch,task.id);return false;}}
 return !batch.interruptedTasks?.[task.id];
}
export function watchBatchDeadline(runtime){
 const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id);if(batch?.status!=='running'||!batchConfig(batch).unattended)return;
 const ids=new Set([...(runtime.activeTaskIds||[]),runtime.activeTaskId,runtime.store.get('singleTaskId')].filter(Boolean)),tasks=[...ids].map(id=>runtime.store.get('task:'+id)).filter(task=>task?.workbenchBatchId===batch.id),now=Date.now();
 if(U.isExpired(batch.unattendedState,now)){pauseBatchPolicy(runtime,batch,'deadline');for(const task of tasks)pauseBatchPolicy(runtime,batch,'deadline',task.id);}
 else for(const task of tasks)if(task.taskDeadlineAt&&now>=task.taskDeadlineAt&&!task.receipt&&['pending','opening','filling','submitting'].includes(task.status))interruptBatchTask(runtime,batch,task.id);
}
export function finalizeBatchDeadline(runtime,task){
 const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(!batch?.interruptedTasks?.[task.id]||task.receipt)return;
 const code=batch.taskInterruptionReasons?.[task.id]||batch.pauseReasonCode;
 runtime.update(task,{status:task.attemptBoundary?'submitted_unconfirmed':'needs_manual',siteStatus:task.attemptBoundary?'sent_unconfirmed':'not_submitted',attentionType:task.attemptBoundary?'unknown_receipt':['deadline','task_deadline'].includes(code)?'unattended_timeout':'unattended_paused',reason:code==='task_deadline'?reasons.task_deadline:batch.reason},'unattended_task_interrupted');
}
export function retainBatchManualPage(runtime,task){
 const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId),config=batch&&batchConfig(batch);
 return !!(config&&(config.fillOnly||config.unattended)&&!task.receipt&&!task.tabClosedAt&&['needs_manual','submitted_unconfirmed'].includes(task.status));
}
export function noteBatchTaskResult(runtime,batch,task){
 if(!batchConfig(batch).unattended)return batch;
 let state=batch.unattendedState;
 if(task.targetId&&!task.tabClosedAt&&!task.receipt&&!['skip','excluded','failed'].includes(task.status))state=U.addManualTodo(state,task.id);else state=U.removeManualTodo(state,task.id);
 if(task.receipt)state=U.noteSuccess(state);
 else if(batch.taskInterruptionReasons?.[task.id]==='task_deadline'||task.status==='failed'||task.status==='err'||['site_unavailable','site_form_unavailable','missing_fields','missing_real_identity','unattended_timeout'].includes(task.attentionType)){
  const failure=U.noteFailure(state,task.reason||'原任务失败',Date.now());state=failure.next;if(failure.pause){state.stopReason=reasons.consecutive_failures;batch.status='paused';batch.reason=reasons.consecutive_failures;runtime.store.set('paused',true);}
 }
 return{...batch,unattendedState:state};
}
