import { randomUUID } from 'node:crypto';
import { queue, plain } from './shared.mjs';

// Registration never opens a site. A durable intent precedes every cloud
// mutation; an uncertain response is read back by its original IDs.
export async function registerAcceptance(runtime,id){
 const frozen=runtime.store.get('acceptance:'+id);
 if(!frozen||frozen.count!==frozen.combinations.length)throw Error('缺少完整冻结范围');
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('注册固定范围需要后台暂停空闲');
 const snapshot=await runtime.cloud.request('snapshot');
 const inventory=await runtime.cloud.request('runs?view=inventory');
 let execution=runtime.store.get('acceptanceExecution:'+id)||{id,scopeSha256:frozen.sha256,createdAt:new Date().toISOString(),items:{}};
 if(execution.scopeSha256!==frozen.sha256)throw Error('固定范围校验不一致');
 const save=()=>runtime.store.set('acceptanceExecution:'+id,execution);
 for(const combo of frozen.combinations){
  let item=execution.items[combo.identity];
  if(item?.status==='registered'||item?.status==='excluded'||item?.status==='registration_rejected')continue;
  const previous=runtime.store.values('task:').find(t=>t.id===combo.existingTaskId)||inventory.tasks.find(t=>t.profileId===combo.profileId&&queue.extractDomain(t.url).toLowerCase()===combo.siteId);
  if(previous){
   const task=runtime.store.get('task:'+previous.id)||(await runtime.cloud.request('tasks/'+previous.id)).task;
   if(!task)throw Error('原任务回读缺失');
   runtime.store.set('task:'+task.id,{...task,acceptanceId:id});
   execution.items[combo.identity]={status:'registered',taskId:task.id,runId:task.runId,originalTask:true,requiresVerification:!!task.attemptBoundary,at:new Date().toISOString()};save();continue;
  }
  if(item?.status==='registering'||item?.status==='registration_unknown'){
   const task=inventory.tasks.find(t=>t.id===item.taskId);
   if(!task){item.status='registration_unknown';item.reason='注册响应未确认，云端暂未读到原 ID；禁止创建替代任务';save();continue;}
   const read=await runtime.cloud.request('tasks/'+task.id);const run=inventory.runs.find(r=>r.id===item.runId);
   if(!run||!read.task)throw Error('原批次回读不完整');
   runtime.store.set('run:'+run.id,run);runtime.store.set('task:'+task.id,{...read.task,profileSnapshot:plain(combo.profile),acceptanceId:id});
   item.status='registered';item.reason='原注册 ID 已回读';save();continue;
  }
  const current=snapshot.documents.siteProfiles?.[combo.profileId];
  if(JSON.stringify(current)!==JSON.stringify(combo.profile)||snapshot.revisions.siteProfiles!==combo.profileRevision){
   execution.items[combo.identity]={status:'registration_rejected',reason:'云端资料版本已变化，冻结资料仍保留；不替换组合或资料',at:new Date().toISOString()};save();continue;
  }
  const run={id:randomUUID(),profileId:combo.profileId,profileRevision:combo.profileRevision,createdAt:new Date().toISOString(),acceptanceId:id,
   authorization:'ordinary_free_submission',ordinaryPermissionsAuthorized:true,feeLimit:0,tasks:[{id:randomUUID(),url:combo.url,destinationKey:queue.normalizeDestinationKey(combo.url)}]};
  item=execution.items[combo.identity]={status:'registering',runId:run.id,taskId:run.tasks[0].id,request:run,at:new Date().toISOString()};save();
  try{
   const saved=await runtime.cloud.request('runs',{run});
   if(saved.run?.id!==run.id||saved.tasks?.[0]?.id!==item.taskId)throw Error('注册响应身份不一致');
   runtime.store.set('run:'+run.id,saved.run);
   for(const task of saved.tasks)runtime.store.set('task:'+task.id,{...task,profileSnapshot:plain(combo.profile),acceptanceId:id});
   item.status='registered';delete item.request;save();
  }catch(error){
   item.status=error.status>=400&&error.status<500?'registration_rejected':'registration_unknown';item.reason=error.message;save();
   if(item.status==='registration_unknown')break;
  }
 }
 return{ok:true,id,count:frozen.count,scopeSha256:frozen.sha256,items:execution.items,started:false};
}
