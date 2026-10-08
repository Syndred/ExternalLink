import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {localRunHistorySources,previewLocalRunHistory} from '../executor/src/run-history-sources.mjs';
import {runHistory} from '../executor/src/run-history.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const home=await mkdtemp(join(tmpdir(),'el-local-run-history-')),backupRoot=join(home,'backups'),store=new Store(':memory:'),pair={endpoint:'https://history.fixture.invalid',workspaceId:'original-history'};await mkdir(backupRoot);store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});
 const original={scope:workbenchScope(pair),activeBatchRun:{runId:'original-batch',status:'paused',tasks:[{index:0,profileId:'p',url:'https://history.example/one',status:'err'},{index:1,profileId:'q',url:'https://history.example/two',status:'pending'}]},automationRunLedger:{schemaVersion:1,order:['original-run'],runs:{'original-run':{runId:'original-run',tasks:{'original-task':{taskId:'original-task',status:'needs_manual'}},events:[{id:'original-event',at:'2020-01-01',result:'Original retained result'}]}}}};
 async function file(folder,value,name='original-run-history.json'){const dir=join(backupRoot,folder);await mkdir(dir,{recursive:true});const path=join(dir,name);await writeFile(path,JSON.stringify(value));return path;}
 async function close(){store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-local-run-history-'));await rm(home,{recursive:true,force:true});}
 return{home,backupRoot,store,pair,original,runtime:{store,backupRoot},file,close};
}
test('scoped saved original history is discovered and imports exact original facts once without executable tasks',async()=>{
 const f=await fixture();try{const path=await f.file('original',f.original),before=digest(await readFile(path)),listing=await localRunHistorySources(f.runtime);assert.equal(listing.sources.length,1);const source=listing.sources[0];assert.equal(source.combinations,2);assert.equal(source.events,1);assert.equal(source.runs,1);assert.equal(source.scope,undefined);assert.equal(source.path,undefined);assert.equal(source.content,undefined);assert.equal(f.store.values('runHistoryPreview:').length,0);
  const preview=await previewLocalRunHistory(f.runtime,{sourceId:source.id}),first=runHistory(f.runtime,'importRunHistory',{previewId:preview.preview.id}),saved=f.store.get('originalRunHistory:'+first.id);assert.deepEqual(saved.activeBatchRun,f.original.activeBatchRun);assert.deepEqual(saved.automationRunLedger,f.original.automationRunLedger);assert.equal(runHistory(f.runtime,'importRunHistory',{previewId:preview.preview.id}).alreadyRestored,true);assert.equal(f.store.values('originalRunHistory:').length,1);assert.equal(f.store.values('task:').length,0);assert.equal(f.store.get('activeBatchRun'),null);assert.equal(f.store.get('paused'),true);assert.equal(f.store.get('acceptanceBatch').cursor,13);assert.equal(digest(await readFile(path)),before);
 }finally{await f.close();}
});
test('discovery ignores unrelated workspaces and unscoped exports while reporting invalid scoped history',async()=>{
 const f=await fixture();try{await f.file('foreign',{...f.original,scope:'https://other.fixture.invalid|other'});const unscoped=structuredClone(f.original);delete unscoped.scope;await f.file('unscoped',unscoped);await f.file('invalid',{scope:f.original.scope,activeBatchRun:{runId:'invalid',tasks:'missing-original-range'}});await f.file('credentials',{scope:f.original.scope,cloudSyncConfig:{accessToken:'private-not-discovered'}},'private-storage.json');const listing=await localRunHistorySources(f.runtime);assert.equal(listing.sources.length,1);assert.equal(listing.sources[0].unavailable,true);assert.match(listing.sources[0].error,/原批次范围/);assert.equal(f.store.values('runHistorySource:').length,0);assert.equal(f.store.values('originalRunHistory:').length,0);
 }finally{await f.close();}
});
test('a changed saved file cannot silently replace the chosen original history and refreshed choice uses its new hash',async()=>{
 const f=await fixture();try{await f.file('original',f.original);const first=(await localRunHistorySources(f.runtime)).sources[0],next=structuredClone(f.original);next.activeBatchRun.tasks.push({index:2,url:'https://history.example/three'});await f.file('original',next);await assert.rejects(previewLocalRunHistory(f.runtime,{sourceId:first.id}),/已变化/);assert.equal(f.store.values('runHistoryPreview:').length,0);const refreshed=(await localRunHistorySources(f.runtime)).sources[0];assert.equal(refreshed.id,first.id);assert.notEqual(refreshed.sha256,first.sha256);const preview=await previewLocalRunHistory(f.runtime,{sourceId:refreshed.id});assert.equal(preview.preview.combinations,3);
 }finally{await f.close();}
});
test('saved history selections cannot cross a workspace or escape the configured backup root',async()=>{
 const f=await fixture();try{await f.file('original',f.original);const source=(await localRunHistorySources(f.runtime)).sources[0];f.store.set('pair',{...f.pair,workspaceId:'other'});await assert.rejects(previewLocalRunHistory(f.runtime,{sourceId:source.id}),/当前工作区/);assert.deepEqual((await localRunHistorySources(f.runtime)).sources,[]);f.store.set('pair',f.pair);const outside=join(f.home,'original-run-history.json');await writeFile(outside,JSON.stringify(f.original));f.store.set('runHistorySource:'+source.id,{id:source.id,scope:f.original.scope,path:outside,sha256:digest(await readFile(outside))});await assert.rejects(previewLocalRunHistory(f.runtime,{sourceId:source.id}),/备份目录/);assert.equal(f.store.values('runHistoryPreview:').length,0);
 }finally{await f.close();}
});
test('a saved original history larger than the small upload limit previews directly without replacing the existing file route',async()=>{
 const f=await fixture();try{const large=structuredClone(f.original);large.automationRunLedger.runs['original-run'].events[0].result='Original content '+ 'A'.repeat(9*1024*1024);const path=await f.file('large',large),before=digest(await readFile(path));const source=(await localRunHistorySources(f.runtime)).sources[0];assert.ok(source.bytes>8*1024*1024);const preview=await previewLocalRunHistory(f.runtime,{sourceId:source.id});assert.equal(preview.preview.events,1);assert.equal(f.store.get('runHistoryPreview:'+preview.preview.id).history.automationRunLedger.runs['original-run'].events[0].result,large.automationRunLedger.runs['original-run'].events[0].result);assert.equal(digest(await readFile(path)),before);assert.equal(f.store.values('task:').length,0);
 }finally{await f.close();}
});
