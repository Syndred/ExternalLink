import {completeSinglePageReceiptQueue} from './single-page-receipt-queue.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {attachEngine} from './engine.mjs';
import {profiles,plain,priorProductSuccess,queue} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {externalFormDestination} from './external-form-source.mjs';
const key=id=>'manualWatch:'+id;
export async function armPreparedManualWatch(runtime,task,page){
 const input={taskId:task.id,targetId:task.targetId,pageUrl:page.url()},issued=await manualWatchMessage(runtime,{...input,action:'manualSubmissionWatchRequest'});
 if(!issued.ok)throw Error(issued.error||'原任务提交监听未就绪');
 runtime.manualWatchFrames||=new Map();const old=runtime.manualWatchFrames.get(task.id);if(old)for(const engine of old.engines)await engine.detach();
 const binding={page,token:issued.watch.token,engines:[]};runtime.manualWatchFrames.set(task.id,binding);
 try{for(const frame of page.frames()){
  if(!/^https?:\/\//.test(frame.url()))continue;const frameUrl=frame.url(),engine=await attachEngine(runtime.context,frame,async message=>{
   if(!['manualSubmissionWatchReady','manualSubmissionClicked'].includes(message.action)||message.frameUrl!==frameUrl||runtime.manualWatchFrames.get(task.id)!==binding)return{ok:false};
   const bound={...message,...input,pageUrl:page.url(),frameUrl,documentId:message.executorDocumentId};
   return message.action==='manualSubmissionClicked'&&runtime.dispatchControl?runtime.dispatchControl('manualWatchMessage',bound):manualWatchMessage(runtime,bound);
  },{worldName:'ExternalLinkManualSubmissionWatch',manualWatch:true});binding.engines.push(engine);const ready=await engine.call({action:'watchManualSubmission',...issued.watch});if(!ready?.ok||!(await manualWatchMessage(runtime,{...input,action:'manualSubmissionWatchReady',token:issued.watch.token,frameUrl,documentId:engine.documentId,baseline:ready.baseline})).ok)throw Error('原网页提交监听尚未确认就绪，停止填写');
 }}catch(error){for(const engine of binding.engines)await engine.detach();if(runtime.manualWatchFrames.get(task.id)===binding)runtime.manualWatchFrames.delete(task.id);throw error;}
}
export async function manualWatchMessage(runtime,input){
 const task=runtime.store.get('task:'+input.taskId);
 if(!task||runtime.job||runtime.store.get('paused')!==true||task.controller==='supervisor'||task.controller==='ai'||task.receipt) return{ok:false};
 const page=await runtime.findPage(task);if(task.targetId!==input.targetId||input.action!=='manualSubmissionClicked'&&page.url()!==input.pageUrl||!isDeepStrictEqual(runtime.store.get('task:'+task.id),task))return{ok:false};
 let watch=runtime.store.get(key(task.id));
 if(input.action==='manualSubmissionWatchRequest'){
  if(task.attemptBoundary||!task.preparedAt&&!task.manualPreparationStartedAt)return{ok:false};
  const scope=workbenchScope(runtime.store.get('pair')),expected=structuredClone(task);
  const assertCurrent=()=>{if(runtime.job||runtime.store.get('paused')!==true||scope!==workbenchScope(runtime.store.get('pair'))||!isDeepStrictEqual(runtime.store.get('task:'+task.id),expected)||page.url()!==input.pageUrl)throw Error('提交监听的原任务、网页或工作区已变化');};
  const source=await externalFormDestination(runtime,page);if(source?queue.normalizeDestinationKey(source.destinationUrl)!==queue.normalizeDestinationKey(task.url):queue.extractDomain(page.url())!==queue.extractDomain(task.url))return{ok:false,error:'网页来源与原任务不一致，请重新选择来源目录'};
  const destinationUrl=source?.destinationUrl||task.url;
  assertCurrent();
  if(!watch||watch.status!=='watching'||watch.scope!==scope||watch.targetId!==task.targetId||watch.browserInstance!==task.browserInstance||watch.pageUrl!==input.pageUrl||watch.destinationUrl!==destinationUrl||Date.now()-watch.createdAt>2*60*60*1000){
   const snapshot=await runtime.cloud.request('snapshot');if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))return{ok:false};
   assertCurrent();
   await runtime.lease(task,{online:true});const profile=task.profileSnapshot||snapshot.documents.siteProfiles?.[task.profileId],config=plain(profiles.buildAgentConfigFromProfile(profile));
   // Lease may update the version; retain its result but reject changed source
   // identity and ownership before installing the listener.
   const latest=runtime.store.get('task:'+task.id);if(scope!==workbenchScope(runtime.store.get('pair'))||page.url()!==input.pageUrl||runtime.store.get('paused')!==true||runtime.job||latest?.targetId!==task.targetId||latest?.browserInstance!==task.browserInstance||latest?.profileId!==task.profileId||latest?.url!==task.url||latest?.attemptBoundary||latest?.receipt)throw Error('提交监听的原任务或网页已变化');
   if(!isDeepStrictEqual(await externalFormDestination(runtime,page),source))throw Error('外部表单来源已变化，停止监听');
   if(scope!==workbenchScope(runtime.store.get('pair'))||!isDeepStrictEqual(runtime.store.get('task:'+task.id),task)||page.url()!==input.pageUrl||runtime.store.get('paused')!==true||runtime.job)throw Error('提交监听的原任务或工作区已变化');
   watch={id:randomUUID(),scope,taskId:task.id,targetId:task.targetId,browserInstance:task.browserInstance,token:randomUUID(),createdAt:Date.now(),status:'watching',pageUrl:input.pageUrl,targetDomain:config.targetDomain,destinationUrl,sourceContext:source,frames:{}};
   runtime.store.set(key(task.id),watch);
  }
  return{ok:true,watch:{token:watch.token,targetDomain:watch.targetDomain,destinationUrl:watch.destinationUrl}};
 }
 if(!watch||watch.scope!==workbenchScope(runtime.store.get('pair'))||watch.status!=='watching'||watch.token!==input.token||Date.now()-watch.createdAt>2*60*60*1000||watch.targetId!==task.targetId||watch.browserInstance!==task.browserInstance||task.attemptBoundary)return{ok:false};
 const frameKey=String(input.documentId)+'::'+input.frameUrl,frame=page.frames().find(f=>f.url()===input.frameUrl);if(!frame&&input.action!=='manualSubmissionClicked')return{ok:false};
 if(input.action==='manualSubmissionWatchReady'){
  watch.frames[frameKey]={url:input.frameUrl,main:frame===page.mainFrame(),baseline:input.baseline?.evidence||''};runtime.store.set(key(task.id),watch);return{ok:true};
 }
 const baseline=watch.frames[frameKey];if(input.action!=='manualSubmissionClicked'||!baseline||baseline.url!==input.frameUrl)return{ok:false};
 // The original isolated engine only emits this after a trusted final-submit
 // event whose product URL matches the watched profile. Persist uncertainty
 // before trying the network; a lost reply must never cause another post.
 const at=new Date().toISOString();watch.status='checking';watch.clickedAt=at;watch.frame=baseline;watch.checks=0;runtime.store.set(key(task.id),watch);
 runtime.update(task,{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:at,baselineEvidence:baseline.baseline,...(Array.isArray(input.actualSubmission?.fields)?{actualSubmission:input.actualSubmission}:{}),manualSubmission:{watchId:watch.id,frameUrl:input.frameUrl,targetId:task.targetId,at},reason:'已观察到人工提交，正在核验新回执'},'manual_attempt_boundary');
 await runtime.lease(task,{online:true}).then(()=>runtime.cloud.flush(runtime.store)).catch(error=>{watch.syncError=error.message;runtime.store.set(key(task.id),watch);});return{ok:true};
}
export async function checkManualWatches(runtime){
 for(const[id,binding]of runtime.manualWatchFrames||[]){const watch=runtime.store.get(key(id));if(binding.page.isClosed()||watch?.token!==binding.token||watch?.status!=='watching'){for(const engine of binding.engines)await engine.detach();runtime.manualWatchFrames.delete(id);}}
 if(runtime.job||runtime.store.get('paused')!==true)return;
 const scope=workbenchScope(runtime.store.get('pair'));
 for(const watch of runtime.store.values('manualWatch:').filter(w=>w.scope===scope&&w.status==='checking')){
  const task=runtime.store.get('task:'+watch.taskId);if(!task){watch.status='needs_manual';runtime.store.set(key(watch.taskId),watch);continue;}
  runtime.manualWatchJob=true;
  try{
   if(task.receipt){await runtime.synchronize();if(runtime.store.get('task:'+task.id)?.cloudVerified!==true)throw Error('原回执已存本机，等待云端独立回读');watch.status='confirmed';watch.confirmedAt=new Date().toISOString();}
   else{
   const page=await runtime.findPage(task);
   const current=new URL(page.url()),host=current.hostname.replace(/^www\./,'').toLowerCase();if(current.origin!==new URL(watch.pageUrl).origin&&host!=='typeform.com'&&!host.endsWith('.typeform.com')&&host!=='formsubmit.co')throw Error('原页已离开监听站点，请人工核验');
   const frame=watch.frame.main?page.mainFrame():page.frames().find(f=>f.url()===watch.frame.url);if(!frame)throw Error('原提交区域已关闭，请人工核验');
   let engine;try{engine=await attachEngine(runtime.context,frame);const evidence=await engine.call({action:'classifySubmitEvidence',destinationUrl:watch.destinationUrl}),normalized=s=>String(s||'').replace(/\s+/g,' ').trim();
    if(evidence.matched&&normalized(evidence.evidence)&&normalized(evidence.evidence)!==normalized(watch.frame.baseline)){
     await runtime.lease(task,{online:true});await runtime.accept(task,page,evidence);await runtime.synchronize();if(runtime.store.get('task:'+task.id)?.cloudVerified!==true)throw Error('原回执已存本机，等待云端独立回读');watch.status='confirmed';watch.confirmedAt=new Date().toISOString();
    }
   }finally{await engine?.detach();}
   }
  }catch(error){watch.error=error.message;}
  finally{runtime.manualWatchJob=false;}
  watch.checks++;if(watch.status==='checking'&&!runtime.store.get('task:'+watch.taskId)?.receipt&&(watch.checks>=12||Date.now()-Date.parse(watch.clickedAt)>60000))watch.status='needs_manual';
  runtime.store.set(key(watch.taskId),watch);
 }
 await completeSinglePageReceiptQueue(runtime);
}
