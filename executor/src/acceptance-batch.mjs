export function startAcceptanceBatch(runtime,id){
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('固定批次启动需要后台暂停空闲');
 const frozen=runtime.store.get('acceptance:'+id),execution=runtime.store.get('acceptanceExecution:'+id);
 if(!frozen||!execution||execution.scopeSha256!==frozen.sha256)throw Error('固定范围尚未注册或校验不一致');
 const previous=runtime.store.get('acceptanceBatch');if(previous&&previous.id!==id&&previous.status!=='complete')throw Error('已有其他固定批次');
 const batch=previous||{id,scopeSha256:frozen.sha256,count:frozen.count,cursor:0,attempts:{},createdAt:new Date().toISOString()};
 runtime.store.set('acceptanceBatch',{...batch,status:'running',reason:'',resumedAt:new Date().toISOString()});runtime.store.set('singleTaskId',null);runtime.store.set('paused',false);runtime.tick();return{ok:true,batch:runtime.store.get('acceptanceBatch')};
}
export async function nextAcceptanceTask(runtime){
 let batch=runtime.store.get('acceptanceBatch');if(batch?.status!=='running')return null;
 const frozen=runtime.store.get('acceptance:'+batch.id),execution=runtime.store.get('acceptanceExecution:'+batch.id);
 if(frozen?.sha256!==batch.scopeSha256||frozen.count!==batch.count)throw Error('固定批次范围变化，停止执行');
 for(;batch.cursor<frozen.combinations.length;batch.cursor++){
  const combo=frozen.combinations[batch.cursor],item=execution.items[combo.identity];
  const task=item?.taskId&&runtime.store.get('task:'+item.taskId);
  if(!task){batch.attempts[combo.identity]={status:item?.status||'unregistered',reason:item?.reason||'原注册未确认',completedAt:new Date().toISOString()};runtime.store.set('acceptanceBatch',batch);continue;}
  if(task.receipt||task.attemptBoundary){batch.attempts[combo.identity]={taskId:task.id,status:task.receipt?'received':'verification_only',cloudVerified:!!task.cloudVerified,reason:task.reason||'',completedAt:new Date().toISOString()};runtime.store.set('acceptanceBatch',batch);continue;}
  if(batch.attempts[combo.identity]?.completedAt)continue;
  if(task.controller==='supervisor'||task.controller==='ai')throw Error('原任务控制权尚未交回');
  await runtime.lease(task,{online:true});
  runtime.update(task,{status:'pending',controller:'executor',acceptanceId:batch.id,profileSnapshot:combo.profile,profileRevision:combo.profileRevision,
   consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'approved_plan',text:'已批准固定范围普通免费投稿及基本登录，额外权限及本人验证登记后继续其他组合'}]},'fixed_batch_task_released');
  batch.attempts[combo.identity]={...batch.attempts[combo.identity],taskId:task.id,startedAt:batch.attempts[combo.identity]?.startedAt||new Date().toISOString()};runtime.store.set('acceptanceBatch',batch);
  runtime.store.set('singleTaskId',task.id);return task;
 }
 batch.status='complete';batch.completedAt=new Date().toISOString();runtime.store.set('acceptanceBatch',batch);runtime.store.set('paused',true);return null;
}
export function finishAcceptanceTask(runtime,taskId){
 const batch=runtime.store.get('acceptanceBatch');if(batch?.status!=='running'||runtime.store.get('paused')!==false)return false;
 const task=runtime.store.get('task:'+taskId);if(!task||['pending','opening','filling','submitting'].includes(task.status))return false;
 const identity=Object.keys(batch.attempts).find(key=>batch.attempts[key].taskId===taskId);if(!identity)return false;
 batch.attempts[identity]={...batch.attempts[identity],completedAt:new Date().toISOString(),status:task.receipt?'received':task.attemptBoundary?'verification_only':task.status,reason:task.reason||'',cloudVerified:!!task.cloudVerified};
 batch.cursor++;runtime.store.set('acceptanceBatch',batch);return true;
}
