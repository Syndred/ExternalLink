import {join} from 'node:path';import {homedir} from 'node:os';import {randomUUID} from 'node:crypto';
import {backupWorkspace} from './migration-backup.mjs';
export async function resetWorkspace(runtime,input){
 if(input.confirmation!=='清空本机工作区')throw Error('请输入清空本机工作区确认');
 if(runtime.singlePageFill)throw Error('请等待当前网页填写结束');
 if(!runtime.store.get('paused')||runtime.job||runtime.linkMonitorJob||runtime.publicLibraryJob||runtime.domainAgeJob||runtime.quickOpenJob||runtime.appMutationFlush||runtime.mediaUploadFlush||runtime.browserAssistantScan||runtime.manualWatchJob||runtime.store.values('manualWatch:').some(w=>w.status==='checking'))throw Error('请先暂停并等待所有后台操作结束');
 const output=join(runtime.backupRoot||join(homedir(),'.externallink-backups'),'workspace-reset-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()),manifest=await backupWorkspace({home:runtime.home,output});
 runtime.store.db.exec('BEGIN IMMEDIATE');try{runtime.store.db.exec('DELETE FROM state; DELETE FROM outbox; DELETE FROM audit_log;');runtime.store.set('paused',true);runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
 await runtime.onWorkspaceReset?.();return{ok:true,backupDirectory:output,integrity:manifest.integrity,backupTasks:manifest.tasks,backupEvents:manifest.outbox};
}
