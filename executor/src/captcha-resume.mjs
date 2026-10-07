import {createHash} from 'node:crypto';
import {attachEngine} from './engine.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {assertOriginalBatch} from './execution-lifecycle.mjs';
import {batchConfig} from './workbench-batch-policy.mjs';
import {originalUnattended as U} from '../../core/original-batch-config.mjs';
import {priorProductSuccess} from './shared.mjs';
import {manualTargetIds} from './manual-controls.mjs';
import {batchScopeRows} from '../../core/workbench-batch-recovery.mjs';
import {parkedResumeIntent} from './parked-task-resume.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=task=>({runId:task.runId,profileId:task.profileId,profileRevision:task.profileRevision,targetId:task.targetId,browserInstance:task.browserInstance,profileSha256:hash(task.profileSnapshot)});
function authority(runtime,task){
 const scope=workbenchScope(runtime.store.get('pair'));
 if(task.workbenchBatchId){const batch=runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(!batch||!['running','waiting_manual'].includes(batch.status)||runtime.store.get('activeWorkbenchBatch')!==batch.id||!batch.items?.some(item=>item.taskId===task.id))return null;assertOriginalBatch(runtime,batch);if(batchConfig(batch).unattended&&U.isExpired(batch.unattendedState))return null;return{kind:'workbench',id:batch.id,scope,scopeSha256:batch.scopeSha256||hash(batchScopeRows(batch)),configSha256:batch.configSha256||hash(batchConfig(batch))};}
 const fixed=runtime.store.get('acceptanceBatch');if(fixed?.status==='running'){const frozen=runtime.store.get('acceptance:'+fixed.id),execution=runtime.store.get('acceptanceExecution:'+fixed.id);if(frozen?.sha256!==fixed.scopeSha256||execution?.scopeSha256!==frozen?.sha256)return null;if(frozen?.combinations?.some(item=>item.existingTaskId===task.id||execution.items?.[item.identity]?.taskId===task.id))return{kind:'fixed',id:fixed.id,scope,scopeSha256:frozen.sha256,count:frozen.count};}
 const plan=runtime.store.get('libraryPlan');if(plan?.status==='active'&&task.libraryPlanId===plan.id&&!plan.globalPause)return{kind:'library',id:plan.id,scope};
 if(runtime.store.get('manualResumeRunId')===task.runId&&runtime.store.get('run:'+task.runId))return{kind:'run',id:task.runId,scope};
 if(runtime.store.get('singleTaskId')===task.id)return{kind:'single',id:task.id,scope};
 if(!runtime.store.get('singleTaskId')&&task.captchaResume?.execution?.kind==='single'&&task.captchaResume.execution.id===task.id&&runtime.store.get('run:'+task.runId))return{kind:'single',id:task.id,scope};
 return null;
}
export function armCaptchaResume(runtime,task,{pageUrl,frameUrl,documentId}){
 if(runtime.store.get('paused')!==false||runtime.store.get('executionStopped')||task.attemptBoundary||task.receipt||!task.profileSnapshot||!Number.isInteger(documentId)||documentId<=0||!/^https?:\/\//.test(pageUrl)||!/^https?:\/\//.test(frameUrl))return false;
 const execution=authority(runtime,task);if(!execution)return false;
 runtime.update(task,{captchaResume:{status:'armed',armedAt:new Date().toISOString(),...identity(task),execution,pageUrl,frameUrl,documentId,pauseAt:runtime.store.get('executionPaused')?.at||'',previousReason:task.reason||''}},'captcha_waiting_original_page');return true;
}
export async function armPageCaptchaResume(runtime,task,page,{active=()=>runtime.store.get('paused')===false}={}){
 if(!active()||runtime.store.get('executionStopped')||task.attemptBoundary||task.receipt||!runtime.context||page.isClosed())return false;
 const expected=identity(task),pageUrl=page.url(),scope=workbenchScope(runtime.store.get('pair'));
 const current=()=>{const value=runtime.store.get('task:'+task.id);return active()&&value&&value.controller==='executor'&&!value.attemptBoundary&&!value.receipt&&!page.isClosed()&&page.url()===pageUrl&&scope===workbenchScope(runtime.store.get('pair'))&&Object.entries(expected).every(([key,entry])=>identity(value)[key]===entry)?value:null;};
 if((await getTargetInfo(runtime.context,page))?.targetId!==expected.targetId||!current())return false;
 for(const frame of page.frames()){
  if(!/^https?:\/\//.test(frame.url()))continue;let engine,ownsEngine=false;const frameUrl=frame.url();
  try{
   const assistant=runtime.browserAssistantFrames?.get(expected.targetId+'::'+frameUrl);
   if(assistant){if(assistant.scope!==scope||assistant.profileId!==expected.profileId)continue;engine=assistant.engine;}
   else{engine=await attachEngine(runtime.context,frame);ownsEngine=true;}
   const detection=await engine.call({action:'detectPage'}),latest=current();if(!latest||frame.isDetached()||frame.url()!==frameUrl)return false;
   if(detection?.hasCaptcha!==true)continue;
   const saved=latest.captchaResume;if(['armed','await_sync'].includes(saved?.status)&&saved.documentId===engine.documentId&&saved.pageUrl===pageUrl&&saved.frameUrl===frameUrl&&Object.entries(expected).every(([key,entry])=>saved[key]===entry)){Object.assign(task,latest);return true;}
   const armed=armCaptchaResume(runtime,latest,{pageUrl,frameUrl,documentId:engine.documentId});if(armed)Object.assign(task,latest);return armed;
  }finally{if(ownsEngine)await engine?.detach();}
 }
 return false;
}
function eligible(runtime,task){
 const saved=task?.captchaResume;if(!saved||!['armed','await_sync'].includes(saved.status)||task.status!=='needs_manual'||task.attentionType!=='human_verification'||task.controller!=='executor'||task.attemptBoundary||task.receipt||task.tabClosedAt||runtime.store.get('executionStopped')||runtime.store.get('singleTaskId')||saved.pauseAt!==(runtime.store.get('executionPaused')?.at||'')||Object.entries(identity(task)).some(([key,value])=>saved[key]!==value)||task.browserInstance!==runtime.host?.startedAt)return false;
 const current=authority(runtime,task);if(!current||hash(current)!==hash(saved.execution))return false;
 if(runtime.activeTaskIds?.has(task.id)||runtime.workbenchTaskJobs?.has(task.id)||runtime.activeTaskId===task.id)return false;
 if(runtime.job&&!(current.kind==='workbench'&&runtime.workbenchTaskJobs&&runtime.store.get('activeWorkbenchBatch')===current.id))return false;
 if(runtime.store.get('paused')!==false){const batch=current.kind==='workbench'&&runtime.store.get('workbenchBatch:'+current.id);if((!batch||batch.status!=='waiting_manual')&&current.kind!=='single')return false;}
 return true;
}
export async function checkCaptchaResumes(runtime,input={}){
 if(runtime.captchaResumeScan||runtime.browserAssistantScan||runtime.manualWatchJob||runtime.connectionBusy||runtime.cloudPullOperation||runtime.cloudPushOperation||runtime.localRecoveryOperation||runtime.store.get('connectionExecutionHold')||!runtime.context)return{ok:true,resumed:[],waiting:[]};
 runtime.captchaResumeScan=true;const resumed=[],waiting=[];
 try{
  for(const original of runtime.store.values('task:').filter(task=>!input.taskId||task.id===input.taskId)){
   let engine,ownsEngine=false;
   try{
    if(!eligible(runtime,original))continue;const saved=original.captchaResume;
    if(input.expectedDocumentId!==undefined&&input.expectedDocumentId!==saved.documentId||input.frameUrl!==undefined&&input.frameUrl!==saved.frameUrl)continue;
    const page=await runtime.findPage(original),frame=page.frames().find(frame=>frame.url()===saved.frameUrl);
    if(!frame||page.url()!==saved.pageUrl||(await getTargetInfo(runtime.context,page))?.targetId!==saved.targetId)continue;
    const assistant=runtime.browserAssistantFrames?.get(saved.targetId+'::'+saved.frameUrl);
    if(assistant){if(assistant.scope!==saved.execution.scope||assistant.profileId!==original.profileId)continue;engine=assistant.engine;}
    else{engine=await attachEngine(runtime.context,frame);ownsEngine=true;}
    const assertCurrent=()=>{const current=runtime.store.get('task:'+original.id);if(!eligible(runtime,current)||current.captchaResume.armedAt!==saved.armedAt||page.isClosed()||frame.isDetached()||page.url()!==saved.pageUrl||frame.url()!==saved.frameUrl||engine.documentId!==saved.documentId)throw Error('验证码恢复的原任务、页面或执行范围已变化');return current;};
    let task=assertCurrent(),detection=await engine.call({action:'detectPage'});assertCurrent();
    if(detection?.hasCaptcha!==false){waiting.push({taskId:task.id,reason:'原页验证码尚未完成'});continue;}
    const snapshot=await runtime.cloud.request('snapshot');task=assertCurrent();
    if(!snapshot.documents.siteProfiles?.[task.profileId]||snapshot.documents.siteProfiles[task.profileId].archived||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('原产品不可用或同站已有收件，保持待核验');
    await runtime.lease(task,{online:true});task=assertCurrent();
    if(task.captchaResume.status!=='await_sync')runtime.update(task,{captchaResume:{...saved,status:'await_sync',resolvedAt:new Date().toISOString()}},'captcha_resolution_intent');
    await runtime.synchronize();task=assertCurrent();detection=await engine.call({action:'detectPage'});task=assertCurrent();
    if(detection?.hasCaptcha!==false){waiting.push({taskId:task.id,reason:'恢复前原页再次出现验证码'});continue;}
    const updates={},patch={};
    if(saved.execution.kind==='workbench'){
     const batch=runtime.store.get('workbenchBatch:'+saved.execution.id),next={...batch,status:'running',reason:'',captchaResumedAt:new Date().toISOString()};assertOriginalBatch(runtime,batch);
     if(batchConfig(batch).unattended){patch.taskDeadlineAt=U.taskDeadline(batch.unattendedState,Date.now());next.unattendedState=U.removeManualTodo(batch.unattendedState,task.id);next.unattendedState=U.noteManualCapacity(next.unattendedState,manualTargetIds(runtime,saved.execution.scope,task.id).size,Date.now());next.interruptedTasks={...batch.interruptedTasks};next.taskInterruptionReasons={...batch.taskInterruptionReasons};delete next.interruptedTasks[task.id];delete next.taskInterruptionReasons[task.id];}
     updates['workbenchBatch:'+batch.id]=next;
    }
    const parallel=saved.execution.kind==='workbench'&&runtime.workbenchTaskJobs;
    runtime.update(task,{...patch,status:'pending',siteStatus:'not_submitted',attentionType:'',captchaResume:{...task.captchaResume,status:'resumed',resumedAt:new Date().toISOString()},...(parallel?{originalResume:parkedResumeIntent(task,saved)}:{}),reason:parallel?'原页验证码已完成，沿原任务、范围与预算等待原批次接续':'原页验证码已完成，沿原任务资料、范围与预算重新检测后继续'},'captcha_resolved_original_task',updates);
    if(!parallel)runtime.store.set('singleTaskId',task.id);runtime.store.set('paused',false);runtime.wakeWorkbench?.();runtime.tick();resumed.push(task.id);break;
   }catch(error){waiting.push({taskId:original.id,reason:error.message});}
   finally{if(ownsEngine)await engine?.detach();}
  }
 }finally{runtime.captchaResumeScan=false;}
 return{ok:true,resumed,waiting};
}
