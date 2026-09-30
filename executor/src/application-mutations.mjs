import { randomUUID } from 'node:crypto';import { isDeepStrictEqual } from 'node:util';
import { applicationMutation as libraryMutation,applicationMutationSatisfied as libraryMutationSatisfied } from '../../core/application-mutation.mjs';import {workbenchScope} from './workbench-sync.mjs';
export function pendingApplication(runtime){const scope=workbenchScope(runtime.store.get('pair'));return runtime.store.values('appMutation:').filter(item=>item.scope===scope&&!['confirmed','discarded'].includes(item.status)).sort((a,b)=>a.at.localeCompare(b.at));}
export async function resolveApplicationConflict(runtime,input){
 if(runtime.appMutationFlush)await runtime.appMutationFlush;
 const item=pendingApplication(runtime).find(item=>item.id===input.id);
 if(item?.status!=='conflict'||!['cloud','local'].includes(input.choice))throw Error('无效冲突处理');
 const snapshot=await runtime.cloud.request('snapshot');
 if(input.revision!==snapshot.revisions[item.key])throw Error('云端版本已变化，请回读后重新比较');
 const resolution={choice:input.choice,at:new Date().toISOString(),remoteData:structuredClone(snapshot.documents[item.key]),remoteRevision:input.revision,originalBaseData:item.baseData};
 runtime.store.set('appMutation:'+item.id,{...item,resolution,baseData:snapshot.documents[item.key],status:input.choice==='cloud'?'discarded':'pending',error:''});
 runtime.store.set('applicationSnapshot',{scope:item.scope,snapshot,at:new Date().toISOString()});
 return{ok:true,...await flushApplicationMutations(runtime)};
}
export function overlayApplication(runtime,snapshot){const result=structuredClone(snapshot);for(const item of pendingApplication(runtime)){try{const change=libraryMutation(result.documents,item.operation);result.documents[change.key]=change.data;}catch{}}return result;}
export async function enqueueLibraryMutation(runtime,input){
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get('applicationSnapshot');if(saved?.scope!==scope)throw Error('请先读取本工作区资料');
 const snapshot=overlayApplication(runtime,saved.snapshot),operation={...input.operation,id:randomUUID(),at:new Date().toISOString()},change=libraryMutation(snapshot.documents,operation);
 const item={id:operation.id,scope,at:operation.at,operation,key:change.key,baseData:snapshot.documents[change.key],status:'pending'};
 runtime.store.set('appMutation:'+item.id,item); // Durable before the first cloud request.
 const result=await flushApplicationMutations(runtime);return{ok:true,id:item.id,persisted:true,...result};
}
export function enqueueProfileMutation(runtime,input){
 const saved=runtime.store.get('applicationSnapshot');if(input.revision!==saved?.snapshot?.revisions?.siteProfiles)throw Error('资料版本已变化，请回读后重试');
 return enqueueLibraryMutation(runtime,{operation:{type:'profile',profileId:input.profileId,profile:input.profile}});
}
export function flushApplicationMutations(runtime){
 if(runtime.appMutationFlush)return runtime.appMutationFlush;
 runtime.appMutationFlush=performFlush(runtime).finally(()=>{runtime.appMutationFlush=null;});return runtime.appMutationFlush;
}
async function performFlush(runtime){
 const pending=pendingApplication(runtime);if(!pending.length)return{pending:0};let snapshot;
 try{snapshot=await runtime.cloud.request('snapshot');}catch(error){return{pending:pending.length,error:error.message};}
 for(const item of pending){
  if(libraryMutationSatisfied(snapshot.documents,item.operation)){item.status='confirmed';item.confirmedAt=new Date().toISOString();runtime.store.set('appMutation:'+item.id,item);continue;}
  if(!isDeepStrictEqual(snapshot.documents[item.key],item.baseData)){item.status='conflict';item.error='云端外链库有并发修改；本机编辑保留，未覆盖云端';runtime.store.set('appMutation:'+item.id,item);break;}
  const change=libraryMutation(snapshot.documents,item.operation);
   try{await runtime.cloud.request(item.operation.type==='profile'?'profile':'library',item.operation.type==='profile'?{profileId:item.operation.profileId,profile:item.operation.profile,revision:snapshot.revisions[item.key]||0}:{operation:item.operation,revision:snapshot.revisions[item.key]||0});
   const read=await runtime.cloud.request('snapshot');if(item.operation.type==='profile'?!libraryMutationSatisfied(read.documents,item.operation):!isDeepStrictEqual(read.documents[item.key],change.data))throw Error('资料回读不一致，原编辑仍在本机');
   snapshot=read;item.status='confirmed';item.confirmedAt=new Date().toISOString();delete item.error;runtime.store.set('appMutation:'+item.id,item);
  }catch(error){item.error=error.message;runtime.store.set('appMutation:'+item.id,item);break;}
 }
 const scope=workbenchScope(runtime.store.get('pair'));runtime.store.set('applicationSnapshot',{scope,snapshot,at:new Date().toISOString()});
 return{pending:pendingApplication(runtime).length,error:pendingApplication(runtime).find(item=>item.error)?.error||''};
}
