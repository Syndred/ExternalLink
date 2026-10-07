import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {readLocalRecoverySource} from '../src/local-recovery.mjs';

// Explicit read-only audit: no catalogue capture, recovery plan, cloud request or browser action.
assert.ok(process.argv.includes('--original-readonly'),'Use --original-readonly to inspect existing private original backups');
const backupRoot=join(homedir(),'.externallink-backups'),home=join(homedir(),'.externallink-executor'),store=new Store(join(home,'outbox.sqlite'),{readOnly:true});
const names=['snapshot.json','recovered-documents.json','outbox.sqlite','before.sqlite','before-executor-activation.sqlite'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const originalState=()=>sha(JSON.stringify({state:store.db.prepare('SELECT id,value FROM state ORDER BY id').all(),outbox:store.db.prepare('SELECT seq,id,value FROM outbox ORDER BY seq').all(),audit:store.db.prepare('SELECT seq,event_id,value FROM audit_log ORDER BY seq').all()}));
async function inventory(){
 const files=[];for(const dir of (await readdir(backupRoot,{withFileTypes:true})).filter(dir=>dir.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)))for(const name of names){const file=join(backupRoot,dir.name,name),info=await stat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(info?.isFile())files.push({file,bytes:info.size,sha256:sha(await readFile(file))});}return files;
}
try{
 const beforeState=originalState(),files=await inventory(),runtime={home,backupRoot,store},reports=[];
 for(const {file}of files){
  try{const source=await readLocalRecoverySource(runtime,file);reports.push({source:relative(backupRoot,file).replaceAll('\\','/'),available:true,scopeVerification:source.scopeVerification,profiles:Object.keys(source.documents.siteProfiles||{}).length,records:Object.keys(source.documents.submissionRecords||{}).length,favorites:Object.values(source.documents.siteAnnotations||{}).filter(item=>item.library?.favorite).length});}
  catch(error){reports.push({source:relative(backupRoot,file).replaceAll('\\','/'),available:false,reason:error.message});}
 }
 assert.deepEqual(await inventory(),files,'Original backup files must stay unchanged');assert.equal(originalState(),beforeState,'Original executor state must stay unchanged');
 console.log(JSON.stringify({ok:true,kind:'original_backup_scope_readonly_audit',reports,summary:{files:files.length,acceptedJson:reports.filter(item=>item.source.endsWith('.json')&&item.available).length,rejectedCloudPullJson:reports.filter(item=>item.source.startsWith('cloud-pull-')&&item.source.endsWith('.json')&&!item.available).length,foreignWorkspace:reports.filter(item=>!item.available&&/其他工作区/.test(item.reason)).length},originalBackupFilesUnchanged:true,originalExecutorStateUnchanged:true,productionDataWrites:0,cloudRequests:0,realAiCalls:0,realSubmissions:0}));
}finally{store.close();}
