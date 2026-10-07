import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {automationLedger,plain,queue,priorProductSuccess} from './shared.mjs';
import {connectionIdentity} from './workbench-connections.mjs';
import {finishWorkbenchTask} from './workbench-features.mjs';
import {prepareIndexNotification} from './index-notification.mjs';

const parkedStatuses=new Set(['needs_manual','needs_captcha','needs_login','captcha','filled','submitted_unconfirmed']);
const key=id=>'manualConfirmation:'+id;
function taskFor(runtime,input){
 const task=runtime.store.get('task:'+input.taskId);
 if(!task?.runId||task.runId!==input.runId)throw Error('批次已变化，请刷新待人工列表后重试');
 if(input.expectedTargetId!==undefined&&task.targetId!==input.expectedTargetId)throw Error('原标签页已变化，请刷新后重试');
 if(['ai','supervisor'].includes(task.controller)||runtime.activeTaskIds?.has(task.id)||runtime.workbenchTaskJobs?.has(task.id)||runtime.job&&(!runtime.activeTaskId||runtime.activeTaskId===task.id))throw Error('请先等待原控制器交回任务');
 return task;
}
function checkScope(runtime,ticket){if(ticket.scope!==connectionIdentity(runtime.store.get('pair')))throw Error('工作区或设备已切换，旧人工确认已放弃');if(runtime.store.get(key(ticket.task.id))?.id!==ticket.id)throw Error('人工确认凭证已变化，请重新确认');}
function ownedReceipt(task,ticket){return task.receipt?.successProof?.manualConfirmationId===ticket.id&&task.receipt.confirmedBy==='manual'&&(!ticket.receipt||isDeepStrictEqual(task.receipt,ticket.receipt));}
function checkFrozenTask(task,ticket){if(['runId','profileId','profileSnapshot','profileRevision','url','destinationKey','targetId','browserInstance','attemptBoundary'].some(field=>!isDeepStrictEqual(task[field],ticket.task[field])))throw Error('原任务、产品资料或提交边界已变化，请重新确认');}

// Only the authenticated native workbench exposes this challenge. The original
// page bridge cannot request it or confirm success on the user's behalf.
export function previewManualConfirmation(runtime,input){
 const task=taskFor(runtime,input),old=runtime.store.get(key(task.id));
 if(old&&ownedReceipt(task,old)){checkScope(runtime,old);checkFrozenTask(task,old);return{ok:true,confirmationNonce:old.id,taskId:task.id,runId:task.runId,pending:task.cloudVerified!==true,evidence:task.receipt.evidence};}
 if(task.receipt||!parkedStatuses.has(task.status))throw Error('该任务当前不在待人工确认状态');
 const ticket={id:randomUUID(),scope:connectionIdentity(runtime.store.get('pair')),task:plain(task),at:new Date().toISOString(),status:'prepared'};
 runtime.store.set(key(task.id),ticket);
 return{ok:true,confirmationNonce:ticket.id,taskId:task.id,runId:task.runId,pending:false};
}

export async function confirmManualSubmission(runtime,input){
 let task=taskFor(runtime,input),ticket=runtime.store.get(key(task.id));
 if(!ticket||!input.confirmationNonce||input.confirmationNonce!==ticket.id)throw Error('人工确认凭证无效，请刷新待人工列表后重试');
 checkScope(runtime,ticket);
 checkFrozenTask(task,ticket);
 if(!ownedReceipt(task,ticket)){
  if(task.receipt||!parkedStatuses.has(task.status)||!isDeepStrictEqual(plain(task),ticket.task))throw Error('原任务或确认状态已变化，请重新确认');
  const proof=plain(automationLedger.validateSuccessProof({confirmedBy:'manual',evidence:input.evidence||'user confirmed submission success'}));
  if(!proof.ok)throw Error(proof.reason);
  const check=()=>{checkScope(runtime,ticket);if(!isDeepStrictEqual(plain(runtime.store.get('task:'+task.id)),plain(task)))throw Error('原任务或资料已变化，人工确认已放弃');taskFor(runtime,input);};
  const snapshot=await runtime.cloud.request('snapshot');check();
  if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('最新云端已有本站成功记录，请核对已有回执');
  await runtime.lease(task,{online:true});check();
  const receivedAt=new Date().toISOString(),receipt={evidence:proof.evidence,evidenceType:proof.evidenceType,confirmedBy:'manual',publicationStatus:queue.inferPublicationStatus({evidence:proof.evidence,publicationStatus:task.publicationStatus,publicUrl:task.publicUrl||'',evidenceUrl:task.evidenceUrl||task.url}),publicUrl:task.publicUrl||'',url:task.url,evidenceUrl:task.evidenceUrl||task.url,receivedAt,syncStatus:'pending',successProof:{source:'manual',manualConfirmationId:ticket.id}};
  // A user's confirmation is evidence of receipt, not a report of fields the
  // executor never saw. Existing actual fields and unknown attempts stay intact.
  runtime.update(task,{receipt,cloudVerified:false,confirmedBy:'manual',successEvidence:proof.evidence,
   actualSubmission:task.actualSubmission||{profileId:task.profileId,profileRevision:task.profileRevision,source:'manual_confirmation',fields:{},attachments:[]},
   manualConfirmation:{id:ticket.id,at:receivedAt,status:'pending_sync'},
   indexNowNotification:task.indexNowNotification||prepareIndexNotification(runtime,task),reason:'人工已确认成功，等待云端账本回读'},'manual_success_confirmation',
   {[key(task.id)]:{...ticket,status:'pending_sync',receipt}});
  ticket=runtime.store.get(key(task.id));
 }
 if(task.cloudVerified!==true){
  try{await runtime.synchronize();}catch(error){checkScope(runtime,ticket);const current=taskFor(runtime,input);checkFrozenTask(current,ticket);if(!ownedReceipt(current,ticket))throw Error('原人工确认已变化，保留当前结果');return{ok:true,confirmed:false,pending:true,taskId:task.id,syncError:error.message};}
 }
 checkScope(runtime,ticket);task=taskFor(runtime,input);
 checkFrozenTask(task,ticket);
 if(!ownedReceipt(task,ticket))throw Error('原人工确认已变化，保留当前结果');
 if(task.cloudVerified!==true)return{ok:true,confirmed:false,pending:true,taskId:task.id,syncError:'人工确认已保存在本机，云端独立回读尚未完成'};
 if(task.manualConfirmation?.status!=='confirmed'){
  runtime.update(task,{status:'finished',siteStatus:'accepted',attentionType:'',skipReason:'',confirmationNonce:'',manualTabId:0,manualTabUrl:'',manualSubmissionConsent:null,
   reason:'人工确认成功，云端账本已回读',completedAt:task.receipt.receivedAt,manualConfirmation:{...task.manualConfirmation,status:'confirmed'}},'manual_success_confirmed',
   {[key(task.id)]:{...ticket,status:'confirmed'}});
  finishWorkbenchTask(runtime,task.id);
 }
 let syncError='';try{await runtime.synchronize();}catch(error){syncError=error.message;}
 checkScope(runtime,ticket);const current=taskFor(runtime,input);checkFrozenTask(current,ticket);if(!ownedReceipt(current,ticket))throw Error('原人工确认已变化，保留当前结果');
 if(!syncError){runtime.wakeWorkbench?.();runtime.tick?.();}
 return{ok:true,confirmed:true,pending:false,taskId:task.id,...(syncError?{syncError}:{})};
}
