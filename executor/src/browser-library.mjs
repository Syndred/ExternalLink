import {attachEngine} from './engine.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {applicationData} from './application-data.mjs';
import {enqueueApplicationPlan,flushApplicationMutations,pendingApplication} from './application-mutations.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
export async function browserLibraryPages(runtime){if(!runtime.context)await runtime.connect();const pages=[];for(const page of runtime.context.pages()){if(!/^https?:\/\//.test(page.url())||/^http:\/\/127\.0\.0\.1:19389(?:\/|$)/.test(page.url()))continue;const info=await getTargetInfo(runtime.context,page);if(info)pages.push({targetId:info.targetId,url:page.url(),title:await page.title().catch(()=>page.url())});}return{ok:true,pages};}
export async function addBrowserPage(runtime,input){
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停并等待投稿动作结束');
 const scope=workbenchScope(runtime.store.get('pair'));
 const listing=await browserLibraryPages(runtime),selected=listing.pages.find(p=>p.targetId===input.targetId);if(!selected||selected.url!==input.expectedUrl)throw Error('所选页面已关闭或已跳转，请刷新页面列表');
 await flushApplicationMutations(runtime);await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('请先处理已有待同步资料');
 const documents=runtime.store.get('applicationSnapshot').snapshot.documents,key=canonicalLibraryDestination(selected.url);
 const existing=String(documents.urlList||'').split('\n').some(line=>{try{return canonicalLibraryDestination(line.split('|')[0].trim())===key;}catch{return false;}});
 let page,platformType='directory';
 if(!existing){
  for(const candidate of runtime.context.pages()){if((await getTargetInfo(runtime.context,candidate))?.targetId===selected.targetId){page=candidate;break;}}
  if(!page||page.isClosed()||page.url()!==selected.url)throw Error('所选页面已关闭或已跳转，请刷新页面列表');
  const detections=await Promise.allSettled(page.frames().filter(frame=>/^https?:\/\//.test(frame.url())).slice(0,24).map(async(frame,index)=>{
   let engine;try{engine=await attachEngine(runtime.context,frame,undefined,{worldName:'ExternalLinkLibraryDetection'});const result=await engine.call({action:'detectPage'});return{...result,index};}finally{await engine?.detach();}
  }));
  const detected=detections.filter(result=>result.status==='fulfilled'&&result.value&&!result.value.error).map(result=>result.value).sort((a,b)=>Number(b.operable===true)-Number(a.operable===true)||Number(b.formFieldCount||0)-Number(a.formFieldCount||0)||a.index-b.index)[0];
  if(!detected)throw Error('页面类型暂不可读，请刷新当前网页后重试');
  platformType=detected.platform||'directory';
  if(page.isClosed()||page.url()!==selected.url)throw Error('所选页面已关闭或已跳转，请刷新页面列表');
 }
 if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('云端连接已变化，请重新选择网页');
 const result=await enqueueApplicationPlan(runtime,{operations:[{type:'add_browser_url',url:selected.url,platformType}]});
 return{...result,url:selected.url,added:!existing,prepended:!existing};
}
