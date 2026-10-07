import {createHash,randomUUID} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Cloud} from './cloud.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {backupWorkspace} from './migration-backup.mjs';
import {taskSummary} from '../../core/application-model.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at=()=>new Date().toISOString();
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const connectionIdentity=pair=>pair?digest([new URL(pair.endpoint).origin,pair.workspaceId,pair.deviceId||'',pair.storageBackend==='d1'?'d1':'neon']):null;
const tableExists=(store,name)=>!!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const summary=pair=>({id:connectionIdentity(pair),endpoint:pair.endpoint,workspaceId:pair.workspaceId,deviceId:pair.deviceId});
export function assertConnectionIdle(runtime){
 if(runtime.store.get('paused')!==true||['job','hydrating','singlePageFill','localRecoveryOperation','fillLearningFlush','linkMonitorJob','linkMonitorStarting','publicLibraryJob','domainAgeJob','quickOpenJob','quickOpenStarting','cloudPullOperation','cloudPushOperation','workbenchTimelineBusy','appMutationFlush','mediaUploadFlush','browserAssistantScan','manualWatchJob','activeTaskId'].some(key=>runtime[key])||runtime.indexNowJobs?.size||runtime.backupImportOperations?.size||runtime.connectionExternalBusy?.()||runtime.activeTaskIds?.size||runtime.store.values('manualWatch:').some(item=>item.status==='checking'))throw Error('请先暂停并等待当前网页、同步和后台操作结束，再更新连接');
}
function enrollment(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||!['d1','neon','legacy',undefined].includes(input.storageBackend)||typeof input.endpoint!=='string'||typeof input.workspaceId!=='string'||!input.workspaceId.trim()||typeof input.deviceId!=='string'||!input.deviceId.trim()||typeof input.deviceToken!=='string'||!input.deviceToken.startsWith('eld_')||input.deviceToken.length>4096)throw Error('请选择有效的设备登记文件');
 let url;try{url=new URL(input.endpoint);}catch{throw Error('云端地址无效');}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('云端地址必须是 HTTPS 服务地址');
 return{endpoint:url.origin,workspaceId:input.workspaceId,deviceId:input.deviceId,deviceToken:input.deviceToken,storageBackend:input.storageBackend||'neon'};
}
function validateSnapshot(config,snapshot){
 if(snapshot?.deviceId!==config.deviceId||snapshot.workspaceId!==config.workspaceId||!snapshot.documents||typeof snapshot.documents!=='object'||Array.isArray(snapshot.documents)||!snapshot.revisions||typeof snapshot.revisions!=='object'||Array.isArray(snapshot.revisions))throw Error('云端设备、工作区或资料范围不一致，原连接保留');
}
const stateRows=store=>store.db.prepare("SELECT id,value FROM state WHERE id NOT LIKE 'connectionPreview:%' AND id NOT LIKE 'assistantFill:%' AND id NOT IN ('applicationSnapshot','workbenchDocuments','singlePagePanel') ORDER BY id").all();
const fence=store=>digest([stateRows(store),stable(store.get('applicationSnapshot')?.snapshot),stable(store.get('workbenchDocuments')?.snapshot),store.db.prepare('SELECT * FROM outbox ORDER BY seq').all(),store.db.prepare('SELECT * FROM audit_log ORDER BY seq').all()]);
function assertPreviewCurrent(runtime,preview){
 if(preview.expiresAt<Date.now()||preview.fromPairSha256!==digest(runtime.store.get('pair'))||preview.fence!==fence(runtime.store))throw Error('连接或本机资料已变化，请重新预览；原台账与待同步内容保留');
 assertConnectionIdle(runtime);
}
export async function connectionProfiles(runtime){
 const pair=runtime.store.get('pair');if(!pair)throw Error('请先连接云端');
 const saved=tableExists(runtime.store,'connection_profiles')?runtime.store.db.prepare('SELECT * FROM connection_profiles ORDER BY saved_at DESC').all().map(row=>({id:row.id,endpoint:row.endpoint,workspaceId:row.workspace_id,deviceId:row.device_id,savedAt:row.saved_at,tasks:runtime.store.db.prepare("SELECT count(*) AS n FROM connection_state WHERE connection_id=? AND id LIKE 'task:%'").get(row.id).n,pendingEvents:runtime.store.db.prepare('SELECT count(*) AS n FROM connection_outbox WHERE connection_id=?').get(row.id).n})):[];
 return{ok:true,current:{...summary(pair),tasks:runtime.store.values('task:').length,pendingEvents:runtime.store.pendingCount()},saved:saved.filter(item=>item.id!==connectionIdentity(pair)),lifecyclePending:runtime.store.get('connectionLifecyclePending'),enrollmentAvailable:await stat(join(runtime.home,'enrollment.json')).then(info=>info.isFile(),()=>false)};
}
export function connectionHistory(runtime,input){
 const row=runtime.store.db.prepare('SELECT * FROM connection_profiles WHERE id=?').get(input.connectionId),after=input.after||0;
 if(!row||!Number.isSafeInteger(after)||after<0)throw Error('原连接记录或游标无效');
 const entries=runtime.store.db.prepare("SELECT position,value FROM connection_state WHERE connection_id=? AND id LIKE 'task:%' AND position>? ORDER BY position LIMIT 51").all(row.id,after),snapshotRow=runtime.store.db.prepare("SELECT value FROM connection_state WHERE connection_id=? AND id='applicationSnapshot'").get(row.id),snapshot=snapshotRow?JSON.parse(snapshotRow.value):null;
 return{ok:true,connection:{id:row.id,endpoint:row.endpoint,workspaceId:row.workspace_id,deviceId:row.device_id},products:Object.entries(snapshot?.snapshot?.documents?.siteProfiles||{}).map(([id,profile])=>({id,name:profile.name||profile.fields?.Name||id})),tasks:entries.slice(0,50).map(item=>taskSummary(JSON.parse(item.value))),next:entries.length>50?entries[49].position:null,readOnly:true};
}
export async function previewConnection(runtime,input={}){
 const pair=runtime.store.get('pair');if(!pair)throw Error('请先使用首次连接页面');assertConnectionIdle(runtime);
 const before=fence(runtime.store),pairHash=digest(pair);let config;
 if(input.connectionId){
  const row=runtime.store.db.prepare("SELECT value FROM connection_state WHERE connection_id=? AND id='pair'").get(input.connectionId);if(!row)throw Error('原连接记录不存在');config=enrollment(JSON.parse(row.value));
 }else config=enrollment(input.enrollment||JSON.parse(await readFile(join(runtime.home,'enrollment.json'),'utf8')));
 const identity=connectionIdentity(config),same=identity===connectionIdentity(pair),saved=runtime.store.db.prepare('SELECT id FROM connection_profiles WHERE id=?').get(identity);
 const savedPair=saved?JSON.parse(runtime.store.db.prepare("SELECT value FROM connection_state WHERE connection_id=? AND id='pair'").get(identity).value):null;
 if(same)config.endpoint=pair.endpoint;else if(savedPair)config.endpoint=savedPair.endpoint;
 const snapshot=await new (runtime.CloudClass||Cloud)(config).request('snapshot');validateSnapshot(config,snapshot);
 if(pairHash!==digest(runtime.store.get('pair'))||before!==fence(runtime.store))throw Error('核验期间连接或本机资料已变化，请重新预览');assertConnectionIdle(runtime);
 const id=randomUUID(),preview={id,fromPairSha256:pairHash,fromId:connectionIdentity(pair),fence:before,targetConfig:config,targetId:identity,snapshot,expiresAt:Date.now()+600000,kind:same?'update':saved?'restore':'switch'};
 runtime.store.set('connectionPreview:'+id,preview);
 const archivedTasks=saved?runtime.store.db.prepare("SELECT count(*) AS n FROM connection_state WHERE connection_id=? AND id LIKE 'task:%'").get(identity).n:0;
 return{ok:true,preview:{id,kind:preview.kind,expiresAt:preview.expiresAt,current:{...summary(pair),tasks:runtime.store.values('task:').length,pendingEvents:runtime.store.pendingCount()},target:{...summary(config),profiles:Object.keys(snapshot.documents.siteProfiles||{}).length,localTasks:same?runtime.store.values('task:').length:archivedTasks},preservesOriginalData:true,startsSubmission:false}};
}
function archiveCurrent(store,pair){
 const id=connectionIdentity(pair);store.db.prepare('INSERT INTO connection_profiles VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET saved_at=excluded.saved_at').run(id,pair.endpoint,pair.workspaceId,pair.deviceId||'',at());
 for(const table of ['connection_state','connection_outbox','connection_audit'])store.db.prepare('DELETE FROM '+table+' WHERE connection_id=?').run(id);
 store.db.prepare("INSERT INTO connection_state SELECT ?,id,value,rowid FROM state WHERE id NOT LIKE 'connectionPreview:%'").run(id);
 store.db.prepare('INSERT INTO connection_outbox SELECT ?,seq,id,value FROM outbox').run(id);
 store.db.prepare('INSERT INTO connection_audit SELECT ?,seq,event_id,scope,run_id,task_id,value FROM audit_log').run(id);
}
async function finishLifecycle(runtime,result,previewId){
 try{await runtime.onConnectionChanged?.();runtime.store.set('connectionLifecyclePending',null);return result;}
 catch(error){runtime.store.set('connectionLifecyclePending',{previewId,error:String(error.message||error)});return{...result,lifecycleWarning:'连接已保存并保持暂停；后台初始化待重试：'+String(error.message||error),lifecyclePending:true};}
}
export async function commitConnection(runtime,input,{expectedId}={}){
 if(input.confirmed!==true)throw Error('请先核对连接预览，再确认更新或切换');
 if(runtime.connectionBusy)throw Error('连接更新正在进行，请等待原请求结果');
 const receipt=runtime.store.db.prepare('SELECT * FROM connection_commits WHERE id=?').get(input.previewId);
 if(receipt){
  if(connectionIdentity(runtime.store.get('pair'))!==receipt.to_id||digest(runtime.store.get('pair'))!==receipt.pair_sha256||expectedId&&![receipt.from_id,receipt.to_id].includes(expectedId))throw Error('当前连接已再次变化，请刷新核对');
  const pending=runtime.store.get('connectionLifecyclePending'),result={...JSON.parse(receipt.result),recovered:true,paused:runtime.store.get('paused')!==false};
  if(pending?.previewId!==input.previewId)return pending?{...result,lifecyclePending:true,lifecycleWarning:'当前连接后台初始化仍待重试，请查看当前连接的原记录'}:result;
  assertConnectionIdle(runtime);runtime.connectionBusy=true;try{return await finishLifecycle(runtime,result,input.previewId);}finally{runtime.connectionBusy=false;}
 }
 const preview=runtime.store.get('connectionPreview:'+input.previewId);if(!preview||expectedId&&preview.fromId!==expectedId)throw Error('原连接预览不存在或已变化，请重新预览');assertPreviewCurrent(runtime,preview);
 runtime.connectionBusy=true;let changed=false;
 try{
  const fresh=await new (runtime.CloudClass||Cloud)(preview.targetConfig).request('snapshot');validateSnapshot(preview.targetConfig,fresh);
  if(digest(stable(fresh.revisions))!==digest(stable(preview.snapshot.revisions)))throw Error('目标云端资料已有新版本，请重新预览');assertPreviewCurrent(runtime,preview);
  const backupDirectory=join(runtime.backupRoot||join(runtime.home,'connection-backups'),'connection-'+preview.id+'-'+randomUUID());
  const backup=await backupWorkspace({home:runtime.home,output:backupDirectory});assertPreviewCurrent(runtime,preview);
  await runtime.onConnectionChanging?.();assertPreviewCurrent(runtime,preview);
  const old=runtime.store.get('pair'),switching=preview.kind!=='update';let pair;
  runtime.store.db.exec('BEGIN IMMEDIATE');
  try{
   if(preview.fromPairSha256!==digest(runtime.store.get('pair')))throw Error('原连接已变化');
   if(switching){
    archiveCurrent(runtime.store,old);
    runtime.store.db.exec('DELETE FROM state; DELETE FROM outbox; DELETE FROM audit_log;');
    if(preview.kind==='restore'){
     runtime.store.db.prepare('INSERT INTO state(id,value) SELECT id,value FROM connection_state WHERE connection_id=? ORDER BY position').run(preview.targetId);
     runtime.store.db.prepare('INSERT INTO outbox(seq,id,value) SELECT seq,id,value FROM connection_outbox WHERE connection_id=? ORDER BY seq').run(preview.targetId);
     runtime.store.db.prepare('INSERT INTO audit_log SELECT seq,event_id,scope,run_id,task_id,value FROM connection_audit WHERE connection_id=? ORDER BY seq').run(preview.targetId);
    }else runtime.store.set('gmailCredentialScope',join(runtime.home,'connection-vault-'+preview.targetId));
   }
   pair={...(switching?runtime.store.get('pair')||{}:old),...preview.targetConfig,localToken:old.localToken,...(old.origin?{origin:old.origin}:{})};runtime.store.set('pair',pair);runtime.store.set('paused',true);
   runtime.store.set('connectionExecutionHold',{connectionId:preview.targetId,at:at(),reason:'云端连接已更新，执行保持暂停；请核对原范围后明确继续'});
   runtime.store.set('connectionLifecyclePending',{previewId:preview.id});
   if(switching&&!runtime.store.get('executorControllerId'))runtime.store.set('executorControllerId',randomUUID());
   if(switching&&!runtime.store.get('applicationSnapshot'))runtime.store.set('applicationSnapshot',{scope:workbenchScope(pair),at:at(),snapshot:fresh});
   const panel=runtime.store.get('singlePagePanel');if(panel)runtime.store.set('singlePagePanel',{...panel,open:false,generation:panel.generation+1});
   const assistant=runtime.store.get('browserAssistantSettings');if(switching&&assistant)runtime.store.set('browserAssistantSettings',{...assistant,enabled:false});
   runtime.store.db.prepare("DELETE FROM state WHERE id LIKE 'connectionPreview:%'").run();
   const result={ok:true,connection:summary(pair),kind:preview.kind,backupDirectory,backupIntegrity:backup.integrity,originalDataPreserved:true,paused:true,startsSubmission:false};
   runtime.store.db.prepare('INSERT INTO connection_commits VALUES(?,?,?,?,?)').run(preview.id,preview.fromId,preview.targetId,digest(pair),JSON.stringify(result));runtime.store.db.exec('COMMIT');changed=true;
   if(switching){runtime.controllerId=runtime.store.get('executorControllerId');runtime.hydrated=false;runtime.workbenchJournalSync=null;runtime.syncRetryAt=0;runtime.syncFailures=0;runtime.activeTaskId=null;runtime.activeTaskIds?.clear();}
   runtime.cloudError='';runtime.lastCloudNetworkFailure=null;return await finishLifecycle(runtime,result,preview.id);
  }catch(error){if(!changed)runtime.store.db.exec('ROLLBACK');throw error;}
 }finally{runtime.connectionBusy=false;if(!changed)await runtime.onConnectionChangeAborted?.();}
}
