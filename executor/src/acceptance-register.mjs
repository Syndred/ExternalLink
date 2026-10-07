import { randomUUID } from 'node:crypto';
import { queue, plain } from './shared.mjs';
import {jsonValueEqual} from '../../core/json-value.mjs';

const connection=runtime=>{const pair=runtime.store.get('pair');return JSON.stringify([pair?.endpoint,pair?.workspaceId,pair?.deviceId,pair?.deviceToken,pair?.storageBackend]);};
async function restoreOriginalRegistration(runtime,cloud,combo,taskId,expectedRunId,acceptanceId,check,{frozenProfile=false}={}){
 if(!expectedRunId)throw Error('原注册缺少批次编号，禁止创建替代任务');
 const local=runtime.store.get('task:'+taskId),response=await cloud.request('runs?runId='+encodeURIComponent(expectedRunId));check();const task=response.tasks?.find(task=>task.id===taskId);
 if(!task||task.id!==taskId||task.profileId!==combo.profileId||!task.runId||expectedRunId&&task.runId!==expectedRunId||queue.extractDomain(task.url).toLowerCase()!==combo.siteId||queue.normalizeDestinationKey(task.url)!==task.destinationKey)throw Error('原注册任务身份回读不一致，保留原编号');
 const run=response.runs?.find(run=>run.id===task.runId);
 if(!run?.profile||run.profileId!==task.profileId||!Array.isArray(run.tasks)||!run.tasks.includes(taskId)||!Array.isArray(run.mediaManifest))throw Error('原批次完整资料或素材回读缺失，不能使用索引摘要');
 if(frozenProfile&&(!jsonValueEqual(run.profile,combo.profile)||run.profileRevision!==combo.profileRevision||task.url!==combo.url))throw Error('原注册资料与冻结范围不一致，禁止替换');
 const existing=runtime.store.get('run:'+run.id);
 for(const key of ['id','profileId','profileRevision','profile','mediaManifest','tasks','createdAt'])if(existing?.[key]!==undefined&&!jsonValueEqual(existing[key],run[key]))throw Error('原批次与本机档案冲突，保留原件');
 if(local&&['runId','profileId','url','destinationKey'].some(key=>local[key]!==task[key]))throw Error('原任务与本机身份冲突，保留原件');
 if(local&&(task.attemptBoundary&&!local.attemptBoundary||task.receipt&&!local.receipt))throw Error('云端原任务已有提交边界或收件，请先核验，未覆盖本机记录');
 const retained=local||task;runtime.store.db.exec('BEGIN IMMEDIATE');
 try{check();runtime.store.set('run:'+run.id,{...run,...existing});runtime.store.set('task:'+taskId,{...retained,acceptanceId});runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
 return retained;
}

// Registration never opens a site. A durable intent precedes every cloud
// mutation; an uncertain response is read back by its original IDs.
export async function registerAcceptance(runtime,id){
 const frozen=runtime.store.get('acceptance:'+id);
 if(!frozen||frozen.count!==frozen.combinations.length)throw Error('缺少完整冻结范围');
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('注册固定范围需要后台暂停空闲');
 const identity=connection(runtime),check=()=>{if(connection(runtime)!==identity)throw Error('工作区或设备连接已变化，原注册编号保留');},cloud=runtime.cloud;
 const snapshot=await cloud.request('snapshot');check();
 const inventory=await cloud.request('runs?view=inventory');check();
 let execution=runtime.store.get('acceptanceExecution:'+id)||{id,scopeSha256:frozen.sha256,createdAt:new Date().toISOString(),items:{}};
 if(execution.scopeSha256!==frozen.sha256)throw Error('固定范围校验不一致');
 const save=()=>{check();runtime.store.set('acceptanceExecution:'+id,execution);};
 for(const combo of frozen.combinations){
  check();
  let item=execution.items[combo.identity];
  if(item?.status==='excluded'||item?.status==='registration_rejected')continue;
  if(item?.status==='registered'){
   const localTask=runtime.store.get('task:'+item.taskId),localRun=runtime.store.get('run:'+item.runId);
   if(!localTask||!localRun?.profile||!Array.isArray(localRun.mediaManifest)||!localRun.tasks?.includes(item.taskId))await restoreOriginalRegistration(runtime,cloud,combo,item.taskId,item.runId,id,check,{frozenProfile:!item.originalTask});
   continue;
  }
  if(item?.status==='registering'||item?.status==='registration_unknown'){
   const original=inventory.tasks.find(t=>t.id===item.taskId);
   if(!original){item.status='registration_unknown';item.reason='注册响应未确认，云端暂未读到原 ID；禁止创建替代任务';save();continue;}
   await restoreOriginalRegistration(runtime,cloud,combo,item.taskId,item.runId,id,check,{frozenProfile:true});
   item.status='registered';item.reason='原注册 ID、完整资料及素材已回读';delete item.request;save();continue;
  }
  const previous=runtime.store.values('task:').find(t=>t.id===combo.existingTaskId)||inventory.tasks.find(t=>t.profileId===combo.profileId&&queue.extractDomain(t.url).toLowerCase()===combo.siteId);
  if(previous){
   const task=await restoreOriginalRegistration(runtime,cloud,combo,previous.id,previous.runId,id,check);
   execution.items[combo.identity]={status:'registered',taskId:task.id,runId:task.runId,originalTask:true,requiresVerification:!!task.attemptBoundary,at:new Date().toISOString()};save();continue;
  }
  const current=snapshot.documents.siteProfiles?.[combo.profileId];
  if(!jsonValueEqual(current,combo.profile)||snapshot.revisions.siteProfiles!==combo.profileRevision){
   execution.items[combo.identity]={status:'registration_rejected',reason:'云端资料版本已变化，冻结资料仍保留；不替换组合或资料',at:new Date().toISOString()};save();continue;
  }
  const run={id:randomUUID(),profileId:combo.profileId,profileRevision:combo.profileRevision,createdAt:new Date().toISOString(),acceptanceId:id,
   authorization:'ordinary_free_submission',ordinaryPermissionsAuthorized:true,feeLimit:0,tasks:[{id:randomUUID(),url:combo.url,destinationKey:queue.normalizeDestinationKey(combo.url)}]};
  item=execution.items[combo.identity]={status:'registering',runId:run.id,taskId:run.tasks[0].id,request:run,at:new Date().toISOString()};save();
  try{
   const saved=await cloud.request('runs',{run});check();
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
