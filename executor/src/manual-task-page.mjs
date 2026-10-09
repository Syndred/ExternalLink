import {getTargetInfo,createForegroundTarget} from './browser-target.mjs';
import {workbenchScope} from './workbench-sync.mjs';

// Opening a parked task is a browsing action. It must never rebind its target,
// discard an attempt boundary, or grant permission to continue submission.
export async function openManualTaskPage(runtime,input={}){
 const scope=workbenchScope(runtime.store.get('pair'));
 const initial=runtime.store.get('task:'+input.taskId);
 const assertCurrent=()=>{
  const task=runtime.store.get('task:'+input.taskId);
  if(!initial||!task||!task.runId||task.runId!==input.expectedRunId||
   (task.targetId||'')!==input.expectedTargetId||task.runId!==initial.runId||
   task.url!==initial.url||task.browserInstance!==initial.browserInstance||
   scope!==workbenchScope(runtime.store.get('pair'))||runtime.connectionBusy||runtime.store.get('connectionExecutionHold'))
   throw Error('原任务或工作区已变化，请刷新任务详情');
  return task;
 };
 const task=assertCurrent();
 if(!task.targetId){
  let url;try{url=new URL(task.url);}catch{throw Error('无法打开此站点地址');}
  if(!['http:','https:'].includes(url.protocol))throw Error('无法打开此站点地址');
  if(!runtime.context)await runtime.connect();
  assertCurrent();
  const targetId=await createForegroundTarget(runtime.context,url.href,assertCurrent);
  return{ok:true,opened:true,mode:'todo',targetId,taskId:task.id,message:'已打开待办页面，请核查站点状态后处理'};
 }
 if(!runtime.context)await runtime.connect();
 assertCurrent();
 if(task.browserInstance!==runtime.host?.startedAt||task.tabClosedAt)throw Error('原页签已关闭或浏览器已变化，请刷新待人工列表');
 for(const page of runtime.context.pages()){
  const info=await getTargetInfo(runtime.context,page);assertCurrent();
  if(task.browserInstance!==runtime.host?.startedAt)throw Error('原浏览器已变化，请刷新待人工列表');
  if(info?.targetId!==task.targetId)continue;
  if(!/^https?:\/\//i.test(page.url()))throw Error('原页签不是普通网站页面，请在浏览器中核查');
  await page.bringToFront();
  return{ok:true,opened:true,mode:'original',targetId:task.targetId,taskId:task.id,message:'已显示原页面，原任务与执行状态保持'};
 }
 throw Error('原页签已关闭，请刷新待人工列表');
}
