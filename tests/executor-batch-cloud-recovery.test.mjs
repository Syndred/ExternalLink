import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {D1Store} from '../cloud/worker/src/d1-store.mjs';
import {d1Executor} from '../cloud/worker/src/d1-executor.mjs';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {Cloud} from '../executor/src/cloud.mjs';
import {previewWorkbenchBatch,startWorkbenchBatch,nextWorkbenchTask,finishWorkbenchTask} from '../executor/src/workbench-features.mjs';
import {recoverCloudBatchRecords} from '../executor/src/workbench-batch-recovery.mjs';
import {batchActionAllowed} from '../executor/src/workbench-batch-policy.mjs';
import {batchJson} from '../core/workbench-batch-recovery.mjs';
import {finalizeUserPause} from '../executor/src/execution-lifecycle.mjs';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {executorApi} from '../cloud/worker/src/executor-api.mjs';
const digest=value=>createHash('sha256').update(batchJson(value)).digest('hex');

test('authenticated lifecycle events preserve user pause and resume identities, original budget and stopped cloud recovery',async()=>{
 const f=await fixture();try{
  const task=await nextWorkbenchTask(f.original),before=f.original.store.get('workbenchBatch:'+f.batchId).unattendedState,deadline=task.taskDeadlineAt;
  f.original.activeTaskIds=new Set([task.id]);f.original.update(task,{status:'filling'},'fixture_filling');
  await f.original.control('pause',{});finalizeUserPause(f.original,task);await f.cloud.flush(f.original.store);
  let saved=await f.cloud.request('tasks/'+task.id);assert.equal(saved.task.workbenchBatchCheckpoint.status,'paused');assert.deepEqual(saved.task.workbenchBatchCheckpoint.pausedTaskIds,[task.id]);assert.equal(saved.task.taskDeadlineAt,deadline);
  await f.original.control('resume',{expectedBatchId:f.batchId});saved=await f.cloud.request('tasks/'+task.id);assert.equal(saved.task.workbenchBatchCheckpoint.status,'running');assert.equal(saved.task.workbenchBatchCheckpoint.unattendedState.runDeadlineAt,before.runDeadlineAt);assert.equal(saved.task.workbenchBatchCheckpoint.unattendedState.taskBudgetUsed,1);
  f.original.activeTaskIds.clear();await f.original.control('stop',{});const inventory=await f.cloud.request('runs');
  const restored=f.runtime();await restored.restoreCloud();const batch=restored.store.get('workbenchBatch:'+f.batchId);
  assert.equal(batch.status,'stopped');assert.equal(batch.count,6);assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.equal(batch.unattendedState.runDeadlineAt,before.runDeadlineAt);assert.ok(inventory.tasks.some(t=>t.workbenchBatchCheckpoint?.status==='stopped'));
  await assert.rejects(restored.control('resume',{expectedBatchId:f.batchId}),/停止/);assert.equal(restored.store.get('paused'),true);assert.equal(f.models(),0);
 }finally{f.close();}
});

test('authenticated selected skip retry retains exact request and original cloud denominator after readback failure',async()=>{
 const f=await fixture();try{
  const batch=f.original.store.get('workbenchBatch:'+f.batchId),task=f.original.store.get('task:'+batch.items[1].taskId),input={taskId:task.id,expectedRunId:task.runId};
  const synchronize=f.original.synchronize.bind(f.original);f.original.synchronize=async()=>{throw Error('fixture lost readback');};
  const failed=await f.original.control('manualSkip',input);assert.equal(failed.skipped,true);assert.match(failed.syncError,/lost readback/);const request=f.original.store.get('manualSkipPending:'+task.id);
  f.original.synchronize=synchronize;await f.original.control('manualSkip',input);
  const readback=(await f.cloud.request('tasks/'+task.id)).task;assert.equal(readback.manualDisposition.requestId,request.id);assert.equal(readback.status,'skip');assert.equal(readback.workbenchBatchCheckpoint.items.length,6);assert.equal(readback.attemptBoundary,undefined);assert.equal(f.original.store.get('manualSkipPending:'+task.id),null);assert.equal(f.original.store.get('paused'),false);assert.equal(f.models(),0);
 }finally{f.close();}
});

async function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  for(const file of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../cloud/worker/migrations/'+file,import.meta.url),'utf8'));
  const db={prepare(sql){let args=[];return{bind(...values){args=values;return this;},first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const q=sqlite.prepare(sql);return q.columns().length?{results:q.all(...args),meta:{changes:0}}:{results:[],meta:{changes:q.run(...args).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const objects=new Map(),bucket={head:async key=>objects.has(key)?{}:null,put:async(key,value,meta)=>objects.set(key,{bytes:new Uint8Array(value),meta}),get:async key=>{const value=objects.get(key);return value?{arrayBuffer:async()=>value.bytes.slice().buffer,httpMetadata:value.meta?.httpMetadata}:null;}};
  const env={LEDGER_DB:db,MEDIA_BUCKET:bucket,APP_ACCESS_TOKEN:'isolated-admin'},backend=new D1Store(db,bucket,'default');
  const profiles=Object.fromEntries(['p','q'].map(id=>[id,{id,name:'Original '+id,fields:{Name:'Original '+id,Url:'https://product-'+id+'.example'}}]));
  const urls=Array.from({length:3},(_,n)=>'https://target'+n+'.example/form');
  for(const [key,data]of Object.entries({siteProfiles:profiles,sheetTableData:{entries:urls.map(link=>({link}))},submissionRecords:{},cfgConcurrency:'4',unattendedPreferences:{enabled:true,hours:8,tasks:3,manualTabs:20}}))await backend.putDocument(key,data,0);
  let models=0;const fetchBefore=globalThis.fetch;
  globalThis.fetch=(url,options)=>d1Executor(new Request(url,options),env,'default',async()=>{models++;return{fixtureOnly:true};});
  const enroll=await d1Executor(new Request('https://fixture.example/v2/executor/devices',{method:'POST',headers:{Authorization:'Bearer isolated-admin'},body:'{}'}),env,'default');
  const enrollment=await enroll.json(),pair={endpoint:'https://fixture.example',workspaceId:'default',deviceToken:enrollment.deviceToken,storageBackend:'d1'},cloud=new Cloud(pair),locals=[];
  const runtime=()=>{const store=new Store(':memory:');locals.push(store);store.set('pair',pair);store.set('paused',true);const value=new Runtime(store,'isolated-unused');Object.defineProperty(value,'cloud',{value:cloud,configurable:true});value.tick=()=>{};return value;};
  const original=runtime();
  const preview=await previewWorkbenchBatch(original,{profileIds:['p','q'],urls,config:{fillOnly:true}});
  await startWorkbenchBatch(original,{batchId:preview.batch.id,ordinaryPermissionsAuthorized:true});
  return {sqlite,backend,cloud,pair,original,runtime,batchId:preview.batch.id,models:()=>models,close(){globalThis.fetch=fetchBefore;for(const store of locals)store.close();sqlite.close();}};
}

test('authenticated D1 restores the full original range, fill-only mode and consumed budgets into an empty local database',async()=>{
  const f=await fixture();try{
    const first=await nextWorkbenchTask(f.original);await f.cloud.flush(f.original.store);
    await f.original.batchModelRequest(first,'plan',{taskId:first.id});
    f.original.update(first,{status:'submitting',attemptBoundary:'original-boundary',targetId:'original-target'},'fixture_unknown');await f.cloud.flush(f.original.store);
    const before=f.original.store.get('workbenchBatch:'+f.batchId),revisions=await f.backend.revisions();
    const restored=f.runtime();await restored.restoreCloud();
    const batch=restored.store.get('workbenchBatch:'+f.batchId);
    assert.equal(batch.status,'paused');assert.equal(restored.store.get('paused'),true);assert.equal(restored.store.get('singleTaskId'),null);
    assert.equal(batch.config.fillOnly,true);assert.equal(batch.config.concurrency,4);assert.equal(batch.count,6);
    assert.deepEqual(batch.items.map(i=>[i.taskId,i.runId,i.profileId,i.url]),before.items.map(i=>[i.taskId,i.runId,i.profileId,i.url]));
    assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.equal(batch.unattendedState.modelCallsUsed,1);assert.equal(batch.unattendedState.runDeadlineAt,before.unattendedState.runDeadlineAt);
    assert.equal(restored.store.get('task:'+first.id).attemptBoundary,'original-boundary');assert.equal(restored.store.get('task:'+first.id).status,'submitted_unconfirmed');
    assert.equal(restored.store.get('task:'+batch.items[1].taskId).status,'pending');assert.equal(restored.store.get('task:'+batch.items[1].taskId).fillOnlyRun,true);
    assert.equal(await nextWorkbenchTask(restored),null);assert.equal(f.models(),1);assert.deepEqual(await f.backend.revisions(),revisions);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,6);
  }finally{f.close();}
});

test('a lost model-reservation proof response prevents the model call and retains the exact original checkpoint for retry',async()=>{
  const f=await fixture();try{
    const task=await nextWorkbenchTask(f.original);await f.cloud.flush(f.original.store);
    const request=f.cloud.request.bind(f.cloud);let fail=true;
    f.cloud.request=async(route,...args)=>{const result=await request(route,...args);if(fail&&route.startsWith('events/')&&route.endsWith('?proof=1'))throw Error('fixture lost proof response');return result;};
    await assert.rejects(f.original.batchModelRequest(task,'plan',{taskId:task.id}),/lost proof/);assert.equal(f.models(),0);assert.ok(f.original.store.pendingCount()>0);
    assert.equal(f.original.store.get('workbenchBatch:'+f.batchId).unattendedState.modelCallsUsed,1);
    fail=false;await f.cloud.flush(f.original.store);assert.equal(f.original.store.pendingCount(),0);
    const restored=f.runtime();await restored.restoreCloud();assert.equal(restored.store.get('workbenchBatch:'+f.batchId).unattendedState.modelCallsUsed,1);assert.equal(f.models(),0);
  }finally{f.close();}
});

test('a model reservation behind more than one outbox page is independently acknowledged before the model request',async()=>{
  const f=await fixture();try{
    const batch=f.original.store.get('workbenchBatch:'+f.batchId),anchor=f.original.store.get('task:'+batch.cloudManifestTaskId);
    for(let n=0;n<105;n++)f.original.update(anchor,{fixtureSequence:n},'fixture_backlog');
    const task=await nextWorkbenchTask(f.original);assert.ok(f.original.store.pendingCount()>100);
    await f.original.batchModelRequest(task,'plan',{taskId:task.id});assert.equal(f.models(),1);assert.equal(f.original.store.pendingCount(),0);
    const remote=(await f.cloud.request('tasks/'+task.id)).task;assert.equal(remote.workbenchBatchCheckpoint.unattendedState.modelCallsUsed,1);assert.equal(remote.workbenchBatchCheckpoint.unattendedState.taskBudgetUsed,1);
  }finally{f.close();}
});

test('task-claim transaction failure preserves task, batch checkpoint revision, budget and original outbox together',async()=>{
  const f=await fixture();try{
    const before=f.original.store.get('workbenchBatch:'+f.batchId),events=f.original.store.pendingCount(),set=f.original.store.set.bind(f.original.store);
    f.original.store.set=(key,value)=>{if(key=== 'task:'+before.items[0].taskId&&value.workbenchBatchCheckpoint?.unattendedState?.taskBudgetUsed===1)throw Error('fixture interrupted commit');return set(key,value);};
    await assert.rejects(nextWorkbenchTask(f.original),/interrupted commit/);
    const after=f.original.store.get('workbenchBatch:'+f.batchId);assert.equal(after.unattendedState.taskBudgetUsed,0);assert.equal(after.cloudCheckpointRevision,before.cloudCheckpointRevision);assert.equal(f.original.store.pendingCount(),events);
    assert.equal(f.original.store.get('task:'+before.items[0].taskId).unattendedClaimed,undefined);
  }finally{f.close();}
});

test('missing cloud tasks preserve the frozen denominator and original IDs without replacement registration',async()=>{
  const f=await fixture();try{
    const saved=await f.cloud.request('runs'),missing=saved.tasks.at(-1);saved.tasks=saved.tasks.filter(t=>t.id!==missing.id);
    const runtime=f.runtime(),batches=recoverCloudBatchRecords(runtime,saved.runs,saved.tasks),batch=batches[0];
    assert.equal(batch.count,6);assert.equal(batch.items.find(i=>i.taskId===missing.id).status,'registration_unknown');assert.equal(batch.items.find(i=>i.taskId===missing.id).runId,missing.runId);assert.equal(runtime.store.values('task:').length,0);
  }finally{f.close();}
});

test('cloud scope changes and conflicting original checkpoints are rejected before local recovery writes',async()=>{
  const f=await fixture();try{
    const saved=await f.cloud.request('runs'),runtime=f.runtime();let requests=0;
    Object.defineProperty(runtime,'cloud',{value:{config:{storageBackend:'d1'},request:async()=>{requests++;runtime.store.set('pair',{...f.pair,workspaceId:'other'});return saved;}},configurable:true});
    await assert.rejects(runtime.restoreCloud(),/工作区已切换/);assert.equal(runtime.store.values('run:').length,0);assert.equal(runtime.store.values('task:').length,0);assert.equal(requests,1);
    runtime.store.set('pair',f.pair);
    const changed=structuredClone(saved);changed.runs.find(run=>run.workbenchBatchManifest).workbenchBatchManifest.config.fillOnly=false;
    assert.throws(()=>recoverCloudBatchRecords(runtime,changed.runs,changed.tasks),/校验失败/);
    const withConflict=structuredClone(saved),source=withConflict.tasks.find(t=>t.workbenchBatchCheckpoint);withConflict.tasks.push({...source,id:'conflict',workbenchBatchCheckpoint:{...source.workbenchBatchCheckpoint,reason:'different same revision'}});
    assert.throws(()=>recoverCloudBatchRecords(runtime,withConflict.runs,withConflict.tasks),/版本冲突/);assert.equal(runtime.store.values('workbenchBatch:').length,0);
  }finally{f.close();}
});

test('original consecutive-failure checkpoint survives a full cloud restore and does not reset at the fifth failure',async()=>{
  const f=await fixture();try{
    const id=f.batchId,batch=f.original.store.get('workbenchBatch:'+id);batch.unattendedState.maxTasks=100;batch.unattendedState.consecutiveFailures=4;f.original.store.set('workbenchBatch:'+id,batch);
    const task=await nextWorkbenchTask(f.original);f.original.update(task,{status:'failed',reason:'original failure'},'fixture_failed');finishWorkbenchTask(f.original,task.id);await f.cloud.flush(f.original.store);
    const restored=f.runtime();await restored.restoreCloud();assert.equal(restored.store.get('workbenchBatch:'+id).unattendedState.consecutiveFailures,5);assert.equal(restored.store.get('workbenchBatch:'+id).count,6);assert.equal(restored.store.get('paused'),true);
  }finally{f.close();}
});

test('batch-linked tasks without their original configuration are parked rather than released with current settings',async()=>{
  const store=new Store(':memory:');try{store.set('pair',{endpoint:'https://fixture.example',workspaceId:'default'});store.set('paused',false);const runtime=new Runtime(store,'isolated'),run={id:'legacy-run',workbenchBatchId:'legacy-batch'},task={id:'legacy-task',runId:run.id,profileId:'p',url:'https://target.example',status:'pending'};
    Object.defineProperty(runtime,'cloud',{value:{request:async()=>({runs:[run],tasks:[task]})}});await runtime.restoreCloud();const parked=store.get('task:'+task.id);assert.equal(parked.status,'needs_manual');assert.equal(parked.attentionType,'batch_recovery_missing');assert.equal(batchActionAllowed(runtime,parked),false);assert.equal(store.get('workbenchBatch:legacy-batch'),null);
  }finally{store.close();}
});

test('a before-submit cloud interruption parks that original task and holds its group instead of silently releasing it again',async()=>{
  const f=await fixture();try{
    const task=await nextWorkbenchTask(f.original);f.original.update(task,{status:'filling',targetId:'original-form'},'fixture_filling');await f.cloud.flush(f.original.store);
    const restored=f.runtime();await restored.restoreCloud();const batch=restored.store.get('workbenchBatch:'+f.batchId);
    assert.equal(restored.store.get('task:'+task.id).status,'needs_manual');assert.equal(batch.items.find(i=>i.taskId===task.id).status,'complete');assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.ok(batch.unattendedState.manualTodoIds.includes(task.id));
    restored.store.set('paused',false);restored.store.set('workbenchBatch:'+batch.id,{...batch,status:'running'});restored.lease=async()=>{};
    const selected=await nextWorkbenchTask(restored);assert.notEqual(selected.id,task.id);assert.notEqual(selected.url,task.url);assert.equal(restored.store.get('task:'+task.id).targetId,'original-form');
  }finally{f.close();}
});

test('an all-existing-task batch persists its new manifest without new runs or replacement task IDs',async()=>{
  const f=await fixture();try{
    const old=f.original.store.get('workbenchBatch:'+f.batchId);f.original.store.set('paused',true);f.original.store.set('workbenchBatch:'+old.id,{...old,status:'stopped'});
    const preview=await previewWorkbenchBatch(f.original,{profileIds:['p','q'],urls:[...new Set(old.items.map(i=>i.url))],config:{fillOnly:true}});assert.equal(preview.batch.items.every(i=>i.existingTask),true);
    await startWorkbenchBatch(f.original,{batchId:preview.batch.id,ordinaryPermissionsAuthorized:true});
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,6);
    const restored=f.runtime();await restored.restoreCloud();const recovered=restored.store.get('workbenchBatch:'+preview.batch.id);
    assert.equal(recovered.cloudManifestInTask,true);assert.equal(recovered.config.fillOnly,true);assert.deepEqual(recovered.items.map(i=>i.taskId),preview.batch.items.map(i=>i.taskId));assert.equal(recovered.count,6);assert.equal(restored.store.get('paused'),true);
  }finally{f.close();}
});

test('a complete local task index still recovers a missing batch policy instead of taking the lightweight shortcut',async()=>{
  const f=await fixture();try{
    const saved=await f.cloud.request('runs'),restored=f.runtime();for(const run of saved.runs)restored.store.set('run:'+run.id,run);for(const task of saved.tasks)restored.store.set('task:'+task.id,task);
    await restored.restoreCloud();assert.equal(restored.store.get('workbenchBatch:'+f.batchId).count,6);assert.equal(restored.store.get('workbenchBatch:'+f.batchId).config.fillOnly,true);
    assert.equal(restored.store.values('task:').length,6);assert.equal(restored.store.get('paused'),true);
  }finally{f.close();}
});

test('a restored older local checkpoint adopts the higher cloud budget revision while an unsynced higher local reservation stays intact',async()=>{
  const f=await fixture();try{
    const saved=await f.cloud.request('runs'),older=f.original.store.get('workbenchBatch:'+f.batchId),restored=f.runtime();
    for(const run of saved.runs)restored.store.set('run:'+run.id,run);for(const task of saved.tasks)restored.store.set('task:'+task.id,task);restored.store.set('workbenchBatch:'+f.batchId,older);
    const task=await nextWorkbenchTask(f.original);await f.original.batchModelRequest(task,'plan',{taskId:task.id});f.original.update(task,{status:'submitting',attemptBoundary:'newer-cloud-boundary'},'fixture_newer_boundary');await f.cloud.flush(f.original.store);
    await restored.restoreCloud();assert.equal(restored.store.get('workbenchBatch:'+f.batchId).unattendedState.taskBudgetUsed,1);assert.equal(restored.store.get('workbenchBatch:'+f.batchId).unattendedState.modelCallsUsed,1);assert.equal(restored.store.get('paused'),true);assert.equal(restored.store.get('task:'+task.id).attemptBoundary,'newer-cloud-boundary');assert.equal(restored.store.get('task:'+task.id).status,'submitted_unconfirmed');
    const local=restored.store.get('workbenchBatch:'+f.batchId);local.cloudCheckpointRevision+=5;local.unattendedState.modelCallsUsed=3;restored.store.set('workbenchBatch:'+f.batchId,local);
    const remote=await f.cloud.request('runs');assert.equal(recoverCloudBatchRecords(restored,remote.runs,remote.tasks).length,0);assert.equal(restored.store.get('workbenchBatch:'+f.batchId).unattendedState.modelCallsUsed,3);
  }finally{f.close();}
});

test('Neon restoration fetches an original run outside the latest thirty by its existing task run ID',async()=>{
  const store=new Store(':memory:');try{
    store.set('pair',{endpoint:'https://fixture.example',workspaceId:'default'});const runtime=new Runtime(store,'isolated'),calls=[],task={id:'old-task',runId:'old-run',status:'finished'};
    Object.defineProperty(runtime,'cloud',{value:{request:async route=>{calls.push(route);return route==='runs'?{runs:[{id:'new-run'}],tasks:[task]}:{runs:[{id:'old-run',tasks:['old-task']}],tasks:[task]};}}});
    await runtime.restoreCloud();assert.deepEqual(calls,['runs','runs?runId=old-run']);assert.equal(store.get('run:old-run').tasks[0],'old-task');assert.equal(store.get('task:old-task').runId,'old-run');
  }finally{store.close();}
});

test('malformed batch metadata is rejected by the authenticated cloud before creating runs or tasks',async()=>{
  const f=await fixture();try{
    const saved=await f.cloud.request('runs'),anchor=saved.runs.find(r=>r.workbenchBatchManifest),before=f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n;
    const run={...anchor,id:'invalid-original-run',tasks:[{id:'invalid-task',url:'https://target0.example/form',destinationKey:'target0.example/form'}],workbenchBatchConfig:{...anchor.workbenchBatchConfig,fillOnly:false}};
    await assert.rejects(f.cloud.request('runs',{run}),error=>error.status===400&&/参数/.test(error.message));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,before);
    run.workbenchBatchConfigSha256=digest(run.workbenchBatchConfig);
    await assert.rejects(f.cloud.request('runs',{run}),error=>error.status===400&&/完整范围/.test(error.message));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,before);
  }finally{f.close();}
});

test('authenticated PostgreSQL JSONB recovery preserves original hashes and restores an anchor outside the newest thirty runs',async()=>{
  const db=new PGlite(),stores=[],fetchBefore=globalThis.fetch;
  try {
    await db.exec(readFileSync(new URL('../cloud/worker/schema.sql',import.meta.url),'utf8'));
    const sql=(strings,...params)=>{const query=strings.reduce((text,part,index)=>text+part+(index<params.length?'$'+(index+1):''),'');return{query,params,then:(done,reject)=>db.query(query,params).then(result=>result.rows).then(done,reject)};};
    sql.transaction=queries=>db.transaction(async tx=>{const results=[];for(const query of queries)results.push((await tx.query(query.query,query.params)).rows);return results;});
    await sql`insert into externallink_workspaces(workspace_id) values('default')`;
    const documents={siteProfiles:{p:{id:'p',fields:{Url:'https://product.example',Name:'Original P'},name:'Original P'}},sheetTableData:{entries:[{link:'https://target.example/form'}]},submissionRecords:{},cfgConcurrency:'4',unattendedPreferences:{enabled:true,hours:8,tasks:3,manualTabs:20}};
    for(const [key,data]of Object.entries(documents))await sql`insert into externallink_workspace_documents(workspace_id,document_key,data) values('default',${key},${JSON.stringify(data)}::jsonb)`;
    const env={APP_ACCESS_TOKEN:'isolated-admin'},helpers={listSnapshot:async()=>{const rows=await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id='default'`;return{documents:Object.fromEntries(rows.map(row=>[row.document_key,row.data])),revisions:Object.fromEntries(rows.map(row=>[row.document_key,Number(row.revision)]))};}};
    globalThis.fetch=(url,options)=>executorApi(new Request(url,options),env,sql,'default',helpers);
    const response=await globalThis.fetch('https://fixture.example/v1/executor/devices',{method:'POST',headers:{Authorization:'Bearer isolated-admin'},body:'{}'}),enrollment=await response.json();assert.equal(response.status,200);
    const pair={endpoint:'https://fixture.example',workspaceId:'default',deviceToken:enrollment.deviceToken},cloud=new Cloud(pair),runtime=()=>{const store=new Store(':memory:');stores.push(store);store.set('pair',pair);store.set('paused',true);const value=new Runtime(store,'isolated');Object.defineProperty(value,'cloud',{value:cloud});value.tick=()=>{};return value;};
    const original=runtime(),preview=await previewWorkbenchBatch(original,{profileIds:['p'],urls:['https://target.example/form'],config:{fillOnly:true}});
    await startWorkbenchBatch(original,{batchId:preview.batch.id,ordinaryPermissionsAuthorized:true});const task=await nextWorkbenchTask(original);original.update(task,{status:'filling',targetId:'original-page'},'fixture_filling');await cloud.flush(original.store);
    const before=original.store.get('workbenchBatch:'+preview.batch.id);
    for(let n=0;n<31;n++)await sql`insert into externallink_executor_runs(workspace_id,run_id,device_id,data,updated_at) values('default',${'later-'+n},${enrollment.deviceId},${JSON.stringify({id:'later-'+n,tasks:[]})}::jsonb,now()+interval '1 day')`;
    assert.equal((await cloud.request('runs')).runs.some(run=>run.workbenchBatchManifest),false);
    const restored=runtime();await restored.restoreCloud();const batch=restored.store.get('workbenchBatch:'+preview.batch.id);
    assert.equal(batch.configSha256,before.configSha256);assert.equal(batch.scopeSha256,before.scopeSha256);assert.equal(batch.count,1);assert.equal(batch.config.fillOnly,true);assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.equal(batch.unattendedState.runDeadlineAt,before.unattendedState.runDeadlineAt);assert.equal(restored.store.get('task:'+task.id).status,'needs_manual');assert.equal(restored.store.get('paused'),true);
  }finally{globalThis.fetch=fetchBefore;for(const store of stores)store.close();await db.close();}
});

test('actual mapper user pause and resume reuse the same filled page and original unattended budget without posting',async()=>{
 const f=await fixture(),home=await mkdtemp(join(tmpdir(),'el-lifecycle-browser-'));let browser;
 try{
  const runtime=f.original;runtime.home=home;browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext();let posts=0,gets=0,external=0;
  await context.route('**/*',async route=>{if(!/^https:\/\/target[0-2]\.example\//.test(route.request().url())){external++;await route.abort();return;}if(route.request().method()==='POST'){posts++;await route.fulfill({body:'unexpected submit'});return;}gets++;await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Submit your tool</title><form><label>Product name<input name="name" required></label><label>Website<input name="url" type="url" required></label><button type="submit">Submit tool</button></form>'});});
  runtime.context=context;runtime.host={startedAt:'isolated-original-lifecycle-browser'};const task=await nextWorkbenchTask(runtime),deadline=task.taskDeadlineAt,budget=runtime.store.get('workbenchBatch:'+f.batchId).unattendedState;
  runtime.activeTaskIds=new Set([task.id]);const update=runtime.update.bind(runtime);let pause;
  runtime.update=(task,patch,type,stateChanges)=>{const event=update(task,patch,type,stateChanges);if(type==='filled_snapshot'&&!pause)pause=runtime.control('pause',{});return event;};
  await runtime.work({taskId:task.id});await pause;runtime.update=update;runtime.activeTaskIds.clear();
  const paused=runtime.store.get('task:'+task.id),target=paused.targetId,page=await runtime.findPage(paused);assert.equal(paused.status,'pending');assert.equal(paused.pauseContinuation.targetId,target);assert.equal(await page.locator('input[name=url]').inputValue(),'https://product-p.example');assert.equal(page.isClosed(),false);assert.equal(paused.attemptBoundary,undefined);
  const loaded=gets;await runtime.control('resume',{expectedBatchId:f.batchId});const continuation=await nextWorkbenchTask(runtime);assert.equal(continuation.id,task.id);await runtime.work({taskId:continuation.id});
  const saved=runtime.store.get('task:'+task.id);assert.equal(saved.targetId,target);assert.equal(saved.browserInstance,paused.browserInstance);assert.equal(saved.taskDeadlineAt,deadline);assert.equal(saved.status,'needs_manual');assert.equal(saved.fillOnlyPrepared,true);assert.equal(page.isClosed(),false);assert.equal(gets,loaded);assert.equal(posts,0);assert.equal(external,0);assert.equal(f.models(),0);assert.equal(runtime.store.get('workbenchBatch:'+f.batchId).unattendedState.taskBudgetUsed,1);assert.equal(runtime.store.get('workbenchBatch:'+f.batchId).unattendedState.runDeadlineAt,budget.runDeadlineAt);assert.equal(runtime.store.get('workbenchBatch:'+f.batchId).count,6);
 }finally{await browser?.close();f.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-lifecycle-browser-'));await rm(absolute,{recursive:true,force:true});}
});

test('the actual mapper prepares a cloud-restored fill-only batch in an isolated browser without posting or changing the remaining range',async()=>{
  const f=await fixture(),home=await mkdtemp(join(tmpdir(),'el-cloud-batch-browser-'));let browser;
  try {
    const restored=f.runtime();await restored.restoreCloud();restored.home=home;
    // The previous isolated process is gone; its cloud lease has expired.
    f.sqlite.prepare('UPDATE executor_controls SET lease_until=0').run();
    await startWorkbenchBatch(restored,{batchId:f.batchId,ordinaryPermissionsAuthorized:true});
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext();let posts=0,external=0;
    await context.route('**/*',async route=>{if(!/^https:\/\/target[0-2]\.example\//.test(route.request().url())){external++;await route.abort();return;}if(route.request().method()==='POST'){posts++;await route.fulfill({body:'unexpected fixture submit'});return;}await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Submit your tool</title><form><label>Product name<input name="name" required></label><label>Website<input name="url" type="url" required></label><button type="submit">Submit tool</button></form>'});});
    restored.context=context;restored.host={startedAt:'isolated-cloud-restored-browser'};
    const task=await nextWorkbenchTask(restored);await restored.work({taskId:task.id});finishWorkbenchTask(restored,task.id);
    const saved=restored.store.get('task:'+task.id),batch=restored.store.get('workbenchBatch:'+f.batchId),page=await restored.findPage(saved);
    assert.equal(saved.fillOnlyPrepared,true);assert.equal(saved.status,'needs_manual');assert.equal(saved.attemptBoundary,undefined);assert.equal(saved.receipt,undefined);assert.equal(saved.tabClosedAt,undefined);assert.equal(await page.locator('input[name=url]').inputValue(),'https://product-p.example');assert.equal(posts,0);assert.equal(external,0);assert.equal(f.models(),0);assert.equal(batch.count,6);assert.equal(batch.unattendedState.taskBudgetUsed,1);assert.equal(batch.items.filter(item=>restored.store.get('task:'+item.taskId)?.status==='pending').length,5);
  }finally{await browser?.close();f.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-cloud-batch-browser-'));await rm(absolute,{recursive:true,force:true});}
});
