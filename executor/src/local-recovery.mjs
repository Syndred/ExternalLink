import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,realpath,stat,mkdir} from 'node:fs/promises';
import {join,sep,resolve,basename} from 'node:path';
import {homedir} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {localRecoveryDocuments,localRecoveryOriginalDocuments,recoveryDocument} from '../../core/local-recovery.mjs';
import {profileRecoveryDependencyKeys} from '../../core/profile-recovery-source.mjs';
import {workbenchScope,pendingWorkbench} from './workbench-sync.mjs';
import {applicationData} from './application-data.mjs';
import {pendingApplication,enqueueApplicationPlan} from './application-mutations.mjs';
import {pendingFillLearning} from './fill-learning.mjs';
import {pendingMediaUploads} from './media-uploads.mjs';
import {backupWorkspace} from './migration-backup.mjs';
const sourceNames=new Set(['snapshot.json','recovered-documents.json','outbox.sqlite','before.sqlite','before-executor-activation.sqlite']);
const rootFor=runtime=>runtime.backupRoot||join(homedir(),'.externallink-backups');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hashFile(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
const sameScope=(runtime,scope)=>{if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，恢复停止，原计划保留');};
async function sourcePath(runtime,file){const root=await realpath(rootFor(runtime)),path=await realpath(file);if(!path.startsWith(root+sep)||!sourceNames.has(basename(path)))throw Error('恢复来源不在本机备份目录内');return path;}
async function rejectWal(path){const wal=await stat(path+'-wal').catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(wal?.size)throw Error('来源数据库有未合入日志，请使用完整的在线备份');}
async function readSource(runtime,file){
 const path=await sourcePath(runtime,file),info=await stat(path);if(!info.isFile())throw Error('恢复来源不是文件');let raw,workspaceId,scope,sha256;
 if(path.endsWith('.sqlite')){
  await rejectWal(path);const db=new DatabaseSync(path,{readOnly:true});
  try{const get=id=>{const row=db.prepare('SELECT value FROM state WHERE id=?').get(id);return row?JSON.parse(row.value):null;},pair=get('pair'),app=get('applicationSnapshot'),journal=get('workbenchDocuments');raw=app?.snapshot||journal?.snapshot;scope=app?.scope||journal?.scope||(pair?workbenchScope(pair):undefined);workspaceId=pair?.workspaceId;if(!raw)throw Error('此数据库没有产品资料快照，请选择JSON资料快照');}
  finally{db.close();}
  sha256=await hashFile(path);await rejectWal(path);
 }else{
  if(info.size>256*1024*1024)throw Error('恢复来源超过256MB');const bytes=await readFile(path);if(bytes.length>256*1024*1024)throw Error('恢复来源超过256MB');raw=JSON.parse(bytes.toString('utf8'));sha256=digest(bytes);workspaceId=raw.workspaceId;scope=raw.scope;
 }
 const after=await stat(path);if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw Error('本机来源在读取期间变化，请重试');
 const originalDocuments=localRecoveryOriginalDocuments(raw),documents=localRecoveryDocuments(raw),profileDependencies=profileRecoveryDependencyKeys(originalDocuments,documents);
 if(scope&&scope!==workbenchScope(runtime.store.get('pair'))||workspaceId&&workspaceId!==(runtime.store.get('pair')?.workspaceId||'default'))throw Error('恢复来源属于其他工作区');
 return{path,documents,profileDependencies,sha256,modifiedAt:info.mtime.toISOString(),bytes:info.size,scopeVerified:!!scope,scopeVerification:scope?'full':workspaceId?'workspace_only':'unscoped'};
}
const counts=docs=>({profiles:Object.keys(docs.siteProfiles||{}).length,records:Object.keys(docs.submissionRecords||{}).length,targets:docs.sheetTableData?.entries?.length||0,annotations:Object.keys(docs.siteAnnotations||{}).length,favorites:Object.values(docs.siteAnnotations||{}).filter(a=>a.library?.favorite).length});
export function localRecoveryPlans(runtime){
 const scope=workbenchScope(runtime.store.get('pair'));return runtime.store.values('localRecoveryPlan:').filter(p=>p.scope===scope&&p.applicationPlanId).map(p=>({id:p.id,at:p.at,status:p.status,sourceSha256:p.sourceSha256,keys:p.selectedKeys,backupSaved:!!p.backupDirectory,remaining:(runtime.store.get('applicationPlan:'+p.applicationPlanId)?.items||[]).filter(i=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+i.id)?.status)).length}));
}
async function captureLocalCache(runtime){
 const scope=workbenchScope(runtime.store.get('pair')),saved=[runtime.store.get('applicationSnapshot'),runtime.store.get('workbenchDocuments')].find(s=>s?.scope===scope&&(Object.keys(s.snapshot?.documents?.siteProfiles||{}).length||Object.keys(s.snapshot?.documents?.sheetTableData?.projects||{}).length));
 if(!saved)return;localRecoveryDocuments(saved.snapshot);const documents=localRecoveryOriginalDocuments(saved.snapshot),identity={scope,workspaceId:runtime.store.get('pair')?.workspaceId||'default',documents,revisions:saved.snapshot.revisions||{}},bytes=JSON.stringify({...identity,capturedAt:saved.at||null}),folder=join(rootFor(runtime),'local-cache-'+digest(JSON.stringify(identity)));
 await mkdir(folder,{recursive:true});sameScope(runtime,scope);await writeFile(join(folder,'snapshot.json'),bytes,{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
}
export async function localRecoverySources(runtime){
 await captureLocalCache(runtime);const scope=workbenchScope(runtime.store.get('pair')),root=rootFor(runtime),sources=[];let directories;
 try{directories=await readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return{ok:true,sources:[],plans:localRecoveryPlans(runtime)};throw error;}
 for(const dir of directories.filter(d=>d.isDirectory()))for(const name of sourceNames){const file=join(root,dir.name,name);if(!await stat(file).then(s=>s.isFile(),()=>false))continue;
  try{const value=await readSource(runtime,file),id=digest(resolve(value.path));sameScope(runtime,scope);runtime.store.set('localRecoverySource:'+id,{id,path:value.path,scope});sources.push({id,label:dir.name.startsWith('local-cache-')?'本机缓存资料 / '+value.modifiedAt:dir.name+' / '+name,modifiedAt:value.modifiedAt,bytes:value.bytes,scopeVerified:value.scopeVerified,scopeVerification:value.scopeVerification,keys:Object.keys(value.documents),...counts(value.documents)});}
  catch(error){sameScope(runtime,scope);sources.push({label:dir.name+' / '+name,unavailable:true,error:error.message});}
 }
 return{ok:true,sources,plans:localRecoveryPlans(runtime)};
}
export async function previewLocalRecovery(runtime,input){
 const source=runtime.store.get('localRecoverySource:'+input.sourceId),scope=workbenchScope(runtime.store.get('pair'));if(!source||source.scope!==scope)throw Error('请刷新并选择本工作区的本机备份');
 const value=await readSource(runtime,source.path);sameScope(runtime,scope);const fresh=await applicationData(runtime,{refresh:true});sameScope(runtime,scope);if(fresh.error)throw Error(fresh.error);if(pendingApplication(runtime).length)throw Error('请先同步或解决已有本机资料冲突');
 const snapshot=runtime.store.get('applicationSnapshot').snapshot,changes=Object.keys(value.documents).filter(key=>!isDeepStrictEqual(recoveryDocument(snapshot.documents,key,value.documents[key]),snapshot.documents[key])),id=randomUUID();
 const dependencyKeys=value.profileDependencies.filter(key=>changes.includes(key));
 runtime.store.set('localRecoveryPlan:'+id,{id,scope,sourceId:input.sourceId,sourceSha256:value.sha256,documents:value.documents,baseDocuments:snapshot.documents,revisions:snapshot.revisions,changes,dependencyKeys,status:'preview',at:new Date().toISOString()});
 return{ok:true,preview:{id,changes,dependencyKeys,sourceCounts:counts(value.documents),currentCounts:counts(snapshot.documents),scopeVerified:value.scopeVerified,scopeVerification:value.scopeVerification,sourceSha256:value.sha256}};
}
function ensureIdle(runtime){
 if(runtime.fillLearningFlush||pendingFillLearning(runtime).length)throw Error('请先同步已保存的字段学习记录，再恢复资料');
 if(runtime.job||runtime.store.get('paused')!==true||runtime.singlePageFill||runtime.manualWatchJob||runtime.linkMonitorJob||runtime.publicLibraryJob||runtime.domainAgeJob||runtime.quickOpenJob||runtime.browserAssistantScan||runtime.mediaUploadFlush||runtime.appMutationFlush||runtime.backupImportOperations?.size)throw Error('请先暂停并等待所有后台操作结束');
 if((runtime.store.pendingCount?.()||0)||pendingWorkbench(runtime).length||pendingMediaUploads(runtime).length)throw Error('请先同步已有投稿记录、人工动态和素材');
 if(runtime.store.get('browserAssistantSettings')?.enabled||runtime.sidepanelAutoTimers?.size||runtime.store.values('manualWatch:').some(w=>w.status==='checking'))throw Error('请先关闭自动填写和人工提交监听，再恢复资料');
}
export function recoverLocalDocuments(runtime,input){
 if(runtime.localRecoveryOperation)throw Error('已有本机恢复操作正在进行，请等待原计划完成');
 const operation=performRecovery(runtime,input);runtime.localRecoveryOperation=operation;return operation.finally(()=>{if(runtime.localRecoveryOperation===operation)runtime.localRecoveryOperation=null;});
}
async function performRecovery(runtime,input){
 if(input.confirmation!=='恢复所选本机资料')throw Error('请输入恢复所选本机资料确认文字');ensureIdle(runtime);
 const scope=workbenchScope(runtime.store.get('pair')),plan=runtime.store.get('localRecoveryPlan:'+input.id);if(!plan||plan.scope!==scope)throw Error('本机恢复预览不存在或工作区已变化');
 if(plan.status==='preview'){
  const source=runtime.store.get('localRecoverySource:'+plan.sourceId);if(!source||source.scope!==scope)throw Error('本机来源不存在，请重新预览');const latest=await readSource(runtime,source.path);sameScope(runtime,scope);if(latest.sha256!==plan.sourceSha256)throw Error('本机来源已经变化，请重新预览');
  if(pendingApplication(runtime).length)throw Error('请先同步或解决已有本机资料冲突');
  if(input.keys!==undefined&&!Array.isArray(input.keys))throw Error('请选择预览中的恢复资料');
  const selected=[...new Set(input.keys||plan.changes)];if(!selected.length||selected.some(k=>!plan.changes.includes(k)))throw Error('请选择预览中的恢复资料');
  const related=plan.dependencyKeys||[],restoringProducts=related.some(key=>selected.includes(key));
  if(restoringProducts&&related.some(key=>!selected.includes(key)))throw Error('旧产品编号及对应的历史资料需要一起恢复，请勾选关联资料');
  const remote=await runtime.cloud.request('snapshot');sameScope(runtime,scope);for(const key of selected)if((remote.revisions[key]||0)!==(plan.revisions[key]||0)||!isDeepStrictEqual(remote.documents[key],plan.baseDocuments[key]))throw Error('云端已变化，请重新比较恢复预览');
  if(!plan.backupDirectory){const output=join(rootFor(runtime),'before-local-recovery-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+plan.id),backup=await backupWorkspace({home:runtime.home,output});plan.backupDirectory=output;plan.backupSha256=backup.sha256;runtime.store.set('localRecoveryPlan:'+plan.id,plan);}
  sameScope(runtime,scope);ensureIdle(runtime);const beforeWrite=await readSource(runtime,source.path);sameScope(runtime,scope);if(beforeWrite.sha256!==plan.sourceSha256)throw Error('本机来源在备份期间变化，请重新预览');
  const ordered=restoringProducts?[...selected.filter(key=>key==='siteProfiles'),...selected.filter(key=>key!=='siteProfiles')]:selected;
  const result=await enqueueApplicationPlan(runtime,{operations:ordered.map(key=>({type:'recover_local',key,data:plan.documents[key]})),dependencyKind:restoringProducts?'profile_recovery':undefined},child=>{plan.applicationPlanId=child;plan.selectedKeys=selected;plan.status='queued';runtime.store.set('localRecoveryPlan:'+plan.id,plan);});
  sameScope(runtime,scope);return finishRecovery(runtime,plan,result);
 }
 if(!plan.applicationPlanId)throw Error('原恢复计划没有持久变更编号，请重新预览');
 const result=await enqueueApplicationPlan(runtime,{planId:plan.applicationPlanId});sameScope(runtime,scope);return finishRecovery(runtime,plan,result);
}
function finishRecovery(runtime,plan,result){
 const items=runtime.store.get('applicationPlan:'+plan.applicationPlanId).items.map(i=>runtime.store.get('appMutation:'+i.id)),excludedKeys=items.filter(i=>i.status==='discarded').map(i=>i.key);
 plan.status=result.remaining?'queued':excludedKeys.length?'completed_with_exclusions':'completed';runtime.store.set('localRecoveryPlan:'+plan.id,plan);return{...result,status:plan.status,id:plan.id,backupSaved:!!plan.backupDirectory,excludedKeys};
}
