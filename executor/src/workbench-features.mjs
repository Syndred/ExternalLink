import {randomUUID,createHash} from 'node:crypto';
import {queue,plain,selectScope,priorProductSuccess,profiles} from './shared.mjs';
import {attachEngine} from './engine.mjs';
import {saveCommentVersion} from './comment-history.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const site=url=>queue.extractDomain(url).toLowerCase();
export async function previewWorkbenchBatch(runtime,input){
 if(!Array.isArray(input.profileIds)||!input.profileIds.length||!Array.isArray(input.urls)||!input.urls.length||input.profileIds.length*input.urls.length>500)throw Error('请选择产品与外链，每批最多 500 个组合');
 const profileIds=[...new Set(input.profileIds)],urls=[...new Set(input.urls)];
 const snapshot=await runtime.cloud.request('snapshot'),inventory=await runtime.cloud.request('runs?view=inventory');
 const items=[];
 for(const profileId of profileIds){
  const profile=snapshot.documents.siteProfiles?.[profileId];if(!profile||profile.archived)throw Error('所选产品不存在或已归档');
  const scope=selectScope(snapshot,null,profileId,urls),exclusions=new Map(scope.exclusions.map(e=>[queue.normalizeDestinationKey(e.url),e.reason])),seen=new Set();
  for(const url of urls){const destinationKey=queue.normalizeDestinationKey(url),previous=runtime.store.values('task:').find(t=>t.profileId===profileId&&site(t.url)===site(url))||inventory.tasks.find(t=>t.profileId===profileId&&site(t.url)===site(url));
   let reason=exclusions.get(destinationKey)||'';
   if(seen.has(site(url)))reason='同站其他入口，保留一个投稿目标';seen.add(site(url));
   if(!reason&&previous&&(previous.receipt||previous.attemptBoundary||!['pending','needs_manual'].includes(previous.status)))reason='同站有原任务结果或提交边界，请先查看或核验原任务';
   items.push({identity:profileId+'::'+destinationKey,profileId,url,destinationKey,profile:plain(profile),profileRevision:snapshot.revisions.siteProfiles,taskId:previous?.id||randomUUID(),runId:previous?.runId||randomUUID(),existingTask:!!previous,status:reason?'excluded':'ready',reason});
  }
 }
 const batch={id:randomUUID(),createdAt:new Date().toISOString(),status:'preview',count:items.length,items,cursor:0,feeLimit:0};batch.scopeSha256=digest(items.map(i=>({identity:i.identity,url:i.url,profile:i.profile,profileRevision:i.profileRevision,taskId:i.taskId,runId:i.runId})));
 runtime.store.set('workbenchBatch:'+batch.id,batch);return{ok:true,batch};
}
export async function startWorkbenchBatch(runtime,input){
 if(input.ordinaryPermissionsAuthorized!==true)throw Error('请确认本批次普通免费投稿范围');
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.get('acceptanceBatch')?.status==='running')throw Error('需要先暂停当前任务');
 const batch=runtime.store.get('workbenchBatch:'+input.batchId);if(!batch||!['preview','paused','registration_unknown','stopped'].includes(batch.status))throw Error('批次不存在或不能启动');
 const active=runtime.store.get('activeWorkbenchBatch');if(active&&active!==batch.id&&runtime.store.get('workbenchBatch:'+active)?.status!=='complete')throw Error('请先处理原批次');
 if(batch.scopeSha256!==digest(batch.items.map(i=>({identity:i.identity,url:i.url,profile:i.profile,profileRevision:i.profileRevision,taskId:i.taskId,runId:i.runId}))))throw Error('批次范围校验不一致');
 const snapshot=await runtime.cloud.request('snapshot'),inventory=await runtime.cloud.request('runs?view=inventory');
 const save=()=>runtime.store.set('workbenchBatch:'+batch.id,batch);
 for(const item of batch.items){
  if(['excluded','complete'].includes(item.status))continue;
  if(priorProductSuccess(snapshot.documents.submissionRecords,item.profileId,item.url)){item.status='excluded';item.reason='该产品同站已有收件';save();continue;}
  if(snapshot.revisions.siteProfiles!==item.profileRevision||JSON.stringify(snapshot.documents.siteProfiles[item.profileId])!==JSON.stringify(item.profile))throw Error('产品资料已变化，原预览保留，请重新预览');
  const allowed=selectScope(snapshot,null,item.profileId,[item.url]);if(!allowed.tasks.length){item.status='excluded';item.reason=allowed.exclusions[0]?.reason||'当前站点不允许提交';save();continue;}
  let task=runtime.store.get('task:'+item.taskId);
  const known=inventory.tasks.find(t=>t.id===item.taskId);
  if(!task&&known)task=(await runtime.cloud.request('tasks/'+item.taskId)).task;
  if(task){runtime.store.set('task:'+task.id,task);item.status='registered';save();continue;}
  if(item.existingTask)throw Error('原任务暂不可读，不创建替代任务');
  // A lost response is recovered only by these exact IDs; never replace them.
  if(item.status==='registration_unknown'||item.status==='registering'){batch.status='registration_unknown';save();throw Error('注册结果未知，原 ID 暂未回读，禁止重复注册');}
  const run={id:item.runId,profileId:item.profileId,profileRevision:item.profileRevision,createdAt:batch.createdAt,authorization:'ordinary_free_submission',ordinaryPermissionsAuthorized:true,feeLimit:0,workbenchBatchId:batch.id,tasks:[{id:item.taskId,url:item.url,destinationKey:item.destinationKey}]};
  item.status='registering';item.request=run;save();
  try{const result=await runtime.cloud.request('runs',{run});if(result.run?.id!==item.runId||result.tasks?.[0]?.id!==item.taskId)throw Error('注册身份不一致');runtime.store.set('run:'+item.runId,result.run);runtime.store.set('task:'+item.taskId,{...result.tasks[0],profileSnapshot:item.profile});item.status='registered';delete item.request;save();}
  catch(error){item.status=error.status>=400&&error.status<500?'excluded':'registration_unknown';item.reason=error.message;batch.status=item.status==='registration_unknown'?'registration_unknown':'paused';save();throw error;}
 }
 batch.status='running';batch.startedAt=batch.startedAt||new Date().toISOString();save();runtime.store.set('executionStopped',null);runtime.store.set('manualResumeRunId',null);runtime.store.set('activeWorkbenchBatch',batch.id);runtime.store.set('singleTaskId',null);runtime.store.set('paused',false);runtime.tick();return{ok:true,batch};
}
export async function nextWorkbenchTask(runtime){
 const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id);if(batch?.status!=='running')return null;
 for(;batch.cursor<batch.items.length;batch.cursor++){
  const item=batch.items[batch.cursor];if(['excluded','complete'].includes(item.status))continue;
  const task=runtime.store.get('task:'+item.taskId);if(!task)throw Error('批次原任务缺失');
  if(task.receipt||task.attemptBoundary){item.status='complete';item.result=task.receipt?'received':'sent_unconfirmed';item.reason=task.reason;runtime.store.set('workbenchBatch:'+id,batch);continue;}
  if(['ai','supervisor'].includes(task.controller))throw Error('原任务尚未交回');
  await runtime.lease(task,{online:true});runtime.update(task,{status:'pending',controller:'executor',profileSnapshot:task.profileSnapshot||item.profile,profileRevision:task.profileRevision||item.profileRevision,workbenchBatchId:id,consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'user_reply',text:'用户确认本批次普通免费投稿'}]},'workbench_task_released');
  item.status='running';item.startedAt=item.startedAt||new Date().toISOString();runtime.store.set('workbenchBatch:'+id,batch);runtime.store.set('singleTaskId',task.id);return task;
 }
 batch.status='complete';batch.completedAt=new Date().toISOString();runtime.store.set('workbenchBatch:'+id,batch);runtime.store.set('activeWorkbenchBatch',null);runtime.store.set('paused',true);return null;
}
export function finishWorkbenchTask(runtime,taskId){
 const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id);if(!batch||batch.items[batch.cursor]?.taskId!==taskId)return false;
 const item=batch.items[batch.cursor],task=runtime.store.get('task:'+taskId);if(!task||['pending','opening','filling','submitting'].includes(task.status))return false;
 item.status='complete';item.result=task.receipt?'received':task.attemptBoundary?'sent_unconfirmed':task.status;item.reason=task.reason||'';item.completedAt=new Date().toISOString();batch.cursor++;runtime.store.set('workbenchBatch:'+id,batch);return batch.status==='running'&&runtime.store.get('paused')===false;
}
export function pauseWorkbenchBatch(runtime,reason='用户暂停'){const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id);if(batch?.status==='running')runtime.store.set('workbenchBatch:'+id,{...batch,status:'paused',reason});}
export async function applicationAi(runtime,action,input){
 if(action==='extractProfile'){let url;try{url=new URL(input.url);}catch{throw Error('请输入有效官网网址');}if(!/^https?:$/.test(url.protocol))throw Error('仅支持普通网站');const result=await runtime.cloud.request('ai/extract-site',{url:url.href,language:input.language||'auto'});runtime.store.set('profileDraft:'+input.profileId,{at:new Date().toISOString(),...result});return result;}
 if(action==='generateProfile')return runtime.cloud.request('ai/generate-site',{profile:input.profile,language:input.language||'auto'});
 const snapshot=await runtime.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[input.profileId];if(!profile||profile.archived)throw Error('请选择在用产品');
 const url=new URL(input.pageUrl);if(!/^https?:$/.test(url.protocol))throw Error('仅支持普通评论页面');
 const result=await runtime.cloud.request('ai/comment',{pageUrl:url.href,pageTitle:String(input.pageTitle||'').slice(0,600),pageText:String(input.pageText||'').slice(0,30000),config:plain(profiles.buildAgentConfigFromProfile(profile,snapshot.documents)),language:input.language||profile.language||'auto',count:3,maxChars:Math.min(2000,Math.max(80,Number(input.maxChars)||700)),allowLink:input.allowLink===true,tone:input.tone||profile.blogRules?.tone||'helpful'});
 runtime.store.set('commentDraft:'+input.profileId+'::'+queue.normalizeDestinationKey(url.href),{...result,profileId:input.profileId,pageUrl:url.href,at:new Date().toISOString()});saveCommentVersion(runtime,{...input,drafts:result.drafts});return result;
}

export async function fillCommentDraft(runtime,input){
 const task=runtime.store.get('task:'+input.taskId);
 if(!task||task.attemptBoundary||task.receipt||!['pending','needs_manual'].includes(task.status))throw Error('只能填写尚未投稿的原任务评论');
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停并等待当前动作结束');
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('请输入不超过 2000 字的评论草稿');
 if(!runtime.context)await runtime.connect();const page=await runtime.findPage(task);
 if(site(page.url())!==site(task.url))throw Error('原任务页面与目标网站不一致');
 const snapshot=await runtime.cloud.request('snapshot');if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('此产品同站已有收件');
 const profile=task.profileSnapshot||snapshot.documents.siteProfiles?.[task.profileId];if(!profile)throw Error('产品资料缺失');
 const config={...plain(profiles.buildAgentConfigFromProfile(profile)),commentTemplate:input.text,applyCommentTemplate:true,aiComments:false,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false};
 await runtime.lease(task,{online:true});
 for(const frame of page.frames()){
  let engine;try{engine=await attachEngine(runtime.context,frame,msg=>runtime.bridge(task,msg));const detection=await engine.call({action:'detectPage',config});if(!detection.commentFound)continue;
   const fill=await engine.call({action:'smartFill',config}),actual=await engine.call({action:'getFilledFieldsReport'});
   if(!JSON.stringify(actual).includes(JSON.stringify(input.text).slice(1,-1)))throw Error('评论填写未通过回读核验');
   runtime.update(task,{selectedComment:input.text,actualPreparation:actual,commentPreparation:{at:new Date().toISOString(),fill,actual},preparedAt:new Date().toISOString()},'comment_draft_filled');await runtime.synchronize();return{ok:true,filled:true,submitted:false};
  }finally{await engine?.detach();}
 }
 throw Error('原页面尚未检测到真实评论表单');
}
export async function detectOriginalTask(runtime,input){
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停并等待当前动作结束');
 const task=runtime.store.get('task:'+input.taskId);if(!task)throw Error('原任务不存在');
 if(!runtime.context)await runtime.connect();const page=await runtime.findPage(task);if(site(page.url())!==site(task.url))throw Error('原页与任务目标不一致');
 const snapshot=await runtime.cloud.request('snapshot'),profile=task.profileSnapshot||snapshot.documents.siteProfiles?.[task.profileId];if(!profile)throw Error('原产品资料缺失');
 const config={...plain(profiles.buildAgentConfigFromProfile(profile,snapshot.documents)),fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false},frames=[];
 for(const frame of page.frames()){if(!/^https?:\/\//.test(frame.url()))continue;let engine;try{engine=await attachEngine(runtime.context,frame,msg=>runtime.bridge(task,msg));frames.push(await engine.call({action:'detectPage',config}));}finally{await engine?.detach();}}
 return{ok:true,taskId:task.id,detectedAt:new Date().toISOString(),frames,filled:false,submitted:false};
}
