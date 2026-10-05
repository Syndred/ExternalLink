import {randomUUID} from 'node:crypto';
import {priorProductSuccess,plain} from './shared.mjs';
import {recoveryCheckpoint} from './tab-cleanup.mjs';
import {workbenchScope} from './workbench-sync.mjs';
const at=()=>new Date().toISOString();
function selectedTask(runtime,input){const task=runtime.store.get('task:'+input.taskId);if(!task?.runId||input.expectedRunId!==task.runId)throw Error('原任务或批次已变化，请刷新后重试');if(input.expectedTargetId!==undefined&&input.expectedTargetId!==task.targetId)throw Error('原标签页已变化，请刷新后重试');if(['supervisor','ai'].includes(task.controller))throw Error('请先等待原控制器交回任务');return task;}
function finishSkippedScope(runtime,task){
 const time=at(),fixed=runtime.store.get('acceptanceBatch'),execution=fixed&&runtime.store.get('acceptanceExecution:'+fixed.id),frozen=fixed&&runtime.store.get('acceptance:'+fixed.id);
 if(fixed&&frozen){const index=frozen.combinations.findIndex(c=>c.existingTaskId===task.id||execution?.items[c.identity]?.taskId===task.id);if(index>=0){const identity=frozen.combinations[index].identity;fixed.attempts||={};fixed.attempts[identity]={...fixed.attempts[identity],taskId:task.id,status:task.receipt?'received':task.attemptBoundary?'verification_only':'manual_skip',reason:task.reason,completedAt:time,manualSkipped:true};if(index===fixed.cursor)fixed.cursor++;runtime.store.set('acceptanceBatch',fixed);}}
 const activeId=runtime.store.get('activeWorkbenchBatch'),batch=activeId&&runtime.store.get('workbenchBatch:'+activeId);
 if(batch){const index=batch.items.findIndex(i=>i.taskId===task.id);if(index>=0){const item=batch.items[index];item.status='complete';item.result=task.receipt?'received':task.attemptBoundary?'sent_unconfirmed':'manual_skip';item.manualSkipped=true;item.reason=task.reason;item.completedAt=time;if(index===batch.cursor)batch.cursor++;runtime.store.set('workbenchBatch:'+batch.id,batch);}}
}
export async function manualSkip(runtime,input){
 const selected=selectedTask(runtime,input);if(runtime.store.get('executionStopped'))throw Error('本次执行已经停止，请明确重新开始原范围');const running=runtime.store.get('paused')===false,active=runtime.store.get('singleTaskId')||runtime.activeTaskId,originalPlan=runtime.store.get('libraryPlan');
 if(runtime.job&&active!==input.taskId)throw Error('正在处理其他任务，请先暂停');
 if(runtime.store.get('paused')!==true||runtime.job)await runtime.control('pause',{reason:'用户人工跳过当前任务'});
 const task=selectedTask(runtime,input);await runtime.lease(task,{online:true});
 runtime.update(task,{...(!task.attemptBoundary&&!task.receipt?{status:'skip',siteStatus:'not_submitted'}:{}),manualDisposition:{action:'skip_current_run',at:at(),reason:String(input.reason||'用户跳过本次处理').slice(0,2000)},reason:task.attemptBoundary||task.receipt?task.reason:'用户跳过本次处理，未投稿'},'manual_skip');
 finishSkippedScope(runtime,task);
 let syncError='';try{await runtime.synchronize();}catch(error){syncError=error.message;}
 // A paused task stays paused. If this was the running task, the original
 // batch may continue only after the skip has been saved and read back.
 if(running&&!syncError){const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id),fixed=runtime.store.get('acceptanceBatch'),plan=runtime.store.get('libraryPlan');if(batch?.status==='paused'&&batch.items.some(i=>i.taskId===selected.id)){runtime.store.set('workbenchBatch:'+id,{...batch,status:'running'});runtime.store.set('paused',false);}else if(fixed?.status==='paused'&&Object.values(fixed.attempts||{}).some(a=>a.taskId===selected.id&&a.manualSkipped)){runtime.store.set('acceptanceBatch',{...fixed,status:'running'});runtime.store.set('paused',false);}else if(plan?.id===originalPlan?.id&&plan?.status==='active'&&selected.libraryPlanId===plan.id){runtime.store.set('libraryPlan',{...plan,globalPause:null});runtime.store.set('paused',false);}else if(active===selected.id&&runtime.store.get('run:'+selected.runId)){runtime.store.set('manualResumeRunId',selected.runId);runtime.store.set('paused',false);}runtime.store.set('singleTaskId',null);runtime.tick();}
 return{ok:true,taskId:task.id,skipped:true,submitted:!!task.attemptBoundary,receiptPreserved:!!task.receipt,syncError};
}
export async function manualSubmit(runtime,input){
 if(input.ordinaryPermissionsAuthorized!==true)throw Error('请确认继续原任务的普通免费投稿');
 if(runtime.store.get('executionStopped'))throw Error('本次执行已经停止，请明确重新开始原范围');
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.get('singleTaskId'))throw Error('请先暂停并等待当前操作结束');
 const task=selectedTask(runtime,input);if(task.attemptBoundary||task.receipt||!['pending','needs_manual'].includes(task.status))throw Error('已有尝试结果或非待处理状态，请先核验原任务');
 if(input.expectedTargetId!==task.targetId||!task.targetId)throw Error('原标签页已变化，请重新准备原任务');
 const scope=workbenchScope(runtime.store.get('pair')),identity={runId:task.runId,profileId:task.profileId,url:task.url,targetId:task.targetId,browserInstance:task.browserInstance,profileRevision:task.profileRevision};
 const assertCurrent=()=>{const current=selectedTask(runtime,input);if(scope!==workbenchScope(runtime.store.get('pair'))||Object.entries(identity).some(([key,value])=>current[key]!==value)||input.confirmProductHuntCreate===true&&current.productHunt?.readyToCreate!==true||current.attemptBoundary||current.receipt||!['pending','needs_manual'].includes(current.status)||runtime.job||runtime.store.get('paused')!==true||runtime.store.get('singleTaskId')||runtime.store.get('executionStopped'))throw Error('原任务、资料、工作区或执行状态已变化，请重新确认');};
 if(input.confirmProductHuntCreate===true&&(!/(^|\.)producthunt\.com$/i.test(new URL(task.url).hostname)||task.productHunt?.readyToCreate!==true))throw Error('请先完成原 Product Hunt 逐步填写，再确认创建草稿');
 await runtime.findPage(task);assertCurrent();const snapshot=await runtime.cloud.request('snapshot'),current=snapshot.documents.siteProfiles?.[task.profileId];assertCurrent();if(!current||current.archived||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('产品不可用或同站已收件，请刷新核验');
 const run=runtime.store.get('run:'+task.runId);if(!run)throw Error('原任务批次不可读，请先同步');
 const profile=task.profileSnapshot||run.profile||current;await runtime.lease(task,{online:true});assertCurrent();
 const productHuntCreationConsent=input.confirmProductHuntCreate===true?{at:at(),runId:task.runId,profileId:task.profileId,targetId:task.targetId,profileRevision:task.profileRevision??snapshot.revisions.siteProfiles,browserInstance:task.browserInstance}:null;
 const manualSubmissionConsent={scope,at:at(),...identity,profileRevision:task.profileRevision??snapshot.revisions.siteProfiles};
 if(input.confirmProductHuntCreate===true&&(!/(^|\.)producthunt\.com$/i.test(new URL(task.url).hostname)||task.productHunt?.readyToCreate!==true))throw Error('请先完成原 Product Hunt 逐步填写，再确认创建草稿');
 runtime.update(task,{status:'pending',controller:'executor',profileSnapshot:plain(profile),profileRevision:task.profileRevision??snapshot.revisions.siteProfiles,fillOnlyRun:false,submitPreparedRun:false,productHuntCreationConsent,manualSubmissionConsent,attentionType:'',reason:'用户继续原任务，重新检测和校验后执行',consentHistory:[...(task.consentHistory||[]),{at:at(),scope:'ordinary_submission_permissions',source:'workbench_manual_continue',text:'用户在原任务详情确认普通免费投稿；额外权限及本人验证仍留待人工'},...(productHuntCreationConsent?[{at:at(),scope:'producthunt_create_draft',source:'workbench_manual_continue',text:'用户明确确认创建原 Product Hunt 草稿；未授权排期、推广或购买'}]:[])]},'manual_continue');
 identity.profileRevision=task.profileRevision;await runtime.synchronize();assertCurrent();runtime.store.set('singleTaskId',task.id);runtime.store.set('paused',false);runtime.tick();return{ok:true,taskId:task.id,running:true};
}
export function stopTabDisposition(task){
 return task.attemptBoundary&&!task.receipt||task.status==='needs_manual'||['ai','supervisor'].includes(task.controller)||task.pageOwnership==='manual'||task.pageHistory?.length||task.authTargetId||task.registration?.boundary||task.loginLinkRequest?.boundary?'preserve_manual':'close_automated';
}
export async function stopExecution(runtime,input={}){
 const id=randomUUID(),time=at(),owned=new Set([runtime.activeTaskId,runtime.store.get('singleTaskId')].filter(Boolean)),workbenchId=runtime.store.get('activeWorkbenchBatch'),workbench=workbenchId&&runtime.store.get('workbenchBatch:'+workbenchId),fixed=runtime.store.get('acceptanceBatch'),execution=fixed&&runtime.store.get('acceptanceExecution:'+fixed.id),plan=runtime.store.get('libraryPlan');
 const activeRuns=new Set([...owned].map(id=>runtime.store.get('task:'+id)?.runId).filter(Boolean));if(runtime.store.get('manualResumeRunId'))activeRuns.add(runtime.store.get('manualResumeRunId'));
 for(const item of workbench?.items||[])if(item.taskId)owned.add(item.taskId);for(const item of Object.values(execution?.items||{}))if(item.taskId)owned.add(item.taskId);for(const task of runtime.store.values('task:'))if(plan?.id&&task.libraryPlanId===plan.id||activeRuns.has(task.runId))owned.add(task.id);
 runtime.store.set('executionStopped',{id,at:time,reason:'用户停止本次执行',status:'stopping',taskIds:[...owned]});runtime.store.set('paused',true);
 if(plan)runtime.store.set('libraryPlan',{...plan,globalPause:{...plan.globalPause,attentionType:'user_stopped',resumeEligible:false,reason:'用户停止本次执行',at:time}});
 let executionError='';if(runtime.job)try{await runtime.job;}catch(error){executionError=error.message;}
 if(workbench){const latest=runtime.store.get('workbenchBatch:'+workbenchId);runtime.store.set('workbenchBatch:'+workbenchId,{...latest,status:'stopped',stoppedAt:time});runtime.store.set('activeWorkbenchBatch',null);}
 if(fixed)runtime.store.set('acceptanceBatch',{...runtime.store.get('acceptanceBatch'),status:'stopped',stoppedAt:time});
 runtime.store.set('singleTaskId',null);runtime.store.set('manualResumeRunId',null);const results=[],closedTargets=new Set(),protectedTargets=new Set(runtime.store.values('task:').filter(t=>stopTabDisposition(t)==='preserve_manual').map(t=>t.targetId).filter(Boolean));
 for(const taskId of owned){const task=runtime.store.get('task:'+taskId);if(!task?.targetId||task.tabClosedAt)continue;
  if(protectedTargets.has(task.targetId)){results.push({taskId,disposition:'preserve_manual'});continue;}
  if(closedTargets.has(task.targetId))continue;
  try{const page=await runtime.findPage(task);await runtime.lease(task,{online:true});const closedAt=at(),checkpoint=recoveryCheckpoint(task,page,task.screenshot||'',closedAt);runtime.update(task,{recoveryCheckpoint:checkpoint,stopCheckpoint:{id,at:time,targetId:task.targetId},...(!task.receipt?{status:'pending',reason:'本次执行已停止；原任务保留，可重新开始'}:{})},'stop_page_checkpoint');await page.close({runBeforeUnload:false});closedTargets.add(task.targetId);runtime.update(task,{tabClosedAt:closedAt},'stop_automated_page_closed');results.push({taskId,disposition:'closed_automated'});}catch(error){results.push({taskId,disposition:'preserved_after_error',error:error.message});}
 }
 let syncError='';try{await runtime.synchronize();}catch(error){syncError=error.message;}
 const result={id,at:time,status:'stopped',taskIds:[...owned],results,syncError,executionError};runtime.store.set('executionStopped',result);return{ok:true,stopped:true,...result};
}
