import { randomUUID } from 'node:crypto';import { isDeepStrictEqual } from 'node:util';
import { applicationMutation as libraryMutation,applicationMutationSatisfied as libraryMutationSatisfied } from '../../core/application-mutation.mjs';import {workbenchScope} from './workbench-sync.mjs';
import {cacheCloudSnapshot} from './cloud-sync-state.mjs';
import {applicationSettingKeys} from '../../core/application-preferences.mjs';
export function pendingApplication(runtime){const scope=workbenchScope(runtime.store.get('pair'));return runtime.store.valuesByInsertion('appMutation:').filter(item=>item.scope===scope&&!['confirmed','discarded'].includes(item.status)).sort((a,b)=>a.at.localeCompare(b.at));}
export const applicationMutationKeys=item=>item.writeKeys||[item.key];
export async function confirmUncertainApplicationEdits(runtime,{timelineOnly=false}={}){
 const scope=workbenchScope(runtime.store.get('pair')),pending=pendingApplication(runtime);
 if(!pending.some(item=>(!timelineOnly||item.operation.type==='timeline')&&item.status==='pending'&&item.writeAttemptedAt&&item.error))return null;
 const snapshot=await runtime.cloud.request('snapshot');if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原动态保留');
 for(const item of pending)if((!timelineOnly||item.operation.type==='timeline')&&item.status==='pending'&&item.writeAttemptedAt&&item.error&&libraryMutationSatisfied(snapshot.documents,item.operation)){
  item.status='confirmed';item.confirmedAt=new Date().toISOString();delete item.error;runtime.store.set('appMutation:'+item.id,item);
  const next=pending.slice(pending.indexOf(item)+1).find(other=>other.key===item.key&&!['confirmed','discarded','conflict'].includes(other.status));
  if(next&&isDeepStrictEqual(next.baseData,snapshot.documents[item.key])){next.baseRevision=snapshot.revisions[item.key]||0;for(const key of Object.keys(next.relatedBaseRevisions||{}))if(isDeepStrictEqual(next.relatedBaseData?.[key],snapshot.documents[key]))next.relatedBaseRevisions[key]=snapshot.revisions[key]||0;runtime.store.set('appMutation:'+next.id,next);}
 }
 cacheCloudSnapshot(runtime,snapshot);return snapshot;
}
export function confirmUncertainTimelineEdits(runtime){return confirmUncertainApplicationEdits(runtime,{timelineOnly:true});}
function mutationIntent(snapshot,operation,change,hasPrior,knownRemote){
 const localOnly=!change.updates&&operation.type!=='recover_local'&&!hasPrior&&!snapshot.revisions[change.key]&&Object.hasOwn(snapshot.documents,change.key)&&knownRemote&&!Object.hasOwn(knownRemote.documents,change.key);
 return localOnly?{operation:{type:'recover_local',key:change.key,data:change.data,id:operation.id,at:operation.at},originalOperation:operation,localOnlyBaseData:snapshot.documents[change.key],baseData:undefined,baseRevision:0}:{operation,baseData:snapshot.documents[change.key],baseRevision:snapshot.revisions[change.key]||0,...(change.revisionKeys?{writeKeys:Object.keys(change.updates),relatedBaseData:Object.fromEntries(change.revisionKeys.filter(key=>key!==change.key).map(key=>[key,snapshot.documents[key]])),relatedBaseRevisions:Object.fromEntries(change.revisionKeys.filter(key=>key!==change.key).map(key=>[key,snapshot.revisions[key]||0]))}:{})};
}
export async function resolveApplicationConflict(runtime,input){
 if(runtime.cloudPullOperation)await runtime.cloudPullOperation;
 if(runtime.appMutationFlush)await runtime.appMutationFlush;
 const item=pendingApplication(runtime).find(item=>item.id===input.id);
 if(item?.status!=='conflict'||!['cloud','local'].includes(input.choice))throw Error('无效冲突处理');
 const snapshot=await runtime.cloud.request('snapshot');
 if(item.scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原冲突保留，请重新选择');
 if(input.revision!==snapshot.revisions[item.key])throw Error('云端版本已变化，请回读后重新比较');
 if(item.relatedBaseRevisions&&Object.keys(item.relatedBaseRevisions).some(key=>input.revisions?.[key]!== (snapshot.revisions[key]||0)))throw Error('关联台账版本已变化或尚未比较，请回读后重新比较');
 const resolution={choice:input.choice,at:new Date().toISOString(),remoteData:structuredClone(snapshot.documents[item.key]),remoteRevision:input.revision,originalBaseData:item.baseData};
 if(item.relatedBaseRevisions){resolution.originalRelatedBaseData=item.relatedBaseData;resolution.relatedRemoteData=Object.fromEntries(Object.keys(item.relatedBaseRevisions).map(key=>[key,snapshot.documents[key]]));}
 runtime.store.set('appMutation:'+item.id,{...item,resolution,baseData:snapshot.documents[item.key],baseRevision:snapshot.revisions[item.key]||0,...(item.relatedBaseRevisions?{relatedBaseData:resolution.relatedRemoteData,relatedBaseRevisions:Object.fromEntries(Object.keys(item.relatedBaseRevisions).map(key=>[key,snapshot.revisions[key]||0]))}:{}),status:input.choice==='cloud'?'discarded':'pending',error:''});
 cacheCloudSnapshot(runtime,snapshot);
 return{ok:true,...await flushApplicationMutations(runtime)};
}
export function overlayApplication(runtime,snapshot){const result=structuredClone(snapshot);for(const item of pendingApplication(runtime)){try{const change=libraryMutation(result.documents,item.operation);Object.assign(result.documents,change.updates||{[change.key]:change.data});}catch{}}return result;}
// Original settings are local immediately, even when their cloud write is
// pending. Execution must not borrow unconfirmed product edits or revisions.
export function overlayApplicationSettings(runtime,snapshot){
 const result=structuredClone(snapshot);
 for(const item of pendingApplication(runtime))if(applicationSettingKeys.includes(item.key)){
  try{const change=libraryMutation(result.documents,item.operation);for(const [key,data]of Object.entries(change.updates||{[change.key]:change.data}))if(applicationSettingKeys.includes(key))result.documents[key]=data;}catch{}
 }
 return result;
}
// Product selection is an immediate local preference, not an unconfirmed
// product payload. Apply only its validated selection keys to visit context.
export function overlayVisitPreferences(runtime,snapshot){
 const result=overlayApplicationSettings(runtime,snapshot);
 result.documents=visitPreferenceDocuments(runtime,result.documents);return result;
}
export function visitPreferenceDocuments(runtime,documents){
 const keys=['autoFillOnVisit','activeSiteId','selectedSiteIds'];let result=documents;
 for(const item of pendingApplication(runtime))if(keys.includes(item.key)){
  if(result===documents)result={...documents};
  try{const change=libraryMutation(result,item.operation);for(const [key,data]of Object.entries(change.updates||{[change.key]:change.data}))if(keys.includes(key))result[key]=data;}catch{}
 }
 return result;
}
export async function enqueueLibraryMutation(runtime,input){
 if(runtime.cloudPullOperation)await runtime.cloudPullOperation;
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get('applicationSnapshot');if(saved?.scope!==scope)throw Error('请先读取本工作区资料');
 const snapshot=overlayApplication(runtime,saved.snapshot),operation={...input.operation,id:randomUUID(),at:new Date().toISOString()},change=libraryMutation(snapshot.documents,operation);
 if(['profile_create','profile_delete'].includes(operation.type)){
  const nextDocuments={...snapshot.documents,[change.key]:change.data},activeSiteId=operation.type==='profile_create'?operation.profileId:globalThis.ExtLinkProfiles.profileSelectionFromDocuments(nextDocuments).activeSiteId;
  const result=await enqueueApplicationPlan(runtime,{operations:[input.operation,{type:'profile_selection',key:'activeSiteId',value:activeSiteId}],allowPending:true});
  return{...result,id:runtime.store.get('applicationPlan:'+result.planId).items[0].id,persisted:true};
 }
 if(operation.type==='mark'){
  const key=globalThis.ExtLinkQueue.normalizeLibraryDestinationKey(operation.url),deleted=(operation.statuses??[operation.status]).includes('deleted');
  if(deleted!==(snapshot.documents.deletedSubmissionKeys||[]).includes(key)){
   const result=await enqueueApplicationPlan(runtime,{operations:[input.operation,{type:deleted?'set_deleted':'clear_deleted',url:operation.url}],allowPending:true});
   return{...result,id:runtime.store.get('applicationPlan:'+result.planId).items[0].id,persisted:true};
  }
 }
 const prior=pendingApplication(runtime).some(item=>item.key===change.key),baseline={documents:snapshot.documents,revisions:saved.snapshot.revisions},item={id:operation.id,scope,at:operation.at,key:change.key,...mutationIntent(baseline,operation,change,prior,saved.remoteSnapshot),status:'pending'};
 runtime.store.set('appMutation:'+item.id,item); // Durable before the first cloud request.
 const result=await flushApplicationMutations(runtime);return{ok:true,id:item.id,persisted:true,...result};
}
export function enqueueProfileMutation(runtime,input){
 if(runtime.cloudPullOperation)return runtime.cloudPullOperation.then(()=>enqueueProfileMutation(runtime,input));
 const saved=runtime.store.get('applicationSnapshot');if(input.revision!==saved?.snapshot?.revisions?.siteProfiles)throw Object.assign(Error('资料版本已变化，请回读后重试'),{status:409});
 return enqueueLibraryMutation(runtime,{operation:{type:'profile',profileId:input.profileId,profile:input.profile}}).then(result=>{const next=runtime.store.get('applicationSnapshot');if(next?.scope!==saved?.scope||next?.scope!==workbenchScope(runtime.store.get('pair')))return result;const snapshot=overlayApplication(runtime,next.snapshot);return{...result,revision:snapshot.revisions.siteProfiles,profile:snapshot.documents.siteProfiles?.[input.profileId]};});
}
export function flushApplicationMutations(runtime){
 if(runtime.cloudPullOperation)return runtime.cloudPullOperation.then(()=>flushApplicationMutations(runtime),()=>flushApplicationMutations(runtime));
 if(runtime.appMutationFlush)return runtime.appMutationFlush;
 runtime.appMutationFlush=performFlush(runtime).finally(()=>{runtime.appMutationFlush=null;});return runtime.appMutationFlush;
}
export async function enqueueApplicationPlan(runtime,{planId,operations,allowPending=false,dependencyKind,baseSnapshot},onPersist){
 if(runtime.cloudPullOperation)await runtime.cloudPullOperation;
 const scope=workbenchScope(runtime.store.get('pair'));let plan=planId&&runtime.store.get('applicationPlan:'+planId);
 if(planId&&(!plan||plan.scope!==scope))throw Error('原资料变更计划不存在');
 if(!plan){const saved=runtime.store.get('applicationSnapshot'),prior=pendingApplication(runtime);if(saved?.scope!==scope||!allowPending&&prior.length)throw Error('请先回读并同步现有资料');const baseline=baseSnapshot||saved.snapshot,working=allowPending?overlayApplication(runtime,baseline):structuredClone(baseline),id=randomUUID(),started=Math.max(Date.now(),allowPending&&prior.length?Date.parse(prior.at(-1).at)+1:0),items=[];
  for(let i=0;i<operations.length;i++){const at=new Date(started+i).toISOString(),operation={...operations[i],id:randomUUID(),at},change=libraryMutation(working.documents,operation);items.push({id:operation.id,scope,at,key:change.key,...mutationIntent({documents:working.documents,revisions:baseline.revisions},operation,change,prior.some(item=>item.key===change.key)||items.some(item=>item.key===change.key),baseSnapshot||saved.remoteSnapshot),status:'pending',applicationPlanId:id});Object.assign(working.documents,change.updates||{[change.key]:change.data});}
  const firstType=items[0]?.originalOperation?.type||items[0]?.operation.type,catalogPlan=['clear_annotation','remove_queue','pin','add_browser_url'].includes(firstType);
  const profileRecovery=dependencyKind==='profile_recovery';
  if(catalogPlan||profileRecovery){for(let i=1;i<items.length;i++)items[i].dependsOn=items[i-1].id;}
  else if(allowPending&&['profile_create','profile_delete','mark'].includes(firstType)&&items[1])items[1].dependsOn=items[0].id;
  plan={id,scope,at:new Date(started).toISOString(),items,status:'queued',...(profileRecovery?{kind:'profile_recovery'}:catalogPlan?{kind:'catalog_lifecycle'}:allowPending&&items[1]?.dependsOn?{kind:firstType==='mark'?'annotation_lifecycle':'profile_lifecycle'}:{})};
  if(allowPending||catalogPlan||profileRecovery){runtime.store.db.exec('BEGIN IMMEDIATE');try{runtime.store.set('applicationPlan:'+id,plan);for(const item of items)runtime.store.set('appMutation:'+item.id,item);onPersist?.(id);runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}}
  else{runtime.store.set('applicationPlan:'+id,plan);onPersist?.(id);}
 }
 // Recover all original entries before flushing. Saving the plan precedes every network write.
 for(const item of plan.items)if(!runtime.store.get('appMutation:'+item.id))runtime.store.set('appMutation:'+item.id,item);
 const result=await flushApplicationMutations(runtime),remaining=plan.items.filter(i=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+i.id)?.status)).length;plan.status=remaining?'queued':'completed';runtime.store.set('applicationPlan:'+plan.id,plan);return{ok:true,planId:plan.id,status:plan.status,remaining,...result};
}
async function performFlush(runtime){
 const scope=workbenchScope(runtime.store.get('pair'));recoverCatalogPlanDependencies(runtime,scope);recoverBackupPlanDependencies(runtime,scope);const rows=pendingApplication(runtime),byId=new Map(rows.map(item=>[item.id,item])),pending=[],seen=new Set();const visit=item=>{if(seen.has(item.id))return;seen.add(item.id);if(byId.has(item.dependsOn))visit(byId.get(item.dependsOn));pending.push(item);};for(const item of rows)visit(item);if(!pending.length)return{pending:0};const cloud=runtime.cloud;let snapshot;
 const checkScope=()=>{if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原资料计划保留，停止写入');};
 try{snapshot=await cloud.request('snapshot');checkScope();}catch(error){return{pending:pending.length,error:error.message};}
 const blocked=new Set(pending.filter(item=>item.status==='conflict').map(item=>item.key));
 const comparable=(key,data)=>key==='siteProfiles'&&data?Object.fromEntries(Object.entries(data).map(([id,profile])=>{const {updatedAt,...content}=profile;return[id,content];})):data;
 const advanceNext=(item,read)=>{const next=pending.slice(pending.indexOf(item)+1).find(other=>other.key===item.key&&!['confirmed','discarded','conflict'].includes(other.status));if(next&&isDeepStrictEqual(comparable(item.key,next.baseData),comparable(item.key,read.documents[item.key]))){next.baseRevision=read.revisions[item.key]||0;for(const key of Object.keys(next.relatedBaseRevisions||{}))if(isDeepStrictEqual(next.relatedBaseData?.[key],read.documents[key]))next.relatedBaseRevisions[key]=read.revisions[key]||0;runtime.store.set('appMutation:'+next.id,next);}};
 for(const item of pending){
  if(scope!==workbenchScope(runtime.store.get('pair')))return{pending:pending.length,error:'工作区已切换，原资料计划保留，停止写入'};
  if(item.dependsOn&&runtime.store.get('appMutation:'+item.dependsOn)?.status==='discarded'){item.status='discarded';item.discardedAt=new Date().toISOString();item.error=item.backupImportId?'原产品导入已选择保留云端，关联历史导入一并取消':runtime.store.get('applicationPlan:'+item.applicationPlanId)?.kind==='profile_recovery'?'原产品恢复已选择保留云端，关联资料恢复一并取消':item.operation.type==='profile_selection'?'产品变更已选择保留云端，关联的当前网站变更一并取消':'原网站操作已选择保留云端，后续关联变更一并取消';runtime.store.set('appMutation:'+item.id,item);continue;}
  if(blocked.has(item.key)&&!(item.status==='pending'&&item.resolution?.choice==='local')||item.dependsOn&&runtime.store.get('appMutation:'+item.dependsOn)?.status!=='confirmed')continue;
  // Revision zero alone cannot establish absence. Read the cloud first; only
  // a genuinely absent document can be created from the complete retained key.
  if(item.baseRevision===0&&item.baseData!==undefined&&!Object.hasOwn(snapshot.documents,item.key)&&!snapshot.revisions[item.key]&&item.operation.type!=='recover_local'&&item.operation.type!=='timeline'&&!item.relatedBaseRevisions){
   const original=item.operation,change=libraryMutation({...snapshot.documents,[item.key]:item.baseData},original);item.originalOperation=original;item.localOnlyBaseData=item.baseData;item.baseData=undefined;item.operation={type:'recover_local',key:item.key,data:change.data,id:original.id,at:original.at};runtime.store.set('appMutation:'+item.id,item);
  }
  // A retained original timestamp can make a fetched row disappear during pruning.
  // Confirm the complete frozen cache result, rather than rewriting after a lost reply.
  const originalDomainResult=item.operation.type==='domain_metrics'&&libraryMutation({[item.key]:item.baseData},item.operation).data;
  const originalSettingsResult=item.operation.type==='settings'&&libraryMutation({[item.key]:item.baseData},item.operation).data;
  if(item.operation.type==='settings'?isDeepStrictEqual(snapshot.documents[item.key],originalSettingsResult):libraryMutationSatisfied(snapshot.documents,item.operation)||originalDomainResult&&isDeepStrictEqual(snapshot.documents[item.key],originalDomainResult)){item.status='confirmed';item.confirmedAt=new Date().toISOString();runtime.store.set('appMutation:'+item.id,item);advanceNext(item,snapshot);continue;}
  // Profile writes stamp updatedAt on the server, while queued edits contain local write times.
  // Compare all actual content; differing write timestamps alone cannot invalidate the next edit.
  if(!isDeepStrictEqual(comparable(item.key,snapshot.documents[item.key]),comparable(item.key,item.baseData))||Object.keys(item.relatedBaseRevisions||{}).some(key=>!isDeepStrictEqual(item.relatedBaseData?.[key],snapshot.documents[key]))){item.status='conflict';item.error='云端外链库或关联台账有并发修改；本机编辑保留，未覆盖云端';runtime.store.set('appMutation:'+item.id,item);blocked.add(item.key);continue;}
  const change=libraryMutation(snapshot.documents,item.operation);
  item.writeAttemptedAt=new Date().toISOString();runtime.store.set('appMutation:'+item.id,item);
   try{checkScope();await cloud.request(item.operation.type==='profile'?'profile':'library',item.operation.type==='profile'?{profileId:item.operation.profileId,profile:item.operation.profile,revision:snapshot.revisions[item.key]||0}:{operation:item.operation,revision:snapshot.revisions[item.key]||0,...(change.revisionKeys?{revisions:Object.fromEntries(change.revisionKeys.map(key=>[key,snapshot.revisions[key]||0]))}:{})});checkScope();
   const read=await cloud.request('snapshot');checkScope();if(item.operation.type==='profile'?!libraryMutationSatisfied(read.documents,item.operation):Object.entries(change.updates||{[item.key]:change.data}).some(([key,data])=>!isDeepStrictEqual(read.documents[key],data)))throw Error('资料或关联台账回读不一致，原编辑仍在本机');
   snapshot=read;item.status='confirmed';item.confirmedAt=new Date().toISOString();delete item.error;runtime.store.set('appMutation:'+item.id,item);
   advanceNext(item,read);
  }catch(error){item.error=error.message;runtime.store.set('appMutation:'+item.id,item);break;}
 }
 if(scope!==workbenchScope(runtime.store.get('pair')))return{pending:pending.filter(i=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+i.id)?.status)).length,error:'工作区已切换，原资料计划保留，停止写入'};
 cacheCloudSnapshot(runtime,snapshot);
 for(const planId of new Set(pending.map(item=>item.applicationPlanId).filter(Boolean))){const plan=runtime.store.get('applicationPlan:'+planId);if(!['profile_lifecycle','annotation_lifecycle','catalog_lifecycle','profile_recovery'].includes(plan?.kind))continue;const entries=plan.items.map(item=>runtime.store.get('appMutation:'+item.id));plan.status=entries.every(item=>['confirmed','discarded'].includes(item?.status))?'completed':'queued';plan.excludedIds=entries.filter(item=>item?.status==='discarded').map(item=>item.id);runtime.store.set('applicationPlan:'+planId,plan);}
 return{pending:pendingApplication(runtime).length,error:pendingApplication(runtime).find(item=>item.error)?.error||''};
}
function recoverBackupPlanDependencies(runtime,scope){
 const updates=[];for(const plan of runtime.store.values('backupImport:'))if(plan.scope===scope&&plan.status==='queued'&&plan.operationFormat==='prepared_keys_v2')for(const [id,parent]of Object.entries(plan.itemDependencies||{})){const item=runtime.store.get('appMutation:'+id);if(item&&item.dependsOn!==parent)updates.push({...item,dependsOn:parent});}
 if(!updates.length)return;runtime.store.db.exec('BEGIN IMMEDIATE');try{for(const item of updates)runtime.store.set('appMutation:'+item.id,item);runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
}
function recoverCatalogPlanDependencies(runtime,scope){
 for(const id of new Set(pendingApplication(runtime).map(item=>item.applicationPlanId).filter(Boolean))){
  const original=runtime.store.get('applicationPlan:'+id);if(original?.scope!==scope||!['clear_annotation','remove_queue','pin'].includes(original.items?.[0]?.operation.type))continue;
  const plan=structuredClone(original),updates=[];let changed=plan.kind!=='catalog_lifecycle';plan.kind='catalog_lifecycle';
  for(let i=1;i<plan.items.length;i++){const item=plan.items[i],parent=plan.items[i-1].id;changed||=item.dependsOn!==parent;item.dependsOn=parent;const saved=runtime.store.get('appMutation:'+item.id);if(saved&&saved.dependsOn!==parent){updates.push({...saved,dependsOn:parent});changed=true;}}
  if(!changed)continue;
  runtime.store.db.exec('BEGIN IMMEDIATE');try{runtime.store.set('applicationPlan:'+id,plan);for(const item of updates)runtime.store.set('appMutation:'+item.id,item);runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
 }
}
