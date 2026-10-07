import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {freshRoundHost,freshRoundTaskReason,freshRoundProof,validateFreshRoundSource} from '../../core/original-fresh-round.mjs';
import {workbenchScope} from './workbench-sync.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const sameFreshRoundHost=(task,item)=>task.profileId===item.profileId&&freshRoundHost(task.url)===freshRoundHost(item.url);
const active=(runtime,id)=>runtime.activeTaskIds?.has(id)||runtime.activeTaskId===id;
export async function readFreshRoundTasks(runtime,tasks) {
  const scope=workbenchScope(runtime.store.get('pair')),before=runtime.store.values('task:'),runs=new Map(),result=[];
  for(const task of tasks){
    if(!runs.has(task.runId))runs.set(task.runId,await runtime.cloud.request('runs?runId='+encodeURIComponent(task.runId)));
    if(scope!==workbenchScope(runtime.store.get('pair'))||!isDeepStrictEqual(before,runtime.store.values('task:')))throw Error('回读期间原任务或工作区已变化，请重新预览');
    const saved=runs.get(task.runId),remote=saved.tasks?.find(row=>row.id===task.id),run=saved.runs?.find(row=>row.id===task.runId);
    if(!remote||remote.runId!==task.runId||!run?.tasks?.includes(task.id))throw Error('云端原任务或原批次暂不可读，不创建替代任务');
    const local=before.find(row=>row.id===task.id);
    if(active(runtime,task.id)||(runtime.store.pendingSummary?.()||runtime.store.pending()).some(event=>event.taskId===task.id)||local&&(freshRoundTaskReason(local)||local.status!==remote.status))throw Error('本机原任务仍须同步、执行或核验');
    result.push(remote);
  }
  return result;
}
export async function previewFreshRound(runtime,known,target) {
  try{
    const tasks=await readFreshRoundTasks(runtime,known),blocked=tasks.find(task=>freshRoundTaskReason(task));
    if(blocked)return {reason:freshRoundTaskReason(blocked)};
    const sources=tasks.filter(task=>!task.originalFreshRoundSuccessorTaskId);
    if(sources.length!==1)return {reason:'同站新一轮来源或继任任务暂不可核验'};
    return {originalFreshRound:await freshRoundProof(sources[0],hash)};
  }catch(error){return {reason:error.message};}
}
export async function assertFreshRoundRegistration(runtime,item) {
  if(!item.originalFreshRound)return;
  const known=runtime.store.values('task:').filter(task=>sameFreshRoundHost(task,item));
  if(known.some(task=>active(runtime,task.id)||freshRoundTaskReason(task)))throw Error('原同站任务仍须同步、执行或核验');
  const {sourceTaskId,sourceRunId}=item.originalFreshRound,source={id:sourceTaskId,runId:sourceRunId};
  const [remote]=await readFreshRoundTasks(runtime,[source]);
  await validateFreshRoundSource(remote,item.originalFreshRound,{...item,id:item.taskId},hash);
  return {scope:workbenchScope(runtime.store.get('pair')),local:runtime.store.get('task:'+sourceTaskId)};
}
export function freshRoundRetirementState(runtime,item,guard) {
  if(!item.originalFreshRound)return {};
  const id=item.originalFreshRound.sourceTaskId,local=runtime.store.get('task:'+id);
  if(guard&&(guard.scope!==workbenchScope(runtime.store.get('pair'))||!isDeepStrictEqual(guard.local,local)))throw Error('注册期间原任务或工作区已变化，新任务须先回读核验');
  if(local&&(active(runtime,id)||freshRoundTaskReason(local)||(runtime.store.pendingSummary?.()||runtime.store.pending()).some(event=>event.taskId===id)))throw Error('原任务仍须同步或核验，不覆盖本机记录');
  return local?{['task:'+id]:{...local,version:item.originalFreshRound.sourceVersion+1,originalFreshRoundSuccessorTaskId:item.taskId}}:{};
}
