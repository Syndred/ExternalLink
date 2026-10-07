import {cacheCloudSnapshot} from './cloud-sync-state.mjs';
import {originalCommentRequest} from './comment-cache.mjs';
import '../../core/target-filters.js';
import {attachEngine} from './engine.mjs';import {getTargetInfo} from './browser-target.mjs';
import {profiles,plain,queue,selectScope,priorProductSuccess} from './shared.mjs';import {workbenchScope} from './workbench-sync.mjs';
import {singlePagePanel,preparedTask} from './single-page.mjs';
import {createHash} from 'node:crypto';
import {enqueueLibraryMutation,overlayApplication,pendingApplication} from './application-mutations.mjs';
import {captureFillLearning} from './fill-learning.mjs';
import {applyDestinationFormKnowledge} from '../../core/form-knowledge.mjs';
import {isProductHuntLaunch,runProductHuntWorkflow} from './product-hunt.mjs';
import {pendingSubmissionQueue} from '../../core/submission-queue.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
const effectiveProfile=(runtime,settings)=>singlePagePanel(runtime)?.open&&singlePagePanel(runtime).profileId||settings.profileId;
export function assistantState(runtime){
 const saved=runtime.store.get('browserAssistantSettings'),scope=workbenchScope(runtime.store.get('pair')),cached=runtime.store.get('applicationSnapshot'),panel=singlePagePanel(runtime),modern=saved?.scope===scope;
 const docs=cached?.scope===scope?(pendingApplication(runtime).some(i=>i.key==='autoFillOnVisit')?overlayApplication(runtime,cached.snapshot).documents:cached.snapshot.documents):{};
 const autoFillOnVisit=Object.hasOwn(docs,'autoFillOnVisit')?docs.autoFillOnVisit===true:modern&&saved.autoFillOnVisit===true;
 const settings=modern?{...saved,autoFillOnVisit}:{scope,enabled:!!(panel?.open&&autoFillOnVisit),autoFillOnVisit,profileId:panel?.profileId||docs.activeSiteId,source:'original_visit_preference'};
 return{settings,connectedFrames:runtime.browserAssistantFrames?.size||0,error:runtime.browserAssistantError||'',fills:runtime.store.values('assistantFill:').filter(j=>j.scope===scope).slice(-20)};
}
export async function saveAssistantSettings(runtime,input){
 if(typeof input.enabled!=='boolean'||typeof input.autoFillOnVisit!=='boolean')throw Error('助手设置无效');const scope=workbenchScope(runtime.store.get('pair'));
 const checkScope=()=>{if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，助手设置保留在原工作区');};let snapshot;
 try{snapshot=await runtime.cloud.request('snapshot');}catch(error){checkScope();const cached=runtime.store.get('applicationSnapshot');if(cached?.scope!==scope)throw error;snapshot=cached.snapshot;}checkScope();snapshot={...snapshot,revisions:snapshot.revisions||{}};
 const docs=overlayApplication(runtime,snapshot).documents;if(input.enabled&&(!docs.siteProfiles?.[input.profileId]||docs.siteProfiles[input.profileId].archived))throw Error('请选择在用产品');
 cacheCloudSnapshot(runtime,snapshot);const settings={scope,enabled:input.enabled,autoFillOnVisit:input.autoFillOnVisit,profileId:input.profileId,at:new Date().toISOString()};runtime.store.set('browserAssistantSettings',settings);
 if(docs.autoFillOnVisit!==input.autoFillOnVisit)await enqueueLibraryMutation(runtime,{operation:{type:'settings',key:'autoFillOnVisit',value:input.autoFillOnVisit}});
 checkScope();if(!input.autoFillOnVisit||!input.enabled)cancelAutoTimers(runtime,'访问自动填写已关闭');await checkBrowserAssistant(runtime);return{ok:true,pendingEdits:pendingApplication(runtime).length,...assistantState(runtime)};
}
function cancelAutoTimers(runtime,reason){for(const[key,timer]of runtime.sidepanelAutoTimers||[]){clearTimeout(timer);const fill=runtime.store.get(key);if(fill)runtime.store.set(key,{...fill,status:'cancelled',reason,cancelledAt:new Date().toISOString()});}runtime.sidepanelAutoTimers?.clear();}
export async function stopBrowserAssistant(runtime){cancelAutoTimers(runtime,'浏览器助手已关闭');for(const item of runtime.browserAssistantFrames?.values()||[]){await item.engine.disableAssistant().catch(()=>{});await item.engine.detach();}runtime.browserAssistantFrames?.clear();}
function snapshotFor(runtime){const snapshot=runtime.store.get('applicationSnapshot');if(snapshot?.scope!==workbenchScope(runtime.store.get('pair')))throw Error('请先回读当前云端资料');return snapshot.snapshot;}
function configFor(runtime,profileId,task){const snapshot=snapshotFor(runtime),profile=task?.profileSnapshot||snapshot.documents.siteProfiles?.[profileId];if(!profile||profile.archived)throw Error('助手产品资料已变化');return{...plain(profiles.buildAgentConfigFromProfile(profile,{email:snapshot.documents.cfgEmail,username:snapshot.documents.cfgName,commentTemplate:snapshot.documents.cfgCommentTemplate})),aiComments:snapshot.documents.targetFilters?.aiComments!==false,aiCommentAllowLink:snapshot.documents.targetFilters?.aiCommentAllowLink!==false,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false};}
const parked=task=>['supervisor','ai'].includes(task.controller)||['login','human_verification','unknown_receipt','payment','paid'].includes(task.attentionType);
export function originalAssistantTask(runtime,profileId,targetId,url){return runtime.store.values('task:').find(t=>t.profileId===profileId&&t.targetId===targetId&&t.browserInstance===runtime.host?.startedAt&&!t.attemptBoundary&&!t.receipt&&['pending','needs_manual'].includes(t.status)&&!parked(t)&&queue.extractDomain(t.url)===queue.extractDomain(url));}
export function autoVisitTarget(snapshot,profileId,url){const profile=snapshot.documents.siteProfiles?.[profileId],annotation=snapshot.documents.siteAnnotations?.[queue.normalizeDestinationKey(url)]||snapshot.documents.siteAnnotations?.[queue.extractDomain(url)];if(!profile||profile.archived||!profiles.profileConfigured(profile)||priorProductSuccess(snapshot.documents.submissionRecords,profileId,url)||annotation&&queue.hasAnnotationStatusInSet(annotation,queue.DEAD_END_STATUSES))return null;return queue.matchSubmissionTarget(url,selectScope(snapshot,null,profileId).tasks.map(task=>({...task,profileId})),profileId);}
function recordVisitQueue(runtime,snapshot,profileId,match){
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get('submissionQueue'),previous=saved?.scope===scope?saved:{},selectedSiteIds=previous.selectedSiteIds?.includes(profileId)?previous.selectedSiteIds:[profileId],destinationKey=canonicalLibraryDestination(match.destinationKey);let options={selectedSiteIds,category:previous.category||'',group:previous.group||''},result=pendingSubmissionQueue(snapshot,options),index=result.groups.findIndex(group=>group.key===destinationKey);
 if(index<0){options={selectedSiteIds,category:'',group:''};result=pendingSubmissionQueue(snapshot,options);index=result.groups.findIndex(group=>group.key===destinationKey);}if(index<0)throw Error('原待提交队列已变化');
 runtime.store.set('submissionQueue',{...previous,scope,...options,index,key:result.groups[index].key,at:new Date().toISOString()});return{queueIndex:index,queueTotal:result.groups.length};
}
function frozenConfig(snapshot,profile,url){return applyDestinationFormKnowledge(snapshot.documents,{...plain(profiles.buildAgentConfigFromProfile(profile,{email:snapshot.documents.cfgEmail,username:snapshot.documents.cfgName,commentTemplate:snapshot.documents.cfgCommentTemplate})),aiComments:snapshot.documents.targetFilters?.aiComments!==false,aiCommentAllowLink:snapshot.documents.targetFilters?.aiCommentAllowLink!==false,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false},url);}
export async function fillAssistantTask(runtime,input){
 const settings=assistantState(runtime).settings,scope=workbenchScope(runtime.store.get('pair')),profileId=effectiveProfile(runtime,settings),engines=[];
 const assertCurrent=()=>{const current=assistantState(runtime).settings,panel=singlePagePanel(runtime);if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，停止原网页填写');if(!current.enabled||!current.autoFillOnVisit||effectiveProfile(runtime,current)!==profileId||input.profileId&&input.profileId!==profileId||runtime.job||runtime.store.get('paused')!==true)throw Error('请暂停任务并启用所选产品的访问自动填写设置');if(input.panelId&&(!panel?.open||panel.id!==input.panelId||panel.generation!==input.panelGeneration||panel.profileId!==profileId||panel.selectedTargetId!==input.targetId))throw Error('网页面板已关闭或切换');};
 const record=input.fillKey&&runtime.store.get(input.fillKey);if(input.fillKey&&(!record||record.scope!==scope||record.profileId!==profileId||record.targetId!==input.targetId||record.url!==input.url))throw Error('原网页填写记录已变化');
 const saveRecord=patch=>{if(record){const latest=runtime.store.get(input.fillKey);if(latest?.status!=='cancelled')runtime.store.set(input.fillKey,{...record,...latest,...patch});}};
 try{
  assertCurrent();let task=originalAssistantTask(runtime,profileId,input.targetId,input.url);if(input.taskId&&task?.id!==input.taskId)throw Error('原任务已变化或已有提交边界');
  if(!runtime.context)await runtime.connect();let page;for(const candidate of runtime.context.pages()){if(!/^https?:\/\//.test(candidate.url()))continue;const info=await getTargetInfo(runtime.context,candidate);if(info?.targetId===input.targetId){page=candidate;break;}}if(!page||page.url()!==input.url)throw Error('原网页已关闭或跳转');
  const snapshot=await runtime.cloud.request('snapshot');assertCurrent();cacheCloudSnapshot(runtime,snapshot);assertCurrent();const match=autoVisitTarget(snapshot,profileId,page.url());if(!match)throw Error('原站点当前不允许自动填写');saveRecord(recordVisitQueue(runtime,snapshot,profileId,match));
  let profile=task?.profileSnapshot||runtime.store.get('run:'+task?.runId)?.profile||snapshot.documents.siteProfiles[profileId],config=frozenConfig(snapshot,profile,page.url());
  const assertPage=()=>{assertCurrent();if(page.isClosed()||page.url()!==input.url)throw Error('原网页已关闭或跳转');};assertPage();
  if(task&&isProductHuntLaunch(page.url())){await runtime.lease(task,{online:true});assertPage();const active=()=>{try{assertPage();return true;}catch{return false;}};const fill=await runProductHuntWorkflow(runtime,task,page,config,{active,confirmCreate:false});await runtime.synchronize();const result={ok:true,taskId:task.id,runId:task.runId,filled:true,submitted:false,platform:'product_hunt',readyToCreate:fill.ready_to_create===true};saveRecord({status:'prepared',result});return result;}
  for(const frame of page.frames()){if(!/^https?:\/\//.test(frame.url()))continue;const engine=await attachEngine(runtime.context,frame);const item={engine,frame,url:frame.url()};engines.push(item);item.detection=await engine.call({action:'detectPage',config});}
  const candidate=engines.filter(item=>['directory','submission','profile','forum'].includes(String(item.detection.platform||'').toLowerCase())&&(item.detection.operable||item.detection.formFieldCount>0)).sort((a,b)=>(b.detection.formFieldCount||0)-(a.detection.formFieldCount||0))[0];if(!candidate)throw Error('未发现原自动填写范围内的表单');if(candidate.detection.submitBlocker?.blocked||candidate.detection.submitBlocker?.payment_uncertain)throw Error('表单有提交闸门或费用不明，请人工检查');
  let guard=await candidate.engine.call({action:'inspectAutoFillGuard',targetDomain:config.targetDomain});if(guard?.blocked)throw Error(guard.reason||'网页已有其他产品内容，请检查后继续');assertPage();
  task=await preparedTask(runtime,{profileId,expectedUrl:match.url,autoVisit:true},snapshot);assertPage();if(input.taskId&&task.id!==input.taskId)throw Error('原任务已变化，停止填写');if(task.attemptBoundary||task.receipt||parked(task))throw Error('原任务已有提交结果、未知尝试或人工闸门');
  if(task.targetId&&task.targetId!==input.targetId){for(const other of runtime.context.pages()){if(!/^https?:\/\//.test(other.url()))continue;if((await getTargetInfo(runtime.context,other))?.targetId===task.targetId)throw Error('原任务网页仍打开，请回到原网页填写');}}
  await runtime.lease(task,{online:true});assertPage();const run=runtime.store.get('run:'+task.runId);profile=task.profileSnapshot||run?.profile;if(!profile)throw Error('原任务冻结资料暂不可读，请先同步');config=frozenConfig(snapshot,profile,candidate.frame.url());config.sidepanelContext={profileId,url:page.url()};
  guard=await candidate.engine.call({action:'inspectAutoFillGuard',targetDomain:config.targetDomain});if(guard?.blocked)throw Error(guard.reason||'网页已有其他产品内容，请检查后继续');assertPage();
  const history=task.targetId&&task.targetId!==input.targetId?[...(task.pageHistory||[]),{targetId:task.targetId,browserInstance:task.browserInstance,at:new Date().toISOString()}]:task.pageHistory;
  runtime.update(task,{targetId:input.targetId,browserInstance:runtime.host.startedAt,pageOwnership:task.targetId===input.targetId&&task.browserInstance===runtime.host.startedAt?task.pageOwnership||'manual':'manual',profileSnapshot:profile,profileRevision:task.profileRevision??run?.profileRevision,...(history?{pageHistory:history}:{})},'assistant_original_page_selected');
  if(candidate.frame.isDetached()||candidate.frame.url()!==candidate.url)throw Error('原表单区域已跳转或关闭');await candidate.engine.detach();candidate.engine=await attachEngine(runtime.context,candidate.frame,message=>runtime.bridge(task,message));assertPage();
  const fill=await candidate.engine.call({action:'smartFill',config,platformType:candidate.detection.platform});if(fill?.error||fill?.ok===false)throw Error(fill.error||'填写未完成');const actual=await candidate.engine.call({action:'getFilledFieldsReport'});runtime.update(task,{actualPreparation:actual,assistantPreparation:{at:new Date().toISOString(),fill,actual},preparedAt:new Date().toISOString()},'assistant_form_prepared');
  let syncError='';try{await runtime.synchronize();}catch(error){syncError=error.message;}const result={ok:true,taskId:task.id,runId:task.runId,filled:true,submitted:false,syncError};saveRecord({status:'prepared',result,error:''});return result;
 }catch(error){saveRecord({status:'needs_manual',error:error.message});throw error;}finally{for(const item of engines)await item.engine.detach();}
}
async function formShape(page){const shapes=[];for(const frame of page.frames()){if(!/^https?:\/\//.test(frame.url()))continue;try{shapes.push([frame.url(),await frame.evaluate(()=>[...document.querySelectorAll('input,textarea,select')].filter(e=>!e.closest('[data-extlink-root],#extlink-manual-icons')).map(e=>[e.tagName,e.id,e.name,e.type,e.disabled,e.required,e.options?.length||0]))]);}catch{}}return createHash('sha256').update(JSON.stringify(shapes)).digest('hex').slice(0,16);}
export async function checkBrowserAssistant(runtime){
 if(runtime.connectionBusy||runtime.cloudPullOperation||runtime.store.get('connectionExecutionHold'))return;
 if(runtime.browserAssistantScan||runtime.job||runtime.controlBusy)return;const settings=assistantState(runtime).settings;if(!settings.enabled){await stopBrowserAssistant(runtime);return;}if(!settings.autoFillOnVisit)cancelAutoTimers(runtime,'访问自动填写已关闭');
 runtime.browserAssistantScan=true;try{
  if(!runtime.context)await runtime.connect();runtime.browserAssistantFrames||=new Map();const live=new Set(),snapshot=snapshotFor(runtime),profileId=effectiveProfile(runtime,settings),panel=singlePagePanel(runtime),scope=workbenchScope(runtime.store.get('pair'));
  for(const page of runtime.context.pages()){
   if(!/^https?:\/\//.test(page.url())||page.url().startsWith('http://127.0.0.1:'+Number(process.env.EXTERNALLINK_WEB_PORT||19389)+'/'))continue;const info=await getTargetInfo(runtime.context,page);if(!info)continue;
   for(const frame of page.frames()){
    if(!/^https?:\/\//.test(frame.url()))continue;const url=frame.url(),key=info.targetId+'::'+url;live.add(key);let item=runtime.browserAssistantFrames.get(key);
    const reuse=item&&item.scope===scope&&item.profileId===profileId&&await item.engine.assistantActive().catch(()=>false);if(item&&!reuse){await item.engine.disableAssistant().catch(()=>{});await item.engine.detach();runtime.browserAssistantFrames.delete(key);item=null;}
    if(!item){
    const bridge=async message=>{
     const current=assistantState(runtime).settings;if(scope!==workbenchScope(runtime.store.get('pair'))||!current.enabled||effectiveProfile(runtime,current)!==profileId||(frame.url()!==url&&message.action!=='manualSubmissionClicked'))return{ok:false,error:'助手页面或产品已变化'};const original=originalAssistantTask(runtime,profileId,info.targetId,page.url()),docs=snapshotFor(runtime).documents,config=applyDestinationFormKnowledge(docs,configFor(runtime,profileId,original),url);
     if(message.action==='getActiveFillConfig')return{ok:true,config,filters:globalThis.ExtLinkTargetFilters.normalize(docs.targetFilters)};
     if(message.action==='contentReady')return{ok:true};
     if(message.action==='saveFillLearnings'){if(message.pageUrl!==url)return{ok:false,error:'助手原页面已变化'};return captureFillLearning(runtime,{profileId,profile:original?.profileSnapshot||docs.siteProfiles[profileId],taskId:original?.id,targetId:info.targetId,browserInstance:runtime.host.startedAt,profileRevision:original?.profileRevision},message);}
     if(message.action==='log'){runtime.store.appendLog({at:new Date().toISOString(),type:'form_engine',runId:original?.runId,taskId:original?.id,profileId,url,message:String(message.msg||'').slice(0,4000),level:['warn','err','ok'].includes(message.cls)?message.cls:'info'});return{ok:true};}
     if(['manualSubmissionWatchRequest','manualSubmissionWatchReady','manualSubmissionClicked'].includes(message.action)){if(!original)return{ok:false};return runtime.dispatchControl('manualWatchMessage',{...message,taskId:original.id,targetId:info.targetId,pageUrl:page.url(),frameUrl:url,documentId:message.executorDocumentId});}
     if(message.action==='generateCommentDrafts')return originalCommentRequest(runtime,{...message,config},payload=>runtime.cloud.request('ai/comment',payload));
     if(original&&['fetchSubmissionMedia','fetchCloudSubmissionMedia'].includes(message.action))return runtime.bridge(original,message);return{ok:false,error:'上传素材需要已登记的原任务'};
    };
    const engine=await attachEngine(runtime.context,frame,bridge,{interactive:true});item={engine,scope,profileId,url};runtime.browserAssistantFrames.set(key,item);
    }
    const known=originalAssistantTask(runtime,profileId,info.targetId,url);
    if(settings.autoFillOnVisit&&frame===page.mainFrame()&&runtime.dispatchControl&&runtime.store.get('paused')===true&&(!panel?.open||panel.selectedTargetId===info.targetId)&&(known||autoVisitTarget(snapshot,profileId,url))){
     const fillKey='assistantFill:'+createHash('sha256').update(scope).digest('hex').slice(0,16)+'::'+info.targetId+'::'+profileId+'::'+item.engine.documentId+'::'+await formShape(page),previous=runtime.store.get(fillKey);if(previous?.scope===scope&&previous.status!=='cancelled')continue;
     const evidence={scope,profileId,targetId:info.targetId,url,fillKey,at:new Date().toISOString(),status:'preparing',submitted:false,...(previous?.scope===scope?{history:[...(previous.history||[]),{at:previous.at,status:previous.status,reason:previous.reason,cancelledAt:previous.cancelledAt}]}:{})};runtime.store.set(fillKey,evidence);
     const fill=async()=>{try{evidence.result=await runtime.dispatchControl('fillAssistantTask',{taskId:known?.id,targetId:info.targetId,url,profileId,fillKey,...(panel?.open?{panelId:panel.id,panelGeneration:panel.generation}:{})});evidence.status='prepared';}catch(error){evidence.status='needs_manual';evidence.error=error.message;}const latest=runtime.store.get(fillKey);if(latest?.status!=='cancelled')runtime.store.set(fillKey,{...latest,...evidence});};
     if(panel?.open){runtime.sidepanelAutoTimers||=new Map();const timer=setTimeout(()=>{runtime.sidepanelAutoTimers.delete(fillKey);fill().catch(error=>{runtime.browserAssistantError=error.message;});},600);runtime.sidepanelAutoTimers.set(fillKey,timer);}else await fill();
    }
   }
  }
  for(const [key,item]of runtime.browserAssistantFrames)if(!live.has(key)){await item.engine.disableAssistant().catch(()=>{});await item.engine.detach();runtime.browserAssistantFrames.delete(key);}runtime.browserAssistantError='';
 }catch(error){runtime.browserAssistantError=error.message;}finally{runtime.browserAssistantScan=false;}
}
