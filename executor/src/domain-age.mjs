import {randomUUID} from 'node:crypto';
import {enqueueLibraryMutation,pendingApplication} from './application-mutations.mjs';
import {applicationData} from './application-data.mjs';
import {workbenchScope} from './workbench-sync.mjs';
export async function startDomainAge(runtime,input){
 if(runtime.domainAgeJob)throw Error('域名查询正在进行');const scope=workbenchScope(runtime.store.get('pair'));
 let job=input.jobId&&runtime.store.get('domainAgeJob:'+input.jobId);
 if(input.jobId&&(!job||job.scope!==scope))throw Error('域名查询任务不存在');
 if(!job){if(!Array.isArray(input.urls)||!input.urls.length||input.urls.length>5000)throw Error('请选择查询网站');const domains=[...new Set(input.urls.map(value=>{const url=new URL(value);if(!/^https?:$/.test(url.protocol))throw Error('只支持普通网站');return url.hostname.replace(/^www\./,'');}))];job={id:randomUUID(),scope,domains,cursor:0,status:'queued',at:new Date().toISOString()};runtime.store.set('domainAgeJob:'+job.id,job);}
 if(job.status==='completed')return{ok:true,job};
 runtime.domainAgeJob=runDomainAge(runtime,job).finally(()=>runtime.domainAgeJob=null);return{ok:true,job};
}
async function runDomainAge(runtime,job){
 try{await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('请先同步本机编辑，再继续域名查询');
  job.status='running';job.error='';runtime.store.set('domainAgeJob:'+job.id,job);
  while(job.cursor<job.domains.length){const domains=job.domains.slice(job.cursor,job.cursor+20),result=await runtime.cloud.request('ai/domain-metrics',{domains});
   if(!Array.isArray(result.results)||result.results.length!==domains.length||result.results.some(r=>!domains.includes(r.domain))||new Set(result.results.map(r=>r.domain)).size!==domains.length)throw Error('域名查询回读不完整');
   const saved=await enqueueLibraryMutation(runtime,{operation:{type:'domain_metrics',results:result.results}});if(saved.pending)throw Error(saved.error||'域名结果已存本机，待同步后继续');
   job.cursor+=domains.length;runtime.store.set('domainAgeJob:'+job.id,job);
  }
  job.status='completed';job.completedAt=new Date().toISOString();
 }catch(error){job.status='paused';job.error=error.message;}runtime.store.set('domainAgeJob:'+job.id,job);
}
