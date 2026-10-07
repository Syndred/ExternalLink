import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {exportApplicationBackup} from '../../core/application-backup.mjs';
import {backupWorkspace} from './migration-backup.mjs';
import {workbenchScope,pendingWorkbench} from './workbench-sync.mjs';
import {pendingApplication,overlayApplication,applicationMutationKeys} from './application-mutations.mjs';
import {pendingMediaUploads} from './media-uploads.mjs';
import {pendingFillLearning} from './fill-learning.mjs';
import {localCloudQueue} from './cloud-status.mjs';
import {cloudDocumentKeys,cloudDigest,cloudSnapshot} from './cloud-sync-state.mjs';

const at=()=>new Date().toISOString();
function fence(runtime){return cloudDigest([runtime.store.get('pair'),runtime.store.get('applicationSnapshot')?.snapshot,runtime.store.get('workbenchDocuments')?.snapshot,pendingApplication(runtime),pendingMediaUploads(runtime),pendingFillLearning(runtime),runtime.store.get('workbenchJournalPending')||[]]);}
function assertAvailable(runtime){if(['appMutationFlush','mediaUploadFlush','fillLearningFlush','workbenchTimelineBusy','localRecoveryOperation','connectionBusy','cloudPushOperation','hydrating'].some(key=>runtime[key])||runtime.backupImportOperations?.size)throw Error('资料正在同步或恢复，请等待原操作完成再回读云端');}
function serial(runtime,key,work){
 if(runtime.cloudPullOperation){if(runtime.cloudPullOperationKey===key)return runtime.cloudPullOperation;throw Error('已有云端回读正在处理，请等待原操作完成');}
 assertAvailable(runtime);runtime.cloudPullOperationKey=key;
 const operation=Promise.resolve().then(work);runtime.cloudPullOperation=operation.finally(()=>{runtime.cloudPullOperation=null;runtime.cloudPullOperationKey=null;});return runtime.cloudPullOperation;
}
function assertCurrent(runtime,expected){if(expected!==fence(runtime))throw Error('本机资料或云端连接在回读期间变化，请重新预览；原修改与任务保留');}
function appliedStatus(runtime,remote){const queue=localCloudQueue(runtime),saved=runtime.store.get('applicationSnapshot').snapshot;return queue.conflictKeys.length?'conflict':queue.pendingKeys.length?'pending':cloudDocumentKeys.some(key=>Object.hasOwn(saved.documents,key)&&!Object.hasOwn(remote.revisions,key)||Object.hasOwn(remote.revisions,key)&&(remote.revisions[key]!==saved.revisions[key]||!Object.hasOwn(saved.documents,key)))?'out_of_date':Object.keys(remote.revisions).length?'current':'empty';}
function adoptSnapshot(runtime,remote,keys,discard){
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get('applicationSnapshot'),old=saved?.scope===scope?saved.snapshot:{documents:{},revisions:{}},snapshot=discard?{documents:{},revisions:{}}:structuredClone(old);
 for(const key of keys){if(Object.hasOwn(remote.documents,key))snapshot.documents[key]=remote.documents[key];if(Object.hasOwn(remote.revisions,key))snapshot.revisions[key]=remote.revisions[key];}
 runtime.store.set('applicationSnapshot',{scope,snapshot,remoteSnapshot:remote,at:at()});
 const journal=runtime.store.get('workbenchDocuments');if(journal?.scope===scope){for(const key of keys){if(Object.hasOwn(remote.documents,key))journal.snapshot.documents[key]=remote.documents[key];else if(discard)delete journal.snapshot.documents[key];if(Object.hasOwn(remote.revisions,key))journal.snapshot.revisions[key]=remote.revisions[key];else if(discard)delete journal.snapshot.revisions[key];}journal.at=at();runtime.store.set('workbenchDocuments',journal);}
 return snapshot;
}
export function pullCloudState(runtime,input={}){
 if(input.discardLocalChanges===true||input.resolveConflicts===true)return Promise.reject(Error('采用云端资料须先备份和预览，再确认原预览'));
 return serial(runtime,'normal',async()=>{
  const queue=localCloudQueue(runtime);if(queue.conflictKeys.length)return{ok:true,applied:false,status:'conflict',...queue,message:'本机有冲突资料，先备份并比较后再采用云端'};
  if(queue.pendingKeys.length)return{ok:true,applied:false,status:'pending',...queue,message:'本机有待上传资料，先备份后选择上传或采用云端'};
  const expected=fence(runtime),remote=cloudSnapshot(runtime.store.get('pair'),await runtime.cloud.request('snapshot'));assertCurrent(runtime,expected);
  adoptSnapshot(runtime,remote,cloudDocumentKeys,false);return{ok:true,applied:true,status:appliedStatus(runtime,remote),documentCount:Object.keys(remote.documents).length,message:'已回读云端资料，仅本机资料继续保留'};
 });
}
function affected(runtime,keys){
 const edits=pendingApplication(runtime),ids=new Set(edits.filter(item=>applicationMutationKeys(item).some(key=>keys.includes(key))).map(item=>item.id));let added;
 do{added=false;for(const item of edits)if(item.dependsOn&&ids.has(item.dependsOn)&&!ids.has(item.id)){ids.add(item.id);added=true;}}while(added);
 return{ids:[...ids],linkedIds:edits.filter(item=>ids.has(item.id)&&!keys.includes(item.key)).map(item=>item.id)};
}
function previewDto(plan){return{id:plan.id,mode:plan.mode,keys:plan.keys,adoptedKeys:plan.adoptedKeys,missingKeys:plan.missingKeys,discardedEdits:plan.affected.ids.length,linkedEdits:plan.affected.linkedIds.length,retainedPendingKeys:plan.retainedPendingKeys,backupDirectory:plan.backupDirectory,backupIntegrity:'ok',expiresAt:plan.expiresAt};}
export function previewCloudPull(runtime,input={}){
 return serial(runtime,'preview',async()=>{
  const queue=localCloudQueue(runtime),mode=input.mode||(queue.conflictKeys.length?'resolve_conflicts':'discard_local');if(!['resolve_conflicts','discard_local'].includes(mode)||mode==='resolve_conflicts'&&!queue.conflictKeys.length)throw Error('请重新核对本机冲突，再选择回读方式');
  const expected=fence(runtime),pair=runtime.store.get('pair'),scope=workbenchScope(pair),id=randomUUID(),remote=cloudSnapshot(pair,await runtime.cloud.request('snapshot'));assertCurrent(runtime,expected);
  const pendingNonConflicts=queue.pendingKeys.filter(key=>!queue.conflictKeys.includes(key)),keys=mode==='resolve_conflicts'&&pendingNonConflicts.length?queue.conflictKeys:cloudDocumentKeys;
  const adoptedKeys=keys.filter(key=>mode==='discard_local'||Object.hasOwn(remote.documents,key)),missingKeys=keys.filter(key=>!Object.hasOwn(remote.documents,key)),affectedEdits=affected(runtime,adoptedKeys);
  const saved=runtime.store.get('applicationSnapshot'),local=saved?.scope===scope?overlayApplication(runtime,saved.snapshot):{documents:{},revisions:{}};
  for(const item of pendingWorkbench(runtime))local.documents.submissionTimeline=globalThis.ExtLinkSubmissionTimeline.append(local.documents.submissionTimeline,item.event);
  const backupDirectory=join(runtime.backupRoot||join(homedir(),'.externallink-backups'),'cloud-pull-'+id),manifest=await backupWorkspace({home:runtime.home,output:backupDirectory});assertCurrent(runtime,expected);
  await writeFile(join(backupDirectory,'snapshot.json'),JSON.stringify(exportApplicationBackup(local.documents),null,2),{flag:'wx'});assertCurrent(runtime,expected);
  const plan={id,scope,pairSha256:cloudDigest(pair),fence:expected,mode,keys,adoptedKeys,missingKeys,affected:affectedEdits,retainedPendingKeys:queue.pendingKeys.filter(key=>!adoptedKeys.includes(key)),remote,remoteFence:cloudDigest(keys.map(key=>[key,Object.hasOwn(remote.documents,key),remote.documents[key],remote.revisions[key]])),backupDirectory,backupSha256:manifest.sha256,expiresAt:Date.now()+600000,at:at(),status:'preview'};
  runtime.store.set('cloudPullPreview:'+id,plan);return{ok:true,preview:previewDto(plan)};
 });
}
async function verifyBackup(plan){
 const manifest=JSON.parse(await readFile(join(plan.backupDirectory,'manifest.json'),'utf8'));if(manifest.sha256!==plan.backupSha256||manifest.integrity!=='ok')throw Error('原备份证明已变化，请重新备份和预览');
 const hash=createHash('sha256');for await(const chunk of createReadStream(join(plan.backupDirectory,'outbox.sqlite')))hash.update(chunk);if(hash.digest('hex')!==plan.backupSha256)throw Error('原备份完整性校验失败，未采用云端');
}
function settlePlans(runtime){
 const scope=workbenchScope(runtime.store.get('pair'));
 for(const plan of runtime.store.values('applicationPlan:'))if(plan.scope===scope){const entries=plan.items.map(item=>runtime.store.get('appMutation:'+item.id));if(entries.every(item=>['confirmed','discarded'].includes(item?.status))){plan.status='completed';plan.excludedIds=entries.filter(item=>item.status==='discarded').map(item=>item.id);runtime.store.set('applicationPlan:'+plan.id,plan);}}
 for(const plan of runtime.store.values('backupImport:'))if(plan.scope===scope&&plan.status==='queued'&&plan.items?.length){const entries=plan.items.map(id=>runtime.store.get('appMutation:'+id));if(entries.every(item=>['confirmed','discarded'].includes(item?.status))){plan.excludedKeys=entries.filter(item=>item.status==='discarded').map(item=>item.key);plan.status=plan.excludedKeys.length?'completed_with_exclusions':'completed';runtime.store.set('backupImport:'+plan.id,plan);}}
}
export function commitCloudPull(runtime,input={}){
 if(input.confirmed!==true||typeof input.previewId!=='string')return Promise.reject(Error('请先备份并明确确认原云端回读预览'));
 const receipt=runtime.store.get('cloudPullReceipt:'+input.previewId);if(receipt){if(receipt.pairSha256!==cloudDigest(runtime.store.get('pair')))return Promise.reject(Error('云端连接已变化，原回读回执保留'));return Promise.resolve({...receipt.result,recovered:true});}
 return serial(runtime,'commit:'+input.previewId,async()=>{
  const plan=runtime.store.get('cloudPullPreview:'+input.previewId);if(!plan||plan.status!=='preview'||plan.expiresAt<Date.now())throw Error('原回读预览不存在或已过期，请重新备份预览');assertCurrent(runtime,plan.fence);
  await verifyBackup(plan);assertCurrent(runtime,plan.fence);
  const remote=cloudSnapshot(runtime.store.get('pair'),await runtime.cloud.request('snapshot'));assertCurrent(runtime,plan.fence);
  if(cloudDigest(plan.keys.map(key=>[key,Object.hasOwn(remote.documents,key),remote.documents[key],remote.revisions[key]]))!==plan.remoteFence)throw Error('云端资料在确认期间变化，请重新预览；原修改保留');
  const ids=new Set(plan.affected.ids),keys=plan.adoptedKeys,now=at(),discardedTimeline=keys.includes('submissionTimeline')?pendingWorkbench(runtime):[];
  runtime.store.db.exec('BEGIN IMMEDIATE');try{
   for(const item of pendingApplication(runtime))if(ids.has(item.id))runtime.store.set('appMutation:'+item.id,{...item,status:'discarded',discardedAt:now,resolution:{choice:'cloud',cloudPullId:plan.id,at:now,remoteData:remote.documents[item.key],remoteRevision:remote.revisions[item.key],originalBaseData:item.baseData},error:plan.affected.linkedIds.includes(item.id)?'原前置资料已采用云端，关联修改一并保留在备份，不再上传':'已确认采用云端，本机原修改保留在备份'});
   if(keys.includes('siteProfiles'))for(const item of pendingMediaUploads(runtime))runtime.store.set('mediaUpload:'+item.assetId,{...item,status:'retained',cloudPullId:plan.id,error:'已采用云端产品资料，原媒体保留在本机备份'});
   for(const item of pendingFillLearning(runtime)){
    const excluded=[...new Set([...(item.cloudExcludedKeys||[]),...keys.filter(key=>['siteProfiles','siteAnnotations'].includes(key))])];if(!excluded.length)continue;item.cloudExcludedKeys=excluded;item.excludedProfile||=excluded.includes('siteProfiles');
    const entries=item.applicationPlanId?runtime.store.get('applicationPlan:'+item.applicationPlanId)?.items||[]:[];
    if(item.applicationPlanId?entries.length&&entries.every(entry=>['confirmed','discarded'].includes(runtime.store.get('appMutation:'+entry.id)?.status)):excluded.includes('siteAnnotations')&&(excluded.includes('siteProfiles')||!Object.keys(item.mappings||{}).length))item.status='completed_with_exclusions';
    item.cloudPullId=plan.id;runtime.store.set('fillLearning:'+item.id,item);
   }
   if(discardedTimeline.length){const discardedIds=new Set(discardedTimeline.map(item=>item.event.id));runtime.store.set('workbenchJournalPending',(runtime.store.get('workbenchJournalPending')||[]).filter(item=>item.scope!==plan.scope||!discardedIds.has(item.event.id)));}
   adoptSnapshot(runtime,remote,plan.keys,plan.mode==='discard_local');settlePlans(runtime);
   const result={ok:true,applied:true,status:appliedStatus(runtime,remote),mode:plan.mode,adoptedKeys:keys,unresolvedKeys:localCloudQueue(runtime).conflictKeys,retainedPendingKeys:localCloudQueue(runtime).pendingKeys,backupDirectory:plan.backupDirectory,backupIntegrity:'ok',previewId:plan.id,message:'已采用核对的云端资料，原本机修改已备份，原任务和批次保留'};
   runtime.store.set('cloudPullReceipt:'+plan.id,{pairSha256:plan.pairSha256,result,discardedTimeline,at:now});runtime.store.set('cloudPullPreview:'+plan.id,{...plan,status:'applied',appliedAt:now});runtime.store.db.exec('COMMIT');return result;
  }catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
 });
}
