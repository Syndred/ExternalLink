import {originalNavigationQueue} from '../../core/submission-queue.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
import {scheduler,queue} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {enqueueApplicationPlan,flushApplicationMutations,pendingApplication,overlayApplication} from './application-mutations.mjs';
import {applicationData} from './application-data.mjs';
import {browsingSnapshot} from './browsing-snapshot.mjs';

function navigationGroupSummary(group){
 return{id:group.id,key:group.key,destinationKey:group.destinationKey,url:group.url,domain:group.domain,platformType:group.platformType,source:group.source,note:group.note,quality:group.quality||null,status:group.status,index:group.index,profileIds:group.jobs.map(job=>job.profileId),profileTotal:group.jobs.length,profiles:group.jobs.map(job=>({profileId:job.profileId,profileName:job.profileName,status:job.status||'pending'})),jobs:group.jobs.map(({config,...job})=>({...job,url:job.destinationUrl||group.url}))};
}

export async function submissionQueue(runtime,input={},advance=false){
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get('submissionQueue'),previous=saved?.scope===scope?saved:null;
 const options={selectedSiteIds:input.selectedSiteIds??previous?.selectedSiteIds,category:input.category??previous?.category??'',group:input.group??previous?.group??''};
 const {snapshot:raw,...browse}=await browsingSnapshot(runtime),snapshot=overlayApplication(runtime,raw);if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已变化，请重新查看队列');const result=originalNavigationQueue(snapshot,options),groups=result.groups;
 let index=Number.isInteger(previous?.index)?previous.index:0,key=input.currentKey||previous?.key||'';
 const matchKey=value=>groups.findIndex(group=>group.key===value),matchAlias=value=>{const exact=matchKey(value),normalized=matchKey(queue.normalizeDestinationKey(value));return exact>=0?exact:normalized>=0?normalized:groups.findIndex(group=>canonicalLibraryDestination(group.key)===canonicalLibraryDestination(value));};
 if(input.url){const matched=queue.findSubmissionIndex(input.url,groups);if(matched>=0){index=matched;key=groups[matched].key;}}
 if(matchKey(key)<0){const alias=matchAlias(key);if(alias>=0)key=groups[alias].key;}
 if(advance){const delta=input.delta??1;if(!Number.isInteger(delta)||Math.abs(delta)>1)throw Error('队列切换仅允许上一站或下一站');index=scheduler.resolveCursorIndex(groups,key,index,delta);}else{const matched=matchKey(key);if(matched>=0)index=matched;if(index<0||index>=groups.length)index=0;}
 const task=groups[index]||null,cursor={scope,index,key:task?.key||'',selectedSiteIds:result.selectedProfileIds,category:options.category,group:options.group,at:new Date().toISOString()};
 runtime.store.set('submissionQueue',cursor);
 let page=previous?.page;
 if(task&&input.open===true){
  if(runtime.job||runtime.store.get('paused')!==true||runtime.browserAssistantScan)throw Error('请先暂停并等待当前网页操作结束');
  if(!runtime.context)await runtime.connect();let selected;
  if(page?.browserInstance===runtime.host?.startedAt&&!runtime.store.values('task:').some(t=>t.targetId===page.targetId&&!t.tabClosedAt)){
   for(const candidate of runtime.context.pages()){const info=await getTargetInfo(runtime.context,candidate);if(info?.targetId===page.targetId){selected=candidate;break;}}
  }
  selected||=await runtime.context.newPage();const info=await getTargetInfo(runtime.context,selected);if(!info)throw Error('网页编号暂不可读，请保留原页核对');
  page={targetId:info.targetId,browserInstance:runtime.host.startedAt,url:task.url};runtime.store.set('submissionQueue',{...cursor,page,opening:true});
  try{await selected.goto(task.url,{waitUntil:'domcontentloaded',timeout:30000});runtime.store.set('submissionQueue',{...cursor,page,opening:false});}catch(error){runtime.store.set('submissionQueue',{...cursor,page,opening:false,error:error.message});throw error;}
 }else if(page)runtime.store.set('submissionQueue',{...cursor,page});
 // The original getter returns summaries. Keep the legacy advance response
 // available, while the native UI explicitly requests compact navigation.
 const compact=!advance||input.compact===true,displayGroups=compact?groups.map(navigationGroupSummary):groups;
 return{ok:true,...browse,tasks:displayGroups,jobs:compact?displayGroups.flatMap(group=>group.jobs):result.tasks,task,index,total:groups.length,meta:result.meta,selectedProfileIds:result.selectedProfileIds,advanced:advance&&!!task,page};
}
export async function removeFromSubmissionQueue(runtime,input){
 if(input.planId)return enqueueApplicationPlan(runtime,{planId:input.planId});
 await flushApplicationMutations(runtime);if(pendingApplication(runtime).length)throw Error('请先处理已有资料待同步或冲突');const fresh=await applicationData(runtime,{refresh:true});if(fresh.error)throw Error(fresh.error);
 return enqueueApplicationPlan(runtime,{operations:[{type:'remove_queue',url:input.url,note:input.note||''},{type:'set_deleted',url:input.url}]});
}
