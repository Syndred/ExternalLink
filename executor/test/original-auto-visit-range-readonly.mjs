import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {readLocalRecoverySource} from '../src/local-recovery.mjs';
import {compareOriginalAutoVisitScope} from '../../tests/helpers/original-auto-visit-projection.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';

assert.ok(process.argv.includes('--original-readonly'),'Use --original-readonly to compare original private data without writes');
const home=join(homedir(),'.externallink-executor'),backupRoot=join(homedir(),'.externallink-backups'),store=new Store(join(home,'outbox.sqlite'),{readOnly:true}),pair=store.get('pair');
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const localState=()=>hash([store.db.prepare('SELECT id,value FROM state ORDER BY id').all(),store.db.prepare('SELECT seq,id,value FROM outbox ORDER BY seq').all(),store.db.prepare('SELECT seq,event_id,value FROM audit_log ORDER BY seq').all()]);
const quote=value=>{assert.ok(!/[\r\n]/.test(value));return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';};
async function snapshot(){
 const url=new URL((pair.storageBackend==='d1'?'/v2/executor/':'/v1/executor/')+'snapshot',pair.endpoint);url.searchParams.set('workspace',pair.workspaceId);assert.equal(url.protocol,'https:');
 const child=spawn('curl.exe',['--silent','--show-error','--max-time','45','--write-out','\n%{http_code}','--config','-'],{windowsHide:true,stdio:['pipe','pipe','pipe']}),chunks=[];
 child.stdout.on('data',part=>chunks.push(part));child.stderr.resume();child.stdin.end('url = '+quote(url.href)+'\nheader = '+quote('Authorization: Bearer '+pair.deviceToken)+'\nrequest = "GET"\n');
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Read-only cloud snapshot failed '+code)));});
 const raw=Buffer.concat(chunks).toString('utf8'),at=raw.lastIndexOf('\n');assert.equal(Number(raw.slice(at+1)),200);return JSON.parse(raw.slice(0,at));
}
try{
 assert.equal(store.get('paused'),true);assert.equal(store.pendingCount(),0);const beforeLocal=localState(),current=await snapshot(),reports=[];
 const baseline=JSON.parse(await readFile(new URL('../test-output/manual-confirmation-cloud-before-2026-10-08.json',import.meta.url),'utf8'));assert.deepEqual(current.revisions,baseline.revisions);assert.deepEqual(Object.fromEntries(Object.entries(current.documents).map(([key,value])=>[key,hash(value)])),baseline.hashes);
 async function compare(source,label){
  const result=await compareOriginalAutoVisitScope(source,row=>console.log(JSON.stringify({sourceNumber:reports.length+1,profileCases:row.cases,mismatchCount:row.mismatchCount,currentGateExclusions:row.currentGateExclusions})));
  reports.push({...label,...result});console.log(JSON.stringify({sourceNumber:reports.length,sourceCases:result.cases,mismatchCount:result.mismatchCount}));
 }
 await compare(current,{source:'current_authenticated_cloud'});
 const inventory=JSON.parse(await readFile(new URL('../test-output/original-cloud-media-backup-scope-readonly-2026-10-08.txt',import.meta.url),'utf8'));
 for(const entry of inventory.reports.filter(row=>row.available&&row.source.endsWith('.json'))){
  const source=await readLocalRecoverySource({store,home,backupRoot},join(backupRoot,entry.source)),beforeBytes=await readFile(source.path);
  await compare({documents:source.documents},{sourceSha256:source.sha256,scopeVerification:source.scopeVerification});assert.equal(createHash('sha256').update(await readFile(source.path)).digest('hex'),createHash('sha256').update(beforeBytes).digest('hex'));
 }
 const after=await snapshot();assert.equal(hash(after.documents),hash(current.documents));assert.deepEqual(after.revisions,current.revisions);assert.equal(localState(),beforeLocal);assert.ok(reports.every(row=>row.sourceUnchanged));
 const mismatchCount=reports.reduce((n,row)=>n+row.mismatchCount,0);
 console.log(JSON.stringify({ok:mismatchCount===0,kind:'actual_current_and_original_backup_compiled_auto_visit_range_readonly',reports,totalCases:reports.reduce((n,row)=>n+row.cases,0),profiles:reports.reduce((n,row)=>n+row.profiles,0),mismatchCount,currentGateExclusions:reports.reduce((n,row)=>n+row.currentGateExclusions,0),currentExecutorGatesReportedSeparately:true,allCloudDocumentHashesAndRevisionsUnchanged:true,originalLocalStateAndBackupBytesUnchanged:true,originalChromeLaunched:false,productionWrites:0,realModels:0,realSubmissions:0}));if(mismatchCount)process.exitCode=1;
}finally{store.close();}
