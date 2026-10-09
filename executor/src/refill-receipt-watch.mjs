import {randomUUID} from 'node:crypto';
import {attachEngine} from './engine.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {queue,priorProductSuccess,plain} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {cloudDigest,cacheCloudSnapshot} from './cloud-sync-state.mjs';
import {enqueueApplicationPlan} from './application-mutations.mjs';
import {observedRefillReceiptSatisfied} from '../../core/observed-refill-receipt.mjs';
import {bindManualWatchNavigation,releaseManualWatchBinding,refreshManualWatchFrames,assertManualWatchSource} from './manual-watch-frames.mjs';
import {profiles} from './shared.mjs';
const key=id=>'refillWatch:'+id,now=()=>new Date().toISOString(),normal=value=>String(value||'').replace(/\s+/g,' ').trim();
function current(runtime,watch){if(watch.scope!==workbenchScope(runtime.store.get('pair'))||watch.connection!==cloudDigest(runtime.store.get('pair')))throw Error('原提交监听连接已变化，记录保留待核验');}
async function findPage(runtime,watch){if(runtime.host?.startedAt!==watch.browserInstance)throw Error('原浏览器已变化，保留点击与回执记录');for(const page of runtime.context?.pages()||[]){if(page.isClosed()||!/^https?:/.test(page.url()))continue;if((await getTargetInfo(runtime.context,page))?.targetId===watch.targetId)return page;}throw Error('原提交网页已关闭，保留点击与回执记录');}
export async function armRefillReceiptWatch(runtime,{state,snapshot,page,config,assertCurrent}){
 if(runtime.store.values('refillWatch:').some(watch=>watch.scope===state.scope&&watch.targetId===state.targetId&&watch.browserInstance===state.browserInstance&&['checking','pending_sync'].includes(watch.status)))throw Error('原网页手动提交仍待核验或同步，请先完成原回执核验');
 await assertCurrent();const records=snapshot.documents.submissionRecords||{},recordKey=queue.submissionRecordKey(queue.normalizeDestinationKey(state.destinationUrl),state.profileId),matches=Object.entries(records).filter(([k,r])=>priorProductSuccess({[k]:r},state.profileId,state.destinationUrl)),previous=matches.find(([k])=>k===recordKey)||matches[0];if(!previous)throw Error('原收件记录暂不可读，停止再次填写');
 runtime.refillWatchFrames||=new Map();for(const [id,binding]of runtime.refillWatchFrames)if(binding.targetId===state.targetId){const old=runtime.store.get(key(id));if(old?.status==='watching')runtime.store.set(key(id),{...old,status:'superseded'});await releaseManualWatchBinding(binding);runtime.refillWatchFrames.delete(id);}
 const watch=plain({id:state.id,scope:state.scope,connection:cloudDigest(runtime.store.get('pair')),profileId:state.profileId,profileName:state.profile.name||state.profileId,targetId:state.targetId,browserInstance:state.browserInstance,pageUrl:state.url,destinationUrl:state.destinationUrl,targetDomain:config.targetDomain,previousRecordKey:previous[0],previousRecord:previous[1],expectedRecords:{[previous[0]]:previous[1],[recordKey]:records[recordKey]||null},token:randomUUID(),createdAt:Date.now(),status:'watching',frames:{},checks:0});
 const binding={page,targetId:state.targetId,token:watch.token,engines:[]};runtime.store.set(key(watch.id),watch);runtime.refillWatchFrames.set(watch.id,binding);
 try{await refreshRefillFrames(runtime,watch,binding,assertCurrent);bindManualWatchNavigation(runtime,binding);}catch(error){await releaseManualWatchBinding(binding);runtime.refillWatchFrames.delete(watch.id);const latest=runtime.store.get(key(watch.id));runtime.store.set(key(watch.id),{...latest,...(latest.status==='watching'?{status:'needs_manual'}:{}),error:error.message});throw error;}
 return watch;
}
async function refreshRefillFrames(runtime,watch,binding,assertCurrent){
 const targetDomain=watch.targetDomain||profiles.buildAgentConfigFromProfile(runtime.store.get('singlePageRefill:'+watch.id)?.profile||{}).targetDomain;
 await refreshManualWatchFrames(runtime,binding,{worldName:'ExternalLinkRefillManualWatch',watchMessage:{token:watch.token,targetDomain,destinationUrl:watch.destinationUrl},assertCurrent:async()=>{await assertCurrent();await assertManualWatchSource(runtime,watch,binding.page);await assertCurrent();},onMessage:(message,frame)=>{
  const latest=runtime.store.get(key(watch.id));if(runtime.refillWatchFrames.get(watch.id)!==binding||latest?.token!==watch.token||latest.status!=='watching')return{ok:false};current(runtime,latest);
  if(message.action==='manualSubmissionWatchReady'){runtime.store.set(key(watch.id),{...latest,frames:{...latest.frames,[message.documentId+'::'+message.frameUrl]:{url:message.frameUrl,main:frame===binding.page.mainFrame(),baseline:normal(message.baseline?.evidence)}}});return{ok:true};}
  return observeRefillClick(runtime,{...message,watchId:watch.id});
 }});
}
export function observeRefillClick(runtime,input){
 const watch=runtime.store.get(key(input.watchId));if(!watch||watch.status!=='watching'||watch.token!==input.token||Date.now()-watch.createdAt>7200000||runtime.host?.startedAt!==watch.browserInstance)return{ok:false};
 current(runtime,watch);const frame=watch.frames[input.documentId+'::'+input.frameUrl];if(!frame)return{ok:false};
 // Save the trusted isolated-world click before any network request or navigation.
 runtime.store.set(key(watch.id),{...watch,status:'checking',clickedAt:now(),frame,actualSubmission:input.actualSubmission||null,checks:0});return{ok:true};
}
async function persistReceipt(runtime,watch){
 current(runtime,watch);
 if(!watch.planId){const snapshot=await runtime.cloud.request('snapshot');current(runtime,watch);cacheCloudSnapshot(runtime,snapshot);}
 const result=await enqueueApplicationPlan(runtime,{planId:watch.planId,operations:[watch.operation]},planId=>{watch.planId=planId;runtime.store.set(key(watch.id),watch);});current(runtime,watch);
 const plan=runtime.store.get('applicationPlan:'+result.planId),item=plan?.items?.[0],mutation=item&&runtime.store.get('appMutation:'+item.id);if(!item||mutation?.status==='discarded')throw Error('原回执保存操作已被移除，保留证据人工核验');
 watch.operation=item.operation;runtime.store.set(key(watch.id),watch);
 const snapshot=await runtime.cloud.request('snapshot');current(runtime,watch);if(!observedRefillReceiptSatisfied(snapshot.documents,item.operation))throw Error(result.error||'新回执和历史动态尚未一起回读');
 watch.status='confirmed';watch.confirmedAt=now();watch.error='';watch.cloudVerified=true;runtime.store.set(key(watch.id),watch);
}
export async function checkRefillReceiptWatches(runtime){
 if(runtime.refillReceiptBusy)return;runtime.refillReceiptBusy=true;
 try{
  for(const [id,binding]of runtime.refillWatchFrames||[]){const watch=runtime.store.get(key(id));if(binding.page.isClosed()||watch?.status!=='watching'||watch.token!==binding.token){await releaseManualWatchBinding(binding);runtime.refillWatchFrames.delete(id);}}
  for(const watch of runtime.store.values('refillWatch:').filter(w=>w.scope===workbenchScope(runtime.store.get('pair'))&&w.status==='watching')){
   if(Date.now()-watch.createdAt>7200000)continue;
   try{current(runtime,watch);const page=await findPage(runtime,watch);if(new URL(page.url()).origin!==new URL(watch.pageUrl).origin)throw Error('原网页已离开监听站点');runtime.refillWatchFrames||=new Map();let binding=runtime.refillWatchFrames.get(watch.id);if(!binding){binding={page,targetId:watch.targetId,token:watch.token,engines:[]};runtime.refillWatchFrames.set(watch.id,binding);bindManualWatchNavigation(runtime,binding);}await refreshRefillFrames(runtime,watch,binding,async()=>{const latest=runtime.store.get(key(watch.id));current(runtime,latest);if(latest.status!=='watching'||latest.token!==watch.token||page.isClosed()||new URL(page.url()).origin!==new URL(watch.pageUrl).origin)throw Error('原监听文档或点击状态已变化');});}catch(error){const latest=runtime.store.get(key(watch.id));runtime.store.set(key(watch.id),{...latest,error:error.message});}
  }
  for(const initial of runtime.store.values('refillWatch:').filter(w=>w.scope===workbenchScope(runtime.store.get('pair'))&&['checking','pending_sync'].includes(w.status))){
   let watch=initial;
   try{
    current(runtime,watch);
    if(!watch.operation){
     const page=await findPage(runtime,watch);current(runtime,watch);const currentUrl=new URL(page.url()),host=currentUrl.hostname.replace(/^www\./,'');if(currentUrl.origin!==new URL(watch.pageUrl).origin&&host!=='typeform.com'&&!host.endsWith('.typeform.com')&&host!=='formsubmit.co')throw Error('原网页已离开提交站点');
     const frame=watch.frame.main?page.mainFrame():page.frames().find(frame=>frame.url()===watch.frame.url);if(!frame)throw Error('原提交区域已关闭');let engine;
     try{engine=await attachEngine(runtime.context,frame);const receipt=await engine.call({action:'classifySubmitEvidence',destinationUrl:watch.destinationUrl});current(runtime,watch);watch.checks++;
      if(receipt.matched&&normal(receipt.evidence)&&normal(receipt.evidence)!==watch.frame.baseline){const evidenceUrl=receipt.evidenceUrl||(watch.frame.main?page.url():watch.frame.url);watch={...watch,status:'pending_sync',operation:{type:'observed_refill_receipt',destinationUrl:watch.destinationUrl,profileId:watch.profileId,profileName:watch.profileName,previousRecordKey:watch.previousRecordKey,previousRecord:watch.previousRecord,expectedRecords:watch.expectedRecords,observation:{token:watch.token,refillId:watch.id,actionObserved:true,clickedAt:watch.clickedAt,observedAt:now(),pageUrl:watch.pageUrl,currentPageUrl:page.url(),frameUrl:watch.frame.url,baseline:watch.frame.baseline,evidenceUrl},receipt}};runtime.store.set(key(watch.id),watch);}
     }finally{await engine?.detach();}
    }
    if(watch.operation)await persistReceipt(runtime,watch);
   }catch(error){watch.error=error.message;}
   if(!watch.operation&&(watch.checks>=12||Date.now()-Date.parse(watch.clickedAt)>60000)){watch.status='needs_manual';watch.error=watch.error||'未读取到新的提交回执，请用登记动态补记';}
   runtime.store.set(key(watch.id),watch);
  }
 }finally{runtime.refillReceiptBusy=false;}
}
export function refillReceiptState(runtime,panel){
 const watches=runtime.store.values('refillWatch:').filter(w=>w.scope===panel.scope&&w.targetId===panel.selectedTargetId&&w.profileId===panel.profileId&&w.browserInstance===runtime.host?.startedAt).sort((a,b)=>b.createdAt-a.createdAt),watch=watches[0];
 if(!watch||watch.status==='superseded')return null;
 const messages={watching:'只填写已准备；将核验你在原网页手动提交后的新回执。',checking:'已观察到手动提交，正在核验新回执。',pending_sync:'新回执已保存在本机，等待云端回读。',confirmed:'手动提交的新回执和历史动态已保存；原网页保留。',needs_manual:'未确认新的提交回执，请检查原网页或登记动态。'};
 return{id:watch.id,status:watch.status,message:messages[watch.status]||'',error:watch.error||'',cloudVerified:watch.cloudVerified===true};
}
