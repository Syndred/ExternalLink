import {getTargetInfo} from './browser-target.mjs';
import {applicationData} from './application-data.mjs';
import {enqueueApplicationPlan,flushApplicationMutations,pendingApplication} from './application-mutations.mjs';
import {queue} from './shared.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
export async function browserLibraryPages(runtime){if(!runtime.context)await runtime.connect();const pages=[];for(const page of runtime.context.pages()){if(!/^https?:\/\//.test(page.url())||/^http:\/\/127\.0\.0\.1:19389(?:\/|$)/.test(page.url()))continue;const info=await getTargetInfo(runtime.context,page);if(info)pages.push({targetId:info.targetId,url:page.url(),title:await page.title().catch(()=>page.url())});}return{ok:true,pages};}
export async function addBrowserPage(runtime,input){
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停并等待投稿动作结束');
 const listing=await browserLibraryPages(runtime),selected=listing.pages.find(p=>p.targetId===input.targetId);if(!selected||selected.url!==input.expectedUrl)throw Error('所选页面已关闭或已跳转，请刷新页面列表');
 await flushApplicationMutations(runtime);await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('请先处理已有待同步资料');
 const documents=runtime.store.get('applicationSnapshot').snapshot.documents,key=canonicalLibraryDestination(selected.url),annotation=queue.findDestinationAnnotation(documents.siteAnnotations||{},key,new URL(selected.url).hostname.replace(/^www\./,''))||{},statuses=queue.normalizeAnnotationStatuses(annotation);
 const operations=[{type:'pin',url:selected.url},{type:'preferences',url:selected.url,preferences:{pinned:true,enabled:true}},...(statuses.includes('deleted')?[{type:'mark',url:selected.url,statuses:statuses.filter(s=>s&&s!=='deleted')}]:[]),{type:'clear_deleted',url:selected.url}];
 return enqueueApplicationPlan(runtime,{operations});
}
