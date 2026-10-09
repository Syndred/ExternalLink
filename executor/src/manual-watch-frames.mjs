import {attachEngine} from './engine.mjs';
import {externalFormDestination,isStandaloneExternalFormUrl} from './external-form-source.mjs';
import {queue} from './shared.mjs';

export async function assertManualWatchSource(runtime,watch,page){
 if(!watch.sourceContext&&!isStandaloneExternalFormUrl(watch.pageUrl))return;
 const source=await externalFormDestination(runtime,page);
 if(!source||page.url()!==watch.pageUrl||queue.normalizeDestinationKey(source.destinationUrl)!==queue.normalizeDestinationKey(watch.destinationUrl))throw Error('外部表单来源已变化，停止监听');
}

// The extension is injected into each new document, which asks for its tab's
// existing watch. Native isolated worlds need the same document lifecycle.
export function bindManualWatchNavigation(runtime,binding){
 if(binding.navigationHandler)return;
 binding.navigationHandler=frame=>{
  if(binding.released)return;
  Promise.resolve(frame.waitForLoadState('domcontentloaded',{timeout:10000})).catch(()=>{}).then(()=>{
   if(!binding.released&&runtime.dispatchControl)return runtime.dispatchControl('checkManualWatches',{});
  }).catch(()=>{});
 };
 binding.page.on('framenavigated',binding.navigationHandler);
}
export async function releaseManualWatchBinding(binding){
 binding.released=true;
 if(binding.navigationHandler)binding.page.off('framenavigated',binding.navigationHandler);
 for(const engine of binding.engines)await engine.detach();
 binding.engines=[];binding.documents?.clear();
}
export async function refreshManualWatchFrames(runtime,binding,{worldName,watchMessage,onMessage,assertCurrent}){
 binding.documents||=new Map();
 const active=binding.page.frames().filter(frame=>/^https?:\/\//.test(frame.url()));
 for(const [frame,item]of binding.documents){
  if(active.includes(frame)&&frame.url()===item.url&&await item.engine.isCurrentDocument())continue;
  await item.engine.detach();binding.documents.delete(frame);binding.engines=binding.engines.filter(engine=>engine!==item.engine);
 }
 for(const frame of active){
  if(binding.documents.has(frame))continue;
  await frame.waitForLoadState('domcontentloaded',{timeout:10000});await assertCurrent();const frameUrl=frame.url();let engine;
  try{
   engine=await attachEngine(runtime.context,frame,message=>{
    if(binding.released||message.frameUrl!==frameUrl||!['manualSubmissionWatchReady','manualSubmissionClicked'].includes(message.action))return{ok:false};
    return onMessage({...message,frameUrl,documentId:message.executorDocumentId},frame);
   },{worldName,manualWatch:true});
   binding.engines.push(engine);binding.documents.set(frame,{engine,url:frameUrl});
   const ready=await engine.call({action:'watchManualSubmission',...watchMessage});await assertCurrent();
   if(!ready?.ok||!(await onMessage({action:'manualSubmissionWatchReady',token:watchMessage.token,frameUrl,documentId:engine.documentId,baseline:ready.baseline},frame))?.ok)throw Error('原网页手动提交监听未就绪');
  }catch(error){if(engine){await engine.detach();binding.engines=binding.engines.filter(value=>value!==engine);binding.documents.delete(frame);}throw error;}
 }
}
