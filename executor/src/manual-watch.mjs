import {randomUUID} from 'node:crypto';
import {attachEngine} from './engine.mjs';
import {profiles,plain,priorProductSuccess} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
const key=id=>'manualWatch:'+id;
export async function manualWatchMessage(runtime,input){
 const task=runtime.store.get('task:'+input.taskId);
 if(!task||runtime.job||runtime.store.get('paused')!==true||task.controller==='supervisor'||task.controller==='ai'||task.receipt) return{ok:false};
 const page=await runtime.findPage(task);if(task.targetId!==input.targetId||page.url()!==input.pageUrl)return{ok:false};
 let watch=runtime.store.get(key(task.id));
 if(input.action==='manualSubmissionWatchRequest'){
  if(task.attemptBoundary||!task.preparedAt)return{ok:false};
  if(!watch||watch.status!=='watching'||Date.now()-watch.createdAt>2*60*60*1000){
   const snapshot=await runtime.cloud.request('snapshot');if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))return{ok:false};
   await runtime.lease(task,{online:true});const profile=task.profileSnapshot||snapshot.documents.siteProfiles?.[task.profileId],config=plain(profiles.buildAgentConfigFromProfile(profile));
   watch={id:randomUUID(),scope:workbenchScope(runtime.store.get('pair')),taskId:task.id,targetId:task.targetId,browserInstance:task.browserInstance,token:randomUUID(),createdAt:Date.now(),status:'watching',pageUrl:input.pageUrl,targetDomain:config.website||profile?.fields?.Url,destinationUrl:task.url,frames:{}};
   runtime.store.set(key(task.id),watch);
  }
  return{ok:true,watch:{token:watch.token,targetDomain:watch.targetDomain,destinationUrl:watch.destinationUrl}};
 }
 if(!watch||watch.status!=='watching'||watch.token!==input.token||Date.now()-watch.createdAt>2*60*60*1000||watch.targetId!==task.targetId||watch.browserInstance!==task.browserInstance||task.attemptBoundary)return{ok:false};
 const frameKey=String(input.documentId)+'::'+input.frameUrl,frame=page.frames().find(f=>f.url()===input.frameUrl);if(!frame&&input.action!=='manualSubmissionClicked')return{ok:false};
 if(input.action==='manualSubmissionWatchReady'){
  watch.frames[frameKey]={url:input.frameUrl,main:frame===page.mainFrame(),baseline:input.baseline?.evidence||''};runtime.store.set(key(task.id),watch);return{ok:true};
 }
 const baseline=watch.frames[frameKey];if(input.action!=='manualSubmissionClicked'||!baseline||baseline.url!==input.frameUrl)return{ok:false};
 // The original isolated engine only emits this after a trusted final-submit
 // event whose product URL matches the watched profile. Persist uncertainty
 // before trying the network; a lost reply must never cause another post.
 const at=new Date().toISOString();watch.status='checking';watch.clickedAt=at;watch.frame=baseline;watch.checks=0;runtime.store.set(key(task.id),watch);
 runtime.update(task,{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:at,baselineEvidence:baseline.baseline,manualSubmission:{watchId:watch.id,frameUrl:input.frameUrl,targetId:task.targetId,at},reason:'已观察到人工提交，正在核验新回执'},'manual_attempt_boundary');
 await runtime.lease(task,{online:true}).then(()=>runtime.cloud.flush(runtime.store)).catch(error=>{watch.syncError=error.message;runtime.store.set(key(task.id),watch);});return{ok:true};
}
export async function checkManualWatches(runtime){
 if(runtime.job||runtime.store.get('paused')!==true)return;
 const scope=workbenchScope(runtime.store.get('pair'));
 for(const watch of runtime.store.values('manualWatch:').filter(w=>w.scope===scope&&w.status==='checking')){
  const task=runtime.store.get('task:'+watch.taskId);if(!task||task.receipt){watch.status=task?.receipt?'confirmed':'needs_manual';runtime.store.set(key(watch.taskId),watch);continue;}
  runtime.manualWatchJob=true;
  try{
   const page=await runtime.findPage(task);
   if(new URL(page.url()).origin!==new URL(watch.pageUrl).origin)throw Error('原页已离开监听站点，请人工核验');
   const frame=watch.frame.main?page.mainFrame():page.frames().find(f=>f.url()===watch.frame.url);if(!frame)throw Error('原提交区域已关闭，请人工核验');
   let engine;try{engine=await attachEngine(runtime.context,frame);const evidence=await engine.call({action:'classifySubmitEvidence',destinationUrl:task.url}),normalized=s=>String(s||'').replace(/\s+/g,' ').trim();
    if(evidence.matched&&normalized(evidence.evidence)&&normalized(evidence.evidence)!==normalized(watch.frame.baseline)){
     await runtime.lease(task,{online:true});await runtime.accept(task,page,evidence);await runtime.synchronize();watch.status='confirmed';watch.confirmedAt=new Date().toISOString();
    }
   }finally{await engine?.detach();}
  }catch(error){watch.error=error.message;}
  finally{runtime.manualWatchJob=false;}
  watch.checks++;if(watch.status==='checking'&&(watch.checks>=12||Date.now()-Date.parse(watch.clickedAt)>60000))watch.status='needs_manual';
  runtime.store.set(key(watch.taskId),watch);
 }
}
