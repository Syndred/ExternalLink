import{randomUUID}from'node:crypto';import{workbenchScope}from'./workbench-sync.mjs';
// Preserve the original plugin's best-effort endpoint and key. A received
// notification is never evidence that a backlink is indexed or published.
const endpoint='https://www.bing.com/indexnow',originalKey='ea4b5c1e2f3a4b5c6d7e8f9a0b1c2d3e';
export function prepareIndexNotification(runtime,task){
 const scope=workbenchScope(runtime.store.get('pair')),snapshot=runtime.store.get('applicationSnapshot'),enabled=task.indexNotificationPreference??(snapshot?.scope===scope?snapshot.snapshot.documents.cfgPingIndex!==false:true);
 return{id:randomUUID(),scope,taskId:task.id,runId:task.runId,profileId:task.profileId,url:task.url,enabled,status:enabled?'pending':'disabled',at:new Date().toISOString()};
}
export async function notifyIndexNow(runtime,task,documents){
 const current=runtime.store.get('task:'+task.id),notification=current?.indexNowNotification;
 if(!notification||!current.receipt||current.cloudVerified!==true||notification.scope!==workbenchScope(runtime.store.get('pair'))||['taskId','runId','profileId','url'].some(key=>(key==='taskId'?task.id:task[key])!==notification[key])||current.url!==notification.url)return;
 runtime.indexNowJobs||=new Map();if(runtime.indexNowJobs.has(task.id))return runtime.indexNowJobs.get(task.id);
 const save=patch=>{const latest=runtime.store.get('task:'+task.id);if(latest?.indexNowNotification?.id!==notification.id)return;runtime.update(latest,{indexNowNotification:{...latest.indexNowNotification,...patch}},'index_notification');Object.assign(task,latest);};
 if(notification.status==='sending'){save({status:'uncertain',reason:'上次通知发送已开始，但未取得完整响应；保留原记录，不重复发送'});return;}
 if(notification.status!=='pending')return;
 const snapshot=runtime.store.get('applicationSnapshot'),preferences=documents??(snapshot?.scope===notification.scope?snapshot.snapshot.documents:{});if(!notification.enabled||preferences.cfgPingIndex===false){save({status:'disabled',reason:'提交后搜索引擎通知已关闭'});return;}
 let target;try{target=new URL(notification.url);if(!/^https?:$/.test(target.protocol)||target.username||target.password)throw Error();}catch{save({status:'rejected',reason:'原通知网址无效'});return;}
 const work=(async()=>{
  const requestUrl=new URL(endpoint);requestUrl.searchParams.set('url',notification.url);requestUrl.searchParams.set('key',originalKey);
  save({status:'sending',startedAt:new Date().toISOString()});
  try{const response=await(runtime.indexNowFetch||fetch)(requestUrl.href,{signal:AbortSignal.timeout(10000),redirect:'error'});await response.body?.cancel();const status=response.status===200?'received':response.status===202?'validation_pending':'rejected';save({status,httpStatus:response.status,completedAt:new Date().toISOString(),reason:status==='received'?'搜索引擎已收到通知，不代表已收录':status==='validation_pending'?'搜索引擎已收到网址，等待密钥验证':'搜索引擎未接受通知，HTTP '+response.status});}
  catch{save({status:'uncertain',completedAt:new Date().toISOString(),reason:'通知发送未确认，原收件记录保留；不会自动重复发送'});}
 })();runtime.indexNowJobs.set(task.id,work);try{await work;}finally{runtime.indexNowJobs.delete(task.id);}
}
