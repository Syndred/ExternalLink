import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {recoveryCheckpoint} from './tab-cleanup.mjs';import {getTargetInfo} from './browser-target.mjs';
import {retainBatchManualPage} from './workbench-batch-policy.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {isDeepStrictEqual} from 'node:util';
export async function closeAcceptanceTask(runtime,task){
 const deadEnd=task.originalDestinationDisposition?.kind==='dead_end'&&['skip','err'].includes(task.status)&&task.attentionType==='destination_dead_end';
 if(!(task.acceptanceId||task.workbenchBatchId||deadEnd)||!task.targetId||task.tabClosedAt)return;
 if(retainBatchManualPage(runtime,task))return;
 const pausedBatch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(pausedBatch?.status==='paused'&&pausedBatch.pauseReasonCode==='user_pause'&&pausedBatch.pausedTaskIds?.includes(task.id))return;
 if(task.attemptBoundary&&!task.receipt)return; // Preserve original verification page.
 if(!task.screenshot||!['needs_manual','finished','excluded','skip','err'].includes(task.status))return;
 const scope=workbenchScope(runtime.store.get('pair')),paused=runtime.store.get('paused'),original=structuredClone(task);
 const check=()=>{const current=runtime.store.get('task:'+task.id),batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(!current||scope!==workbenchScope(runtime.store.get('pair'))||paused!==runtime.store.get('paused')||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||current.receipt&&!original.receipt||current.attemptBoundary&&!original.attemptBoundary||['ai','supervisor'].includes(current.controller)||current.browserInstance!==runtime.host.startedAt||['id','runId','profileId','profileRevision','version','controllerId','targetId','browserInstance','status','reason','attemptBoundary','acceptanceId','workbenchBatchId'].some(key=>current[key]!==original[key])||!isDeepStrictEqual(current.profileSnapshot,original.profileSnapshot)||batch?.status==='paused'&&batch.pauseReasonCode==='user_pause'&&batch.pausedTaskIds?.includes(task.id))throw Object.assign(Error('原任务或控制状态已变化，关页停止'),{staleTask:true});};
 check();
 const frozen=runtime.store.get('acceptance:'+task.acceptanceId),execution=runtime.store.get('acceptanceExecution:'+task.acceptanceId);
 const workbench=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
 const run=!task.acceptanceId&&!task.workbenchBatchId&&runtime.store.get('run:'+task.runId);
 if(!frozen?.combinations.some(c=>c.existingTaskId===task.id||execution?.items[c.identity]?.taskId===task.id)&&!workbench?.items.some(i=>i.taskId===task.id)&&!(deadEnd&&run?.id===task.runId&&run.profileId===task.profileId&&run.tasks?.some(item=>(typeof item==='string'?item:item.id)===task.id)))throw Error('原任务不属于固定范围或原运行组，禁止关页');
 let bytes;try{bytes=await readFile(task.screenshot);}catch(error){check();throw error;}const sha256=createHash('sha256').update(bytes).digest('hex');
 check();const originalPage=await runtime.findPage(task),closedAt=new Date().toISOString();check();
 const checkpoint={...recoveryCheckpoint(task,originalPage,task.screenshot,closedAt),screenshotSha256:sha256,cloudSyncPending:!task.artifactRef};
 if(deadEnd){checkpoint.stage='destination_dead_end';checkpoint.nextStep='目标网站无法继续，取消原因已保存；修改站点条件后明确重试原任务';checkpoint.formRecoverability='destination_dead_end_requires_explicit_retry';}
 runtime.update(task,{recoveryCheckpoint:checkpoint},'fixed_task_recovery_checkpoint');
 const owned=new Set([task.targetId,...(task.authBrowserInstance===runtime.host.startedAt?[task.authTargetId]:[]),...(task.authPages||[]).filter(p=>p.browserInstance===runtime.host.startedAt).map(p=>p.targetId)]);
 const closed=[];
 for(const page of runtime.context.pages()){
  check();
  if(!/^https?:\/\//.test(page.url()))continue;
  const info=await getTargetInfo(runtime.context,page);
  check();
  if(!owned.has(info?.targetId)&&info?.openerId!==task.targetId)continue;
  if(runtime.store.values('task:').some(other=>other.id!==task.id&&other.targetId===info.targetId&&other.browserInstance===task.browserInstance&&!other.tabClosedAt&&(!['skip','err','excluded'].includes(other.status)||other.attemptBoundary||other.receipt)))throw Error('原页仍被其他任务关联，保留页签');
  await page.close();closed.push(info.targetId);
 }
 check();
 runtime.update(task,{tabClosedAt:closedAt,closedTargetIds:closed,closeReason:task.receipt?'站方已收件，原证据保留':'原任务未投稿阻塞，恢复点已持久保存'},'fixed_task_tabs_closed');
}
