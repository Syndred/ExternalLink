import {attachEngine} from './engine.mjs';import {getTargetInfo} from './browser-target.mjs';
import {profiles,plain,queue,selectScope,priorProductSuccess} from './shared.mjs';import {workbenchScope} from './workbench-sync.mjs';
import {singlePagePanel} from './single-page.mjs';
import {captureFillLearning} from './fill-learning.mjs';
import {applyDestinationFormKnowledge} from '../../core/form-knowledge.mjs';
import {isProductHuntLaunch,runProductHuntWorkflow} from './product-hunt.mjs';
const effectiveProfile=(runtime,settings)=>singlePagePanel(runtime)?.open&&singlePagePanel(runtime).profileId||settings.profileId;
export function assistantState(runtime){const saved=runtime.store.get('browserAssistantSettings'),scope=workbenchScope(runtime.store.get('pair'));return{settings:saved?.scope===scope?saved:{enabled:false,autoFillOnVisit:false},connectedFrames:runtime.browserAssistantFrames?.size||0,error:runtime.browserAssistantError||'',fills:runtime.store.values('assistantFill:').filter(j=>j.scope===scope).slice(-20)};}
export async function saveAssistantSettings(runtime,input){
 if(typeof input.enabled!=='boolean'||typeof input.autoFillOnVisit!=='boolean')throw Error('助手设置无效');const snapshot=await runtime.cloud.request('snapshot');if(input.enabled&&(!snapshot.documents.siteProfiles?.[input.profileId]||snapshot.documents.siteProfiles[input.profileId].archived))throw Error('请选择在用产品');
 const settings={scope:workbenchScope(runtime.store.get('pair')),enabled:input.enabled,autoFillOnVisit:input.autoFillOnVisit,profileId:input.profileId,at:new Date().toISOString()};runtime.store.set('browserAssistantSettings',settings);await checkBrowserAssistant(runtime);return{ok:true,...assistantState(runtime)};
}
export async function stopBrowserAssistant(runtime){for(const item of runtime.browserAssistantFrames?.values()||[]){await item.engine.disableAssistant().catch(()=>{});await item.engine.detach();}runtime.browserAssistantFrames?.clear();}
function snapshotFor(runtime){const snapshot=runtime.store.get('applicationSnapshot');if(snapshot?.scope!==workbenchScope(runtime.store.get('pair')))throw Error('请先回读当前云端资料');return snapshot.snapshot;}
function configFor(runtime,profileId,task){const snapshot=snapshotFor(runtime),profile=task?.profileSnapshot||snapshot.documents.siteProfiles?.[profileId];if(!profile||profile.archived)throw Error('助手产品资料已变化');return{...plain(profiles.buildAgentConfigFromProfile(profile,{email:snapshot.documents.cfgEmail,username:snapshot.documents.cfgName,commentTemplate:snapshot.documents.cfgCommentTemplate})),aiComments:snapshot.documents.targetFilters?.aiComments!==false,aiCommentAllowLink:snapshot.documents.targetFilters?.aiCommentAllowLink!==false,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false};}
export function originalAssistantTask(runtime,profileId,targetId,url){return runtime.store.values('task:').find(t=>t.profileId===profileId&&t.targetId===targetId&&t.browserInstance===runtime.host?.startedAt&&!t.attemptBoundary&&!t.receipt&&['pending','needs_manual'].includes(t.status)&&!['supervisor','ai'].includes(t.controller)&&queue.extractDomain(t.url)===queue.extractDomain(url));}
export async function fillAssistantTask(runtime,input){
 const settings=assistantState(runtime).settings;
 if(!settings.enabled||!settings.autoFillOnVisit||runtime.job||runtime.store.get('paused')!==true)throw Error('请暂停任务并启用访问时自动填写');
 const panel=singlePagePanel(runtime);if(input.panelId&&(!panel?.open||panel.id!==input.panelId||panel.generation!==input.panelGeneration))throw Error('网页面板已关闭或切换');
 const task=originalAssistantTask(runtime,effectiveProfile(runtime,settings),input.targetId,input.url);if(!task||task.id!==input.taskId)throw Error('原任务已变化或已有提交边界');
 const page=await runtime.findPage(task);if(page.url()!==input.url)throw Error('原页面已跳转');
 const snapshot=await runtime.cloud.request('snapshot');if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url)||!selectScope(snapshot,null,task.profileId,[task.url]).tasks.length)throw Error('原站点当前不允许填写');
 await runtime.lease(task,{online:true});const run=runtime.store.get('run:'+task.runId);if(!task.profileSnapshot){if(!run?.profile)throw Error('原批次冻结资料暂不可读，请先同步');runtime.update(task,{profileSnapshot:run.profile,profileRevision:run.profileRevision},'assistant_profile_frozen');}
 const config=applyDestinationFormKnowledge(snapshot.documents,{...configFor(runtime,task.profileId),...plain(profiles.buildAgentConfigFromProfile(task.profileSnapshot)),fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false},page.url());
 if(isProductHuntLaunch(page.url())){const active=()=>{const current=assistantState(runtime).settings,panel=singlePagePanel(runtime);return current.enabled&&current.autoFillOnVisit&&effectiveProfile(runtime,current)===task.profileId&&runtime.store.get('paused')===true&&!page.isClosed()&&(!input.panelId||panel?.open&&panel.id===input.panelId&&panel.generation===input.panelGeneration);};const fill=await runProductHuntWorkflow(runtime,task,page,config,{active,confirmCreate:false});await runtime.synchronize();return{ok:true,filled:true,submitted:false,platform:'product_hunt',readyToCreate:fill.ready_to_create===true};}
 const engine=await attachEngine(runtime.context,page.mainFrame(),message=>runtime.bridge(task,message));
 try{const detection=await engine.call({action:'detectPage',config});if(!detection.operable)throw Error('未发现可操作表单');const fill=await engine.call({action:'smartFill',config}),actual=await engine.call({action:'getFilledFieldsReport'});runtime.update(task,{actualPreparation:actual,assistantPreparation:{at:new Date().toISOString(),fill,actual},preparedAt:new Date().toISOString()},'assistant_form_prepared');await runtime.synchronize();return{ok:true,filled:true,submitted:false};}finally{await engine.detach();}
}
export async function checkBrowserAssistant(runtime){
 if(runtime.browserAssistantScan||runtime.job||runtime.controlBusy)return;const settings=assistantState(runtime).settings;if(!settings.enabled){await stopBrowserAssistant(runtime);return;}
 runtime.browserAssistantScan=true;try{
  if(!runtime.context)await runtime.connect();runtime.browserAssistantFrames||=new Map();const live=new Set(),snapshot=snapshotFor(runtime),profileId=effectiveProfile(runtime,settings),panel=singlePagePanel(runtime);
  for(const page of runtime.context.pages()){
   if(!/^https?:\/\//.test(page.url())||page.url().startsWith('http://127.0.0.1:'+Number(process.env.EXTERNALLINK_WEB_PORT||19389)+'/'))continue;const info=await getTargetInfo(runtime.context,page);if(!info)continue;
   for(const frame of page.frames()){
    if(!/^https?:\/\//.test(frame.url()))continue;const url=frame.url(),key=info.targetId+'::'+url;live.add(key);let item=runtime.browserAssistantFrames.get(key);
    if(item&&item.profileId===profileId&&await item.engine.assistantActive().catch(()=>false))continue;if(item){await item.engine.disableAssistant().catch(()=>{});await item.engine.detach();runtime.browserAssistantFrames.delete(key);}
    const bridge=async message=>{
     const current=assistantState(runtime).settings;if(!current.enabled||effectiveProfile(runtime,current)!==profileId||(frame.url()!==url&&message.action!=='manualSubmissionClicked'))return{ok:false,error:'助手页面或产品已变化'};const original=originalAssistantTask(runtime,profileId,info.targetId,page.url()),docs=snapshotFor(runtime).documents,config=applyDestinationFormKnowledge(docs,configFor(runtime,profileId,original),url);
     if(message.action==='getActiveFillConfig')return{ok:true,config,filters:{...docs.targetFilters,showManualFillIcons:docs.targetFilters?.showManualFillIcons!==false}};
     if(message.action==='contentReady')return{ok:true};
     if(message.action==='saveFillLearnings'){if(message.pageUrl!==url)return{ok:false,error:'助手原页面已变化'};return captureFillLearning(runtime,{profileId,profile:original?.profileSnapshot||docs.siteProfiles[profileId],taskId:original?.id,targetId:info.targetId,browserInstance:runtime.host.startedAt,profileRevision:original?.profileRevision},message);}
     if(message.action==='log'){runtime.store.appendLog({at:new Date().toISOString(),type:'form_engine',runId:original?.runId,taskId:original?.id,profileId,url,message:String(message.msg||'').slice(0,4000),level:['warn','err','ok'].includes(message.cls)?message.cls:'info'});return{ok:true};}
     if(['manualSubmissionWatchRequest','manualSubmissionWatchReady','manualSubmissionClicked'].includes(message.action)){if(!original)return{ok:false};return runtime.dispatchControl('manualWatchMessage',{...message,taskId:original.id,targetId:info.targetId,pageUrl:page.url(),frameUrl:url,documentId:message.executorDocumentId});}
     if(message.action==='generateCommentDrafts')return runtime.cloud.request('ai/comment',{...message,config});
     if(original&&['fetchSubmissionMedia','fetchCloudSubmissionMedia'].includes(message.action))return runtime.bridge(original,message);return{ok:false,error:'上传素材需要已登记的原任务'};
    };
    const engine=await attachEngine(runtime.context,frame,bridge,{interactive:true});item={engine,profileId,url};runtime.browserAssistantFrames.set(key,item);
    const fillKey='assistantFill:'+info.targetId+'::'+profileId+'::'+engine.documentId,previous=runtime.store.get(fillKey),known=originalAssistantTask(runtime,profileId,info.targetId,url);
    if(settings.autoFillOnVisit&&!previous&&known&&frame===page.mainFrame()&&runtime.dispatchControl&&(!panel?.open||!panel.selectedTargetId||panel.selectedTargetId===info.targetId)){
     const evidence={scope:settings.scope,profileId,url,at:new Date().toISOString(),status:'preparing',submitted:false};runtime.store.set(fillKey,evidence);
     const fill=async()=>{try{evidence.result=await runtime.dispatchControl('fillAssistantTask',{taskId:known.id,targetId:info.targetId,url,...(panel?.open?{panelId:panel.id,panelGeneration:panel.generation}:{})});evidence.status='prepared';}catch(error){evidence.status='needs_manual';evidence.error=error.message;}runtime.store.set(fillKey,evidence);};
     if(panel?.open){runtime.sidepanelAutoTimers||=new Map();const timer=setTimeout(()=>{runtime.sidepanelAutoTimers.delete(fillKey);fill().catch(error=>{runtime.browserAssistantError=error.message;});},600);runtime.sidepanelAutoTimers.set(fillKey,timer);}else await fill();
    }
   }
  }
  for(const [key,item]of runtime.browserAssistantFrames)if(!live.has(key)){await item.engine.disableAssistant().catch(()=>{});await item.engine.detach();runtime.browserAssistantFrames.delete(key);}runtime.browserAssistantError='';
 }catch(error){runtime.browserAssistantError=error.message;}finally{runtime.browserAssistantScan=false;}
}
