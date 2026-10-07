import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {originalGroup,frozenGroup} from './original-destination-disposition.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {checkpointTaskUpdate,flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';
import {queue} from './shared.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {noteBatchTaskResult} from './workbench-batch-policy.mjs';

export const originalUnavailableReason='云端 AI 服务暂不可用，请稍后重试';
export function originalAgentUnavailableError(error){return !error?.originalTaskSyncFailure&&!error?.staleTask&&!error?.unattendedBudget&&!error?.batchPaused&&![401,403,409].includes(error?.status)&&/云端|cloud|worker|fetch/i.test(error?.message||'');}
export async function originalTaskSync(work){try{return await work();}catch(error){if(!error.staleTask&&!error.unattendedBudget&&!error.batchPaused)error.originalTaskSyncFailure=true;throw error;}}
const stale=message=>Object.assign(Error(message),{staleTask:true});
const destination=task=>task.destinationGroupKey||task.destinationKey||queue.normalizeDestinationKey(task.url);
const digest=group=>{if(!group.key)return null;const frozen=frozenGroup(group);if(group.key==='acceptanceBatch')frozen.identities=frozen.identities.map(({combo,entry,id})=>({combo,id,runId:entry?.runId}));return createHash('sha256').update(batchJson(frozen)).digest('hex');};
function assertFrozenProfile(task,group){const frozen=group.key?.startsWith('workbenchBatch:')?group.record.items.find(item=>item.taskId===task.id):group.key==='acceptanceBatch'?group.identities.find(item=>item.id===task.id)?.combo:null;const expected=frozen?.profile;if(expected&&task.profileSnapshot&&!isDeepStrictEqual(expected,task.profileSnapshot)||frozen?.profileRevision!==undefined&&task.profileRevision!==undefined&&task.profileRevision!==frozen.profileRevision)throw stale('原同站产品资料已离开冻结范围');}
function members(runtime,task,group){
 const ids=group.key?.startsWith('workbenchBatch:')?group.record.items.map(item=>item.taskId):group.key==='acceptanceBatch'?group.identities.map(item=>item.id):(group.record?.tasks||[]).map(item=>typeof item==='string'?item:item.id);
 return ids.map(id=>runtime.store.get('task:'+id)).filter(item=>item&&destination(item)===destination(task)).map(item=>{const member=originalGroup(runtime,item);if(member.key!==group.key||digest(member)!==digest(group))throw stale('同站产品已不属于原冻结组');assertFrozenProfile(item,member);return item;});
}
const future=(runtime,task,group)=>{const tasks=members(runtime,task,group),index=tasks.findIndex(item=>item.id===task.id);return index<0?[]:tasks.slice(index+1);};

// Original skipTaskWithReason: skip this product, then advanceDestinationGroup.
// The next product is claimed by its ordinary scheduler, under the frozen budget.
export async function skipOriginalUnavailableTask(runtime,{task,page,result,assertCurrent}){
 if(!result.originalAgentUnavailable||task.receipt||task.attemptBoundary)return false;
 await assertCurrent();let group=originalGroup(runtime,task);const scope=workbenchScope(runtime.store.get('pair')),groupDigest=digest(group),before=structuredClone(runtime.store.get('task:'+task.id));
 if(!group.key)throw stale('原代理跳过缺少原运行组，保留任务');
 if(before.controller!=='executor'||before.receipt||before.attemptBoundary||before.syncConflict||!isDeepStrictEqual(before,task))throw stale('原代理跳过任务已变化');
 if(before.status==='skip'&&before.attentionType==='agent_unavailable'&&before.originalAgentSkip?.aiTakeoverId===(task.aiTakeover?.id||null))return true;
 await assertCurrent();group=originalGroup(runtime,task);if(scope!==workbenchScope(runtime.store.get('pair'))||digest(group)!==groupDigest||!isDeepStrictEqual(runtime.store.get('task:'+task.id),before))throw stale('原代理跳过范围或任务已变化');
 const next=future(runtime,task,group).find(item=>item.status==='pending');
 const at=new Date().toISOString(),patch={status:'skip',siteStatus:'not_submitted',attentionType:'agent_unavailable',reason:originalUnavailableReason,hasActivity:true,
  originalAgentSkip:{at,cause:result.reason||'',aiTakeoverId:task.aiTakeover?.id||null},
  originalGroupAdvance:{scope,groupKey:group.key,groupSha256:groupDigest,sourceTaskId:task.id,targetId:task.targetId,browserInstance:task.browserInstance,pageUrl:page.url(),status:next?'awaiting_next':'complete',nextTaskId:next?.id||null,at}};
 let states={};if(group.key.startsWith('workbenchBatch:')){let batch=structuredClone(group.record);const item=batch.items.find(item=>item.taskId===task.id);item.status='complete';item.result='skip';item.reason=originalUnavailableReason;item.completedAt=at;while(batch.cursor<batch.items.length&&['complete','excluded'].includes(batch.items[batch.cursor].status))batch.cursor++;batch=noteBatchTaskResult(runtime,batch,{...task,...patch},{persistPause:false});states[group.key]=batch;}
 runtime.update(task,patch,'original_agent_unavailable_skipped',states);return true;
}

// Called after the next task's lease and frozen task-budget claim, before opening
// or filling. Transfer and its two task events survive a crash together.
export async function attachOriginalGroupPage(runtime,task){
 if(!task.originalGroupPage&&!runtime.store.values('task:').some(source=>source.originalGroupAdvance?.status==='awaiting_next'&&source.workbenchBatchId===task.workbenchBatchId&&source.acceptanceId===task.acceptanceId&&(task.workbenchBatchId||task.acceptanceId||source.runId===task.runId)&&destination(source)===destination(task)))return false;
 const group=originalGroup(runtime,task),scope=workbenchScope(runtime.store.get('pair'));if(!group.key)return false;
 assertFrozenProfile(task,group);
 if(task.originalGroupPage){const assigned=task.originalGroupPage,source=runtime.store.get('task:'+assigned.sourceTaskId);if(assigned.status==='original_page_missing')throw stale('原同站页签已缺失，须明确恢复原任务');if(!['assigned','navigating','ready'].includes(assigned.status)||assigned.scope!==scope||assigned.groupKey!==group.key||assigned.groupSha256!==digest(group)||assigned.targetId!==task.targetId||assigned.browserInstance!==runtime.host?.startedAt||source?.originalGroupAdvance?.status!=='transferred'||source.originalGroupAdvance.nextTaskId!==task.id||source.originalGroupAdvance.targetId!==assigned.targetId||source.receipt||source.attemptBoundary||source.controller!=='executor'||task.receipt||task.attemptBoundary||task.syncConflict||task.controller!=='executor')throw stale('恢复的原同站页签转交身份已变化');if(task.acceptanceId||!runtime.store.get('offlineMode')?.enabled){const before=structuredClone(task),prior=structuredClone(source);await originalTaskSync(()=>flushBatchTaskEvents(runtime,source));const remote=(await originalTaskSync(()=>runtime.cloud.request('runs?runId='+encodeURIComponent(source.runId)))).tasks?.find(item=>item.id===source.id);if(scope!==workbenchScope(runtime.store.get('pair'))||!isDeepStrictEqual(runtime.store.get('task:'+task.id),before)||!isDeepStrictEqual(runtime.store.get('task:'+source.id),prior)||!remote||['id','version','status','controller','runId','profileId','targetId','browserInstance'].some(key=>remote[key]!==source[key])||remote.receipt||remote.attemptBoundary||remote.syncConflict||!isDeepStrictEqual(remote.originalGroupAdvance,source.originalGroupAdvance))throw stale('恢复期间云端原页来源已变化，原页接续已停止');}return true;}
 const source=members(runtime,task,group).find(source=>source.originalGroupAdvance?.status==='awaiting_next'&&future(runtime,source,group).find(item=>item.status==='pending')?.id===task.id);
 if(!source)return false;const advance=structuredClone(source.originalGroupAdvance),before=structuredClone(task);let sourceBefore=structuredClone(source);
 const check=()=>{const current=runtime.store.get('task:'+task.id),prior=runtime.store.get('task:'+source.id),currentGroup=originalGroup(runtime,task);if(scope!==workbenchScope(runtime.store.get('pair'))||advance.scope!==scope||advance.groupKey!==currentGroup.key||advance.groupSha256!==digest(currentGroup)||!isDeepStrictEqual(current,before)||!isDeepStrictEqual(prior,sourceBefore)||runtime.store.get('paused')!==false||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||current.controller!=='executor'||current.receipt||current.attemptBoundary||current.syncConflict||current.status!=='pending'||source.status!=='skip'||source.receipt||source.attemptBoundary||source.syncConflict||source.controller!=='executor'||advance.browserInstance!==runtime.host?.startedAt||runtime.activeTaskIds?.has(source.id)||runtime.activeTaskId===source.id)throw stale('原同站接续任务、预算范围或原页已变化');};
 check();
 if(task.acceptanceId||!runtime.store.get('offlineMode')?.enabled){await originalTaskSync(async()=>{await flushBatchTaskEvents(runtime,source);check();const remote=(await runtime.cloud.request('runs?runId='+encodeURIComponent(source.runId))).tasks?.find(item=>item.id===source.id);check();if(!remote||['id','runId','profileId','url','destinationKey','version','status','controller'].some(key=>remote[key]!==source[key])||remote.receipt||remote.attemptBoundary||remote.syncConflict||!isDeepStrictEqual(remote.profileSnapshot,source.profileSnapshot)||!isDeepStrictEqual(remote.originalGroupAdvance,advance))throw Object.assign(Error('云端原页来源任务已变化，未转交'),{status:409});const lease=await runtime.cloud.request('lease',{taskId:source.id,version:source.version,controllerId:runtime.controllerId});check();if(!Number.isSafeInteger(lease.version)||lease.version<source.version)throw Object.assign(Error('原页来源控制权版本不可核验'),{status:409});source.version=lease.version;source.controllerId=runtime.controllerId;runtime.store.set('task:'+source.id,source);sourceBefore=structuredClone(source);});}
 check();let page;try{page=await runtime.findPage(source);}catch(error){check();runtime.update(task,{status:'needs_manual',attentionType:'group_navigation_failed',reason:'无法重新进入提交入口: '+error.message,originalGroupPage:{scope,sourceTaskId:source.id,status:'original_page_missing',targetId:advance.targetId,browserInstance:advance.browserInstance}},'original_group_page_missing');return false;}
 check();const info=await getTargetInfo(runtime.context,page);check();if(info?.targetId!==advance.targetId||page.isClosed()||page.url()!==advance.pageUrl)throw stale('原同站页签或网址已变化，未复用');
 if(runtime.store.values('task:').some(other=>other.id!==source.id&&other.id!==task.id&&other.targetId===advance.targetId&&other.browserInstance===advance.browserInstance&&!other.tabClosedAt&&other.originalGroupAdvance?.status!=='transferred'))throw stale('原页仍被其他任务关联，未接续新产品');
 const at=new Date().toISOString(),patch={targetId:advance.targetId,browserInstance:advance.browserInstance,tabClosedAt:null,originalGroupPage:{scope,groupKey:group.key,groupSha256:advance.groupSha256,sourceTaskId:source.id,targetId:advance.targetId,browserInstance:advance.browserInstance,status:'assigned',at}},sourcePatch={originalGroupAdvance:{...advance,status:'transferred',transferredAt:at,nextTaskId:task.id}};
 const first=checkpointTaskUpdate(runtime,source,sourcePatch),second=checkpointTaskUpdate(runtime,task,patch,first.stateChanges);check();const changes=[{task:{...source,...first.patch},type:'original_group_page_transferred'},{task:{...task,...second.patch},type:'original_group_page_assigned'}];runtime.store.transitionMany(changes,second.stateChanges);Object.assign(task,changes[1].task);
 // A failed write or readback leaves the same durable assignment for retry.
 await originalTaskSync(async()=>{await flushBatchTaskEvents(runtime,source);await flushBatchTaskEvents(runtime,task);});return true;
}

export function retainOriginalUnavailablePage(runtime,task){
 if(task.status!=='skip'||!task.originalAgentSkip||task.originalGroupAdvance?.status!=='awaiting_next')return false;
 const group=originalGroup(runtime,task),advance=task.originalGroupAdvance;if(advance.scope!==workbenchScope(runtime.store.get('pair'))||advance.groupKey!==group.key||advance.groupSha256!==digest(group))return true;
 if(future(runtime,task,group).some(item=>item.status==='pending'))return true;
 runtime.update(task,{originalGroupAdvance:{...advance,status:'complete',completedAt:new Date().toISOString()}},'original_group_advance_complete');return false;
}

export async function navigateOriginalGroupPage(runtime,task,page,{active}){
 const assignment=task.originalGroupPage;if(!assignment||assignment.status==='ready')return;
 let before=structuredClone(task);const scope=workbenchScope(runtime.store.get('pair'));
 const check=async()=>{const verify=()=>{const current=runtime.store.get('task:'+task.id);if(!active()||scope!==workbenchScope(runtime.store.get('pair'))||!isDeepStrictEqual(current,before)||current.receipt||current.attemptBoundary||current.controller!=='executor'||page.isClosed()||assignment.targetId!==current.targetId||assignment.browserInstance!==runtime.host?.startedAt||assignment.groupSha256!==digest(originalGroup(runtime,current)))throw stale('原同站导航任务或控制状态已变化');};verify();const info=await getTargetInfo(runtime.context,page);verify();if(info?.targetId!==assignment.targetId)throw stale('原同站导航页签身份已变化');};
 await check();runtime.update(task,{originalGroupPage:{...assignment,status:'navigating',navigationStartedAt:new Date().toISOString()}},'original_group_navigation_boundary');before=structuredClone(task);
 await originalTaskSync(()=>flushBatchTaskEvents(runtime,task));await check();
 try{if(page.url()===task.url)await page.reload({waitUntil:'domcontentloaded',timeout:45000});else await page.goto(task.url,{waitUntil:'domcontentloaded',timeout:45000});}
 catch(error){await check();runtime.update(task,{status:'needs_manual',attentionType:'group_navigation_failed',reason:'无法重新进入提交入口: '+error.message,originalGroupPage:{...task.originalGroupPage,status:'navigation_failed',navigationFailure:error.message}},'original_group_navigation_failed');return false;}
 await check();runtime.update(task,{originalGroupPage:{...task.originalGroupPage,status:'ready',navigationCompletedAt:new Date().toISOString(),pageUrl:page.url()}},'original_group_navigation_ready');return true;
}
