import {randomUUID} from 'node:crypto';
import {applicationModel} from '../../core/application-model.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {createBackgroundTarget} from './browser-target.mjs';
import {overlayApplication} from './application-mutations.mjs';
import {browsingSnapshot} from './browsing-snapshot.mjs';
export const quickOpenSummary=job=>({id:job.id,scope:job.scope,at:job.at,status:job.status,cursor:job.cursor,count:job.items.length,items:job.items,removeOpened:job.removeOpened,history:job.history||[],error:job.error,browseSource:job.browseSource,browseSavedAt:job.browseSavedAt,browseMessage:job.browseMessage});
export async function quickOpenLibrary(runtime,input={}){
 if(runtime.quickOpenJob||runtime.quickOpenStarting)throw Error('正在打开上一批网站');
 if(!input.jobId&&(!Array.isArray(input.urls)||input.urls.length>5000))throw Error('请选择最多 5000 个外链入口');
 runtime.quickOpenStarting=true;try{
 if(runtime.job||runtime.store.get('paused')!==true)throw Error('请先暂停投稿，等当前动作结束');
 if(input.jobId){const prior=runtime.store.get('quickOpenJob:'+input.jobId);if(!prior||prior.scope!==workbenchScope(runtime.store.get('pair'))||prior.status!=='paused')throw Error('原打开任务不存在或无法继续');if(prior.items.slice(prior.cursor).some(i=>i.status!=='queued'))throw Error('原打开结果不确定，请先核对已打开页签');prior.history=[...(prior.history||[]),...(prior.error?[{at:new Date().toISOString(),cursor:prior.cursor,error:prior.error,phase:'resume_previous_error'}]:[])];prior.status='running';prior.error='';runtime.store.set('quickOpenJob:'+prior.id,prior);runtime.quickOpenJob=run(runtime,prior).finally(()=>runtime.quickOpenJob=null);return{ok:true,job:quickOpenSummary(prior)};}
 const scope=workbenchScope(runtime.store.get('pair')),{snapshot:raw,...browse}=await browsingSnapshot(runtime),snapshot=overlayApplication(runtime,raw);if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已变化，请重新选择网址');const allowed=new Map(applicationModel(snapshot).library.map(r=>[canonicalLibraryDestination(r.url),r.url])),seen=new Set(),items=[],limit=Math.min(20,Math.max(1,Number(input.batchSize)||5));
 for(const raw of input.urls||[]){let u;try{u=new URL(raw);}catch{continue;}if(!/^https?:$/.test(u.protocol)||u.username||u.password)continue;const key=canonicalLibraryDestination(u.href);if(!allowed.has(key)||seen.has(key))continue;seen.add(key);items.push({url:allowed.get(key),status:'queued'});if(items.length>=limit)break;}
 if(!items.length)throw Error('没有可打开的有效外链');
 const job={id:randomUUID(),scope,at:new Date().toISOString(),...browse,items,removeOpened:input.removeOpened!==false,cursor:0,status:'running',intervalMs:Math.min(5000,Math.max(100,Number(input.intervalMs)||800))};runtime.store.set('quickOpenJob:'+job.id,job);runtime.quickOpenJob=run(runtime,job).finally(()=>runtime.quickOpenJob=null);return{ok:true,job:quickOpenSummary(job)};
 }finally{runtime.quickOpenStarting=false;}
}
async function run(runtime,job){try{
 if(!runtime.context)await runtime.connect();
 for(;job.cursor<job.items.length;job.cursor++){
  const item=job.items[job.cursor];item.status='opening';runtime.store.set('quickOpenJob:'+job.id,job);
  try{item.targetId=await createBackgroundTarget(runtime.context,item.url);item.status='opened';}catch(error){item.status='failed';item.error=error.message;}
  runtime.store.set('quickOpenJob:'+job.id,job);if(job.cursor<job.items.length-1)await new Promise(r=>setTimeout(r,job.intervalMs));
 }
 job.status='completed';
 }catch(error){job.status='paused';job.error=error.message;job.history=[...(job.history||[]),{at:new Date().toISOString(),cursor:job.cursor,error:error.message,phase:'paused'}];}runtime.store.set('quickOpenJob:'+job.id,job);}
