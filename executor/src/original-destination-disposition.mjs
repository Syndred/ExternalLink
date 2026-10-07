import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {queue} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {assertBatchPolicy,noteBatchTaskResult} from './workbench-batch-policy.mjs';
import {checkpointTaskUpdate} from './workbench-batch-recovery.mjs';
import {originalUnattended as U} from '../../core/original-batch-config.mjs';
import {batchJson,batchScopeRows} from '../../core/workbench-batch-recovery.mjs';

// bd916b2 markTaskNeedsManual / markTaskBlocked and cancelRemainingDestinationTasks.
// Classification is already independently saved before a dead-end disposition.
export function originalDeadEndDisposition(result,status){
 if(!queue.isDeadEndStatus(status)||result.semanticReview||result.uncertain||result.payment_uncertain||result.humanGate==='payment_uncertain'||result.matched)return null;
 return{kind:'dead_end',classificationStatus:status,taskStatus:result.blocked||result.status==='blocked'?status==='paid'?'skip':'err':'skip',reason:result.reason||status};
}
const destination=task=>task.destinationGroupKey||task.destinationKey||queue.normalizeDestinationKey(task.url);
const pending=task=>task?.status==='pending'&&!task.receipt&&!task.attemptBoundary&&!['ai','supervisor'].includes(task.controller);
const stale=message=>Object.assign(Error(message),{staleTask:true});
const sameIdentity=(item,task)=>item.taskId===task.id&&item.runId===task.runId&&item.profileId===task.profileId&&item.url===task.url&&(!item.destinationKey||item.destinationKey===task.destinationKey);
function originalGroup(runtime,task){
 if(task.workbenchBatchId){const batch=runtime.store.get('workbenchBatch:'+task.workbenchBatchId);if(!batch)throw stale('原批次不可读，保留同站待处理任务');assertBatchPolicy(runtime,batch);if(batch.count!==batch.items.length||new Set(batch.items.map(item=>item.taskId)).size!==batch.count||batch.cloudRecoveryVersion===1&&batch.scopeSha256!==createHash('sha256').update(batchJson(batchScopeRows(batch))).digest('hex'))throw stale('原批次范围校验失败');if(!batch.items.some(item=>sameIdentity(item,task)))throw stale('当前任务不属于原批次');return{key:'workbenchBatch:'+batch.id,record:batch,ids:batch.items.filter(item=>(item.destinationGroupKey||item.destinationKey||queue.normalizeDestinationKey(item.url))===destination(task)&&!['complete','excluded'].includes(item.status)).map(item=>item.taskId)};}
 if(task.acceptanceId){const frozen=runtime.store.get('acceptance:'+task.acceptanceId),execution=runtime.store.get('acceptanceExecution:'+task.acceptanceId),batch=runtime.store.get('acceptanceBatch');const {sha256,startedAt,...scope}=frozen||{};if(!frozen||!execution||batch?.id!==task.acceptanceId||frozen.sha256!==batch.scopeSha256||execution.scopeSha256!==frozen.sha256||frozen.count!==batch.count||createHash('sha256').update(JSON.stringify(scope)).digest('hex')!==sha256)throw stale('原固定范围校验失败，保留同站待处理任务');const members=frozen.combinations.map(combo=>({combo,entry:execution.items[combo.identity],id:execution.items[combo.identity]?.taskId||combo.existingTaskId}));if(!members.some(({combo,entry,id})=>id===task.id&&combo.profileId===task.profileId&&combo.url===task.url&&(!entry?.runId||entry.runId===task.runId)))throw stale('当前任务不属于原固定范围');return{key:'acceptanceBatch',record:batch,identities:members,ids:members.filter(({combo})=>queue.normalizeDestinationKey(combo.url)===destination(task)).map(({id})=>id).filter(Boolean)};}
 const run=runtime.store.get('run:'+task.runId);if(!run)return{ids:[]};if(run.id!==task.runId||run.profileId!==task.profileId||!(run.tasks||[]).some(item=>(typeof item==='string'?item:item.id)===task.id))throw stale('当前任务不属于原运行组');return{key:'run:'+task.runId,record:run,ids:(run.tasks||[]).map(item=>typeof item==='string'?item:item.id)};
}
const frozenGroup=group=>!group.key?null:group.key.startsWith('workbenchBatch:')?{id:group.record.id,scope:group.record.scope,count:group.record.count,config:group.record.config,configSha256:group.record.configSha256,scopeSha256:group.record.scopeSha256,items:group.record.items.map(({identity,url,profileId,destinationKey,destinationGroupKey,taskId,runId,profile,profileRevision})=>({identity,url,profileId,destinationKey,destinationGroupKey,taskId,runId,profile,profileRevision}))}:group.key==='acceptanceBatch'?{id:group.record.id,count:group.record.count,scopeSha256:group.record.scopeSha256,identities:group.identities}:{id:group.record.id,profileId:group.record.profileId,profile:group.record.profile,tasks:group.record.tasks};
export async function applyOriginalDestinationDisposition(runtime,{task,result,classification,assertCurrent}){
 const disposition=originalDeadEndDisposition(result,classification?.status);if(!disposition)return null;
 await assertCurrent();const scope=workbenchScope(runtime.store.get('pair')),group=originalGroup(runtime,task),frozen=structuredClone(frozenGroup(group)),originalTask=structuredClone(runtime.store.get('task:'+task.id)),prepared=[];
 const sameGroup=()=>{if(scope!==workbenchScope(runtime.store.get('pair')))throw Object.assign(Error('工作区已变化，同站取消结果已放弃'),{staleTask:true});const current=originalGroup(runtime,task);if(group.key&&(current.key!==group.key||!isDeepStrictEqual(frozenGroup(current),frozen)))throw Object.assign(Error('原批次范围已变化，同站取消结果已放弃'),{staleTask:true});group.record=current.record;};
 for(const id of new Set(group.ids)){
  if(id===task.id)continue;await assertCurrent();sameGroup();let sibling=runtime.store.get('task:'+id);
  if(!pending(sibling)||destination(sibling)!==destination(task)||runtime.activeTaskIds?.has(id)||runtime.store.get('singleTaskId')===id)continue;
  if(task.workbenchBatchId){const item=group.record.items.find(item=>item.taskId===id);if(sibling.workbenchBatchId!==task.workbenchBatchId||!sameIdentity(item,sibling))throw stale('同站任务已不属于原批次，保留新状态');}
  else if(task.acceptanceId){const member=group.identities.find(item=>item.id===id);if(sibling.acceptanceId!==task.acceptanceId||member.combo.profileId!==sibling.profileId||member.combo.url!==sibling.url||member.entry?.runId&&member.entry.runId!==sibling.runId)throw stale('同站任务已不属于原固定范围');}
  else if(sibling.runId!==task.runId||sibling.profileId!==task.profileId||sibling.workbenchBatchId||sibling.acceptanceId)throw stale('同站任务已属于其他运行组');
  const before=structuredClone(sibling);
  if(!runtime.store.get('offlineMode')?.enabled){
   const read=await runtime.cloud.request('runs?runId='+encodeURIComponent(sibling.runId));await assertCurrent();sameGroup();const remote=read.tasks?.find(remote=>remote.id===id);
   if(!isDeepStrictEqual(runtime.store.get('task:'+id),before))throw Object.assign(Error('同站原任务已变化，取消结果已放弃'),{staleTask:true});
   if(!remote||['id','runId','profileId','url','destinationKey'].some(key=>remote[key]!==sibling[key])||!pending(remote)||remote.version!==sibling.version)throw Object.assign(Error('云端同站原任务不再是待执行状态，保留待核验'),{status:409});
   const lease=await runtime.cloud.request('lease',{taskId:id,version:sibling.version,controllerId:runtime.controllerId});await assertCurrent();sameGroup();
   if(!Number.isSafeInteger(lease.version)||lease.version<sibling.version)throw Object.assign(Error('云端同站领取版本不可核验，取消未保存'),{status:409});
   if(!isDeepStrictEqual(runtime.store.get('task:'+id),before))throw Object.assign(Error('领取期间同站原任务已变化，保留新状态'),{staleTask:true});
   sibling={...sibling,version:lease.version,controllerId:runtime.controllerId};runtime.store.set('task:'+id,sibling);
  }
  prepared.push({before:structuredClone(sibling),task:sibling});
 }
 await assertCurrent();sameGroup();if(!isDeepStrictEqual(runtime.store.get('task:'+task.id),originalTask))throw Object.assign(Error('原目标处置任务已变化'),{staleTask:true});
 for(const sibling of prepared)if(!isDeepStrictEqual(runtime.store.get('task:'+sibling.task.id),sibling.before))throw Object.assign(Error('同站待执行任务在保存前已变化'),{staleTask:true});
 const previous=task.originalDestinationDisposition;
 if(!prepared.length&&previous?.kind==='dead_end'&&previous.scope===scope&&previous.classificationStatus===classification.status&&previous.reason===disposition.reason&&(!task.attemptBoundary&&!task.receipt?task.status===disposition.taskStatus:true))return previous;
 const at=new Date().toISOString(),reason=result.reason||classification.reason||disposition.reason,ownPatch={originalDestinationDisposition:{...disposition,scope,sourceTaskId:task.id,at,cancelledTaskIds:[...new Set([...(previous?.scope===scope&&previous.kind==='dead_end'?previous.cancelledTaskIds||[]:[]),...prepared.map(item=>item.task.id)])]},hasActivity:true,...(!task.attemptBoundary&&!task.receipt?{status:disposition.taskStatus,siteStatus:'not_submitted',reason,attentionType:'destination_dead_end'}:{})},rows=[{task,patch:ownPatch,type:'original_destination_dead_end'},...prepared.map(({task:sibling})=>({task:sibling,patch:{status:'skip',siteStatus:'not_submitted',reason:`blocked_by_destination:${classification.status}:${reason||''}`,hasActivity:true,originalDestinationDisposition:{kind:'blocked_by_destination',classificationStatus:classification.status,sourceTaskId:task.id,scope,at},...(task.workbenchBatchId?{workbenchBatchId:task.workbenchBatchId}:{})},type:'original_destination_sibling_cancelled'}))];
 let states={};
 if(group.key&&!group.key.startsWith('run:')){let next=structuredClone(group.record);if(group.key.startsWith('workbenchBatch:')){for(const row of rows){const item=next.items.find(item=>item.taskId===row.task.id);if(!item)throw Error('原批次取消任务缺失');item.status='complete';item.result=row.task.receipt?'received':row.task.attemptBoundary?'sent_unconfirmed':row.patch.status;item.reason=row.patch.reason||row.task.reason;item.completedAt=at;if(next.config?.unattended&&!row.task.attemptBoundary&&!row.task.receipt)next.unattendedState=U.removeManualTodo(next.unattendedState,row.task.id);}while(next.cursor<next.items.length&&['complete','excluded'].includes(next.items[next.cursor].status))next.cursor++;if(task.originalDestinationDisposition?.kind!=='dead_end'||!['skip','err'].includes(task.status)){next=noteBatchTaskResult(runtime,next,{...task,...ownPatch},{persistPause:false});if(next.status==='paused'&&group.record.status==='running')states.paused=true;}}
  else{for(const combo of runtime.store.get('acceptance:'+task.acceptanceId).combinations){const entry=runtime.store.get('acceptanceExecution:'+task.acceptanceId).items[combo.identity],row=rows.find(row=>row.task.id===(entry?.taskId||combo.existingTaskId));if(row&&row.task.id!==task.id)next.attempts[combo.identity]={...next.attempts[combo.identity],taskId:row.task.id,status:'skip',reason:row.patch.reason,completedAt:at};}}
  states[group.key]=next;
 }
 const changes=[];for(const row of rows){const checkpoint=checkpointTaskUpdate(runtime,row.task,row.patch,states);states=checkpoint.stateChanges;changes.push({task:{...row.task,...checkpoint.patch},type:row.type});}
 runtime.store.transitionMany(changes,states);Object.assign(task,changes[0].task);runtime.wakeWorkbench?.();return task.originalDestinationDisposition;
}
