import {pendingApplication,flushApplicationMutations} from './application-mutations.mjs';
import {pendingMediaUploads,flushMediaUploads} from './media-uploads.mjs';
import {pendingWorkbench,journalSync,workbenchScope} from './workbench-sync.mjs';
import {pendingFillLearning,flushFillLearning} from './fill-learning.mjs';
import {cloudDocumentKeys,normalizeCloudRevisions,cloudDigest} from './cloud-sync-state.mjs';
export function localCloudQueue(runtime){
 const edits=pendingApplication(runtime),pending=new Set(edits.map(item=>item.key)),conflicts=new Set(edits.filter(item=>item.status==='conflict').map(item=>item.key));
 if(pendingMediaUploads(runtime).length)pending.add('siteProfiles');
 if(pendingWorkbench(runtime).length)pending.add('submissionTimeline');
 for(const item of pendingFillLearning(runtime))if(!item.applicationPlanId){if(Object.keys(item.mappings||{}).length&&!item.cloudExcludedKeys?.includes('siteProfiles'))pending.add('siteProfiles');if(!item.cloudExcludedKeys?.includes('siteAnnotations'))pending.add('siteAnnotations');}
 return{pendingKeys:cloudDocumentKeys.filter(key=>pending.has(key)),conflictKeys:cloudDocumentKeys.filter(key=>conflicts.has(key))};
}
export async function cloudStatus(runtime){
 const pair=runtime.store.get('pair'),checkedAt=new Date().toISOString(),base={ok:true,checkedAt,endpoint:pair?.endpoint,workspaceId:pair?.workspaceId,deviceId:pair?.deviceId};
 if(!pair)return{...base,connected:false,status:'disconnected',error:'请先连接云端'};
 const identity=cloudDigest(pair);
 try{
  const remote=await runtime.cloud.request('revisions');if(cloudDigest(runtime.store.get('pair'))!==identity)throw Error('云端连接在核对期间变化，请重新核对');
  const revisions=normalizeCloudRevisions(remote?.revisions),saved=runtime.store.get('applicationSnapshot'),local=saved?.scope===workbenchScope(pair)?saved.snapshot:{documents:{},revisions:{}},known=normalizeCloudRevisions(local.revisions||{}),queue=localCloudQueue(runtime);
  const outOfDateKeys=cloudDocumentKeys.filter(key=>Object.hasOwn(revisions,key)&&(revisions[key]!==known[key]||!Object.hasOwn(local.documents,key))),localOnlyKeys=cloudDocumentKeys.filter(key=>Object.hasOwn(local.documents,key)&&!Object.hasOwn(revisions,key));
  const status=queue.conflictKeys.length?'conflict':queue.pendingKeys.length?'pending':outOfDateKeys.length||localOnlyKeys.length?'out_of_date':!Object.keys(revisions).length?'empty':'current';
  return{...base,connected:true,status,revisions,outOfDateKeys,localOnlyKeys,...queue,pendingCount:queue.pendingKeys.length,conflictCount:queue.conflictKeys.length,remoteDocumentCount:Object.keys(revisions).length,pendingEdits:pendingApplication(runtime).length,pendingLearning:pendingFillLearning(runtime).length,pendingMedia:pendingMediaUploads(runtime).length,pendingEvents:runtime.store.pendingCount(),pendingTimeline:pendingWorkbench(runtime).length};
 }catch(error){return{...base,connected:false,status:'unavailable',error:error.message,...localCloudQueue(runtime)};}
}
export function pushLocalChanges(runtime){
 if(runtime.cloudPushOperation)return runtime.cloudPushOperation;
 const operation=Promise.resolve().then(async()=>{
  if(runtime.cloudPullOperation)await runtime.cloudPullOperation;
  const status=await cloudStatus(runtime);if(!status.connected)throw Error(status.error||'云端当前不可用，未上传本机修改');
  // A refreshed display cache must not authorize replacing a newer cloud value.
  const pending=pendingApplication(runtime),first=new Map();for(const item of pending)if(!first.has(item.key))first.set(item.key,item);
  const changed=[...first].filter(([key,item])=>item.status!=='conflict'&&(!Number.isInteger(item.baseRevision)||(status.revisions[key]||0)!==item.baseRevision)).map(([key])=>key);
  if(changed.length){for(const item of pending)if(changed.includes(item.key))runtime.store.set('appMutation:'+item.id,{...item,status:'conflict',error:Number.isInteger(item.baseRevision)?'云端版本已变化，已暂停上传；本机修改保留':'原修改的版本依据缺失，请比较本机与云端后确认'});throw Error('云端版本已变化或原版本依据缺失，已暂停上传，请先比较冲突资料');}
  const blocked=new Set(localCloudQueue(runtime).conflictKeys);
  if(pendingMediaUploads(runtime).length&&!blocked.has('siteProfiles'))await flushMediaUploads(runtime);
  if(pendingApplication(runtime).length)await flushApplicationMutations(runtime);
  if(pendingFillLearning(runtime).length)await flushFillLearning(runtime);
  if(pendingWorkbench(runtime).length&&!blocked.has('submissionTimeline'))await journalSync(runtime).flush();
  await runtime.cloud.flush(runtime.store);return cloudStatus(runtime);
 });runtime.cloudPushOperation=operation.finally(()=>{runtime.cloudPushOperation=null;});return runtime.cloudPushOperation;
}
