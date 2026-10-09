import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {D1Store} from '../cloud/worker/src/d1-store.mjs';
import {d1Executor} from '../cloud/worker/src/d1-executor.mjs';
import {executorApi} from '../cloud/worker/src/executor-api.mjs';
import {originalLibraryAction} from './helpers/original-library-catalog.mjs';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {applicationMutationDependencies} from '../core/application-mutation-dependencies.mjs';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueApplicationPlan,flushApplicationMutations,overlayApplication,pendingApplication} from '../executor/src/application-mutations.mjs';

const keys=['urlList','deletedSubmissionKeys','siteAnnotations'],url='https://original.example/post';
const fixture=()=>({urlList:'https://ahead.example/form|directory\n'+url+'|article\n'+url+'|wp_comment',deletedSubmissionKeys:['original.example/post','unrelated.example'],siteAnnotations:{'original.example/post':{status:'deleted',library:{favorite:true,groups:['original']},formKnowledge:{selector:'#original'}},'original.example':{note:'Original domain note'},unrelated:{note:'Retain another entry'}},submissionRecords:{receipt:{status:'success',evidence:'Keep original receipt'}},submissionTimeline:{receipt:[{type:'submitted',at:'2026-09-01'}]}});
const operation=(extra={})=>({type:'add_browser_url',id:'original-browser-add',at:'2026-10-09T06:00:00Z',url,platformType:'forum',...extra});

test('new and existing browser additions preserve the complete frozen addToUrlList result without pinning or deduplicating existing lines',async()=>{
 for(const inputUrl of [url,'https://new.example/post'])for(const platformType of ['wp_comment','profile','forum','directory','submission','article','unknown']){
  const before=fixture();before.urlList=' \n'+before.urlList+'\n ';const original=await originalLibraryAction(before,'add',{url:inputUrl,platformType}),op=operation({url:inputUrl,platformType}),change=applicationMutation(before,op),after={...before,...change.updates};
  assert.deepEqual(after,original.documents);assert.deepEqual(change.revisionKeys,keys);assert.deepEqual(applicationMutationDependencies(op),keys);assert.equal(applicationMutationSatisfied(after,op),true);assert.equal(before.siteAnnotations['original.example/post'].library.favorite,true);
 }
});

test('atomic browser addition survives offline SQLite reopen and a lost reply without replaying any of its three documents',async()=>{
 const home=mkdtempSync(join(tmpdir(),'el-original-browser-add-'));let store=new Store(join(home,'outbox.sqlite'));let online=false,writes=0;
 try{
  const before=fixture(),snapshot={documents:structuredClone(before),revisions:Object.fromEntries(keys.map(key=>[key,1]))},pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original-add'},scope=workbenchScope(pair);store.set('pair',pair);store.set('applicationSnapshot',{scope,snapshot:structuredClone(snapshot)});
  const cloud={async request(route,input){if(!online)throw Error('Fixture offline');if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'library');assert.deepEqual(input.revisions,{urlList:1,deletedSubmissionKeys:1,siteAnnotations:1});writes++;const change=applicationMutation(snapshot.documents,input.operation);Object.assign(snapshot.documents,change.updates);for(const key of keys)snapshot.revisions[key]++;throw Error('Fixture atomic reply lost');}},runtime={store,cloud};
  const queued=await enqueueApplicationPlan(runtime,{operations:[operation()]}),saved=store.get('applicationPlan:'+queued.planId),id=saved.items[0].id;assert.equal(saved.kind,'catalog_lifecycle');assert.deepEqual(store.get('appMutation:'+id).writeKeys,keys);const expected=(await originalLibraryAction(before,'add',{url,platformType:'forum'})).documents;assert.deepEqual(overlayApplication(runtime,snapshot).documents,expected);assert.deepEqual(snapshot.documents,before);assert.equal(writes,0);
  store.close();store=new Store(join(home,'outbox.sqlite'));online=true;await flushApplicationMutations({store,cloud});assert.equal(writes,1);await flushApplicationMutations({store,cloud});assert.equal(writes,1);assert.equal(store.get('appMutation:'+id).status,'confirmed');assert.equal(store.get('applicationPlan:'+queued.planId).status,'completed');assert.deepEqual(snapshot.documents,expected);assert.deepEqual(store.get('appMutation:'+id).relatedBaseData.siteAnnotations,before.siteAnnotations);
 }finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-browser-add-'));rmSync(home,{recursive:true,force:true});}
});

test('concurrent changes to any browser-add document retain the complete pending operation and never clear newer marks',async()=>{
 for(const key of keys){const store=new Store(':memory:');try{
  const snapshot={documents:fixture(),revisions:Object.fromEntries(keys.map(k=>[k,1]))},pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'add-conflict'},scope=workbenchScope(pair);store.set('pair',pair);store.set('applicationSnapshot',{scope,snapshot:structuredClone(snapshot)});let online=false,writes=0;
  const runtime={store,cloud:{async request(route){if(!online)throw Error('Fixture offline');if(route==='snapshot')return structuredClone(snapshot);writes++;throw Error('Must not overwrite concurrent data');}}};await enqueueApplicationPlan(runtime,{operations:[operation()]});
  if(key==='urlList')snapshot.documents[key]='https://concurrent.example/new|profile\n'+snapshot.documents[key];else if(key==='deletedSubmissionKeys')snapshot.documents[key].push('concurrent.example/new');else snapshot.documents[key].unrelated.note='Concurrent note';snapshot.revisions[key]++;const before=structuredClone(snapshot);online=true;await flushApplicationMutations(runtime);
  const pending=pendingApplication(runtime);assert.equal(pending.length,1);assert.equal(pending[0].status,'conflict');assert.equal(pending[0].operation.type,'add_browser_url');assert.deepEqual(snapshot,before);assert.equal(writes,0);
 }finally{store.close();}}
});

async function backend(kind){
 const state={beforeTransaction:null};
 if(kind==='D1'){
  const sqlite=new DatabaseSync(':memory:');for(const file of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../cloud/worker/migrations/'+file,import.meta.url),'utf8'));
  const db={prepare(sql){let args=[];return{bind(...values){args=values;return this;},first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const query=sqlite.prepare(sql);return query.columns().length?{results:query.all(...args),meta:{changes:0}}:{results:[],meta:{changes:query.run(...args).changes}};}};},async batch(statements){const hook=state.beforeTransaction;state.beforeTransaction=null;await hook?.();sqlite.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const objects=new Map(),bucket={head:async key=>objects.has(key)?{customMetadata:objects.get(key).meta?.customMetadata}:null,put:async(key,value,meta)=>objects.set(key,{bytes:new Uint8Array(value),meta}),get:async key=>{const value=objects.get(key);return value?{arrayBuffer:async()=>value.bytes.slice().buffer,httpMetadata:value.meta?.httpMetadata,customMetadata:value.meta?.customMetadata}:null;}},env={LEDGER_DB:db,MEDIA_BUCKET:bucket,APP_ACCESS_TOKEN:'fixture-admin'},store=new D1Store(db,bucket,'default');
  state.call=(route,token,input)=>d1Executor(new Request('https://cloud.fixture.invalid/v2/executor/'+route,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(input)}),env,'default');
  state.seed=async documents=>{for(const[key,data]of Object.entries(documents))await store.putDocument(key,data,0);};state.read=async()=>{const result={};for(const key of Object.keys(fixture())){const row=await store.document(key);if(row)result[key]={data:row.data,revision:row.revision};}return result;};
  state.change=async(key,data,revision)=>store.putDocument(key,data,revision);state.close=async()=>sqlite.close();
 }else{
  const db=new PGlite();await db.exec(readFileSync(new URL('../cloud/worker/schema.sql',import.meta.url),'utf8'));
  const sql=(strings,...params)=>{const query=strings.reduce((text,part,index)=>text+part+(index<params.length?'$'+(index+1):''),'');return{query,params,then:(resolve,reject)=>db.query(query,params).then(result=>result.rows).then(resolve,reject)};};
  sql.transaction=async queries=>{const hook=state.beforeTransaction;state.beforeTransaction=null;await hook?.();return db.transaction(async tx=>{const result=[];for(const query of queries)result.push((await tx.query(query.query,query.params)).rows);return result;});};await sql`insert into externallink_workspaces(workspace_id) values('default')`;
  const env={APP_ACCESS_TOKEN:'fixture-admin'};state.call=(route,token,input)=>executorApi(new Request('https://cloud.fixture.invalid/v1/executor/'+route,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(input)}),env,sql,'default',{});
  state.seed=async documents=>{for(const[key,data]of Object.entries(documents))await sql`insert into externallink_workspace_documents(workspace_id,document_key,data) values('default',${key},${JSON.stringify(data)}::jsonb)`;};state.read=async()=>Object.fromEntries((await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id='default'`).map(row=>[row.document_key,{data:row.data,revision:Number(row.revision)}]));
  state.change=async(key,data,revision)=>db.query("update externallink_workspace_documents set data=$1::jsonb,revision=revision+1 where workspace_id='default' and document_key=$2 and revision=$3",[JSON.stringify(data),key,revision]);state.close=()=>db.close();
 }
 state.request=async(...args)=>{const response=await state.call(...args);return{status:response.status,data:await response.json()};};return state;
}

for(const kind of ['D1','PostgreSQL'])test('authenticated '+kind+' browser add matches original documents and fences all three revisions atomically',async()=>{
 const f=await backend(kind);try{
  const documents=fixture();await f.seed(documents);const original=await f.read(),device=await f.request('devices','fixture-admin',{});assert.equal(device.status,200);const token=device.data.deviceToken,op=operation(),input={operation:op,revision:1,revisions:{urlList:1,deletedSubmissionKeys:1,siteAnnotations:1}};
  for(const denied of ['wrong','fixture-admin'])assert.equal((await f.request('library',denied,input)).status,401);
  assert.equal((await f.request('library',token,{operation:op,revision:1})).status,400);
  for(const key of keys)assert.equal((await f.request('library',token,{...input,revisions:{...input.revisions,[key]:0}})).status,key==='urlList'?400:409);
  assert.deepEqual(await f.read(),original);const expected=(await originalLibraryAction(documents,'add',{url,platformType:'forum'})).documents,saved=await f.request('library',token,input);assert.equal(saved.status,200,JSON.stringify(saved));let current=await f.read();assert.deepEqual(Object.fromEntries(Object.entries(current).map(([k,v])=>[k,v.data])),expected);assert.deepEqual(current.submissionRecords,original.submissionRecords);assert.deepEqual(current.submissionTimeline,original.submissionTimeline);assert.equal((await f.request('library',token,input)).status,409);
  // An annotation edit after the server's read must reject the whole add,
  // including insertion of a new URL, without writing partial documents.
  const before=await f.read(),revisions=Object.fromEntries(keys.map(key=>[key,before[key].revision])),concurrent={...before.siteAnnotations.data,newer:{note:'Concurrent annotation'}};f.beforeTransaction=()=>f.change('siteAnnotations',concurrent,revisions.siteAnnotations);
  const race=await f.request('library',token,{operation:operation({id:'add-race',url:'https://new.example/post'}),revision:revisions.urlList,revisions});assert.equal(race.status,409,JSON.stringify(race));current=await f.read();assert.deepEqual(current.urlList,before.urlList);assert.deepEqual(current.deletedSubmissionKeys,before.deletedSubmissionKeys);assert.deepEqual(current.siteAnnotations.data,concurrent);assert.deepEqual(current.submissionRecords,original.submissionRecords);
  const fresh=Object.fromEntries(keys.map(key=>[key,current[key].revision])),retry=await f.request('library',token,{operation:operation({id:'add-retry',url:'https://new.example/post'}),revision:fresh.urlList,revisions:fresh});assert.equal(retry.status,200,JSON.stringify(retry));const expectedNew=(await originalLibraryAction(Object.fromEntries(Object.entries(current).map(([k,v])=>[k,v.data])),'add',{url:'https://new.example/post',platformType:'forum'})).documents;assert.deepEqual(Object.fromEntries(Object.entries(await f.read()).map(([k,v])=>[k,v.data])),expectedNew);
 }finally{await f.close();}
});
