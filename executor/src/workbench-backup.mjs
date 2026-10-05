import {randomUUID} from 'node:crypto';
import {exportApplicationBackup,mergeApplicationBackup,applicationBackupFragment} from '../../core/application-backup.mjs';
import {backupUpload} from './backup-upload.mjs';
import {applicationData} from './application-data.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {pendingApplication,overlayApplication,flushApplicationMutations} from './application-mutations.mjs';
export async function workbenchBackup(runtime,action,input={}){
 if(['backupUploadStart','backupUploadPart','backupUploadComplete'].includes(action))return backupUpload(runtime,action,input,(backup,source)=>workbenchBackup(runtime,'previewBackup',{backup,source}));
 if(action==='exportBackup'){
  await applicationData(runtime,{refresh:true});const snapshot=overlayApplication(runtime,runtime.store.get('applicationSnapshot').snapshot);
  return{ok:true,data:exportApplicationBackup(snapshot.documents),pendingEdits:pendingApplication(runtime).length};
 }
 if(action==='previewBackup'){
  const expectedScope=workbenchScope(runtime.store.get('pair'));
  await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('请先同步或解决待处理的本机编辑，再导入备份');
  if(expectedScope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，请重新预览原备份');
  const snapshot=runtime.store.get('applicationSnapshot').snapshot,merged=mergeApplicationBackup(snapshot.documents,input.backup),id=randomUUID(),scope=workbenchScope(runtime.store.get('pair'));
  const previous=input.source?.previousPreviewId&&runtime.store.get('backupImport:'+input.source.previousPreviewId);
  if(previous?.scope===scope&&previous.source?.id===input.source.id&&previous.status==='preview'){
   if(previous.changes.every(key=>(snapshot.revisions[key]||0)===(previous.revisions[key]||0)))return{ok:true,preview:previous.preview};
   runtime.store.set('backupImport:'+previous.id,{...previous,status:'superseded',supersededBy:id});
  }
  const changes=Object.keys(merged).filter(k=>JSON.stringify(merged[k])!==JSON.stringify(snapshot.documents[k]));
  const preview={id,changes,recordsImported:Object.keys(input.backup.submissionRecords||{}).length,profilesImported:Object.keys(input.backup.siteProfiles||{}).length,targetsImported:input.backup.sheetTableData?.entries?.length||0};
  runtime.store.set('backupImport:'+id,{id,scope,backup:input.backup,source:input.source,preview,operationFormat:'key_fragments_v1',baseDocuments:snapshot.documents,revisions:snapshot.revisions,changes,status:'preview',at:new Date().toISOString()});
  return{ok:true,preview};
 }
 const plan=runtime.store.get('backupImport:'+input.id);if(!plan||plan.scope!==workbenchScope(runtime.store.get('pair')))throw Error('备份预览不存在');
 const operation=(id,key)=>({id,at:plan.at,type:plan.operationFormat==='key_fragments_v1'?'backup_key_merge':'backup_merge',key,backup:plan.operationFormat==='key_fragments_v1'?applicationBackupFragment(plan.backup,key):plan.backup});
 if(plan.status==='preview'){
  const current=await runtime.cloud.request('snapshot');for(const key of plan.changes)if((current.revisions[key]||0)!==(plan.revisions[key]||0))throw Error('云端资料已变化，请重新预览备份');
  if(plan.scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原备份保留');
  const items=plan.changes.map(key=>{const id=randomUUID();return{id,scope:plan.scope,at:plan.at,key,baseData:plan.baseDocuments[key],status:'pending',operation:operation(id,key),backupImportId:plan.id};});
  // Persist the original import and IDs before sending any cloud write.
  plan.status='queued';plan.items=items.map(i=>i.id);runtime.store.set('backupImport:'+plan.id,plan);for(const item of items)runtime.store.set('appMutation:'+item.id,item);
 }else if(plan.status==='queued'){
  for(let i=0;i<plan.items.length;i++){const id=plan.items[i],key=plan.changes[i];if(!runtime.store.get('appMutation:'+id))runtime.store.set('appMutation:'+id,{id,scope:plan.scope,at:plan.at,key,baseData:plan.baseDocuments[key],status:'pending',operation:operation(id,key),backupImportId:plan.id});}
 }
 const result=await flushApplicationMutations(runtime),remaining=(plan.items||[]).filter(id=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+id)?.status));
 const excludedKeys=(plan.items||[]).map(id=>runtime.store.get('appMutation:'+id)).filter(item=>item?.status==='discarded').map(item=>item.key);
 if(!remaining.length){plan.status=excludedKeys.length?'completed_with_exclusions':'completed';plan.excludedKeys=excludedKeys;runtime.store.set('backupImport:'+plan.id,plan);}
 return{ok:true,id:plan.id,status:plan.status,remaining:remaining.length,excludedKeys,...result};
}
