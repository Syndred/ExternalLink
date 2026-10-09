import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {executorApi} from '../cloud/worker/src/executor-api.mjs';
import {Cloud} from '../executor/src/cloud.mjs';
import {Store} from '../executor/src/store.mjs';
import {queue} from '../executor/src/shared.mjs';
import {existingSinglePageReceipt,verifyExistingSinglePageReceipt} from '../executor/src/existing-single-page-receipt.mjs';
import {existingReceiptTimelineContains} from '../core/existing-receipt.mjs';
import {observedRefillReceiptKeys,observedRefillReceiptSatisfied} from '../core/observed-refill-receipt.mjs';

test('authenticated PostgreSQL repairs only the old receipt timeline and rejects stale associated revisions',async()=>{
 const db=new PGlite(),store=new Store(':memory:'),fetchBefore=globalThis.fetch;
 try{
  await db.exec(readFileSync(new URL('../cloud/worker/schema.sql',import.meta.url),'utf8'));
  const sql=(strings,...params)=>{const query=strings.reduce((text,part,index)=>text+part+(index<params.length?'$'+(index+1):''),'');return{query,params,then:(done,reject)=>db.query(query,params).then(result=>result.rows).then(done,reject)};};sql.transaction=queries=>db.transaction(async tx=>{const results=[];for(const query of queries)results.push((await tx.query(query.query,query.params)).rows);return results;});
  await sql`insert into externallink_workspaces(workspace_id) values('default')`;const url='https://bai.tools/submit',record=structuredClone(queue.buildSuccessRecord({destinationUrl:url,profileId:'p',submittedAt:'2026-01-01T00:00:00Z',evidence:'Original PostgreSQL receipt'})),key=queue.submissionRecordKey(record.destinationKey,'p'),documents={siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.example'}}},submissionRecords:{[key]:record},submissionTimeline:{}};
  for(const [name,data]of Object.entries(documents))await sql`insert into externallink_workspace_documents(workspace_id,document_key,data) values('default',${name},${JSON.stringify(data)}::jsonb)`;
  const env={APP_ACCESS_TOKEN:'isolated-admin'},helpers={recordEvent:async()=>{},listSnapshot:async()=>{const rows=await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id='default'`;return{documents:Object.fromEntries(rows.map(row=>[row.document_key,row.data])),revisions:Object.fromEntries(rows.map(row=>[row.document_key,Number(row.revision)]))};}};globalThis.fetch=(url,options)=>executorApi(new Request(url,options),env,sql,'default',helpers);
  const enrollment=await(await globalThis.fetch('https://fixture.example/v1/executor/devices',{method:'POST',headers:{Authorization:'Bearer isolated-admin'},body:'{}'})).json(),pair={endpoint:'https://fixture.example',workspaceId:'default',deviceToken:enrollment.deviceToken},cloud=new Cloud(pair),runtime={store,cloud,host:{startedAt:'isolated'}};store.set('pair',pair);const before=await cloud.request('snapshot'),state=existingSinglePageReceipt(runtime,before,'p',url,{id:'panel',generation:1,profileId:'p',selectedTargetId:'original'});
  const result=await verifyExistingSinglePageReceipt(runtime,state,()=>{});assert.equal(result.cloudSynced,true);assert.equal(result.submitted,false);const after=await cloud.request('snapshot');assert.deepEqual(after.documents.submissionRecords,before.documents.submissionRecords);assert.equal(after.revisions.submissionRecords,before.revisions.submissionRecords);assert.equal(existingReceiptTimelineContains(after.documents.submissionTimeline,key,record),true);assert.equal((await cloud.request('runs?view=inventory')).tasks.length,0);
  const operation={type:'receipt_timeline_repair',id:'stale',at:'2026-10-09T00:00:00Z',recordKey:key,expectedRecord:record},revisions={submissionTimeline:after.revisions.submissionTimeline,timelineSchemaVersion:after.revisions.timelineSchemaVersion,submissionRecords:after.revisions.submissionRecords};
  await assert.rejects(()=>cloud.request('library',{operation,revision:revisions.submissionTimeline}),/关联资料版本号/);
  await assert.rejects(()=>cloud.request('library',{operation,revision:revisions.submissionTimeline,revisions:{...revisions,submissionRecords:revisions.submissionRecords-1}}),/关联资料/);
  assert.deepEqual((await cloud.request('snapshot')).documents,after.documents);await verifyExistingSinglePageReceipt(runtime,state,()=>{});assert.deepEqual((await cloud.request('snapshot')).revisions,after.revisions);
  const observed={type:'observed_refill_receipt',id:'original-manual-observation',at:'2026-10-09T01:00:02Z',destinationUrl:url,profileId:'p',profileName:'Original',previousRecordKey:key,previousRecord:record,expectedRecords:{[key]:record},observation:{token:'original-token',refillId:'original-refill',actionObserved:true,clickedAt:'2026-10-09T01:00:00Z',observedAt:'2026-10-09T01:00:02Z',pageUrl:url,currentPageUrl:url,evidenceUrl:url,baseline:'Old page'},receipt:{matched:true,evidence:'A new original receipt',publicationStatus:'pending_moderation'}},associated=Object.fromEntries(observedRefillReceiptKeys.map(key=>[key,after.revisions[key]||0]));
  await assert.rejects(()=>cloud.request('library',{operation:observed,revision:associated.submissionRecords}),/关联资料版本号/);
  await assert.rejects(()=>cloud.request('library',{operation:observed,revision:associated.submissionRecords,revisions:{...associated,submissionTimeline:associated.submissionTimeline-1}}),/关联资料/);
  await cloud.request('library',{operation:observed,revision:associated.submissionRecords,revisions:associated});const newer=await cloud.request('snapshot');assert.equal(observedRefillReceiptSatisfied(newer.documents,observed),true);assert.deepEqual(newer.documents.submissionTimeline[key][0],after.documents.submissionTimeline[key][0]);assert.equal(newer.documents.submissionTimeline[key].length,2);assert.equal((await cloud.request('runs?view=inventory')).tasks.length,0);
  await cloud.request('library',{operation:observed,revision:newer.revisions.submissionRecords,revisions:Object.fromEntries(observedRefillReceiptKeys.map(key=>[key,newer.revisions[key]||0]))});assert.deepEqual((await cloud.request('snapshot')).revisions,newer.revisions);
 }finally{globalThis.fetch=fetchBefore;store.close();await db.close();}
});
