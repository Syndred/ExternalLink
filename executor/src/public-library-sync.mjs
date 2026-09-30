import {randomUUID} from 'node:crypto';
import {fetchSubmifyPublicLibrary,mergeSubmify} from '../../core/submify-sync.mjs';
import {applicationData} from './application-data.mjs';
import {enqueueApplicationPlan,flushApplicationMutations,pendingApplication} from './application-mutations.mjs';
import {workbenchScope} from './workbench-sync.mjs';
export async function startPublicLibrarySync(runtime,input={}){
 if(runtime.publicLibraryJob)throw Error('公共库同步正在进行');const scope=workbenchScope(runtime.store.get('pair'));let job=input.jobId&&runtime.store.get('publicLibraryJob:'+input.jobId);if(input.jobId&&(!job||job.scope!==scope))throw Error('原公共库同步不存在');
 if(!job){job={id:randomUUID(),scope,status:'queued',at:new Date().toISOString()};runtime.store.set('publicLibraryJob:'+job.id,job);}if(job.status==='completed')return{ok:true,job};runtime.publicLibraryJobId=job.id;runtime.publicLibraryJob=run(runtime,job).finally(()=>{runtime.publicLibraryJob=null;runtime.publicLibraryJobId=null;});return{ok:true,job:{id:job.id,status:job.status}};
}
async function run(runtime,job){try{
 job.status='running';job.error='';runtime.store.set('publicLibraryJob:'+job.id,job);await flushApplicationMutations(runtime);await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('已有编辑尚待同步或解决冲突');
 if(!job.source){job.source=await fetchSubmifyPublicLibrary(runtime.fetchPublic||globalThis.fetch);runtime.store.set('publicLibraryJob:'+job.id,job);}
 const snapshot=runtime.store.get('applicationSnapshot').snapshot;
 if(!job.planId){const merged=mergeSubmify(snapshot.documents,job.source.items,job.at),gates=merged.addedItems.filter(i=>i.gate).map(i=>({url:i.entry.link,reason:i.gate}));job.stats={...merged.stats,safetyDisabled:gates.length};runtime.store.set('publicLibraryJob:'+job.id,job);
  const result=await enqueueApplicationPlan(runtime,{operations:[{type:'submify_gates',gates},{type:'submify_import',items:job.source.items}]},id=>{job.planId=id;runtime.store.set('publicLibraryJob:'+job.id,job);});if(result.remaining)throw Error(result.error||'公共库变更已存本机，待同步或解决冲突');
 }else{const result=await enqueueApplicationPlan(runtime,{planId:job.planId});if(result.remaining)throw Error(result.error||'原公共库变更仍待同步');}
 let proof=await runtime.cloud.request('snapshot');const missingIds=()=>{const refs=new Set((proof.documents.sheetTableData?.entries||[]).flatMap(r=>[String(r.sourceId||''),...(r.sourceRefs||[]).map(String)]));return job.source.items.some(i=>i.id&&!refs.has(String(i.id)));};
 if(missingIds()){
  // Repair provenance only, from the original frozen source. Do not refetch or overwrite user fields.
  await applicationData(runtime,{refresh:true});const repair=await enqueueApplicationPlan(runtime,job.repairPlanId?{planId:job.repairPlanId}:{operations:[{type:'submify_refs',items:job.source.items}]},id=>{job.repairPlanId=id;runtime.store.set('publicLibraryJob:'+job.id,job);});if(repair.remaining)throw Error(repair.error||'公共库来源编号修复待同步');proof=await runtime.cloud.request('snapshot');
 }
 if(missingIds())throw Error('公共库来源编号云端回读不完整');job.status='completed';job.completedAt=new Date().toISOString();delete job.source;
 }catch(error){job.status='paused';job.error=error.message;}runtime.store.set('publicLibraryJob:'+job.id,job);
}
