import {randomUUID,createHash} from 'node:crypto';
import {attachEngine} from './engine.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {profiles,plain} from './shared.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';
import {assertOriginalBatch} from './execution-lifecycle.mjs';
import {manualSubmit,manualSkip} from './manual-controls.mjs';

const actions=new Set(['manualContinue','manualSubmit','manualSkip']);
const digest=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const identity=task=>({runId:task.runId,profileId:task.profileId,profileRevision:task.profileRevision,targetId:task.targetId,browserInstance:task.browserInstance,profileSha256:digest(task.profileSnapshot)});
const conflictingPageTask=(runtime,task)=>runtime.store.values('task:').some(other=>other.id!==task.id&&other.targetId===task.targetId&&other.browserInstance===task.browserInstance&&!other.tabClosedAt&&(other.attemptBoundary||other.receipt||['pending','needs_manual','opening','filling','submitting'].includes(other.status)));

export function taskPageControlEligible(runtime,task){
  const scope=workbenchScope(runtime.store.get('pair')),pending=task&&runtime.store.get('manualSkipPending:'+task.id),retrySkip=pending?.scope===scope&&pending.taskId===task.id&&pending.runId===task.runId&&task.status==='skip'&&task.manualDisposition?.requestId===pending.id;
  if(!task?.runId||!task.profileSnapshot||task.profileRevision===undefined||!task.targetId||task.browserInstance!==runtime.host?.startedAt||task.controller!=='executor'||task.status!=='needs_manual'&&!retrySkip||task.attentionType==='fill_only'&&!retrySkip||task.attemptBoundary||task.receipt||task.tabClosedAt||task.manualDisposition&&!retrySkip||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold'))return false;
  if(runtime.activeTaskIds?.has(task.id)||runtime.workbenchTaskJobs?.has(task.id)||runtime.activeTaskId===task.id)return false;
  const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
  if(task.workbenchBatchId&&(!batch||batch.scope!==scope))return false;
  if(batch)assertOriginalBatch(runtime,batch);
  if(batch&&(task.workbenchBatchConfigSha256&&task.workbenchBatchConfigSha256!==batch.configSha256||task.workbenchBatchScopeSha256&&task.workbenchBatchScopeSha256!==batch.scopeSha256))return false;
  return !!runtime.store.get('run:'+task.runId)&&!conflictingPageTask(runtime,task);
}

async function removeBinding(runtime,binding){
  if(binding.busy)return;
  if(await binding.engine.isCurrentDocument())await binding.engine.call({action:'removeTaskWaitBanners'}).catch(()=>{});
  if(binding.ownsEngine)await binding.engine.detach();
  if(runtime.taskPageControls?.get(binding.taskId)===binding)runtime.taskPageControls.delete(binding.taskId);
}
export async function releaseTaskPageControl(runtime,taskId){const binding=runtime.taskPageControls?.get(taskId);if(!binding||binding.busy)return false;await removeBinding(runtime,binding);return true;}
export async function stopTaskPageControls(runtime){
  for(const binding of runtime.taskPageControls?.values()||[]){binding.cancelled=true;if(!binding.busy)await removeBinding(runtime,binding);}
}

function assertBinding(runtime,binding,message){
  const task=runtime.store.get('task:'+binding.taskId),scope=workbenchScope(runtime.store.get('pair'));
  const pending=runtime.store.get('manualSkipPending:'+binding.taskId),retrySkip=pending?.scope===scope&&pending.taskId===task?.id&&pending.runId===task?.runId&&task?.manualDisposition?.requestId===pending.id;
  const ownSkip=message.action==='manualSkip'&&(binding.busy||retrySkip)&&task?.manualDisposition?.action==='skip_current_run'&&task.status==='skip',ownClose=ownSkip&&task.tabClosedAt&&task.closeReason==='用户跳过本次处理，原任务与恢复点保留';
  if(!task||binding.cancelled||runtime.taskPageControls?.get(binding.taskId)!==binding||scope!==binding.scope||runtime.store.get('connectionExecutionHold')||runtime.store.get('executionStopped')||task.attemptBoundary||task.receipt||task.tabClosedAt&&!ownClose||task.manualDisposition&&!ownSkip||task.controller!=='executor'||!['needs_manual','pending',...(ownSkip?['skip']:[])].includes(task.status)||task.browserInstance!==runtime.host?.startedAt||Object.entries(identity(task)).some(([key,value])=>binding.identity[key]!==value)||!ownClose&&(binding.page.isClosed()||binding.frame.isDetached()||binding.page.url()!==binding.pageUrl||binding.frame.url()!==binding.frameUrl))throw Error('原人工网页、任务、产品或工作区已变化，请回到原任务');
  if(message.taskId!==task.id||message.runId!==task.runId||message.taskControlId!==binding.id||message.executorDocumentId!==binding.engine.documentId||message.executorFrameUrl!==binding.frameUrl)throw Error('原页面按钮已过期，请刷新原任务');
  const run=runtime.store.get('run:'+task.runId);if(!run||digest(run.profile||null)!==binding.runProfileSha256||digest(run.mediaManifest||[])!==binding.mediaManifestSha256)throw Error('原批次产品或素材清单已变化，请核验原任务');
  if(conflictingPageTask(runtime,task))throw Error('原页还绑定其他任务或提交边界，请先核验');
  const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
  if(batch){assertOriginalBatch(runtime,batch);if(batch.scope!==scope||batch.id!==binding.batchId||batch.scopeSha256!==binding.scopeSha256||batch.configSha256!==binding.configSha256)throw Error('原批次范围或参数已变化');}
  const assistant=runtime.browserAssistantFrames?.get(task.targetId+'::'+binding.frameUrl);
  if(assistant&&(assistant.scope!==scope||assistant.profileId!==task.profileId||assistant.engine!==binding.engine))throw Error('原网页助手已切换产品或连接');
  return task;
}

export async function handleTaskPageMessage(runtime,message){
  if(!actions.has(message.action))throw Error('未知原页面操作');
  const binding=runtime.taskPageControls?.get(message.taskId);
  if(!binding||binding.busy)throw Error('原页面操作正在确认或已经变化');
  assertBinding(runtime,binding,message);
  if(message.action==='manualSubmit'&&!['manual_button','form_detected'].includes(message.callbackSource)||message.action!=='manualSubmit'&&message.callbackSource!=='manual_button')throw Error('原页面操作来源无效');
  binding.busy=true;
  const assertContext=()=>assertBinding(runtime,binding,message);
  const assertPageDocument=async()=>{assertContext();if(!await binding.engine.isCurrentDocument())throw Error('原页面文档已重载，停止旧按钮操作');assertContext();};
  try{
    await assertPageDocument();
    const task=assertContext(),input={taskId:task.id,expectedRunId:task.runId,expectedTargetId:task.targetId,ordinaryPermissionsAuthorized:true};
    const result=message.action==='manualSkip'?await manualSkip(runtime,input,{assertContext,assertPageDocument}):await manualSubmit(runtime,input,{assertContext,assertPageDocument,fromPage:true,preserveOriginalPermissions:message.action==='manualSubmit',deferTick:true});
    if(result.syncError)throw Error(result.syncError);
    return{...result,afterReply:async()=>{binding.busy=false;await removeBinding(runtime,binding);runtime.wakeWorkbench?.();runtime.tick();}};
  }catch(error){
    return{ok:false,error:error.message,afterReply:()=>{binding.busy=false;}};
  }
}

export async function checkTaskPageControls(runtime){
  if(runtime.taskPageControlsScan||runtime.browserAssistantScan||runtime.controlBusy||runtime.connectionBusy||runtime.cloudPullOperation||runtime.localRecoveryOperation||runtime.store.get('connectionExecutionHold')||!runtime.context)return{ok:true,connected:runtime.taskPageControls?.size||0};
  runtime.taskPageControlsScan=true;runtime.taskPageControls||=new Map();
  try{
    for(const binding of runtime.taskPageControls.values()){
      if(binding.busy)continue;
      const task=runtime.store.get('task:'+binding.taskId);
      if(!taskPageControlEligible(runtime,task)||binding.scope!==workbenchScope(runtime.store.get('pair'))||Object.entries(identity(task)).some(([key,value])=>binding.identity[key]!==value)||binding.page.isClosed()||binding.frame.isDetached()||binding.page.url()!==binding.pageUrl||!await binding.engine.isCurrentDocument())await removeBinding(runtime,binding);
    }
    for(const task of runtime.store.values('task:')){
      if(!taskPageControlEligible(runtime,task))continue;
      let binding=runtime.taskPageControls.get(task.id);
      if(binding?.busy)continue;
      if(!binding){
        const page=await runtime.findPage(task);if(page.isClosed()||!/^https?:\/\//.test(page.url())||(await getTargetInfo(runtime.context,page))?.targetId!==task.targetId)continue;
        const frame=page.mainFrame(),scope=workbenchScope(runtime.store.get('pair')),assistant=runtime.browserAssistantFrames?.get(task.targetId+'::'+frame.url());
        if(assistant&&(assistant.scope!==scope||assistant.profileId!==task.profileId))continue;
        const batch=task.workbenchBatchId&&runtime.store.get('workbenchBatch:'+task.workbenchBatchId);
        const run=runtime.store.get('run:'+task.runId);
        binding={id:randomUUID(),taskId:task.id,profileId:task.profileId,scope,identity:identity(task),runProfileSha256:digest(run.profile||null),mediaManifestSha256:digest(run.mediaManifest||[]),page,frame,pageUrl:page.url(),frameUrl:frame.url(),ownsEngine:!assistant,batchId:batch?.id,scopeSha256:batch?.scopeSha256,configSha256:batch?.configSha256};
        binding.engine=assistant?.engine||await attachEngine(runtime.context,frame,message=>actions.has(message.action)?runtime.dispatchControl?runtime.dispatchControl('taskPageControl',message):handleTaskPageMessage(runtime,message):runtime.bridge(runtime.store.get('task:'+task.id)||task,message),{parkedControls:true});
        runtime.taskPageControls.set(task.id,binding);
      }
      const skipPending=runtime.store.get('manualSkipPending:'+task.id)?.scope===binding.scope;
      const state=JSON.stringify([task.reason,task.attentionType,task.fillOnlyRun,skipPending]);
      if(binding.renderedState===state)continue;
      const config={...plain(profiles.buildAgentConfigFromProfile(task.profileSnapshot)),nativeTaskControl:{taskId:task.id,runId:task.runId,id:binding.id,skipPending}};
      await binding.engine.call({action:task.attentionType==='site_form_unavailable'&&!skipPending?'showWaitingBanner':'showManualWaitBanner',config,taskIndex:task.id,reason:skipPending?'原跳过记录尚未确认，请点击“跳过”重试。':task.reason,timeoutSec:0,platformType:task.platformType});
      binding.renderedState=state;
    }
    runtime.taskPageControlsError='';
  }catch(error){runtime.taskPageControlsError=error.message;}
  finally{runtime.taskPageControlsScan=false;}
  return{ok:true,connected:runtime.taskPageControls.size,error:runtime.taskPageControlsError||''};
}
