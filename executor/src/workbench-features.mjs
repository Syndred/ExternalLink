import {randomUUID,createHash} from 'node:crypto';
import {queue,plain,selectScope,priorProductSuccess,profiles,scheduler} from './shared.mjs';
import {attachEngine} from './engine.mjs';
import {saveCommentVersion,copyCommentDraft} from './comment-history.mjs';
import {originalCommentRequest} from './comment-cache.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {freezeBatchConfig,assertBatchPolicy,initializeBatchPolicy,refreshBatchManualCapacity,releaseBatchTask,noteBatchTaskResult,batchConfig,pauseBatchPolicy} from './workbench-batch-policy.mjs';
import {originalUnattended} from '../../core/original-batch-config.mjs';
import {batchManifest,batchRunMetadata,batchRecoveryVersion,batchJson,batchScopeRows,maximumLibraryBatchCombinations} from '../../core/workbench-batch-recovery.mjs';
import {originalLibraryBatchScope} from '../../core/library-batch-scope.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {resumeExecution} from './execution-lifecycle.mjs';
import {queuedParkedTasks,selectParkedResume} from './parked-task-resume.mjs';
import {jsonValueEqual} from '../../core/json-value.mjs';
import {previewFreshRound,assertFreshRoundRegistration,freshRoundRetirementState} from './original-fresh-round.mjs';
import {freshRoundTaskReason} from '../../core/original-fresh-round.mjs';
import '../../core/target-filters.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const frozenDigest=(batch,value)=>batch.cloudRecoveryVersion===batchRecoveryVersion?createHash('sha256').update(batchJson(value)).digest('hex'):digest(value);
const site=url=>queue.extractDomain(url).toLowerCase();
export async function previewWorkbenchBatch(runtime,input){
 const scoped=input.libraryScope!==undefined;
 if(!Array.isArray(input.profileIds)||!input.profileIds.length||!scoped&&(!Array.isArray(input.urls)||!input.urls.length||input.profileIds.length*input.urls.length>500))throw Error('请选择产品与外链，每批最多 500 个组合');
 if(scoped&&(!input.libraryScope||!['category','group'].includes(input.libraryScope.kind)||typeof input.libraryScope.value!=='string'||!input.libraryScope.value.trim()||input.urls!==undefined))throw Error('请选择明确的原分类或分组范围');
 const profileIds=[...new Set(input.profileIds)];let urls=[...new Set(input.urls||[])];
 const expectedScope=workbenchScope(runtime.store.get('pair'));
 const optionKeys=['concurrency','pingIndex','fillOnly','unattended','unattendedMaxHours','unattendedMaxTasks','unattendedMaxManualTabs'];
 if(input.config!==undefined&&(!input.config||typeof input.config!=='object'||Array.isArray(input.config)||Object.entries(input.config).some(([key,value])=>!optionKeys.includes(key)||!['string','number','boolean'].includes(typeof value))))throw Error('批量参数格式无效');
 const snapshot=await runtime.cloud.request('snapshot'),inventory=await runtime.cloud.request('runs?view=inventory');
 if(expectedScope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已变化，请重新预览');
 const originalScope=scoped?originalLibraryBatchScope(snapshot,{profileIds,[input.libraryScope.kind]:input.libraryScope.value}):null;
 if(scoped&&!originalScope.tasks.length)throw Error('该分类或分组没有新的待提交组合，原批次和待办保留');
 if(scoped&&originalScope.tasks.length>maximumLibraryBatchCombinations)throw Error('原分类或分组超过可保存的完整范围，未截断或启动；请先处理原范围');
 if(scoped)urls=[...new Set(originalScope.tasks.map(task=>task.url))];
 const rows=scoped?originalScope.tasks:profileIds.flatMap(profileId=>urls.map(url=>({profileId,url}))),items=[],seenByProfile=new Map(),scopes=new Map(),originalTasks=new Map();
 for(const task of [...runtime.store.values('task:'),...(inventory.tasks||[])]){const key=task.profileId+'::'+site(task.url),known=originalTasks.get(key)||[];known.push(task);originalTasks.set(key,known);}
 for(const {profileId,url} of rows){
  const profile=snapshot.documents.siteProfiles?.[profileId];if(!profile||profile.archived)throw Error('所选产品不存在或已归档');
  if(!scopes.has(profileId))scopes.set(profileId,selectScope(snapshot,null,profileId,urls));const scope=scopes.get(profileId),exclusions=new Map(scope.exclusions.map(e=>[queue.normalizeLibraryDestinationKey(e.url),e.reason])),seen=seenByProfile.get(profileId)||new Set();seenByProfile.set(profileId,seen);
  const destinationKey=queue.normalizeDestinationKey(url),known=originalTasks.get(profileId+'::'+site(url))||[],previous=known.find(task=>task.url===url&&task.destinationKey===destinationKey&&task.runId),blocked=known.find(task=>task.receipt||task.attemptBoundary||!['pending','needs_manual'].includes(task.status));
   let reason=exclusions.get(queue.normalizeLibraryDestinationKey(url))||'';
   if(seen.has(site(url)))reason='同站其他入口，保留一个投稿目标';seen.add(site(url));
   let renewal={};
   if(!reason&&blocked){if(known.every(task=>!freshRoundTaskReason(task))){renewal=await previewFreshRound(runtime,[...new Map(known.map(task=>[task.id,task])).values()],{profileId,url});reason=renewal.reason||'';}else reason='同站有原任务结果或提交边界，请先查看或核验原任务';}
   if(!reason&&known.length&&!previous&&!renewal.originalFreshRound)reason='同站有原任务使用其他入口，请先查看或核验原任务';
   const reuse=previous&&!reason&&!renewal.originalFreshRound;
   items.push({identity:profileId+'::'+destinationKey,profileId,url,destinationKey,profile:plain(profile),profileRevision:snapshot.revisions.siteProfiles,taskId:reuse?previous.id:randomUUID(),runId:reuse?previous.runId:randomUUID(),existingTask:!!reuse,...(renewal.originalFreshRound?{originalFreshRound:renewal.originalFreshRound}:{}),...(known.length&&!reuse?{relatedOriginalTaskId:(blocked||previous||known[0]).id}:{}),status:reason?'excluded':'ready',reason});
 }
 const batch={id:randomUUID(),scope:expectedScope,...freezeBatchConfig(snapshot.documents,input.config),cloudRecoveryVersion:batchRecoveryVersion,createdAt:new Date().toISOString(),status:'preview',count:items.length,items,cursor:0,feeLimit:0,...(scoped?{libraryScope:{kind:input.libraryScope.kind,value:input.libraryScope.value.trim(),meta:originalScope.meta,exclusions:originalScope.exclusions}}:{})};batch.configSha256=frozenDigest(batch,batch.config);batch.scopeSha256=frozenDigest(batch,batchScopeRows(batch));
 runtime.store.set('workbenchBatch:'+batch.id,batch);return{ok:true,batch};
}
export async function startWorkbenchBatch(runtime,input){
 if(input.ordinaryPermissionsAuthorized!==true)throw Error('请确认本批次普通免费投稿范围');
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.get('acceptanceBatch')?.status==='running')throw Error('需要先暂停当前任务');
 const batch=runtime.store.get('workbenchBatch:'+input.batchId);if(!batch||!['preview','paused','registration_unknown','stopped','waiting_manual'].includes(batch.status))throw Error('批次不存在或不能启动');
 assertBatchPolicy(runtime,batch);
 const active=runtime.store.get('activeWorkbenchBatch');if(active&&active!==batch.id&&!['complete','waiting_manual','stopped'].includes(runtime.store.get('workbenchBatch:'+active)?.status))throw Error('请先处理原批次');
 if(batch.status==='paused'&&active===batch.id&&!runtime.store.get('executionStopped')){await resumeExecution(runtime,{expectedBatchId:batch.id});return{ok:true,batch:runtime.store.get('workbenchBatch:'+batch.id)};}
 if(batch.scopeSha256!==frozenDigest(batch,batchScopeRows(batch)))throw Error('批次范围校验不一致');
 const snapshot=await runtime.cloud.request('snapshot'),inventory=await runtime.cloud.request('runs?view=inventory');
 const save=()=>runtime.store.set('workbenchBatch:'+batch.id,batch);
 assertBatchPolicy(runtime,batch);
 // Refresh exclusions before choosing the sole manifest anchor. A newly
 // received first target must not strand all the other original combinations.
 for(const item of batch.items){if(['excluded','complete'].includes(item.status))continue;if(priorProductSuccess(snapshot.documents.submissionRecords,item.profileId,item.url)){item.status='excluded';item.reason='该产品同站已有收件';save();continue;}if(snapshot.revisions.siteProfiles!==item.profileRevision||!jsonValueEqual(snapshot.documents.siteProfiles[item.profileId],item.profile))throw Error('产品资料已变化，原预览保留，请重新预览');const allowed=selectScope(snapshot,null,item.profileId,[item.url]);if(!allowed.tasks.length){item.status='excluded';item.reason=allowed.exclusions[0]?.reason||'当前站点不允许提交';save();}}
 if(batch.cloudRecoveryVersion===batchRecoveryVersion&&!batch.cloudManifest){const anchor=batch.items.find(i=>i.status!=='excluded'&&!i.existingTask)||batch.items.find(i=>i.status!=='excluded');if(anchor){batch.cloudManifestTaskId=anchor.taskId;batch.cloudManifestInTask=!!anchor.existingTask;batch.cloudManifest=batchManifest(batch);save();}}
 for(const item of batch.items){
  if(['excluded','complete'].includes(item.status))continue;
  if(priorProductSuccess(snapshot.documents.submissionRecords,item.profileId,item.url)){item.status='excluded';item.reason='该产品同站已有收件';save();continue;}
  if(snapshot.revisions.siteProfiles!==item.profileRevision||!jsonValueEqual(snapshot.documents.siteProfiles[item.profileId],item.profile))throw Error('产品资料已变化，原预览保留，请重新预览');
  const allowed=selectScope(snapshot,null,item.profileId,[item.url]);if(!allowed.tasks.length){item.status='excluded';item.reason=allowed.exclusions[0]?.reason||'当前站点不允许提交';save();continue;}
  let task=runtime.store.get('task:'+item.taskId);
  const known=inventory.tasks.find(t=>t.id===item.taskId);
  if(known&&(!task||!runtime.store.get('run:'+item.runId)?.profile)){
   const original=await runtime.cloud.request('runs?runId='+encodeURIComponent(item.runId));assertBatchPolicy(runtime,batch);const remote=original.tasks.find(t=>t.id===item.taskId),run=original.runs.find(r=>r.id===item.runId);
   if(!remote||remote.runId!==item.runId||remote.profileId!==item.profileId||remote.url!==item.url||remote.destinationKey!==item.destinationKey||!run?.profile||run.profileId!==item.profileId||!run.tasks?.includes(item.taskId)||!Array.isArray(run.mediaManifest))throw Error('原任务、完整批次或素材回读不一致，禁止重复注册');
   if(task&&(remote.attemptBoundary&&!task.attemptBoundary||remote.receipt&&!task.receipt))throw Error('云端原任务已有提交边界或收件，请先核验');
   const localRun=runtime.store.get('run:'+run.id);for(const key of ['id','profileId','profileRevision','profile','mediaManifest','tasks','createdAt'])if(localRun?.[key]!==undefined&&!jsonValueEqual(localRun[key],run[key]))throw Error('原批次与本机档案冲突，保留原件');
   task=task||remote;runtime.store.set('run:'+run.id,{...run,...localRun});
  }
  if(task){item.status='registered';runtime.store.transitionMany([],{...freshRoundRetirementState(runtime,item),['task:'+task.id]:task,['workbenchBatch:'+batch.id]:batch});continue;}
  if(item.existingTask)throw Error('原任务暂不可读，不创建替代任务');
  // A lost response is recovered only by these exact IDs; never replace them.
  if(item.status==='registration_unknown'||item.status==='registering'){batch.status='registration_unknown';save();throw Error('注册结果未知，原 ID 暂未回读，禁止重复注册');}
  const renewalGuard=await assertFreshRoundRegistration(runtime,item);assertBatchPolicy(runtime,batch);
  const run={id:item.runId,profileId:item.profileId,profileRevision:item.profileRevision,createdAt:batch.createdAt,authorization:'ordinary_free_submission',ordinaryPermissionsAuthorized:true,feeLimit:0,workbenchBatchId:batch.id,...batchRunMetadata(batch,item),...(item.originalFreshRound?{freshRoundControllerId:runtime.controllerId}:{}),tasks:[{id:item.taskId,url:item.url,destinationKey:item.destinationKey,...(item.originalFreshRound?{originalFreshRound:item.originalFreshRound}:{})}]};
  item.status='registering';item.request=run;save();
  try{const result=await runtime.cloud.request('runs',{run});assertBatchPolicy(runtime,batch);if(result.run?.id!==item.runId||result.tasks?.[0]?.id!==item.taskId)throw Error('注册身份不一致');const retirement=freshRoundRetirementState(runtime,item,renewalGuard);item.status='registered';delete item.request;runtime.store.transitionMany([],{...retirement,['run:'+item.runId]:result.run,['task:'+item.taskId]:{...result.tasks[0],profileSnapshot:item.profile},['workbenchBatch:'+batch.id]:batch});}
  catch(error){item.status=error.status>=400&&error.status<500?'excluded':'registration_unknown';item.reason=error.message;batch.status=item.status==='registration_unknown'?'registration_unknown':'paused';save();throw error;}
 }
 initializeBatchPolicy(batch);batch.status='running';batch.startedAt=batch.startedAt||new Date().toISOString();save();runtime.store.set('executionStopped',null);runtime.store.set('manualResumeRunId',null);runtime.store.set('activeWorkbenchBatch',batch.id);runtime.store.set('singleTaskId',null);
 if(batch.cloudRecoveryVersion===batchRecoveryVersion&&batch.cloudManifestTaskId){const anchor=runtime.store.get('task:'+batch.cloudManifestTaskId);if(!anchor)throw Error('原批次云端清单任务不可读');await runtime.lease(anchor,{online:true});assertBatchPolicy(runtime,batch);runtime.update(anchor,{workbenchBatchId:batch.id,fillOnlyRun:batch.config.fillOnly===true},'workbench_batch_policy_registered');await flushBatchTaskEvents(runtime,anchor);assertBatchPolicy(runtime,runtime.store.get('workbenchBatch:'+batch.id));Object.assign(batch,runtime.store.get('workbenchBatch:'+batch.id));}
 if(batchConfig(batch).unattended){const decision=originalUnattended.canStartTask(batch.unattendedState);if(!decision.ok){const paused=pauseBatchPolicy(runtime,batch,decision.reason);return{ok:true,batch:paused};}batch.unattendedState.stopReason='';save();}
 runtime.store.set('paused',false);runtime.tick();return{ok:true,batch};
}
export function nextWorkbenchTask(runtime,options={}){
 const previous=runtime.workbenchDispatchOperation||Promise.resolve(),operation=previous.catch(()=>{}).then(()=>selectWorkbenchTask(runtime,options));
 runtime.workbenchDispatchOperation=operation;return operation.finally(()=>{if(runtime.workbenchDispatchOperation===operation)runtime.workbenchDispatchOperation=null;});
}
export function advanceWorkbenchCursor(batch){while(batch.cursor<batch.items.length&&['excluded','complete'].includes(batch.items[batch.cursor].status))batch.cursor++;return batch;}
async function selectWorkbenchTask(runtime,{single=true}={}){
 const id=runtime.store.get('activeWorkbenchBatch');let batch=id&&runtime.store.get('workbenchBatch:'+id);if(batch?.status!=='running')return null;assertBatchPolicy(runtime,batch);
 const liveIds=runtime.activeTaskIds||new Set(),busyDestinations=new Set(batch.items.filter(i=>liveIds.has(i.taskId)).map(i=>i.destinationKey||queue.normalizeDestinationKey(i.url)));
 for(const pending of runtime.store.values('manualSkipPending:').filter(item=>item?.scope===workbenchScope(runtime.store.get('pair'))&&item.batchId===batch.id)){const item=batch.items.find(item=>item.taskId===pending.taskId);if(item)busyDestinations.add(item.destinationKey||queue.normalizeDestinationKey(item.url));}
 const resumed=await selectParkedResume(runtime,batch,{busyDestinations,destinationFor:task=>queue.normalizeDestinationKey(task.url)});
 if(resumed){if(single)runtime.store.set('singleTaskId',resumed.id);return resumed;}
 batch=runtime.store.get('workbenchBatch:'+id);if(batch?.status!=='running'||runtime.store.get('paused')!==false)return null;
 batch=await refreshBatchManualCapacity(runtime,batch);if(batch.status!=='running'||batch.unattendedState?.waitReason==='manual_capacity')return null;
 advanceWorkbenchCursor(batch);
 const queued=queuedParkedTasks(runtime,batch);for(const task of queued)busyDestinations.add(queue.normalizeDestinationKey(task.url));
 for(const pending of runtime.store.values('manualSkipPending:').filter(item=>item?.scope===workbenchScope(runtime.store.get('pair'))&&item.batchId===batch.id)){const item=batch.items.find(item=>item.taskId===pending.taskId);if(item)busyDestinations.add(item.destinationKey||queue.normalizeDestinationKey(item.url));}
 const parkedDestinations=new Set(batch.items.filter(i=>{const task=runtime.store.get('task:'+i.taskId);return i.status==='complete'&&!task?.receipt&&!task?.manualDisposition&&['needs_manual','submitted_unconfirmed'].includes(task?.status);}).map(i=>i.destinationKey||queue.normalizeDestinationKey(i.url)));
 const order=scheduler.groupTasksByDestination(batch.items.map((item,index)=>({...item,index,destinationGroupKey:item.destinationKey||queue.normalizeDestinationKey(item.url)}))).flatMap(group=>group.tasks.map(task=>task.index));
 for(const index of order){
  const item=batch.items[index];if(['excluded','complete'].includes(item.status)||liveIds.has(item.taskId)||busyDestinations.has(item.destinationKey||queue.normalizeDestinationKey(item.url)))continue;
  if(parkedDestinations.has(item.destinationKey||queue.normalizeDestinationKey(item.url)))continue;
  const task=runtime.store.get('task:'+item.taskId);if(!task)throw Error('批次原任务缺失');
  if(task.receipt||task.attemptBoundary){item.status='complete';item.result=task.receipt?'received':'sent_unconfirmed';item.reason=task.reason;if(!task.receipt)parkedDestinations.add(item.destinationKey||queue.normalizeDestinationKey(item.url));advanceWorkbenchCursor(batch);runtime.store.set('workbenchBatch:'+id,batch);continue;}
  if(['ai','supervisor'].includes(task.controller))throw Error('原任务尚未交回');
  runtime.store.set('workbenchBatch:'+id,batch);await runtime.lease(task,{online:true});batch=runtime.store.get('workbenchBatch:'+id);if(batch.items[index]?.taskId!==task.id||['excluded','complete'].includes(batch.items[index].status))return null;if(!releaseBatchTask(runtime,batch,task,{status:'pending',controller:'executor',profileSnapshot:task.profileSnapshot||item.profile,profileRevision:task.profileRevision||item.profileRevision,workbenchBatchId:id,consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'user_reply',text:'用户确认本批次普通免费投稿'}]},index))return null;
  if(single)runtime.store.set('singleTaskId',task.id);return task;
 }
 if(liveIds.size||runtime.store.values('manualSkipPending:').some(item=>item?.scope===workbenchScope(runtime.store.get('pair'))&&item.batchId===batch.id))return null;
 if(queued.some(task=>task.originalResume.status==='preparing'))return null;
 if(queued.length){batch.status='waiting_manual';batch.reason=runtime.parkedResumeError||'原待人工接续仍需同步或核验，原任务和预算保留';runtime.store.set('workbenchBatch:'+id,batch);runtime.store.set('paused',true);return null;}
 advanceWorkbenchCursor(batch);if(parkedDestinations.size){batch.status='waiting_manual';batch.reason='自动队列已处理，原任务及同站后续产品保留等待人工';runtime.store.set('workbenchBatch:'+id,batch);runtime.store.set('paused',true);return null;}if(batch.cursor<batch.items.length)return null;
 batch.status='complete';batch.completedAt=new Date().toISOString();runtime.store.set('workbenchBatch:'+id,batch);runtime.store.set('activeWorkbenchBatch',null);runtime.store.set('paused',true);return null;
}
export function finishWorkbenchTask(runtime,taskId){
 const id=runtime.store.get('activeWorkbenchBatch');let batch=id&&runtime.store.get('workbenchBatch:'+id);const item=batch?.items.find(i=>i.taskId===taskId);if(!item)return false;
 const task=runtime.store.get('task:'+taskId);if(!task||['pending','opening','filling','submitting'].includes(task.status))return false;
 const previousResult=item.result;item.result=task.receipt?'received':task.attemptBoundary?'sent_unconfirmed':task.status;item.reason=task.reason||'';
 const changed=item.status!=='complete'||previousResult!==item.result;
 if(changed){item.status='complete';item.completedAt=new Date().toISOString();batch=noteBatchTaskResult(runtime,batch,task);}advanceWorkbenchCursor(batch);runtime.store.set('workbenchBatch:'+id,batch);if(changed&&batch.cloudRecoveryVersion===batchRecoveryVersion)runtime.update(task,{},'workbench_batch_result_checkpoint');return batch.status==='running'&&runtime.store.get('paused')===false;
}
export function pauseWorkbenchBatch(runtime,reason='用户暂停'){const id=runtime.store.get('activeWorkbenchBatch'),batch=id&&runtime.store.get('workbenchBatch:'+id);if(batch?.status==='running')runtime.store.set('workbenchBatch:'+id,{...batch,status:'paused',reason});}
export async function applicationAi(runtime,action,input){
 if(action==='extractProfile'){let url;try{url=new URL(input.url);}catch{throw Error('请输入有效官网网址');}if(!/^https?:$/.test(url.protocol))throw Error('仅支持普通网站');const result=await runtime.cloud.request('ai/extract-site',{url:url.href,language:input.language||'auto'});runtime.store.set('profileDraft:'+input.profileId,{at:new Date().toISOString(),...result});return result;}
 if(action==='generateProfile')return runtime.cloud.request('ai/generate-site',{profile:input.profile,language:input.language||'auto'});
 const scope=workbenchScope(runtime.store.get('pair')),assertScope=()=>{if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，旧评论结果已放弃');};
 const snapshot=await runtime.cloud.request('snapshot');assertScope();const profile=snapshot.documents.siteProfiles?.[input.profileId];if(!profile||profile.archived)throw Error('请选择在用产品');
 const filters=globalThis.ExtLinkTargetFilters.normalize(snapshot.documents.targetFilters);if(!filters.aiComments)throw Error('AI 评论生成已在设置中关闭');
 const url=new URL(input.pageUrl);if(!/^https?:$/.test(url.protocol))throw Error('仅支持普通评论页面');
 const tone=input.tone||profile.blogRules?.tone||'helpful',allowLink=input.allowLink!==false&&filters.aiCommentAllowLink,config=plain(profiles.buildAgentConfigFromProfile(profile,snapshot.documents));config.blogRules={...config.blogRules,tone};
 const result=await originalCommentRequest(runtime,{pageUrl:url.href,pageTitle:String(input.pageTitle||'').slice(0,600),pageText:String(input.pageText||'').slice(0,30000),config,language:input.language||profile.language||'auto',count:Math.max(1,Math.min(Number(input.count)||3,5)),maxChars:Math.min(2000,Math.max(80,Number(input.maxChars)||700)),allowLink,tone,refresh:input.refresh},payload=>runtime.cloud.request('ai/comment',payload));assertScope();
 const drafts=(Array.isArray(result?.drafts)?result.drafts:[]).map(copyCommentDraft).filter(d=>d?.text.trim()).slice(0,5);if(result?.ok===false||result?.status&&result.status!=='ok'||!drafts.length)throw Error(result?.error||result?.reason||'AI 评论生成失败，请确认文章正文足够长');
 const normalized={...result,drafts,allowLink,tone};saveCommentVersion(runtime,{...input,tone,allowLink,drafts});runtime.store.set('commentDraft:'+input.profileId+'::'+queue.normalizeDestinationKey(url.href),{...normalized,scope,profileId:input.profileId,pageUrl:url.href,at:new Date().toISOString()});return normalized;
}

export async function fillCommentDraft(runtime,input){
 const task=runtime.store.get('task:'+input.taskId);
 if(!task||task.attemptBoundary||task.receipt||!['pending','needs_manual'].includes(task.status))throw Error('只能填写尚未投稿的原任务评论');
 if(input.profileId!==undefined&&input.profileId!==task.profileId)throw Error('评论产品与原任务不一致');
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停并等待当前动作结束');
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('请输入不超过 2000 字的评论草稿');
 if(!runtime.context)await runtime.connect();const page=await runtime.findPage(task);
 if(site(page.url())!==site(task.url))throw Error('原任务页面与目标网站不一致');
 const articleUrl=new URL(input.pageUrl??page.url()).href,scope=workbenchScope(runtime.store.get('pair')),assertArticle=()=>{if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，停止旧评论填写');if(new URL(page.url()).href!==articleUrl)throw Error('文章页面已切换，旧评论不能填入其他文章');};assertArticle();
 const snapshot=await runtime.cloud.request('snapshot');assertArticle();if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('此产品同站已有收件');
 const profile=task.profileSnapshot||snapshot.documents.siteProfiles?.[task.profileId];if(!profile)throw Error('产品资料缺失');
 const config={...plain(profiles.buildAgentConfigFromProfile(profile)),commentTemplate:input.text,applyCommentTemplate:true,aiComments:false,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false};
 await runtime.lease(task,{online:true});assertArticle();
 for(const frame of page.frames()){
  let engine;try{engine=await attachEngine(runtime.context,frame,msg=>runtime.bridge(task,msg));const detection=await engine.call({action:'detectPage',config});if(!detection.commentFound)continue;
   assertArticle();const fill=await engine.call({action:'smartFill',config}),actual=await engine.call({action:'getFilledFieldsReport'});assertArticle();
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
