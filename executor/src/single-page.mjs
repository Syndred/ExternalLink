import {randomUUID,createHash} from 'node:crypto';
import {queue,profiles,plain,priorProductSuccess} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {attachEngine} from './engine.mjs';
import {manualSubmit} from './manual-controls.mjs';
const at=()=>new Date().toISOString();
export function singlePagePanel(runtime){const panel=runtime.store.get('singlePagePanel');return panel?.scope===workbenchScope(runtime.store.get('pair'))?panel:null;}
export function sidepanelOpened(runtime,input={}){
 const old=singlePagePanel(runtime);if(input.panelId&&(!old||old.id!==input.panelId))throw Error('网页操作面板已变化，请重新打开');
 const panel={id:input.panelId||randomUUID(),scope:workbenchScope(runtime.store.get('pair')),open:true,at:at(),generation:(old?.generation||0)+1,selectedTargetId:input.targetId||old?.selectedTargetId,profileId:input.profileId||old?.profileId};runtime.store.set('singlePagePanel',panel);return{ok:true,panel};
}
export function sidepanelClosed(runtime,input={}){
 const panel=singlePagePanel(runtime);if(!panel||input.panelId!==panel.id)return{ok:true,ignored:true};
 for(const [key,timer]of runtime.sidepanelAutoTimers||[]){clearTimeout(timer);const fill=runtime.store.get(key);if(fill)runtime.store.set(key,{...fill,status:'cancelled',reason:'网页面板已关闭',cancelledAt:at()});}runtime.sidepanelAutoTimers?.clear();runtime.store.set('singlePagePanel',{...panel,open:false,generation:panel.generation+1,closedAt:at()});return{ok:true,closed:true};
}
function assertPanel(runtime,input){const panel=singlePagePanel(runtime);if(!panel?.open||input.panelId!==panel.id)throw Error('网页操作面板已关闭或变化，请重新打开');return panel;}
async function selectedPage(runtime,input){
 if(!runtime.context)await runtime.connect();
 for(const page of runtime.context.pages()){if(!/^https?:\/\//.test(page.url()))continue;const info=await getTargetInfo(runtime.context,page);if(info?.targetId===input.targetId){if(page.url()!==input.expectedUrl)throw Error('所选网页已跳转，请重新检测');return page;}}
 throw Error('所选网页已关闭，请刷新页面列表');
}
function configFor(snapshot,profile){return{...plain(profiles.buildAgentConfigFromProfile(profile,{email:snapshot.documents.cfgEmail,username:snapshot.documents.cfgName,commentTemplate:snapshot.documents.cfgCommentTemplate})),learnedFieldMappings:profile.learnedFieldMappings||{},fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false};}
async function preparedTask(runtime,input,snapshot){
 const scope=workbenchScope(runtime.store.get('pair')),host=queue.extractDomain(input.expectedUrl),key=queue.normalizeDestinationKey(input.expectedUrl),inventory=await runtime.cloud.request('runs?view=inventory');
 const candidates=[...runtime.store.values('task:'),...inventory.tasks].filter(t=>t.profileId===input.profileId&&queue.extractDomain(t.url)===host);
 if(candidates.some(t=>t.attemptBoundary||t.receipt))throw Error('同站已有提交结果或未知尝试，请先核验原任务');
 let task=candidates.find(t=>t.destinationKey===key&&['pending','needs_manual'].includes(t.status));
 if(task){if(!runtime.store.get('task:'+task.id))task=(await runtime.cloud.request('tasks/'+task.id)).task;if(!runtime.store.get('run:'+task.runId)){const existing=await runtime.cloud.request('runs?runId='+encodeURIComponent(task.runId)),run=existing.runs.find(r=>r.id===task.runId);if(!run)throw Error('原批次暂不可读');runtime.store.set('run:'+run.id,run);}runtime.store.set('task:'+task.id,task);return task;}
 const identity=createHash('sha256').update(scope+'|'+input.profileId+'|'+key).digest('hex'),index='singlePagePlanIndex:'+identity;
 let planId=runtime.store.get(index),plan=planId&&runtime.store.get('singlePagePlan:'+planId);
 if(plan){const read=await runtime.cloud.request('runs?runId='+encodeURIComponent(plan.run.id));task=read.tasks.find(t=>t.id===plan.run.tasks[0].id);const run=read.runs.find(r=>r.id===plan.run.id);if(task&&run){runtime.store.set('run:'+run.id,run);runtime.store.set('task:'+task.id,{...task,profileSnapshot:run.profile,profileRevision:run.profileRevision});runtime.store.set('singlePagePlan:'+plan.id,{...plan,status:'registered',registeredAt:at()});return runtime.store.get('task:'+task.id);}if(['registering','registration_unknown'].includes(plan.status))throw Error('原单页登记结果未知，请继续核对原编号，不能重复登记');if(plan.status==='rejected'&&plan.run.profileRevision!==snapshot.revisions.siteProfiles){plan={...plan,history:[...(plan.history||[]),{at:at(),error:plan.error,run:plan.run}],run:{...plan.run,profileRevision:snapshot.revisions.siteProfiles},status:'planned'};runtime.store.set('singlePagePlan:'+plan.id,plan);}}
 if(!plan){const run={id:randomUUID(),profileId:input.profileId,profileRevision:snapshot.revisions.siteProfiles,createdAt:at(),mode:'single_page_preparation',authorization:'fill_only',feeLimit:0,tasks:[{id:randomUUID(),url:input.expectedUrl,destinationKey:key}]};plan={id:randomUUID(),scope,run,status:'planned',at:at()};runtime.store.set('singlePagePlan:'+plan.id,plan);runtime.store.set(index,plan.id);}
 runtime.store.set('singlePagePlan:'+plan.id,{...plan,status:'registering'});
 try{const saved=await runtime.cloud.request('runs',{run:plan.run});if(saved.run?.id!==plan.run.id||saved.tasks?.[0]?.id!==plan.run.tasks[0].id)throw Error('单页登记编号不一致');runtime.store.set('run:'+saved.run.id,saved.run);task={...saved.tasks[0],profileSnapshot:saved.run.profile,profileRevision:saved.run.profileRevision};runtime.store.set('task:'+task.id,task);runtime.store.set('singlePagePlan:'+plan.id,{...plan,status:'registered',registeredAt:at()});return task;}catch(error){runtime.store.set('singlePagePlan:'+plan.id,{...plan,status:error.status>=400&&error.status<500?'rejected':'registration_unknown',error:error.message});throw error;}
}
export async function sidepanelDetect(runtime,input){
 assertPanel(runtime,input);if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停当前任务');const page=await selectedPage(runtime,input),snapshot=await runtime.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[input.profileId];if(!profile||profile.archived)throw Error('请选择在用产品');
 const frames=[];for(const frame of page.frames()){if(!/^https?:\/\//.test(frame.url()))continue;let engine;try{engine=await attachEngine(runtime.context,frame);frames.push({url:frame.url(),...await engine.call({action:'detectPage',config:configFor(snapshot,profile)})});}finally{await engine?.detach();}}
 return{ok:true,frames,url:page.url(),profileId:profile.id};
}
export async function sidepanelFill(runtime,input){
 assertPanel(runtime,input);if(runtime.singlePageFill||runtime.job||runtime.store.get('paused')!==true)throw Error('请暂停并等待当前网页操作完成');runtime.singlePageFill=true;
 const engines=[];try{
  const page=await selectedPage(runtime,input),snapshot=await runtime.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[input.profileId];if(!profile||profile.archived||!profiles.profileConfigured(profile))throw Error('请选择已配置资料的在用产品');if(priorProductSuccess(snapshot.documents.submissionRecords,input.profileId,page.url()))throw Error('该产品同站已有收件，请先核验');
  if(input.mode==='comment'&&(!input.commentText?.trim()||input.commentText.length>20000))throw Error('请输入待填写的评论，最多20000字');
  let config=configFor(snapshot,profile);if(input.mode==='comment')config.commentTemplate=input.commentText;
  for(const frame of page.frames()){if(!/^https?:\/\//.test(frame.url()))continue;const engine=await attachEngine(runtime.context,frame);engines.push({engine,frame,detection:await engine.call({action:'detectPage',config})});}
  const candidate=engines.filter(e=>input.mode==='comment'?e.detection.commentFound:e.detection.operable).sort((a,b)=>(b.detection.formFieldCount||0)-(a.detection.formFieldCount||0))[0];if(!candidate)throw Error(input.mode==='comment'?'未发现评论表单':'未发现可填写表单');
  const guard=await candidate.engine.call({action:'inspectAutoFillGuard',targetDomain:config.targetDomain});if(guard?.blocked)throw Error(guard.reason||'网页已有其他产品内容，请检查后继续');
  const task=await preparedTask(runtime,input,snapshot);if(task.attemptBoundary||task.receipt||['ai','supervisor'].includes(task.controller))throw Error('原任务结果或控制权已变化，请先核验');assertPanel(runtime,input);await runtime.lease(task,{online:true});
  const history=task.targetId&&task.targetId!==input.targetId?[...(task.pageHistory||[]),{targetId:task.targetId,browserInstance:task.browserInstance,at:at()}]:task.pageHistory;
  runtime.update(task,{targetId:input.targetId,browserInstance:runtime.host.startedAt,pageOwnership:'manual',...(history?{pageHistory:history}:{}),profileSnapshot:task.profileSnapshot||profile,profileRevision:task.profileRevision??snapshot.revisions.siteProfiles},'single_page_selected');
  config=configFor(snapshot,task.profileSnapshot);if(input.mode==='comment')config.commentTemplate=input.commentText;config.sidepanelContext={profileId:task.profileId,url:page.url()};
  await candidate.engine.detach();candidate.engine=await attachEngine(runtime.context,candidate.frame,message=>runtime.bridge(task,message));
  if(page.url()!==input.expectedUrl)throw Error('网页已跳转，请重新检测');const fill=await candidate.engine.call({action:'smartFill',config,platformType:input.mode==='comment'?'wp_comment':candidate.detection.platform});if(fill?.error||fill?.ok===false)throw Error(fill.error||'填写未完成');
  const actual=await candidate.engine.call({action:'getFilledFieldsReport'}),validation=await candidate.engine.call({action:'collectFormValidation'});runtime.update(task,{actualPreparation:actual,preparedAt:at(),singlePagePreparation:{at:at(),mode:input.mode||'form',fill,actual,validation,panelId:input.panelId},reason:'单页资料已填写，尚未投稿'},'single_page_prepared');
  let syncError='';try{await runtime.synchronize();}catch(error){syncError=error.message;}
  if(input.submit===true){if(syncError)throw Error('填写已保存但记录尚未回读，暂不投稿');const result=await manualSubmit(runtime,{taskId:task.id,expectedRunId:task.runId,expectedTargetId:task.targetId,ordinaryPermissionsAuthorized:input.ordinaryPermissionsAuthorized});return{...result,filled:true};}
  return{ok:true,taskId:task.id,runId:task.runId,filled:true,submitted:false,fill,actual,validation,syncError};
 }finally{for(const item of engines)await item.engine.detach();runtime.singlePageFill=false;}
}
