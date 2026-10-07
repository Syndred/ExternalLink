import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {readLocalRecoverySource} from '../src/local-recovery.mjs';
import {compareOriginalNavigationScope} from '../../tests/helpers/original-navigation-projection.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';

assert.ok(process.argv.includes('--original-readonly'),'Use --original-readonly to compare the original private library without writes');
const home=join(homedir(),'.externallink-executor'),backupRoot=join(homedir(),'.externallink-backups'),store=new Store(join(home,'outbox.sqlite'),{readOnly:true}),pair=store.get('pair');
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const localState=()=>hash([store.db.prepare('SELECT id,value FROM state ORDER BY id').all(),store.db.prepare('SELECT seq,id,value FROM outbox ORDER BY seq').all(),store.db.prepare('SELECT seq,event_id,value FROM audit_log ORDER BY seq').all()]);
const quote=value=>{assert.ok(!/[\r\n]/.test(value));return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';};
async function snapshot(){
 const url=new URL((pair.storageBackend==='d1'?'/v2/executor/':'/v1/executor/')+'snapshot',pair.endpoint);url.searchParams.set('workspace',pair.workspaceId);assert.equal(url.protocol,'https:');
 const child=spawn('curl.exe',['--silent','--show-error','--max-time','45','--write-out','\n%{http_code}','--config','-'],{windowsHide:true,stdio:['pipe','pipe','pipe']}),chunks=[];child.stdout.on('data',part=>chunks.push(part));child.stderr.resume();child.stdin.end('url = '+quote(url.href)+'\nheader = '+quote('Authorization: Bearer '+pair.deviceToken)+'\nrequest = "GET"\n');
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Read-only cloud snapshot failed '+code)));});const raw=Buffer.concat(chunks).toString('utf8'),at=raw.lastIndexOf('\n');assert.equal(Number(raw.slice(at+1)),200);return JSON.parse(raw.slice(0,at));
}
try{
 assert.equal(store.get('paused'),true);assert.equal(store.pendingCount(),0);const beforeLocal=localState(),current=await snapshot(),reports=[];
 const baseline=JSON.parse(await readFile(new URL('../test-output/manual-confirmation-cloud-before-2026-10-08.json',import.meta.url),'utf8'));assert.deepEqual(current.revisions,baseline.revisions);assert.deepEqual(Object.fromEntries(Object.entries(current.documents).map(([key,value])=>[key,hash(value)])),baseline.hashes);
 reports.push({source:'current_authenticated_cloud',...(await compareOriginalNavigationScope(current))});console.log(JSON.stringify({sourceNumber:1,scopeCases:reports.at(-1).scopeCases,mismatchCount:reports.at(-1).mismatchCount}));
 const inventory=JSON.parse(await readFile(new URL('../test-output/original-cloud-media-backup-scope-readonly-2026-10-08.txt',import.meta.url),'utf8'));
 for(const entry of inventory.reports.filter(row=>row.available&&row.source.endsWith('.json'))){
  const source=await readLocalRecoverySource({store,home,backupRoot},join(backupRoot,entry.source)),beforeBytes=await readFile(source.path);
  const result=await compareOriginalNavigationScope({documents:source.documents});assert.equal(createHash('sha256').update(await readFile(source.path)).digest('hex'),createHash('sha256').update(beforeBytes).digest('hex'));reports.push({sourceSha256:source.sha256,scopeVerification:source.scopeVerification,...result});console.log(JSON.stringify({sourceNumber:reports.length,scopeCases:result.scopeCases,mismatchCount:result.mismatchCount}));
 }
 const after=await snapshot();assert.equal(hash(after.documents),hash(current.documents));assert.deepEqual(after.revisions,current.revisions);assert.equal(localState(),beforeLocal);assert.ok(reports.every(row=>row.sourceUnchanged));
 const mismatchCount=reports.reduce((count,row)=>count+row.mismatchCount,0),unexplainedMismatchCount=mismatchCount;console.log(JSON.stringify({ok:unexplainedMismatchCount===0,kind:'actual_current_and_original_backup_navigation_queue_readonly',reports,totalComparisons:reports.reduce((count,row)=>count+row.comparisons,0),mismatchCount,unexplainedMismatchCount,allComparedOriginalNavigationFieldsMatch:mismatchCount===0,scopesCompared:reports.reduce((count,row)=>count+row.scopeCases,0),allCloudDocumentHashesAndRevisionsUnchanged:true,originalLocalStateAndBackupBytesUnchanged:true,originalChromeLaunched:false,productionWrites:0,realModels:0,realSubmissions:0}));if(unexplainedMismatchCount)process.exitCode=1;
}finally{store.close();}
