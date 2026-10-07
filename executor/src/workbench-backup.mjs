import {randomUUID} from 'node:crypto';
import {exportApplicationBackup,prepareApplicationBackup,applicationBackupFragment} from '../../core/application-backup.mjs';
import {remapProfileRecoveryKey} from '../../core/profile-recovery-source.mjs';
import {preparedBackupPatch} from '../../core/prepared-backup-key.mjs';
import {backupUpload} from './backup-upload.mjs';
import {applicationData} from './application-data.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {pendingApplication,overlayApplication,flushApplicationMutations} from './application-mutations.mjs';
export async function workbenchBackup(runtime,action,input={}){
 if(action!=='importBackup')return performWorkbenchBackup(runtime,action,input);
 const operations=runtime.backupImportOperations||=new Map(),key=workbenchScope(runtime.store.get('pair'))+'\n'+input.id;
 if(operations.has(key))return operations.get(key);
 if(operations.size)throw Error('已有备份正在导入，请等待原导入完成');
 const operation=performWorkbenchBackup(runtime,action,input);operations.set(key,operation);try{return await operation;}finally{if(operations.get(key)===operation)operations.delete(key);}
}
async function performWorkbenchBackup(runtime,action,input){
 if(['backupUploadStart','backupUploadPart','backupUploadComplete'].includes(action))return backupUpload(runtime,action,input,(backup,source)=>workbenchBackup(runtime,'previewBackup',{backup,source}));
 if(action==='exportBackup'){
  await applicationData(runtime,{refresh:true});const snapshot=overlayApplication(runtime,runtime.store.get('applicationSnapshot').snapshot);
  return{ok:true,data:exportApplicationBackup(snapshot.documents),pendingEdits:pendingApplication(runtime).length};
 }
 if(action==='previewBackup'){
  const expectedScope=workbenchScope(runtime.store.get('pair'));
  await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('请先同步或解决待处理的本机编辑，再导入备份');
  if(expectedScope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，请重新预览原备份');
  const cached=runtime.store.get('applicationSnapshot'),snapshot=cached.remoteSnapshot||cached.snapshot,prepared=prepareApplicationBackup(snapshot.documents,input.backup),merged=prepared.documents,id=randomUUID(),scope=workbenchScope(runtime.store.get('pair'));
  const previous=input.source?.previousPreviewId&&runtime.store.get('backupImport:'+input.source.previousPreviewId);
  if(previous?.scope===scope&&previous.source?.id===input.source.id&&previous.status==='preview'){
   if(previous.changes.every(key=>(snapshot.revisions[key]||0)===(previous.revisions[key]||0)))return{ok:true,preview:previous.preview};
   runtime.store.set('backupImport:'+previous.id,{...previous,status:'superseded',supersededBy:id});
  }
  const changed=Object.keys(merged).filter(k=>JSON.stringify(merged[k])!==JSON.stringify(snapshot.documents[k])),changes=changed.includes('siteProfiles')?['siteProfiles',...changed.filter(key=>key!=='siteProfiles')]:changed,dependencyKeys=prepared.dependencyKeys.filter(key=>changes.includes(key));
  const profilesPrepared=Object.keys(globalThis.ExtLinkProfiles.stabilizeTableProfiles(input.backup.sheetTableData?.projects||{},input.backup.siteProfiles||{}).profiles).length;
  const preview={id,changes,dependencyKeys,recordsImported:Object.keys(input.backup.submissionRecords||{}).length,profilesImported:Object.keys(input.backup.siteProfiles||{}).length,profilesPrepared,targetsImported:input.backup.sheetTableData?.entries?.length||0};
  const readKeys=[...new Set([...changes,...(dependencyKeys.length?['siteProfiles','sheetTableData','siteAnnotations','submissionRecords','submissionTimeline','linkMonitorResults']:[])])];
  runtime.store.set('backupImport:'+id,{id,scope,backup:input.backup,source:input.source,preview,preparedDocuments:merged,profileIdMap:prepared.profileIdMap,dependencyKeys,readKeys,operationFormat:'prepared_keys_v2',baseDocuments:snapshot.documents,revisions:snapshot.revisions,changes,status:'preview',at:new Date().toISOString()});
  return{ok:true,preview};
 }
 const plan=runtime.store.get('backupImport:'+input.id);if(!plan||plan.scope!==workbenchScope(runtime.store.get('pair')))throw Error('备份预览不存在');
 if(pendingApplication(runtime).some(item=>item.backupImportId!==plan.id))throw Error('请先同步或解决其他本机编辑，再继续原备份导入');
 if(plan.status==='queued'&&runtime.status().paused===true){if(runtime.job)await runtime.job;if(runtime.appMutationFlush)await runtime.appMutationFlush;}
 if(plan.scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原备份保留');
 if(runtime.status().paused!==true||runtime.job||runtime.singlePageFill||runtime.localRecoveryOperation||runtime.mediaUploadFlush||runtime.appMutationFlush||runtime.browserAssistantScan)throw Error('请先暂停并等待后台操作结束，再合并备份');
 if(pendingApplication(runtime).some(item=>item.backupImportId!==plan.id))throw Error('请先同步或解决其他本机编辑，再继续原备份导入');
 const operation=(id,key)=>plan.operationFormat==='prepared_keys_v2'?{id,at:plan.at,type:'backup_prepared_key',key,profileIdMap:plan.profileIdMap||{},patch:preparedBackupPatch(remapProfileRecoveryKey(plan.baseDocuments[key],key,plan.profileIdMap||{}),plan.preparedDocuments[key])}:{id,at:plan.at,type:plan.operationFormat==='key_fragments_v1'?'backup_key_merge':'backup_merge',key,backup:plan.operationFormat==='key_fragments_v1'?applicationBackupFragment(plan.backup,key):plan.backup};
 if(plan.status==='preview'){
  const current=await runtime.cloud.request('snapshot');for(const key of plan.readKeys||plan.changes)if((current.revisions[key]||0)!==(plan.revisions[key]||0))throw Error('云端资料已变化，请重新预览备份');
  if(plan.scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原备份保留');
  let previous;const items=plan.changes.map(key=>{const id=randomUUID(),related=plan.dependencyKeys?.includes(key),item={id,scope:plan.scope,at:plan.at,key,baseData:plan.baseDocuments[key],baseRevision:plan.revisions[key]||0,status:'pending',operation:operation(id,key),backupImportId:plan.id,...(related&&previous?{dependsOn:previous}:{})};if(related)previous=id;return item;});
  // Persist the original import and IDs before sending any cloud write.
  plan.status='queued';plan.items=items.map(i=>i.id);plan.itemDependencies=Object.fromEntries(items.filter(item=>item.dependsOn).map(item=>[item.id,item.dependsOn]));
  runtime.store.db.exec('BEGIN IMMEDIATE');try{runtime.store.set('backupImport:'+plan.id,plan);for(const item of items)runtime.store.set('appMutation:'+item.id,item);runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
 }else if(plan.status==='queued'){
  for(let i=0;i<plan.items.length;i++){const id=plan.items[i],key=plan.changes[i];if(!runtime.store.get('appMutation:'+id))runtime.store.set('appMutation:'+id,{id,scope:plan.scope,at:plan.at,key,baseData:plan.baseDocuments[key],baseRevision:plan.revisions[key]||0,status:'pending',operation:operation(id,key),backupImportId:plan.id,...(plan.itemDependencies?.[id]?{dependsOn:plan.itemDependencies[id]}:{})});}
 }
 const result=await flushApplicationMutations(runtime),remaining=(plan.items||[]).filter(id=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+id)?.status));
 const excludedKeys=(plan.items||[]).map(id=>runtime.store.get('appMutation:'+id)).filter(item=>item?.status==='discarded').map(item=>item.key);
 if(!remaining.length){plan.status=excludedKeys.length?'completed_with_exclusions':'completed';plan.excludedKeys=excludedKeys;runtime.store.set('backupImport:'+plan.id,plan);}
 return{ok:true,id:plan.id,status:plan.status,remaining:remaining.length,excludedKeys,...result};
}
