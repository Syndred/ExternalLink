import {createHash} from 'node:crypto';
import {workbenchScope} from './workbench-sync.mjs';
import {enqueueApplicationPlan,pendingApplication} from './application-mutations.mjs';
import {fillLearningMappings,destinationFormSchema} from '../../core/form-knowledge.mjs';
import {profiles} from './shared.mjs';
export function captureFillLearning(runtime,binding,message){
 const scope=workbenchScope(runtime.store.get('pair')),mappings=fillLearningMappings(message.mappings),schema=destinationFormSchema(message.schema),url=new URL(message.pageUrl);
 if(!/^https?:$/.test(url.protocol)||url.username||url.password||!schema||new URL(schema.url).hostname!==url.hostname||message.profileId!==binding.profileId||typeof message.identity?.name!=='string'||!message.identity.name||typeof message.identity?.url!=='string'||!message.identity.url||profiles.fillIdentityMismatch({projectKey:message.profileId,brandName:message.identity.name,targetDomain:message.identity.url},binding.profile))throw Error('原字段学习页面或产品已变化');
 const source={scope,profileId:binding.profileId,taskId:binding.taskId||null,targetId:binding.targetId,browserInstance:binding.browserInstance,profileRevision:binding.profileRevision,url:url.origin+url.pathname,identity:{name:message.identity.name,url:message.identity.url},mappings,schema};
 const id=createHash('sha256').update(JSON.stringify(source)).digest('hex'),old=runtime.store.get('fillLearning:'+id);if(old)return{ok:true,persisted:true,id,status:old.status};
 runtime.store.set('fillLearning:'+id,{...source,id,at:new Date().toISOString(),status:'pending'});return{ok:true,persisted:true,id,status:'pending'};
}
export function pendingFillLearning(runtime){const scope=workbenchScope(runtime.store.get('pair'));return runtime.store.values('fillLearning:').filter(item=>item.scope===scope&&!['confirmed','completed_with_exclusions'].includes(item.status));}
export function flushFillLearning(runtime){if(runtime.fillLearningFlush)return runtime.fillLearningFlush;runtime.fillLearningFlush=performFlush(runtime).finally(()=>{runtime.fillLearningFlush=null;});return runtime.fillLearningFlush;}
async function performFlush(runtime){
 if(runtime.store.get('offlineMode')?.enabled)return{pending:pendingFillLearning(runtime).length,offline:true};
 const scope=workbenchScope(runtime.store.get('pair'));
 for(const item of pendingFillLearning(runtime)){
  if(scope!==workbenchScope(runtime.store.get('pair')))break;
  try{
   let operations;
   if(!item.applicationPlanId){
    if(pendingApplication(runtime).length)break;
    const snapshot=await runtime.cloud.request('snapshot');if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原字段学习保留');
    runtime.store.set('applicationSnapshot',{scope,snapshot,at:new Date().toISOString()});
    const profile=snapshot.documents.siteProfiles?.[item.profileId],same=profile&&!profile.archived&&!profiles.fillIdentityMismatch({projectKey:item.profileId,brandName:item.identity.name,targetDomain:item.identity.url},profile);
    operations=[...(same&&Object.keys(item.mappings).length?[{type:'form_learning',profileId:item.profileId,url:item.url,identity:item.identity,mappings:item.mappings}]:[]),{type:'form_knowledge',url:item.url,mappings:item.mappings,schema:item.schema}];
    item.excludedProfile=!same;runtime.store.set('fillLearning:'+item.id,item);
   }
   const result=await enqueueApplicationPlan(runtime,{planId:item.applicationPlanId,operations},planId=>{item.applicationPlanId=planId;runtime.store.set('fillLearning:'+item.id,item);});
   const plan=runtime.store.get('applicationPlan:'+result.planId),discarded=(plan?.items||[]).some(entry=>runtime.store.get('appMutation:'+entry.id)?.status==='discarded');item.status=result.remaining?'pending':item.excludedProfile||discarded?'completed_with_exclusions':'confirmed';item.error=result.error||'';runtime.store.set('fillLearning:'+item.id,item);if(result.remaining)break;
  }catch(error){item.error=error.message;runtime.store.set('fillLearning:'+item.id,item);break;}
 }
 return{pending:pendingFillLearning(runtime).length};
}
