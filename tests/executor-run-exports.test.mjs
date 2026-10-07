import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {Store} from '../executor/src/store.mjs';
import {runExports} from '../executor/src/run-exports.mjs';
import {runHistory} from '../executor/src/run-history.mjs';

const scope='https://cloud.example|default';
function fixture(file=':memory:'){
 const store=new Store(file);store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default',localToken:'local-private-secret',deviceToken:'device-private-secret'});store.set('paused',true);
 const statuses=[{status:'finished',receipt:{evidence:'原页面明确收件',publicationStatus:'pending_moderation',evidenceUrl:'https://one.example/receipt'}},{status:'submitted_unconfirmed',attemptBoundary:{id:'original-attempt',at:'2026-10-01'},reason:'响应丢失'}, {status:'failed',reason:'网站拒绝'}, {status:'skip',reason:'人工跳过'}, {status:'pending'}, {status:'finished'}, {status:'finished',receipt:{evidence:'Imported label',confirmedBy:'migration'}}];
 const items=statuses.map((state,index)=>{const id='t'+index,task={id,runId:'shared-run',profileId:'p',profileSnapshot:{name:'原产品'},url:'https://site'+index+'.example/submit',...state,credentials:{password:'task-private-secret'},targetId:'browser-private-target'};store.set('task:'+id,task);return{identity:'identity-'+index,taskId:id,runId:'shared-run',profileId:'p',profile:{name:'原产品'},url:task.url,status:'registered'};});
 store.set('workbenchBatch:batch',{id:'batch',scope,count:items.length,cursor:6,items,status:'paused',startedAt:'2026-10-01T00:00:00Z'});store.set('activeWorkbenchBatch','batch');
 return{store};
}
function state(runtime){return{rows:runtime.store.db.prepare('SELECT * FROM state ORDER BY id').all(),outbox:runtime.store.pending(),audit:runtime.store.db.prepare('SELECT * FROM audit_log ORDER BY seq').all()};}
const exportRecord=(runtime,sourceId='workbench:batch')=>JSON.parse(runExports(runtime,'exportAutomationRun',{sourceId}).content);

test('report and ledger modules are the exact pre-refactor sources, packed reports retain original classification',()=>{
 const expected={'batch-report':'2a63c8eeb08c83fe80ca0396a1ef3352454f55ca9f2b01aa536ce0d0e4ab6e1d','automation-ledger':'17987102df70f8635c002b13863fb63811568755ab07ec9edc95e25c56c57ce2'};
 const sandbox={self:{}};vm.createContext(sandbox);
 for(const [name,hash]of Object.entries(expected)){const source=readFileSync(new URL('../core/'+name+'.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');assert.equal(createHash('sha256').update(source).digest('hex'),hash);vm.runInContext(source,sandbox);}
 const runtime=fixture();try{
 const batch={runId:'original/batch',status:'paused',config:{unattended:true},unattendedState:{waitReason:'manual_capacity',manualTabCount:20,maxManualTabs:20,modelCallsUsed:7},destinations:[[1,'旧站','https://original.example/submit','original.example']],tasks:['ok','err','skip','pending','running','needs_manual'].map((status,i)=>[i,1,'p','旧产品',status,null,null,'原原因 '+i,'原证据 '+i,'pending_moderation','https://original.example/public','https://original.example/evidence'])};
 runtime.store.set('activeBatchRun',batch);const actual=runExports(runtime,'exportBatchReport',{sourceId:'original-batch:local'}).report,reference=JSON.parse(JSON.stringify(sandbox.self.ExtLinkBatchReport.build(batch)));delete actual.generatedAt;delete reference.generatedAt;assert.deepEqual(actual,reference);assert.throws(()=>exportRecord(runtime,'original-batch:local'),/不替代执行记录/);
 const exported=runExports(runtime,'exportBatchReport',{sourceId:'original-batch:local'});assert.equal(exported.filename,'externallink-original_batch-本轮报告.md');assert.match(exported.content,/等待人工处理：已保留 20\/20/);assert.match(exported.content,/本轮模型调用：7/);assert.match(exported.content,/等待审核/);assert.equal(exported.count,6);assert.match(exported.content,/原固定范围：6/);
 }finally{runtime.store.close();}
});

test('native fixed denominator retains unknown attempts, failures, skips, remaining and receipt-less finished tasks',()=>{
 const runtime=fixture();try{const before=state(runtime),result=runExports(runtime,'exportBatchReport',{sourceId:'workbench:batch'});assert.deepEqual(result.summary,{success:1,manual:3,failed:1,skipped:1,remaining:1});assert.equal(result.count,7);assert.match(result.content,/处理游标：6/);assert.match(result.content,/响应丢失/);assert.match(result.content,/原页面明确收件/);assert.match(result.content,/等待审核/);assert.match(result.content,/原任务尚未取得确定回执/);assert.deepEqual(state(runtime),before);
 const payload=exportRecord(runtime);assert.equal(payload.tasks.t1.attemptBoundary.id,'original-attempt');assert.equal(payload.tasks.t0.receipt.evidenceUrl,'https://one.example/receipt');assert.equal(payload.frozenCombinations.length,7);assert.doesNotMatch(JSON.stringify(payload),/local-private-secret|device-private-secret|task-private-secret|browser-private-target/);
 }finally{runtime.store.close();}
});

test('full persisted event export exceeds viewer pages and original ledger cap without mixing other tasks or scopes',()=>{
 const runtime=fixture();try{
 for(let index=0;index<1205;index++)runtime.store.appendLog({id:'event-'+index,at:'2026-10-01T00:00:00Z',runId:'shared-run',taskId:'t1',message:'原日志 '+index+'\n保留换行',artifactRef:'artifact-'+index});
 runtime.store.appendLog({id:'unselected',runId:'shared-run',taskId:'other-task',message:'unselected task'});runtime.store.appendLog({id:'run-level',runId:'shared-run',message:'批次事件'});runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'foreign'});runtime.store.appendLog({id:'foreign',runId:'shared-run',taskId:'t1',message:'foreign scope'});runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});
 const before=state(runtime),payload=exportRecord(runtime);assert.equal(payload.events.length,1206);assert.equal(payload.events[0].id,'event-0');assert.equal(payload.events[1204].id,'event-1204');assert.equal(payload.events[1204].message,'原日志 1204\n保留换行');assert.equal(payload.events.at(-1).id,'run-level');assert.equal(payload.source.availableEvents,1206);assert.deepEqual(state(runtime),before);
 }finally{runtime.store.close();}
});

test('original ledger export follows its first original ID rather than sorting timestamps or rewriting payload',()=>{
 const runtime=fixture();try{const ledger={schemaVersion:1,order:['first/ID','later'],runs:{'first/ID':{runId:'first/ID',status:'failed',startedAt:'2020-01-01',tasks:{original:{taskId:'original',status:'failed',artifactRef:'old-artifact'}},events:[{id:'original-event',at:'original-time',errorCode:'old-error'}],originalExtra:{retain:true}},later:{runId:'later',startedAt:'2030-01-01',events:[]}}};runtime.store.set('automationRunLedger',ledger);
 const before=state(runtime),sources=runExports(runtime,'runExportSources');assert.equal(sources.defaultRecord,'original-run:local:first/ID');const output=runExports(runtime,'exportAutomationRun',{sourceId:sources.defaultRecord});assert.equal(output.filename,'externallink-first_ID-执行记录.json');assert.deepEqual(JSON.parse(output.content),ledger.runs['first/ID']);assert.deepEqual(state(runtime),before);assert.throws(()=>runExports(runtime,'exportBatchReport',{sourceId:sources.defaultRecord}),/不是原批次报告/);
 }finally{runtime.store.close();}
});

test('frozen acceptance keeps missing and unregistered combinations and original identifiers without registering replacements',()=>{
 const runtime=fixture();try{
 const combinations=Array.from({length:3},(_,i)=>({identity:'c'+i,profileId:'p',profile:{name:'原产品'},url:'https://frozen'+i+'.example/submit'}));runtime.store.set('acceptance:fixed',{id:'fixed',scope,sha256:'hash',count:3,combinations});runtime.store.set('acceptanceExecution:fixed',{scopeSha256:'hash',items:{c0:{status:'registered',taskId:'missing-original',runId:'original-run'},c1:{status:'registration_rejected',reason:'云端版本变化'}}});runtime.store.set('acceptanceBatch',{id:'fixed',scopeSha256:'hash',status:'paused',count:3,cursor:2});const before=state(runtime),payload=exportRecord(runtime,'acceptance:fixed');assert.equal(payload.frozenCombinations.length,3);assert.equal(payload.frozenCombinations[0].taskId,'missing-original');assert.equal(payload.tasks['missing-original'].id,'missing-original');assert.equal(payload.frozenCombinations[2].taskId,null);assert.deepEqual(payload.report.summary,{success:0,manual:1,failed:1,skipped:0,remaining:1});assert.deepEqual(state(runtime),before);
 runtime.store.set('acceptanceBatch',{id:'fixed',scopeSha256:'different',count:3});assert.throws(()=>exportRecord(runtime,'acceptance:fixed'),/校验不一致/);
 }finally{runtime.store.close();}
});

test('exports reject changed denominators, crossed task identity, foreign workspace and absent records',()=>{
 const runtime=fixture();try{const batch=runtime.store.get('workbenchBatch:batch');runtime.store.set('workbenchBatch:batch',{...batch,count:8});assert.throws(()=>exportRecord(runtime),/范围不完整/);runtime.store.set('workbenchBatch:batch',batch);const task=runtime.store.get('task:t0');runtime.store.set('task:t0',{...task,profileId:'other'});assert.throws(()=>exportRecord(runtime),/组合不一致/);runtime.store.set('task:t0',task);
 runtime.store.set('workbenchBatch:foreign',{...batch,id:'foreign',scope:'https://cloud.example|other'});runtime.store.set('run:foreign',{id:'foreign',workspaceId:'other',tasks:[{id:'t0'}]});const sources=runExports(runtime,'runExportSources');assert.equal(sources.sources.some(s=>s.sourceId.endsWith(':foreign')),false);assert.throws(()=>exportRecord(runtime,'workbench:foreign'),/不存在或属于其他/);assert.throws(()=>runExports(runtime,'exportBatchReport',{}),/请选择/);assert.throws(()=>exportRecord(runtime,'workbench:absent'),/不存在/);assert.equal(runtime.store.pendingCount(),0);
 }finally{runtime.store.close();}
});

test('malformed historical source remains visible with reason and does not prevent valid originals exporting',()=>{
 const runtime=fixture();try{runtime.store.set('run:incomplete',{id:'incomplete'});const sources=runExports(runtime,'runExportSources');const invalid=sources.sources.find(s=>s.sourceId==='run:incomplete');assert.equal(invalid.record,false);assert.match(invalid.error,/完整任务范围/);assert.equal(exportRecord(runtime).taskTotal,7);}finally{runtime.store.close();}
});

test('SQLite reopen and read-only exporting preserve outbox and exact task/event identities',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-run-exports-')),file=join(home,'outbox.sqlite');let runtime;
 try{runtime=fixture(file);const event=runtime.store.transition(runtime.store.get('task:t1'),'original_transition');const before=state(runtime);runtime.store.close();runtime={store:new Store(file,{readOnly:true})};const payload=exportRecord(runtime);assert.equal(payload.events[0].id,event.id);assert.equal(payload.tasks.t1.id,'t1');assert.deepEqual(state(runtime),before);assert.equal(runtime.store.pendingCount(),1);}finally{runtime?.store.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-run-exports-'));await rm(absolute,{recursive:true,force:true});}
});

test('original history file preview and idempotent restoration retain original IDs without activating tasks or storing unrelated credentials',()=>{
 const runtime=fixture();try{const before=runtime.store.values('task:'),batchBefore=runtime.store.get('workbenchBatch:batch'),ledger={schemaVersion:1,order:['original-id'],runs:{'original-id':{runId:'original-id',status:'failed',tasks:{'old-task':{taskId:'old-task',artifactRef:'original-artifact'}},events:[{id:'original-event',at:'2020-01-01',result:'Original result'}]}}};const file={automationRunLedger:ledger,activeBatchRun:{runId:'old-batch',status:'paused',config:{unattended:true,apiKey:'private-model-key'},tasks:[{index:1,profileId:'p',status:'err',skipReason:'Old failure',url:'https://old.example'}]},pair:{localToken:'discarded-credential'},cfgApiKey:'unrelated-private-key'};
 const preview=runHistory(runtime,'previewRunHistory',{name:'original.json',content:JSON.stringify(file)}).preview;assert.equal(preview.events,1);assert.equal(runtime.store.values('originalRunHistory:').length,0);const saved=runHistory(runtime,'importRunHistory',{previewId:preview.id});assert.equal(saved.executionStarted,false);assert.equal(runHistory(runtime,'importRunHistory',{previewId:preview.id}).alreadyRestored,true);assert.equal(runtime.store.values('originalRunHistory:').length,1);
 const sources=runExports(runtime,'runExportSources');assert.deepEqual(JSON.parse(runExports(runtime,'exportAutomationRun',{sourceId:sources.defaultRecord}).content),ledger.runs['original-id']);const report=runExports(runtime,'exportBatchReport',{sourceId:sources.defaultReport});assert.match(report.content,/Old failure/);assert.doesNotMatch(JSON.stringify(report),/private-model-key|discarded-credential|unrelated-private-key/);assert.doesNotMatch(JSON.stringify(runtime.store.values('originalRunHistory:')),/discarded-credential|unrelated-private-key/);assert.deepEqual(runtime.store.values('task:'),before);assert.deepEqual(runtime.store.get('workbenchBatch:batch'),batchBefore);assert.equal(runtime.store.get('activeBatchRun'),null);assert.equal(runtime.store.get('automationRunLedger'),null);assert.equal(runtime.store.get('paused'),true);assert.equal(runtime.store.pendingCount(),0);
 }finally{runtime.store.close();}
});

test('history restoration rejects missing event IDs, credential-bearing ledger, prototype fields, ordinary backups and changed scope',()=>{
 const runtime=fixture();try{const valid={runId:'old',tasks:{},events:[{id:'old-event'}]};for(const raw of [{siteProfiles:{p:{name:'ordinary'}}},{...valid,events:[{result:'missing ID'}]},{...valid,deviceToken:'private'},{...valid,events:[{id:'same'},{id:'same'}]},JSON.parse('{"runId":"old","tasks":{},"events":[],"__proto__":{}}')])assert.throws(()=>runHistory(runtime,'previewRunHistory',{content:JSON.stringify(raw)}));
 const preview=runHistory(runtime,'previewRunHistory',{content:JSON.stringify(valid)}).preview;runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'other'});assert.throws(()=>runHistory(runtime,'importRunHistory',{previewId:preview.id}),/工作区/);assert.equal(runtime.store.values('originalRunHistory:').length,0);assert.equal(runtime.store.pendingCount(),0);
 }finally{runtime.store.close();}
});

test('history restoration rolls back failed persistence and keeps changed versions as separate original sources',()=>{
 const runtime=fixture();try{const run={runId:'old-ID',status:'failed',tasks:{},events:[{id:'same-event',result:'old'}]},first=runHistory(runtime,'previewRunHistory',{content:JSON.stringify(run)}).preview;const set=runtime.store.set.bind(runtime.store);runtime.store.set=(key,value)=>{if(key.startsWith('originalRunHistory:')){set(key,value);throw Error('disk fixture failed');}return set(key,value);};assert.throws(()=>runHistory(runtime,'importRunHistory',{previewId:first.id}),/disk fixture failed/);assert.equal(runtime.store.values('originalRunHistory:').length,0);runtime.store.set=set;runHistory(runtime,'importRunHistory',{previewId:first.id});const second=runHistory(runtime,'previewRunHistory',{content:JSON.stringify({...run,events:[{id:'same-event',result:'new original version'}]})}).preview;assert.notEqual(first.id,second.id);runHistory(runtime,'importRunHistory',{previewId:second.id});assert.equal(runtime.store.values('originalRunHistory:').length,2);assert.equal(runtime.store.get('originalRunHistory:'+first.id).automationRunLedger.runs['old-ID'].events[0].result,'old');assert.equal(runtime.store.get('originalRunHistory:'+second.id).automationRunLedger.runs['old-ID'].events[0].result,'new original version');
 }finally{runtime.store.close();}
});

test('original restored history survives disk reopen and repeats through the same preview and source IDs',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-run-history-')),file=join(home,'outbox.sqlite');let runtime;
 try{runtime=fixture(file);const old={runId:'reopened-original',tasks:{},events:[{id:'retained-event',result:'retained'}]},preview=runHistory(runtime,'previewRunHistory',{content:JSON.stringify(old)}).preview;runHistory(runtime,'importRunHistory',{previewId:preview.id});runtime.store.close();runtime={store:new Store(file)};const repeated=runHistory(runtime,'importRunHistory',{previewId:preview.id});assert.equal(repeated.id,preview.id);assert.equal(repeated.alreadyRestored,true);assert.deepEqual(exportRecord(runtime,'original-run:'+preview.id+':reopened-original'),old);assert.equal(runtime.store.pendingCount(),0);assert.equal(runtime.store.get('paused'),true);}finally{runtime?.store.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-run-history-'));await rm(absolute,{recursive:true,force:true});}
});

test('large history upload resumes exact saved chunks after reopen, verifies full file and retains original payload and hash',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-run-history-large-')),file=join(home,'outbox.sqlite');let runtime;
 try{runtime=fixture(file);const history={runId:'large-original',tasks:{},events:[{id:'large-event',result:'原历史'.repeat(1050000)}]},bytes=Buffer.from(JSON.stringify(history)),sha256=createHash('sha256').update(bytes).digest('hex');assert.ok(bytes.length>8*1024*1024);const upload=runHistory(runtime,'runHistoryUploadStart',{name:'large-original.json',sha256,bytes:bytes.length}).upload;
 const part=inputIndex=>{const data=bytes.subarray(inputIndex*upload.partBytes,Math.min((inputIndex+1)*upload.partBytes,bytes.length));return{id:upload.id,index:inputIndex,data:data.toString('base64'),sha256:createHash('sha256').update(data).digest('hex')};};runHistory(runtime,'runHistoryUploadPart',part(0));assert.throws(()=>runHistory(runtime,'runHistoryUploadComplete',{id:upload.id}),/分段未齐/);runtime.store.close();runtime={store:new Store(file)};const resumed=runHistory(runtime,'runHistoryUploadStart',{sha256,bytes:bytes.length}).upload;assert.equal(resumed.id,upload.id);assert.deepEqual(resumed.present,[0]);assert.equal(runHistory(runtime,'runHistoryUploadPart',part(0)).alreadySaved,true);for(let index=1;index<upload.count;index++)runHistory(runtime,'runHistoryUploadPart',part(index));
 const preview=runHistory(runtime,'runHistoryUploadComplete',{id:upload.id}).preview;runHistory(runtime,'importRunHistory',{previewId:preview.id});assert.deepEqual(exportRecord(runtime,'original-run:'+preview.id+':large-original'),history);assert.equal(runtime.store.get('originalRunHistory:'+preview.id).sourceFileSha256,sha256);assert.equal(runtime.store.pendingCount(),0);assert.equal(runtime.store.get('paused'),true);
 }finally{runtime?.store.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-run-history-large-'));await rm(absolute,{recursive:true,force:true});}
});

test('history chunks reject altered content, unsafe ranges, scope changes and a corrupted final file without restoring partial history',()=>{
 const runtime=fixture();try{const bytes=Buffer.from(JSON.stringify({runId:'old',tasks:{},events:[]})),sha256=createHash('sha256').update(bytes).digest('hex'),upload=runHistory(runtime,'runHistoryUploadStart',{sha256,bytes:bytes.length}).upload,part={id:upload.id,index:0,data:bytes.toString('base64'),sha256};assert.throws(()=>runHistory(runtime,'runHistoryUploadPart',{...part,index:1}),/范围/);assert.throws(()=>runHistory(runtime,'runHistoryUploadPart',{...part,sha256:'0'.repeat(64)}),/校验/);runHistory(runtime,'runHistoryUploadPart',part);runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'foreign'});assert.throws(()=>runHistory(runtime,'runHistoryUploadComplete',{id:upload.id}),/工作区/);runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});runtime.store.set('runHistoryPart:'+upload.id+':0',{index:0,sha256,data:Buffer.from('changed').toString('base64')});assert.throws(()=>runHistory(runtime,'runHistoryUploadComplete',{id:upload.id}),/校验/);assert.equal(runtime.store.values('originalRunHistory:').length,0);assert.equal(runtime.store.pendingCount(),0);
 }finally{runtime.store.close();}
});
