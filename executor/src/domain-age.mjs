import {randomUUID} from 'node:crypto';
import {enqueueApplicationPlan,pendingApplication} from './application-mutations.mjs';
import {applicationData} from './application-data.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {freshDomainMetric,domainMetricsLimit,domainMetricsBatch} from '../../core/domain-metrics.mjs';
import '../../core/queue.js';
function requestedDomains(input){
 const values=input.urls??input.domains??(input.domain?[input.domain]:[]);
 if(!Array.isArray(values)||!values.length)throw Error('请选择查询网站');
 return [...new Set(values.map(value=>{if(typeof value!=='string')throw Error('域名格式无效');if(input.urls){const url=new URL(value);if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw Error('只支持普通网站');value=url.hostname;}const domain=globalThis.ExtLinkQueue.normalizeBlacklistEntry(value);if(!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain))throw Error('域名格式无效');return domain;}))];
}
export async function startDomainAge(runtime,input={}){
 if(runtime.domainAgeJob)throw Error('域名查询正在进行');const scope=workbenchScope(runtime.store.get('pair'));
 let job=input.jobId&&runtime.store.get('domainAgeJob:'+input.jobId);
 if(input.jobId&&(!job||job.scope!==scope))throw Error('域名查询任务不存在');
 if(!job){if(input.refresh!==undefined&&typeof input.refresh!=='boolean')throw Error('刷新选项无效');job={id:randomUUID(),scope,domains:requestedDomains(input),refresh:input.refresh===true,cursor:0,cachedCount:0,lookedUp:0,knownCount:0,results:{},status:'queued',at:new Date().toISOString()};runtime.store.set('domainAgeJob:'+job.id,job);}
 if(['completed','completed_with_exclusions'].includes(job.status))return{ok:true,job};
 runtime.domainAgeJobId=job.id;runtime.domainAgeJob=runDomainAge(runtime,job).finally(()=>{runtime.domainAgeJob=null;runtime.domainAgeJobId=null;});return{ok:true,job};
}
async function runDomainAge(runtime,job){
 const save=()=>{const results=Object.values({...job.results,...Object.fromEntries((job.pendingResult?.results||[]).map(row=>[row.domain,row]))});job.knownCount=results.length<job.cursor?null:results.filter(row=>row?.status==='ok'&&Number.isFinite(row.ageMonths)).length;runtime.store.set('domainAgeJob:'+job.id,job);};
 const assertScope=()=>{if(job.scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原域名结果和查询范围保留，请回到原工作区继续');};
 try{
  await applicationData(runtime,{refresh:true});assertScope();
  const ownPlans=[job.pendingResult?.planId,job.prunePlanId].filter(Boolean);
  if(pendingApplication(runtime).some(item=>!ownPlans.includes(item.applicationPlanId)))throw Error('请先同步本机编辑，再继续域名查询');
  job.results||={};job.cachedCount??=0;job.lookedUp??=job.cursor;job.refresh??=false;job.excludedDomains||=[];job.status='running';job.error='';save();
  if(!job.lookupDomains){
   const cache=runtime.store.get('applicationSnapshot')?.snapshot?.documents?.domainMetricsCache||{},now=Date.now();job.lookupDomains=[];job.lookupCursor=0;
   // Freeze the original cached/missing partition once. Cached entries must
   // not break the original twenty-domain batches or be counted again on resume.
   for(const domain of job.domains.slice(job.cursor)){if(!job.refresh&&freshDomainMetric(cache[domain],now)){job.results[domain]=cache[domain];job.cachedCount++;}else job.lookupDomains.push(domain);}
   job.cursor=job.domains.length-job.lookupDomains.length;save();
  }
  while(job.lookupCursor<job.lookupDomains.length){
   assertScope();
   if(job.pendingResult){
    const pending=job.pendingResult,expected=job.lookupDomains.slice(job.lookupCursor,job.lookupCursor+pending.domains.length);
    if(JSON.stringify(pending.domains)!==JSON.stringify(expected))throw Error('原域名结果与查询范围不一致');
    const result=await enqueueApplicationPlan(runtime,pending.planId?{planId:pending.planId}:{operations:[{type:'domain_metrics',results:pending.results}]},id=>{pending.planId=id;save();});assertScope();
    if(result.remaining)throw Error(result.error||'原域名结果已存本机，待同步或解决冲突后继续');
    const plan=runtime.store.get('applicationPlan:'+pending.planId),excluded=plan.items.some(item=>runtime.store.get('appMutation:'+item.id)?.status==='discarded');
    if(excluded)job.excludedDomains.push(...pending.domains);
    for(const row of pending.results)job.results[row.domain]=row;
    if(!pending.counted)job.lookedUp+=pending.domains.length;job.cursor+=pending.domains.length;job.lookupCursor+=pending.domains.length;delete job.pendingResult;save();continue;
   }
   const domains=job.lookupDomains.slice(job.lookupCursor,job.lookupCursor+domainMetricsBatch);
   const fetchedAt=Date.now(),response=await runtime.cloud.request('ai/domain-metrics',{domains});
   if(response.ok===false||!Array.isArray(response.results)||response.results.length!==domains.length||response.results.some(row=>!domains.includes(row?.domain))||new Set(response.results.map(row=>row.domain)).size!==domains.length)throw Error('域名查询回读不完整');
   job.pendingResult={domains,results:response.results.map(row=>({...row,fetchedAt})),counted:true};job.lookedUp+=domains.length;save();assertScope();
  }
  const cache=runtime.store.get('applicationSnapshot')?.snapshot?.documents?.domainMetricsCache||{};
  if(job.prunePlanId||Object.keys(cache).length>domainMetricsLimit){
   const result=await enqueueApplicationPlan(runtime,job.prunePlanId?{planId:job.prunePlanId}:{operations:[{type:'domain_metrics',results:[]}]},id=>{job.prunePlanId=id;save();});assertScope();if(result.remaining)throw Error(result.error||'原缓存清理计划待同步');
   const plan=runtime.store.get('applicationPlan:'+job.prunePlanId);job.pruneExcluded=plan.items.some(item=>runtime.store.get('appMutation:'+item.id)?.status==='discarded');
  }
  job.status=job.excludedDomains.length||job.pruneExcluded?'completed_with_exclusions':'completed';job.completedAt=new Date().toISOString();
 }catch(error){job.status='paused';job.error=error.message;}save();
}
