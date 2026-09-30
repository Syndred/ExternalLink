import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {recoveryCheckpoint} from './tab-cleanup.mjs';import {getTargetInfo} from './browser-target.mjs';
export async function closeAcceptanceTask(runtime,task){
 if(!(task.acceptanceId||task.workbenchBatchId)||!task.targetId||task.tabClosedAt)return;
 if(task.attemptBoundary&&!task.receipt)return; // Preserve original verification page.
 if(!task.screenshot||!['needs_manual','finished','excluded'].includes(task.status))return;
 const frozen=runtime.store.get('acceptance:'+task.acceptanceId),execution=runtime.store.get('acceptanceExecution:'+task.acceptanceId);
 const workbench=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
 if(!frozen?.combinations.some(c=>c.existingTaskId===task.id||execution?.items[c.identity]?.taskId===task.id)&&!workbench?.items.some(i=>i.taskId===task.id))throw Error('原任务不属于固定范围，禁止关页');
 const bytes=await readFile(task.screenshot),sha256=createHash('sha256').update(bytes).digest('hex');
 const original=await runtime.findPage(task),closedAt=new Date().toISOString();
 const checkpoint={...recoveryCheckpoint(task,original,task.screenshot,closedAt),screenshotSha256:sha256,cloudSyncPending:!task.artifactRef};
 runtime.update(task,{recoveryCheckpoint:checkpoint},'fixed_task_recovery_checkpoint');
 const owned=new Set([task.targetId,...(task.authBrowserInstance===runtime.host.startedAt?[task.authTargetId]:[]),...(task.authPages||[]).filter(p=>p.browserInstance===runtime.host.startedAt).map(p=>p.targetId)]);
 const closed=[];
 for(const page of runtime.context.pages()){
  if(!/^https?:\/\//.test(page.url()))continue;
  const info=await getTargetInfo(runtime.context,page);
  if(!owned.has(info?.targetId)&&info?.openerId!==task.targetId)continue;
  await page.close();closed.push(info.targetId);
 }
 runtime.update(task,{tabClosedAt:closedAt,closedTargetIds:closed,closeReason:task.receipt?'站方已收件，原证据保留':'原任务未投稿阻塞，恢复点已持久保存'},'fixed_task_tabs_closed');
}
