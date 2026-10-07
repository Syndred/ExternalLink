import {createHash,randomUUID} from 'node:crypto';
import {workbenchScope} from './workbench-sync.mjs';
import {assertOriginalBatch} from './execution-lifecycle.mjs';
import {batchConfig} from './workbench-batch-policy.mjs';
import {originalUnattended as U} from '../../core/original-batch-config.mjs';
import {batchScopeRows,batchJson} from '../../core/workbench-batch-recovery.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {attachEngine} from './engine.mjs';
import {priorProductSuccess} from './shared.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskIdentity=task=>({runId:task.runId,profileId:task.profileId,profileRevision:task.profileRevision,targetId:task.targetId,browserInstance:task.browserInstance,profileSha256:createHash('sha256').update(batchJson(task.profileSnapshot)).digest('hex')});
export function pendingParkedResume(task){return task?.status==='pending'&&['preparing','queued','dispatching','dispatched'].includes(task.originalResume?.status);}
export function parkedResumeIntent(task,capsule,{kind='captcha'}={}){return{id:randomUUID(),kind,status:'queued',requestedAt:new Date().toISOString(),...taskIdentity(task),execution:structuredClone(capsule.execution),pageUrl:capsule.pageUrl,frameUrl:capsule.frameUrl,documentId:capsule.documentId,pauseAt:capsule.pauseAt};}
export async function observeParkedResumePage(runtime,task,page){
 const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(batch)assertOriginalBatch(runtime,batch);const pageUrl=page.url(),candidates=[];
 for(const frame of page.frames()){
  if(!/^https?:\/\//.test(frame.url()))continue;const frameUrl=frame.url();let engine,ownsEngine=false;
  try{const assistant=runtime.browserAssistantFrames?.get(task.targetId+'::'+frameUrl)||runtime.taskPageControls?.get(task.id)?.frame===frame&&runtime.taskPageControls.get(task.id);if(assistant){if(assistant.scope!==workbenchScope(runtime.store.get('pair'))||assistant.profileId!==task.profileId)continue;engine=assistant.engine;}else{engine=await attachEngine(runtime.context,frame);ownsEngine=true;}const detection=await engine.call({action:'detectPage'});if(!page.isClosed()&&!frame.isDetached()&&page.url()===pageUrl&&frame.url()===frameUrl)candidates.push({frameUrl,documentId:engine.documentId,score:detection.operable?10000+Number(detection.formFieldCount||0):frame===page.mainFrame()?1:0});}
  finally{if(ownsEngine)await engine?.detach();}
 }
 const original=candidates.sort((a,b)=>b.score-a.score)[0];if(!original)throw Error('原继续任务没有可核验的网页文档');
 return{pageUrl,frameUrl:original.frameUrl,documentId:original.documentId,pauseAt:runtime.store.get('executionPaused')?.at||'',execution:batch?{kind:'workbench',id:batch.id,scope:workbenchScope(runtime.store.get('pair')),scopeSha256:batch.scopeSha256||hash(batchScopeRows(batch)),configSha256:batch.configSha256||hash(batchConfig(batch))}:{kind:'page',id:task.id,scope:workbenchScope(runtime.store.get('pair'))}};
}
export function queuedParkedTasks(runtime,batch){return runtime.store.values('task:').filter(task=>pendingParkedResume(task)&&task.workbenchBatchId===batch.id&&task.originalResume.execution.scope===workbenchScope(runtime.store.get('pair')));}
export function captureParkedResumeRequests(runtime,batch){return queuedParkedTasks(runtime,batch).filter(task=>task.originalResume.status!=='preparing').map(task=>({taskId:task.id,requestId:task.originalResume.id}));}
export function pausedParkedResumeTasks(runtime,batch){
 const scope=workbenchScope(runtime.store.get('pair'));
 return (batch.pausedParkedResumes||[]).map(saved=>runtime.store.get('task:'+saved.taskId)).filter(task=>{
  const request=task?.originalResume,saved=(batch.pausedParkedResumes||[]).find(saved=>saved.taskId===task?.id),skip=task&&runtime.store.get('manualSkipPending:'+task.id);
  return pendingParkedResume(task)&&request.status!=='preparing'&&request.id===saved?.requestId&&request.execution.kind==='workbench'&&request.execution.id===batch.id&&request.execution.scope===scope&&task.workbenchBatchId===batch.id&&task.controller==='executor'&&!task.attemptBoundary&&!task.receipt&&!task.tabClosedAt&&!task.manualDisposition&&skip?.scope!==scope&&request.execution.scopeSha256===(batch.scopeSha256||hash(batchScopeRows(batch)))&&request.execution.configSha256===(batch.configSha256||hash(batchConfig(batch)))&&Object.entries(taskIdentity(task)).every(([key,value])=>request[key]===value);
 });
}
function assertRequest(runtime,task,request,batchId){
 const batch=runtime.store.get('workbenchBatch:'+batchId),current=runtime.store.get('task:'+task.id);
 if(!batch||runtime.store.get('activeWorkbenchBatch')!==batchId||batch.status!=='running'||runtime.store.get('paused')!==false||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||request.execution.kind!=='workbench'||request.execution.id!==batchId||request.execution.scope!==workbenchScope(runtime.store.get('pair'))||!pendingParkedResume(current)||current.originalResume.id!==request.id||current.controller!=='executor'||current.attemptBoundary||current.receipt||current.tabClosedAt||current.browserInstance!==runtime.host?.startedAt||runtime.activeTaskIds?.has(task.id)||runtime.workbenchTaskJobs?.has(task.id)||Object.entries(taskIdentity(current)).some(([key,value])=>request[key]!==value))throw Error('原待人工接续任务或执行范围已变化，待办保留');
 assertOriginalBatch(runtime,batch);
 if(request.execution.scopeSha256!==(batch.scopeSha256||hash(batchScopeRows(batch)))||request.execution.configSha256!==(batch.configSha256||hash(batchConfig(batch))))throw Error('原待人工接续范围或参数已变化');
 if(request.pauseAt!==(runtime.store.get('executionPaused')?.at||''))throw Error('用户暂停后原接续待办保持暂停');
 if(runtime.store.get('manualSkipPending:'+current.id)?.scope===workbenchScope(runtime.store.get('pair'))||current.manualDisposition)throw Error('原任务正在跳过或已经跳过，未继续执行');
 if(batchConfig(batch).unattended&&U.isExpired(batch.unattendedState))throw Error('原全局截止时间已到，接续待办和预算保留');
 return{batch,task:current};
}
export async function assertParkedResumePage(runtime,task){
 const request=task.originalResume;if(request?.status!=='dispatched')return;
 if(runtime.store.get('manualSkipPending:'+task.id)?.scope===workbenchScope(runtime.store.get('pair'))||task.manualDisposition)throw Error('原任务正在跳过或已经跳过，未填写网页');
 if(Object.entries(taskIdentity(task)).some(([key,value])=>request[key]!==value)||request.execution.scope!==workbenchScope(runtime.store.get('pair'))||request.pauseAt!==(runtime.store.get('executionPaused')?.at||''))throw Error('原接续任务或暂停记录已变化，未填写网页');
 const page=await runtime.findPage(task),frame=page.frames().find(frame=>frame.url()===request.frameUrl);let engine,ownsEngine=false;
 try{
  if(!frame||page.url()!==request.pageUrl)throw Error('原接续网页已导航或关闭，未填写');
  const assistant=runtime.browserAssistantFrames?.get(request.targetId+'::'+request.frameUrl);
  if(assistant){if(assistant.scope!==request.execution.scope||assistant.profileId!==request.profileId)throw Error('原接续网页助手已变化');engine=assistant.engine;}
  else{engine=await attachEngine(runtime.context,frame);ownsEngine=true;}
  if(engine.documentId!==request.documentId||page.isClosed()||frame.isDetached()||page.url()!==request.pageUrl||frame.url()!==request.frameUrl)throw Error('原接续页面文档已变化，未填写');
 }finally{if(ownsEngine)await engine?.detach();}
}
// Selection runs inside the existing serialized batch dispatcher. A recovered
// task keeps its original combination and does not consume another task slot.
export async function selectParkedResume(runtime,batch,{busyDestinations=new Set(),destinationFor=task=>task.url}={}){
 for(const candidate of queuedParkedTasks(runtime,batch)){
  if(candidate.originalResume.status==='preparing')continue;
  if(busyDestinations.has(destinationFor(candidate))||runtime.activeTaskIds?.has(candidate.id))continue;
  const request=candidate.originalResume;let engine,ownsEngine=false;
  try{
   let checked=assertRequest(runtime,candidate,request,batch.id);const page=await runtime.findPage(checked.task),frame=page.frames().find(frame=>frame.url()===request.frameUrl);
   if(!frame||page.url()!==request.pageUrl||(await getTargetInfo(runtime.context,page))?.targetId!==request.targetId)throw Error('原接续网页已导航或关闭，待办保留');
   const assistant=runtime.browserAssistantFrames?.get(request.targetId+'::'+request.frameUrl);
   if(assistant){if(assistant.scope!==request.execution.scope||assistant.profileId!==request.profileId)throw Error('原网页助手已切换产品');engine=assistant.engine;}
   else{engine=await attachEngine(runtime.context,frame);ownsEngine=true;}
   const ensure=()=>{const value=assertRequest(runtime,candidate,request,batch.id);if(page.isClosed()||frame.isDetached()||page.url()!==request.pageUrl||frame.url()!==request.frameUrl||engine.documentId!==request.documentId)throw Error('原接续页面文档已变化，待办保留');return value;};
   checked=ensure();if((await engine.call({action:'detectPage'}))?.hasCaptcha!==false)throw Error('原页仍需真人验证，接续待办保留');ensure();
   await runtime.synchronize();checked=ensure();await flushBatchTaskEvents(runtime,checked.task);checked=ensure();
   const snapshot=await runtime.cloud.request('snapshot');checked=ensure();if(!snapshot.documents.siteProfiles?.[request.profileId]||snapshot.documents.siteProfiles[request.profileId].archived||priorProductSuccess(snapshot.documents.submissionRecords,request.profileId,checked.task.url))throw Error('原产品不可用或同站已有收件，接续待核验');
   await runtime.lease(checked.task,{online:true});checked=ensure();
   if(checked.task.originalResume.status==='queued'){
    const next={...checked.batch,items:checked.batch.items.map(item=>item.taskId===candidate.id?{...item,status:'running'}:item)},patch={originalResume:{...request,status:'dispatching',dispatchedAt:new Date().toISOString()},reason:'原待人工任务已由原批次领取，重新检测后继续'};
    if(batchConfig(next).unattended)patch.taskDeadlineAt=U.taskDeadline(next.unattendedState,Date.now());
    runtime.update(checked.task,patch,'parked_task_dispatch_intent',{['workbenchBatch:'+next.id]:next});
   }
   await runtime.synchronize();checked=ensure();await flushBatchTaskEvents(runtime,checked.task);checked=ensure();
   if((await engine.call({action:'detectPage'}))?.hasCaptcha!==false)throw Error('原页恢复前再次出现验证关口');checked=ensure();
   if(checked.task.originalResume.status!=='dispatched')runtime.update(checked.task,{originalResume:{...checked.task.originalResume,status:'dispatched'}},'parked_task_dispatched');
   return checked.task;
  }catch(error){runtime.parkedResumeError=error.message;}
  finally{if(ownsEngine)await engine?.detach();}
 }
 return null;
}
