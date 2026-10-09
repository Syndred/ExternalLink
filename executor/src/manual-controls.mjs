import {randomUUID} from 'node:crypto';
import {priorProductSuccess,plain} from './shared.mjs';
import {recoveryCheckpoint} from './tab-cleanup.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {assertOriginalBatch,persistBatchLifecycle} from './execution-lifecycle.mjs';
import {batchConfig} from './workbench-batch-policy.mjs';
import {originalUnattended as U} from '../../core/original-batch-config.mjs';
import {observeParkedResumePage,parkedResumeIntent} from './parked-task-resume.mjs';
import {retainOriginalManualSkipPage} from './original-agent-unavailable.mjs';
const at=()=>new Date().toISOString();
export function manualTargetIds(runtime,scope,excluded){return new Set(runtime.store.values('task:').filter(other=>{const source=other.workbenchBatchId&&runtime.store.get('workbenchBatch:'+other.workbenchBatchId);return other.id!==excluded&&source&&(!source.scope||source.scope===scope)&&other.targetId&&!other.tabClosedAt&&!other.receipt&&['needs_manual','submitted_unconfirmed'].includes(other.status);}).map(other=>other.targetId));}
function selectedTask(runtime,input){const task=runtime.store.get('task:'+input.taskId);if(!task?.runId||input.expectedRunId!==task.runId)throw Error('原任务或批次已变化，请刷新后重试');if(input.expectedTargetId!==undefined&&input.expectedTargetId!==task.targetId)throw Error('原标签页已变化，请刷新后重试');if(['supervisor','ai'].includes(task.controller))throw Error('请先等待原控制器交回任务');return task;}
function finishSkippedScope(runtime,task){
 const time=at(),fixed=runtime.store.get('acceptanceBatch'),execution=fixed&&runtime.store.get('acceptanceExecution:'+fixed.id),frozen=fixed&&runtime.store.get('acceptance:'+fixed.id);
 if(fixed&&frozen){const index=frozen.combinations.findIndex(c=>c.existingTaskId===task.id||execution?.items[c.identity]?.taskId===task.id);if(index>=0){const identity=frozen.combinations[index].identity;fixed.attempts||={};fixed.attempts[identity]={...fixed.attempts[identity],taskId:task.id,status:task.receipt?'received':task.attemptBoundary?'verification_only':'manual_skip',reason:task.reason,completedAt:time,manualSkipped:true};if(index===fixed.cursor)fixed.cursor++;runtime.store.set('acceptanceBatch',fixed);}}
 const activeId=runtime.store.get('activeWorkbenchBatch'),batch=activeId&&runtime.store.get('workbenchBatch:'+activeId);
 if(batch){const index=batch.items.findIndex(i=>i.taskId===task.id);if(index>=0){const item=batch.items[index];item.status='complete';item.result=task.receipt?'received':task.attemptBoundary?'sent_unconfirmed':'manual_skip';item.manualSkipped=true;item.reason=task.reason;item.completedAt=time;if(index===batch.cursor)batch.cursor++;runtime.store.set('workbenchBatch:'+batch.id,batch);}}
}
export async function manualSkip(runtime,input,guards={}){
 guards.assertContext?.();await guards.assertPageDocument?.();
 const selected=selectedTask(runtime,input);if(runtime.store.get('executionStopped'))throw Error('本次执行已经停止，请明确重新开始原范围');const workbenchId=runtime.store.get('activeWorkbenchBatch'),workbench=workbenchId&&runtime.store.get('workbenchBatch:'+workbenchId);if(workbench?.items.some(item=>item.taskId===selected.id))return skipWorkbenchTask(runtime,input,workbench,guards);
 const running=runtime.store.get('paused')===false,active=runtime.store.get('singleTaskId')||runtime.activeTaskId,originalPlan=runtime.store.get('libraryPlan');
 if(runtime.job&&active!==input.taskId)throw Error('正在处理其他任务，请先暂停');
 if(runtime.store.get('paused')!==true||runtime.job)await runtime.control('pause',{reason:'用户人工跳过当前任务'});
 if(runtime.job)await runtime.job;
 const task=selectedTask(runtime,input);await runtime.lease(task,{online:true});await guards.assertPageDocument?.();guards.assertContext?.();
 runtime.update(task,{...(!task.attemptBoundary&&!task.receipt?{status:'skip',siteStatus:'not_submitted'}:{}),manualDisposition:{action:'skip_current_run',at:at(),reason:String(input.reason||'用户跳过本次处理').slice(0,2000)},reason:task.attemptBoundary||task.receipt?task.reason:'用户跳过本次处理，未投稿'},'manual_skip');
 finishSkippedScope(runtime,task);
 let syncError='';try{await runtime.synchronize();}catch(error){syncError=error.message;}
 // A paused task stays paused. If this was the running task, the original
 // batch may continue only after the skip has been saved and read back.
 if(running&&!syncError){const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id),fixed=runtime.store.get('acceptanceBatch'),plan=runtime.store.get('libraryPlan');if(batch?.status==='paused'&&batch.items.some(i=>i.taskId===selected.id)){runtime.store.set('workbenchBatch:'+id,{...batch,status:'running'});runtime.store.set('paused',false);}else if(fixed?.status==='paused'&&Object.values(fixed.attempts||{}).some(a=>a.taskId===selected.id&&a.manualSkipped)){runtime.store.set('acceptanceBatch',{...fixed,status:'running'});runtime.store.set('paused',false);}else if(plan?.id===originalPlan?.id&&plan?.status==='active'&&selected.libraryPlanId===plan.id){runtime.store.set('libraryPlan',{...plan,globalPause:null});runtime.store.set('paused',false);}else if(active===selected.id&&runtime.store.get('run:'+selected.runId)){runtime.store.set('manualResumeRunId',selected.runId);runtime.store.set('paused',false);}runtime.store.set('singleTaskId',null);runtime.tick();}
 return{ok:true,taskId:task.id,skipped:true,submitted:!!task.attemptBoundary,receiptPreserved:!!task.receipt,syncError};
}
async function skipWorkbenchTask(runtime,input,batch,guards={}){
 assertOriginalBatch(runtime,batch);const selected=selectedTask(runtime,input),scope=workbenchScope(runtime.store.get('pair')),key='manualSkipPending:'+selected.id,old=runtime.store.get(key),request=old||{id:randomUUID(),scope,batchId:batch.id,taskId:selected.id,runId:selected.runId,at:at(),stage:'requested'};
 const check=()=>{guards.assertContext?.();if(scope!==workbenchScope(runtime.store.get('pair'))||batch.id!==runtime.store.get('activeWorkbenchBatch')||runtime.store.get('executionStopped'))throw Error('工作区或原批次已变化，原跳过请求保留');return selectedTask(runtime,input);};
 if(old&&(old.scope!==scope||old.batchId!==batch.id||old.runId!==selected.runId))throw Error('原跳过请求属于其他范围');
 runtime.store.set(key,request);runtime.wakeWorkbench?.();
 // Only the selected worker is cancelled. Its destination stays reserved until
 // its original event has an independent cloud readback; other groups continue.
 const owned=runtime.workbenchTaskJobs?.get(selected.id);if(owned)await owned;
 const task=check();let event;
 try{
  if(request.stage!=='await_sync'){
   await runtime.lease(task,{online:true});await guards.assertPageDocument?.();check();const current=runtime.store.get('workbenchBatch:'+batch.id);assertOriginalBatch(runtime,current);
   const item=current.items.find(item=>item.taskId===task.id);item.status='complete';item.result=task.receipt?'received':task.attemptBoundary?'sent_unconfirmed':'manual_skip';item.manualSkipped=true;item.reason=task.attemptBoundary||task.receipt?task.reason:'用户跳过本次处理，未投稿';item.completedAt=at();
   while(current.cursor<current.items.length&&['complete','excluded'].includes(current.items[current.cursor].status))current.cursor++;
   if(current.config?.unattended)current.unattendedState=U.removeManualTodo(current.unattendedState,task.id);
   event=runtime.update(task,{...(!task.attemptBoundary&&!task.receipt?{status:'skip',siteStatus:'not_submitted',manualSubmissionConsent:null,productHuntCreationConsent:null,...(task.originalResume?{originalResume:{...task.originalResume,status:'cancelled'}}:{})}:{}),manualDisposition:{action:'skip_current_run',at:request.at,requestId:request.id,reason:String(input.reason||'用户跳过本次处理').slice(0,2000)},reason:task.attemptBoundary||task.receipt?task.reason:'用户跳过本次处理，未投稿'},'manual_skip',{['workbenchBatch:'+batch.id]:current,[key]:{...request,stage:'await_sync'}});
  }
  await runtime.synchronize();check();await flushBatchTaskEvents(runtime,task,event?.id);check();
  let retained=false;
  if(stopTabDisposition(task)==='close_automated'){retained=await retainOriginalManualSkipPage(runtime,task);check();if(retained){await flushBatchTaskEvents(runtime,task);check();}}
  if(!retained&&task.targetId&&!task.tabClosedAt&&!task.receipt&&!task.attemptBoundary&&stopTabDisposition(task)==='close_automated'&&!runtime.store.values('task:').some(other=>other.id!==task.id&&other.targetId===task.targetId&&stopTabDisposition(other)==='preserve_manual')){
   const page=await runtime.findPage(task);check();const time=at();runtime.update(task,{recoveryCheckpoint:recoveryCheckpoint(task,page,task.screenshot||'',time)},'manual_skip_page_checkpoint');await page.close({runBeforeUnload:false});runtime.update(task,{tabClosedAt:time,closeReason:'用户跳过本次处理，原任务与恢复点保留'},'manual_skip_page_closed');await flushBatchTaskEvents(runtime,task);check();
  }
  runtime.store.set(key,null);runtime.wakeWorkbench?.();runtime.tick();
  return{ok:true,taskId:task.id,skipped:true,isolated:true,submitted:!!task.attemptBoundary,receiptPreserved:!!task.receipt,syncError:''};
 }catch(error){runtime.store.set(key,{...runtime.store.get(key),error:error.message});return{ok:true,taskId:task.id,skipped:!!runtime.store.get('task:'+task.id)?.manualDisposition,isolated:true,submitted:!!task.attemptBoundary,receiptPreserved:!!task.receipt,syncError:error.message};}
}
export async function manualSubmit(runtime,input,{assertContext=()=>{},assertPageDocument=async()=>{},preserveOriginalPermissions=false,fromPage=false,deferTick=false}={}){
 assertContext();
 await assertPageDocument();
 if(!preserveOriginalPermissions&&input.ordinaryPermissionsAuthorized!==true)throw Error('请确认继续原任务的普通免费投稿');
 if(runtime.store.get('executionStopped'))throw Error('本次执行已经停止，请明确重新开始原范围');
 const task=selectedTask(runtime,input);if(task.attemptBoundary||task.receipt||!['pending','needs_manual'].includes(task.status))throw Error('已有尝试结果或非待处理状态，请先核验原任务');
 if(runtime.store.get('manualSkipPending:'+task.id)?.scope===workbenchScope(runtime.store.get('pair'))||task.manualDisposition)throw Error('原任务正在跳过或已经跳过，请刷新核验');
 const activeBatchId=runtime.store.get('activeWorkbenchBatch'),parallel=!!(runtime.workbenchTaskJobs&&task.workbenchBatchId===activeBatchId&&runtime.store.get('workbenchBatch:'+activeBatchId)?.status==='running'&&runtime.store.get('paused')===false&&!runtime.workbenchTaskJobs.has(task.id)&&!runtime.activeTaskIds?.has(task.id));
 if((!parallel&&(runtime.job||runtime.store.get('paused')!==true))||runtime.store.get('singleTaskId'))throw Error('请先暂停并等待当前操作结束');
 if(input.expectedTargetId!==task.targetId||!task.targetId)throw Error('原标签页已变化，请重新准备原任务');
 const scope=workbenchScope(runtime.store.get('pair')),identity={runId:task.runId,profileId:task.profileId,url:task.url,targetId:task.targetId,browserInstance:task.browserInstance,profileRevision:task.profileRevision};
 const assertCurrent=()=>{assertContext();const current=selectedTask(runtime,input),executionChanged=parallel?(runtime.store.get('activeWorkbenchBatch')!==activeBatchId||runtime.store.get('workbenchBatch:'+activeBatchId)?.status!=='running'||runtime.store.get('paused')!==false||runtime.workbenchTaskJobs?.has(task.id)||runtime.activeTaskIds?.has(task.id)):(runtime.job||runtime.store.get('paused')!==true);if(scope!==workbenchScope(runtime.store.get('pair'))||Object.entries(identity).some(([key,value])=>current[key]!==value)||input.confirmProductHuntCreate===true&&current.productHunt?.readyToCreate!==true||current.attemptBoundary||current.receipt||!['pending','needs_manual'].includes(current.status)||executionChanged||runtime.store.get('singleTaskId')||runtime.store.get('executionStopped'))throw Error('原任务、资料、工作区或执行状态已变化，请重新确认');};
 if(input.confirmProductHuntCreate===true&&(!/(^|\.)producthunt\.com$/i.test(new URL(task.url).hostname)||task.productHunt?.readyToCreate!==true))throw Error('请先完成原 Product Hunt 逐步填写，再确认创建草稿');
 const originalPage=await runtime.findPage(task);assertCurrent();const snapshot=await runtime.cloud.request('snapshot'),current=snapshot.documents.siteProfiles?.[task.profileId];assertCurrent();if(!current||current.archived||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('产品不可用或同站已收件，请刷新核验');
 const run=runtime.store.get('run:'+task.runId);if(!run)throw Error('原任务批次不可读，请先同步');
 const profile=task.profileSnapshot||run.profile||current;await runtime.lease(task,{online:true});assertCurrent();
 const productHuntCreationConsent=input.confirmProductHuntCreate===true?{at:at(),runId:task.runId,profileId:task.profileId,targetId:task.targetId,profileRevision:task.profileRevision??snapshot.revisions.siteProfiles,browserInstance:task.browserInstance}:null;
 const manualSubmissionConsent=preserveOriginalPermissions?task.manualSubmissionConsent||null:{scope,at:at(),...identity,profileRevision:task.profileRevision??snapshot.revisions.siteProfiles};
 const resumePage=parallel||fromPage?await observeParkedResumePage(runtime,task,originalPage):null;assertCurrent();await assertPageDocument();assertCurrent();
 if(input.confirmProductHuntCreate===true&&(!/(^|\.)producthunt\.com$/i.test(new URL(task.url).hostname)||task.productHunt?.readyToCreate!==true))throw Error('请先完成原 Product Hunt 逐步填写，再确认创建草稿');
 const originalBatch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId),resumed={},batchUpdates={};
 if(originalBatch&&batchConfig(originalBatch).unattended){
  assertOriginalBatch(runtime,originalBatch);const time=Date.now(),state=originalBatch.unattendedState||U.createCheckpoint(batchConfig(originalBatch),time),next={...originalBatch,unattendedState:U.removeManualTodo(state,task.id),interruptedTasks:{...originalBatch.interruptedTasks},taskInterruptionReasons:{...originalBatch.taskInterruptionReasons}};
  delete next.interruptedTasks[task.id];delete next.taskInterruptionReasons[task.id];resumed.taskDeadlineAt=U.taskDeadline(state,time);
  next.unattendedState=U.noteManualCapacity(next.unattendedState,manualTargetIds(runtime,scope,task.id).size,time);batchUpdates['workbenchBatch:'+originalBatch.id]=next;
 }
 const previousPreferences={fillOnlyRun:task.fillOnlyRun===true,attentionType:task.attentionType,reason:task.reason,manualSubmissionConsent:task.manualSubmissionConsent||null};
 const continued={...resumed,status:'pending',controller:'executor',profileSnapshot:plain(profile),profileRevision:task.profileRevision??snapshot.revisions.siteProfiles,fillOnlyRun:false,submitPreparedRun:false,productHuntCreationConsent,manualSubmissionConsent,attentionType:'',reason:'用户继续原任务，重新检测和校验后执行',consentHistory:[...(task.consentHistory||[]),{at:at(),scope:'ordinary_submission_permissions',source:'workbench_manual_continue',text:'用户在原任务详情确认普通免费投稿；额外权限及本人验证仍留待人工'},...(productHuntCreationConsent?[{at:at(),scope:'producthunt_create_draft',source:'workbench_manual_continue',text:'用户明确确认创建原 Product Hunt 草稿；未授权排期、推广或购买'}]:[])]};
 if(preserveOriginalPermissions){continued.fillOnlyRun=task.fillOnlyRun===true;continued.manualSubmissionConsent=manualSubmissionConsent;continued.consentHistory=[...(task.consentHistory||[])];}
 continued.manualContinueRequestId=randomUUID();
 if(resumePage)continued.originalResume={...parkedResumeIntent({...task,...continued},resumePage,{kind:preserveOriginalPermissions&&!manualSubmissionConsent?'navigation':'manual'}),status:parallel?'preparing':'dispatched'};
 runtime.update(task,continued,'manual_continue',batchUpdates);
 identity.profileRevision=task.profileRevision;
 try{await runtime.synchronize();await assertPageDocument();assertContext();assertCurrent();if(runtime.store.get('manualSkipPending:'+task.id)?.scope===scope||task.manualDisposition)throw Error('原任务正在跳过，取消继续');}catch(error){const current=runtime.store.get('task:'+task.id);if(current?.manualContinueRequestId===continued.manualContinueRequestId&&!current.attemptBoundary&&!current.receipt&&!current.manualDisposition){
  const cancelledUpdates={},savedBatch=originalBatch&&runtime.store.get('workbenchBatch:'+originalBatch.id);
  if(savedBatch?.scope===scope&&batchConfig(savedBatch).unattended){const targets=manualTargetIds(runtime,scope,current.id);if(current.targetId&&!current.tabClosedAt)targets.add(current.targetId);cancelledUpdates['workbenchBatch:'+savedBatch.id]={...savedBatch,unattendedState:U.noteManualCapacity(U.addManualTodo(savedBatch.unattendedState,current.id),targets.size,Date.now())};}
  runtime.update(current,{manualSubmissionConsent:null,productHuntCreationConsent:null,...(current.originalResume?{originalResume:{...current.originalResume,status:'cancelled'}}:{}),fillOnlyRun:true,submitPreparedRun:false,status:'needs_manual',attentionType:'fill_only',reason:'原任务继续未确认完成，保留已填资料，投稿确认已取消',...(fromPage?{fillOnlyRun:previousPreferences.fillOnlyRun,attentionType:previousPreferences.attentionType,reason:'原网页继续未完成，请重试：'+String(error.message||error).slice(0,1000)}:{}),...(preserveOriginalPermissions?{...previousPreferences,reason:String(previousPreferences.reason||'原任务待人工')+'；继续未完成：'+String(error.message||error).slice(0,1000)}:{}),manualContinueError:String(error.message||error).slice(0,2000)},'single_page_submit_cancelled',cancelledUpdates);
 }runtime.wakeWorkbench?.();throw error;}
 assertCurrent();if(parallel){runtime.update(task,{originalResume:{...task.originalResume,status:'queued'}},'manual_continue_queued');if(!deferTick)runtime.wakeWorkbench?.();}else runtime.store.set('singleTaskId',task.id);runtime.store.set('paused',false);if(!deferTick)runtime.tick();return{ok:true,taskId:task.id,running:true,...(parallel?{queued:true}: {})};
}
export function stopTabDisposition(task){
 return task.attemptBoundary&&!task.receipt||task.status==='needs_manual'||['ai','supervisor'].includes(task.controller)||task.pageOwnership==='manual'||task.pageHistory?.length||task.authTargetId||task.registration?.boundary||task.loginLinkRequest?.boundary?'preserve_manual':'close_automated';
}
export async function stopExecution(runtime,input={}){
 const id=randomUUID(),time=at(),owned=new Set([...(runtime.activeTaskIds||[]),runtime.activeTaskId,runtime.store.get('singleTaskId')].filter(Boolean)),inFlight=new Set(owned),workbenchId=runtime.store.get('activeWorkbenchBatch'),workbench=workbenchId&&runtime.store.get('workbenchBatch:'+workbenchId),fixed=runtime.store.get('acceptanceBatch'),execution=fixed&&runtime.store.get('acceptanceExecution:'+fixed.id),plan=runtime.store.get('libraryPlan');
 const activeRuns=new Set([...owned].map(id=>runtime.store.get('task:'+id)?.runId).filter(Boolean));if(runtime.store.get('manualResumeRunId'))activeRuns.add(runtime.store.get('manualResumeRunId'));
 for(const item of workbench?.items||[])if(item.taskId)owned.add(item.taskId);for(const item of Object.values(execution?.items||{}))if(item.taskId)owned.add(item.taskId);for(const task of runtime.store.values('task:'))if(plan?.id&&task.libraryPlanId===plan.id||activeRuns.has(task.runId))owned.add(task.id);
 runtime.store.set('executionStopped',{id,at:time,reason:'用户停止本次执行',status:'stopping',taskIds:[...owned]});runtime.store.set('paused',true);
 if(plan)runtime.store.set('libraryPlan',{...plan,globalPause:{...plan.globalPause,attentionType:'user_stopped',resumeEligible:false,reason:'用户停止本次执行',at:time}});
 let executionError='';if(runtime.job)try{await runtime.job;}catch(error){executionError=error.message;}
 if(workbench?.config?.unattended)for(const taskId of inFlight){const task=runtime.store.get('task:'+taskId);if(!task||task.receipt||task.workbenchBatchId!==workbench.id||!['pending','opening','filling','submitting'].includes(task.status))continue;const interrupted=U.interruptedTaskStatus({status:'running',submissionAttempted:!!task.attemptBoundary}),batch=runtime.store.get('workbenchBatch:'+workbench.id),item=batch.items.find(item=>item.taskId===taskId);if(item){item.status='complete';item.result=task.attemptBoundary?'sent_unconfirmed':interrupted.status;item.reason=interrupted.reason;}batch.unattendedState=U.addManualTodo(batch.unattendedState,taskId);runtime.update(task,{...interrupted,siteStatus:task.attemptBoundary?'sent_unconfirmed':'not_submitted',attentionType:task.attemptBoundary?'unknown_receipt':'interrupted_task'},'stopped_unattended_task',{['workbenchBatch:'+batch.id]:batch});}
 if(workbench){const latest=runtime.store.get('workbenchBatch:'+workbenchId);while(latest.cursor<latest.items.length&&['complete','excluded'].includes(latest.items[latest.cursor].status))latest.cursor++;runtime.store.set('workbenchBatch:'+workbenchId,{...latest,status:'stopped',reason:'用户停止本次执行',pauseReasonCode:'user_stop',stoppedAt:time});runtime.store.set('activeWorkbenchBatch',null);}
 if(fixed)runtime.store.set('acceptanceBatch',{...runtime.store.get('acceptanceBatch'),status:'stopped',stoppedAt:time});
 runtime.store.set('singleTaskId',null);runtime.store.set('manualResumeRunId',null);const results=[],closedTargets=new Set(),protectedTargets=new Set(runtime.store.values('task:').filter(t=>stopTabDisposition(t)==='preserve_manual').map(t=>t.targetId).filter(Boolean));
 for(const taskId of owned){const task=runtime.store.get('task:'+taskId);if(!task?.targetId||task.tabClosedAt)continue;
  if(protectedTargets.has(task.targetId)){results.push({taskId,disposition:'preserve_manual'});continue;}
  if(closedTargets.has(task.targetId))continue;
  try{const page=await runtime.findPage(task);await runtime.lease(task,{online:true});const closedAt=at(),checkpoint=recoveryCheckpoint(task,page,task.screenshot||'',closedAt);runtime.update(task,{recoveryCheckpoint:checkpoint,stopCheckpoint:{id,at:time,targetId:task.targetId},...(!task.receipt?{status:'pending',reason:'本次执行已停止；原任务保留，可重新开始'}:{})},'stop_page_checkpoint');await page.close({runBeforeUnload:false});closedTargets.add(task.targetId);runtime.update(task,{tabClosedAt:closedAt},'stop_automated_page_closed');results.push({taskId,disposition:'closed_automated'});}catch(error){results.push({taskId,disposition:'preserved_after_error',error:error.message});}
 }
 let syncError='';try{if(workbench)await persistBatchLifecycle(runtime,runtime.store.get('workbenchBatch:'+workbenchId),'workbench_run_stopped');await runtime.synchronize();}catch(error){syncError=error.message;}
 const result={id,at:time,status:'stopped',taskIds:[...owned],results,syncError,executionError};runtime.store.set('executionStopped',result);return{ok:true,stopped:true,...result};
}
