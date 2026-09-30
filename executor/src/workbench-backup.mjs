import {randomUUID} from 'node:crypto';
import {exportApplicationBackup,mergeApplicationBackup} from '../../core/application-backup.mjs';
import {applicationData} from './application-data.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {pendingApplication,overlayApplication,flushApplicationMutations} from './application-mutations.mjs';
export async function workbenchBackup(runtime,action,input={}){
 if(action==='exportBackup'){
  await applicationData(runtime,{refresh:true});const snapshot=overlayApplication(runtime,runtime.store.get('applicationSnapshot').snapshot);
  return{ok:true,data:exportApplicationBackup(snapshot.documents),pendingEdits:pendingApplication(runtime).length};
 }
 if(action==='previewBackup'){
  await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('请先同步或解决待处理的本机编辑，再导入备份');
  const snapshot=runtime.store.get('applicationSnapshot').snapshot,merged=mergeApplicationBackup(snapshot.documents,input.backup),id=randomUUID(),scope=workbenchScope(runtime.store.get('pair'));
  const changes=Object.keys(merged).filter(k=>JSON.stringify(merged[k])!==JSON.stringify(snapshot.documents[k]));
  runtime.store.set('backupImport:'+id,{id,scope,backup:input.backup,baseDocuments:snapshot.documents,revisions:snapshot.revisions,changes,status:'preview',at:new Date().toISOString()});
  return{ok:true,preview:{id,changes,recordsImported:Object.keys(input.backup.submissionRecords||{}).length,profilesImported:Object.keys(input.backup.siteProfiles||{}).length,targetsImported:input.backup.sheetTableData?.entries?.length||0}};
 }
 const plan=runtime.store.get('backupImport:'+input.id);if(!plan||plan.scope!==workbenchScope(runtime.store.get('pair')))throw Error('备份预览不存在');
 if(plan.status==='preview'){
  const current=await runtime.cloud.request('snapshot');for(const key of plan.changes)if((current.revisions[key]||0)!==(plan.revisions[key]||0))throw Error('云端资料已变化，请重新预览备份');
  const items=plan.changes.map(key=>{const id=randomUUID();return{id,scope:plan.scope,at:plan.at,key,baseData:plan.baseDocuments[key],status:'pending',operation:{id,at:plan.at,type:'backup_merge',key,backup:plan.backup},backupImportId:plan.id};});
  // Persist the original import and IDs before sending any cloud write.
  plan.status='queued';plan.items=items.map(i=>i.id);runtime.store.set('backupImport:'+plan.id,plan);for(const item of items)runtime.store.set('appMutation:'+item.id,item);
 }else if(plan.status==='queued'){
  for(let i=0;i<plan.items.length;i++){const id=plan.items[i],key=plan.changes[i];if(!runtime.store.get('appMutation:'+id))runtime.store.set('appMutation:'+id,{id,scope:plan.scope,at:plan.at,key,baseData:plan.baseDocuments[key],status:'pending',operation:{id,at:plan.at,type:'backup_merge',key,backup:plan.backup},backupImportId:plan.id});}
 }
 const result=await flushApplicationMutations(runtime),remaining=(plan.items||[]).filter(id=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+id)?.status));if(!remaining.length){plan.status='completed';runtime.store.set('backupImport:'+plan.id,plan);}return{ok:true,id:plan.id,status:plan.status,remaining:remaining.length,...result};
}
