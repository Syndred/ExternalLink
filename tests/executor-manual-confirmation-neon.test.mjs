import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {executorApi} from '../cloud/worker/src/executor-api.mjs';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';

test('authenticated Neon manual confirmation retains original data and restores the complete task and manual timeline',async()=>{
 const db=new PGlite(),stores=[],previousFetch=globalThis.fetch;
 try{
  await db.exec(await readFile(new URL('../cloud/worker/schema.sql',import.meta.url),'utf8'));
  const sql=(strings,...params)=>{const query=strings.reduce((value,part,index)=>value+part+(index<params.length?'$'+(index+1):''),'');return{query,params,then:(resolve,reject)=>db.query(query,params).then(value=>value.rows).then(resolve,reject)};};sql.transaction=queries=>db.transaction(async tx=>{const results=[];for(const query of queries)results.push((await tx.query(query.query,query.params)).rows);return results;});
  await sql`insert into externallink_workspaces(workspace_id) values('default')`;
  const profile={id:'p',name:'Original P',fields:{Name:'Original P',Url:'https://product.example'}},documents={siteProfiles:{p:profile},sheetTableData:{entries:[{link:'https://target.example/form'}]},siteAnnotations:{'target.example/form':{note:'Keep original',library:{favorite:true,groups:['original']}}},submissionRecords:{protected:{profileId:'other',destinationUrl:'https://other.example',status:'success',evidence:'Protected original'}},submissionTimeline:{protected:[{id:'original',note:'Original history'}]},cfgPingIndex:false};
  for(const [key,data]of Object.entries(documents))await sql`insert into externallink_workspace_documents(workspace_id,document_key,data) values('default',${key},${JSON.stringify(data)}::jsonb)`;
  const env={APP_ACCESS_TOKEN:'isolated-admin'},helpers={recordEvent:async()=>{},listSnapshot:async()=>{const rows=await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id='default'`;return{documents:Object.fromEntries(rows.map(row=>[row.document_key,row.data])),revisions:Object.fromEntries(rows.map(row=>[row.document_key,Number(row.revision)]))};}};
  globalThis.fetch=(url,options)=>executorApi(new Request(url,options),env,sql,'default',helpers);
  const response=await fetch('https://fixture.example/v1/executor/devices',{method:'POST',headers:{Authorization:'Bearer isolated-admin'},body:'{}'}),enrollment=await response.json();assert.equal(response.status,200);
  const pair={endpoint:'https://fixture.example',workspaceId:'default',deviceId:enrollment.deviceId,deviceToken:enrollment.deviceToken,storageBackend:'neon'},make=()=>{const store=new Store(':memory:');stores.push(store);store.set('pair',pair);store.set('paused',true);const runtime=new Runtime(store,'unused-neon-confirmation');runtime.tick=()=>{};return runtime;},runtime=make(),snapshot=await runtime.cloud.request('snapshot'),run={id:'manual-original-run',profileId:'p',profileRevision:snapshot.revisions.siteProfiles,profile,tasks:[{id:'manual-original-task',url:'https://target.example/form',destinationKey:'target.example/form'}]},registered=await runtime.cloud.request('runs',{run});runtime.store.set('run:'+run.id,registered.run);runtime.store.set('task:manual-original-task',registered.tasks[0]);
  runtime.update(registered.tasks[0],{status:'needs_manual',controller:'executor',profileSnapshot:profile,profileRevision:run.profileRevision,indexNotificationPreference:false},'fixture_original_parked');await runtime.synchronize();
  const input={taskId:'manual-original-task',runId:run.id},preview=await runtime.control('previewManualConfirmation',input);assert.equal((await runtime.control('confirmSubmissionSuccess',{...input,confirmationNonce:preview.confirmationNonce,evidence:'Original account receipt verified by owner'})).confirmed,true);
  const after=await runtime.cloud.request('snapshot'),record=after.documents.submissionRecords['target.example/form::p'];assert.equal(record.confirmedBy,'manual');assert.equal(record.evidenceType,'manual_confirmation');assert.equal(after.documents.submissionTimeline['target.example/form::p'].find(event=>event.id==='executor-manual-original-task').source,'manual');
  for(const key of ['siteProfiles','sheetTableData','siteAnnotations','cfgPingIndex'])assert.deepEqual(after.documents[key],snapshot.documents[key]);assert.deepEqual(after.documents.submissionRecords.protected,documents.submissionRecords.protected);assert.deepEqual(after.documents.submissionTimeline.protected,documents.submissionTimeline.protected);
  const restored=make();await restored.restoreCloud();const task=restored.store.get('task:manual-original-task');assert.equal(task.status,'finished');assert.equal(task.cloudVerified,true);assert.equal(task.manualConfirmation.status,'confirmed');assert.equal(task.receipt.evidence,record.evidence);assert.equal(task.receipt.successProof.manualConfirmationId,record.successProof.manualConfirmationId);assert.deepEqual(task.actualSubmission.fields,{});assert.equal(restored.store.get('paused'),true);
 }finally{globalThis.fetch=previousFetch;for(const store of stores)store.close();await db.close();}
});
