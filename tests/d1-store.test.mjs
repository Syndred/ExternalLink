import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { D1Store } from '../cloud/worker/src/d1-store.mjs';
import { d1Api } from '../cloud/worker/src/d1-api.mjs';
import worker from '../cloud/worker/src/index.mjs';
import { deviceSnapshotResponse } from '../cloud/worker/src/device-snapshot.mjs';

test('device snapshot streams exact large Unicode documents and immutable revisions without parsing objects',async()=>{
 const f=fixture(),large={rows:Array.from({length:3000},(_,i)=>({id:i,text:'中文字段和资料'.repeat(50)}))};
 await f.store.putDocument('sheetTableData',large,0);
 await f.store.putDocument('siteProfiles',{'产品':{id:'中文',text:'"换行\n😀'}},0);
 await new D1Store(f.db,f.bucket,'other').putDocument('private',{secret:'unrelated'},0);
 f.store.readObject=()=>{throw new Error('snapshot must not parse stored JSON');};
 const response=await deviceSnapshotResponse(f.store,'device-one'),snapshot=await response.json();
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(snapshot.documents.sheetTableData,large);
 assert.deepEqual(snapshot.documents.siteProfiles,{'产品':{id:'中文',text:'"换行\n😀'}});
 assert.deepEqual(snapshot.revisions,{sheetTableData:1,siteProfiles:1});
 assert.equal(snapshot.documents.private,undefined);
 const row=f.sqlite.prepare("SELECT object_key FROM documents WHERE workspace='one' AND key='sheetTableData'").get();
 f.objects.set(row.object_key,new TextEncoder().encode('{}'));
 await assert.rejects(deviceSnapshotResponse(f.store,'device-one'),/校验失败/);
});

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../cloud/worker/migrations/'+name,import.meta.url),'utf8'));
  const db={prepare(sql){let values=[];return{bind(...v){values=v;return this;},async first(){return sqlite.prepare(sql).get(...values)||null;},async all(){return{results:sqlite.prepare(sql).all(...values)};},async run(){const stmt=sqlite.prepare(sql);return stmt.columns().length?{results:stmt.all(...values),meta:{changes:0}}:{results:[],meta:{changes:stmt.run(...values).changes}};}};},
    async batch(statements){sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const objects=new Map();let reads=0;
  const bucket={async head(k){return objects.has(k)?{}:null;},async put(k,v){objects.set(k,new Uint8Array(v));},async get(k){reads++;return objects.has(k)?{arrayBuffer:async()=>objects.get(k).slice().buffer}:null;}};
  return{db,bucket,objects,sqlite,reads:()=>reads,store:new D1Store(db,bucket,'one')};
}
test('large documents live outside D1, CAS prevents another browser overwriting changes and retains history',async()=>{
  const f=fixture(),data={text:'x'.repeat(2100000)};
  assert.equal((await f.store.putDocument('siteProfiles',data,0)).revision,1);
  assert.deepEqual((await f.store.document('siteProfiles')).data,data);
  assert.equal((await f.store.putDocument('siteProfiles',data,1)).unchanged,true);
  await assert.rejects(f.store.putDocument('siteProfiles',{text:'stale'},0),/其他客户端/);
  await f.store.putDocument('siteProfiles',{text:'new'},1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM document_history').get().n,2);
  assert.deepEqual(await new D1Store(f.db,f.bucket,'other').revisions(),{});
});
test('indexed journal pages never load evidence objects; detail is scoped and verified',async()=>{
  const f=fixture();
  for(const id of ['a','b','c'])await f.store.importTask({id,profileId:id==='c'?'B':'A',url:'https://example.test/'+id,status:'needs_manual',actualSubmission:{text:'x'.repeat(200000)}});
  const before=f.reads(),page=await f.store.journal(new URLSearchParams('profileId=A&limit=1'));
  assert.equal(page.tasks[0].id,'a');assert.equal(page.next,'a');assert.equal(f.reads(),before);
  assert.equal(page.tasks[0].actualSubmission,undefined);
  assert.equal((await f.store.journal(new URLSearchParams('profileId=A&after=a&limit=1'))).next,null);
  assert.equal((await new D1Store(f.db,f.bucket,'other').journal(new URLSearchParams('taskId=a'))).task,null);
  assert.equal((await f.store.journal(new URLSearchParams('taskId=a'))).task.actualSubmission.text.length,200000);
  await assert.rejects(f.store.importTask({id:'a',profileId:'A',url:'https://different.test'}),/不同版本/);
});
test('recovery archive retries are idempotent and corrupt or missing evidence fails closed',async()=>{
  const f=fixture();const saved=await f.store.archive('batch-1','outbox',[{id:'event1'}]);
  await f.store.archive('batch-1','outbox',[{id:'event1'}]);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM recovery_objects').get().n,1);
  await assert.rejects(f.store.archive('batch-1','outbox',[{id:'different'}]),/内容不同/);
  f.objects.set(saved.key,new TextEncoder().encode('{}'));
  await assert.rejects(f.store.readObject(saved.key,saved.checksum),/校验失败/);
  f.objects.delete(saved.key);
  await assert.rejects(f.store.readObject(saved.key,saved.checksum),/对象缺失/);
});
test('D1 API requires scoped credentials and works without a Neon connection',async()=>{
  const f=fixture(),env={LEDGER_DB:f.db,MEDIA_BUCKET:f.bucket,ALLOWED_WORKSPACE_ID:'one',D1_RECOVERY_TOKEN:'recovery-test'};
  const call=(path,body,authorised=true,token='')=>d1Api(new Request('https://example.test/v2/'+path+'?workspace=one',{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}),env,async()=>authorised);
  assert.equal((await call('health',null,false)).status,401);
  assert.equal((await call('health',null,false,'recovery-test')).status,401);
  assert.equal((await call('recovery/status')).status,401);
  assert.equal((await call('recovery/status',null,false,'recovery-test')).status,200);
  await f.store.putDocument('siteProfiles',{A:{id:'A'}},0);
  const event={id:'note1',profileId:'A',destinationUrl:'https://example.test',type:'email_reply',occurredAt:'2026-09-29T00:00:00Z',note:'Reply received'};
  assert.equal((await call('timeline',{event})).status,200);
  assert.equal((await call('timeline',{event})).status,200);
  assert.equal((await call('timeline',{event:{...event,note:'different'}})).status,409);
  const read=await(await call('journal-documents')).json();
  assert.equal(Object.values(read.documents.submissionTimeline).flat().length,1);
  assert.equal((await(await call('health')).json()).storage,'d1+r2');
  const latest={A:{id:'A',fields:{Description:'Updated local description'}}};
  assert.equal((await call('recover-local-document',{key:'siteProfiles',data:latest,revision:0})).status,409);
  assert.equal((await call('recover-local-document',{key:'siteProfiles',data:latest,revision:1})).status,200);
  assert.deepEqual((await f.store.document('siteProfiles')).data,latest);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM recovery_objects WHERE kind='source_backup'").get().n,1);
  await f.store.archive('plugin-backup-2026-09-25','source_backup',{submissionRecords:{'old.test::A':{status:'success',publicationStatus:'published'}}});
  const history=await(await call('journal-documents')).json();assert.equal(history.documents.historicalRecords['old.test::A'].requiresVerification,true);assert.equal(history.documents.submissionRecords?.['old.test::A'],undefined);
  await f.store.putDocument('submissionRecords',{'receipt.test::A':{taskId:'verified-task',evidence:'receipt',status:'success'}},0);
  const restored=await(await call('recover-local-document',{key:'submissionRecords',revision:1,data:{'browser.test::A':{status:'success'}}})).json();
  assert.equal(restored.data['receipt.test::A'].taskId,'verified-task');assert.equal(restored.data['browser.test::A'].status,'success');
});
test('production Worker routes D1 requests without DATABASE_URL and separates two clients by workspace',async()=>{
  const f=fixture(),env={LEDGER_DB:f.db,MEDIA_BUCKET:f.bucket,ALLOWED_WORKSPACE_ID:'one',APP_ACCESS_TOKEN:'test-only',ALLOWED_ORIGIN:'chrome-extension://test',ALLOW_AUTHENTICATED_EXTENSIONS:'true'};
  await f.store.putDocument('siteProfiles',{A:{id:'A',fields:{short:'description'}}},0);
  const call=workspace=>worker.fetch(new Request('https://example.test/v2/snapshot?workspace='+workspace,{headers:{Authorization:'Bearer test-only'}}),env);
  const first=await(await call('one')).json(),second=await(await call('one')).json();
  assert.deepEqual(first.documents,second.documents);assert.equal(first.storage,'d1+r2');
  assert.equal((await call('other')).status,403);
  const disabled=await worker.fetch(new Request('https://example.test/v2/executor/runs?workspace=one',{headers:{Authorization:'Bearer test-only'}}),env);
  assert.equal(disabled.status,401);
  for(const origin of ['chrome-extension://'+'a'.repeat(32),'chrome-extension://'+'b'.repeat(32)]){
    const req=new Request('https://example.test/v2/snapshot?workspace=one',{headers:{Origin:origin,Authorization:'Bearer test-only'}});
    const response=await worker.fetch(req,env);assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
    const denied=await worker.fetch(new Request(req.url,{headers:{Origin:origin}}),env);assert.equal(denied.status,401);
  }
  const webOrigin=await worker.fetch(new Request('https://example.test/v2/health?workspace=one',{headers:{Origin:'https://untrusted.example',Authorization:'Bearer test-only'}}),env);
  assert.equal(webOrigin.headers.get('Access-Control-Allow-Origin'),null);
  const migrated={...env,STATE_BACKEND:'d1',EXECUTOR_BACKEND:'d1'};
  const legacy=await worker.fetch(new Request('https://example.test/v1/snapshot?workspace=one',{headers:{Authorization:'Bearer test-only'}}),migrated);
  assert.equal(legacy.status,428);assert.equal((await legacy.json()).code,'LOCAL_SNAPSHOT_REQUIRED');
  const current=await worker.fetch(new Request('https://example.test/v2/snapshot?workspace=one',{headers:{Authorization:'Bearer test-only'}}),migrated);
  assert.equal(current.status,200);assert.equal((await current.json()).storage,'d1+r2');
});
