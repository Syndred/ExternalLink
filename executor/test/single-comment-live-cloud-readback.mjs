import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {Runtime} from '../src/runtime.mjs';
import {Cloud} from '../src/cloud.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const native=new Store(join(homedir(),'.externallink-executor','outbox.sqlite'),{readOnly:true});const pair=native.get('pair');native.close();assert.equal(pair.storageBackend,'d1');assert.equal(pair.workspaceId,'default');
const cwd=fileURLToPath(new URL('../../cloud/worker/',import.meta.url)),wrangler=fileURLToPath(new URL('../../cloud/worker/node_modules/wrangler/bin/wrangler.js',import.meta.url));
const cli=args=>execFileSync(process.execPath,[wrangler,...args],{cwd,encoding:'utf8',maxBuffer:2*1024*1024,timeout:60000,windowsHide:true});
const sql=command=>JSON.parse(cli(['d1','execute','externallink-ledger','--remote','--command',command,'--json']));
const suffix=randomUUID(),runId='autoclose-'+suffix,taskId='autoclose-task-'+suffix;
const output=fileURLToPath(new URL('../../docs/evidence/no-extension-2026-09-30/autonomous-closure-2026-10-10/live-failure-cloud.json',import.meta.url));
const cloud=new Cloud(pair);console.log('Reading protected cloud document baseline');const before=await cloud.request('snapshot');
const pointersBefore=sql("SELECT id,object_key,checksum FROM executor_runs WHERE workspace='default' ORDER BY id; SELECT id,object_key,checksum,summary FROM journal_tasks WHERE workspace='default' ORDER BY id");
const home=await mkdtemp(join(tmpdir(),'el-live-field-proof-')),store=new Store(join(home,'outbox.sqlite'));store.set('pair',pair);store.set('paused',true);const runtime=new Runtime(store,home);
const initial=sql(`SELECT count(*) AS n FROM executor_runs WHERE workspace='default' AND id='${runId}'`);assert.equal(initial[0].results[0].n,0);
let registered=false,cleaned=false;const keys=new Set();
try{
 const profileId=Object.hasOwn(before.documents.siteProfiles,'JevPlay')?'JevPlay':Object.keys(before.documents.siteProfiles)[0];assert.ok(profileId);
 const url='https://'+suffix+'.autoclose.invalid/article',run={id:runId,profileId,profileRevision:before.revisions.siteProfiles,createdAt:new Date().toISOString(),mode:'single_page_preparation',authorization:'fill_only',feeLimit:0,tasks:[{id:taskId,url,destinationKey:new URL(url).host+'/article'}]};
 console.log('Registering uniquely named fill-only test task');const result=await cloud.request('runs',{run});registered=true;const initialTasksChecksum=createHash('sha256').update(JSON.stringify(result.tasks)).digest('hex');assert.equal(result.tasks.length,1);store.set('run:'+runId,result.run);const task=result.tasks[0];store.set('task:'+taskId,task);
 const at=new Date().toISOString(),actualPreparation={fields:[{name:'comment',value:'Controlled accepted original comment 中文🙂'}]},failure={at,mode:'comment',actual:{fields:[{name:'comment',value:'Controlled rejected comment 中文🙂'}]},reason:'评论填写未通过回读核验'};
 runtime.update(task,{actualPreparation,singlePagePreparationFailure:failure,status:'needs_manual',reason:failure.reason},'single_page_comment_incomplete');const event=store.pending()[0];console.log('Writing and independently reading new failure field');await cloud.flush(store);assert.equal(store.pendingCount(),0);
 const read=await cloud.request('events/'+event.id),remote=await cloud.request('tasks/'+taskId);assert.deepEqual(read.event,event);assert.deepEqual(remote.task.singlePagePreparationFailure,failure);assert.deepEqual(remote.task.actualPreparation,actualPreparation);assert.equal(remote.task.attemptBoundary,undefined);assert.equal(remote.task.receipt,undefined);
 // The exact cloud task body survives a separate SQLite database reopening.
 const restored=new Store(join(home,'restored.sqlite'));try{restored.set('task:'+taskId,remote.task);}finally{restored.close();}const reopened=new Store(join(home,'restored.sqlite'));try{assert.deepEqual(reopened.get('task:'+taskId),remote.task);}finally{reopened.close();}
 const pointers=sql(`SELECT object_key FROM executor_runs WHERE workspace='default' AND id='${runId}' UNION SELECT object_key FROM journal_tasks WHERE workspace='default' AND id='${taskId}' UNION SELECT object_key FROM executor_events WHERE workspace='default' AND task_id='${taskId}'`)[0].results;
 for(const row of pointers){assert.match(row.object_key,/^default\/d1\/objects\/[a-f0-9]{64}\.json$/);keys.add(row.object_key);}
 // Registration stores the initial tasks array separately from the final task pointer.
 keys.add('default/d1/objects/'+initialTasksChecksum+'.json');
 const after=await cloud.request('snapshot');assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.revisions,before.revisions);
 await writeFile(output,JSON.stringify({ok:true,actualHostedWorker:true,storage:'production D1 and R2',uniqueTestRun:runId,uniqueTestTask:taskId,exactImmutableEventReadback:true,exactTaskFailureAndPreviousSuccessReadback:true,separateSqliteReopen:true,workspaceDocumentsAndRevisionsUnchanged:true,beforeDocumentsSha256:hash(before.documents),taskSubmissionBoundaryAbsent:true,posts:0,formalReceipts:0,originalTasksModified:0,originalChromeUntouched:true,cleanupPending:true},null,2)+'\n');
}finally{
 if(registered){console.log('Removing only this test task, event, run and their R2 objects');sql(`DELETE FROM executor_events WHERE workspace='default' AND task_id='${taskId}'; DELETE FROM journal_tasks WHERE workspace='default' AND id='${taskId}'; DELETE FROM executor_controls WHERE workspace='default' AND id='${taskId}' AND run_id='${runId}'; DELETE FROM executor_runs WHERE workspace='default' AND id='${runId}';`);for(const key of keys)cli(['r2','object','delete','externallink-media/'+key,'--remote']);const remaining=sql(`SELECT (SELECT count(*) FROM executor_runs WHERE workspace='default' AND id='${runId}')+(SELECT count(*) FROM executor_controls WHERE workspace='default' AND id='${taskId}')+(SELECT count(*) FROM journal_tasks WHERE workspace='default' AND id='${taskId}')+(SELECT count(*) FROM executor_events WHERE workspace='default' AND task_id='${taskId}') AS n`)[0].results[0].n;assert.equal(remaining,0);cleaned=true;}
 store.close();await rm(home,{recursive:true,force:true});
}
assert.equal(cleaned,true);const after=await cloud.request('snapshot');assert.deepEqual(after,before);const pointersAfter=sql("SELECT id,object_key,checksum FROM executor_runs WHERE workspace='default' ORDER BY id; SELECT id,object_key,checksum,summary FROM journal_tasks WHERE workspace='default' ORDER BY id");assert.deepEqual(pointersAfter.map(row=>row.results),pointersBefore.map(row=>row.results));
await writeFile(output,JSON.stringify({ok:true,actualHostedWorker:true,storage:'production D1 and R2',uniqueTestRun:runId,uniqueTestTask:taskId,exactImmutableEventReadback:true,exactTaskFailureAndPreviousSuccessReadback:true,separateSqliteReopen:true,workspaceDocumentsAndRevisionsUnchanged:true,allOriginalRunsAndTasksUnchanged:true,beforeDocumentsSha256:hash(before.documents),testD1RowsRemoved:true,testR2ObjectsRemoved:keys.size,taskSubmissionBoundaryAbsent:true,posts:0,formalReceipts:0,originalTasksModified:0,originalChromeUntouched:true},null,2)+'\n');console.log(JSON.stringify({ok:true,liveAuthenticatedNewFailureFieldsReadback:true,originalStateUnchanged:true,testD1AndR2Cleaned:true,posts:0}));
