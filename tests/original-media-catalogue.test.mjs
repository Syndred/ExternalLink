import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {originalMediaCatalogue,originalMediaCatalogueResponse} from '../cloud/worker/src/original-media-catalogue.mjs';
import {d1Api} from '../cloud/worker/src/d1-api.mjs';
import worker from '../cloud/worker/src/index.mjs';

test('original media audit reads exact legacy fields and original file order from an independent scoped PostgreSQL index',async()=>{
  const db=new PGlite();try{
    await db.exec('CREATE TABLE externallink_media_assets (workspace_id text,asset_id text,profile_id text,media_kind text,media_index integer,file_name text,content_type text,byte_length integer,sha256 text,created_at timestamptz,updated_at timestamptz)');
    const insert=(workspace,id,profile,name)=>db.query('INSERT INTO externallink_media_assets VALUES($1,$2,$3,$4,0,$5,$6,68,$7,now(),now())',[workspace,id,profile,'logo',name,'image/png','a'.repeat(64)]);
    await insert('default','second','JevPlay','z.png');await insert('default','first',' profile-id ','a.png');await insert('foreign','secret','other','private.png');
    const before=await db.query('SELECT * FROM externallink_media_assets ORDER BY asset_id');let calls=0;
    const sql=async(strings,...values)=>{calls++;assert.match(strings.join('?'),/^\s*select\b/i);return(await db.query(strings.reduce((s,v,i)=>s+v+(i<values.length?'$'+(i+1):''),''),values)).rows;};
    const data=await originalMediaCatalogue(sql,'default');assert.equal(calls,1);assert.equal(data.source,'original-neon-media-index');assert.deepEqual(data.assets.map(x=>x.asset_id),['first','second']);assert.equal(data.assets[0].profile_id,' profile-id ');assert.equal(data.assets[1].profile_id,'JevPlay');assert.equal(data.assets[0].byte_length,68);assert.equal(data.assets[0].sha256,'a'.repeat(64));assert.deepEqual(await db.query('SELECT * FROM externallink_media_assets ORDER BY asset_id'),before);
    const injection=await originalMediaCatalogue(sql,"default' OR true --");assert.deepEqual(injection.assets,[]);
  }finally{await db.close();}
});

test('original media recovery route rejects ordinary credentials, foreign workspaces and every mutation before reading any source',async()=>{
  const env={ALLOWED_WORKSPACE_ID:'default',D1_RECOVERY_TOKEN:'recovery-only',LEDGER_DB:{},MEDIA_BUCKET:{}};let calls=0;
  const auxiliary=async(path,request)=>{calls++;assert.equal(path,'/recovery/original-media-catalogue');assert.equal(request.method,'GET');return new Response('{"ok":true}');};
  const call=(token='recovery-only',workspace='default',method='GET')=>d1Api(new Request('https://example.test/v2/recovery/original-media-catalogue?workspace='+workspace,{method,headers:{Authorization:'Bearer '+token}}),env,async()=>true,auxiliary);
  assert.equal((await call('ordinary-device')).status,401);assert.equal((await call('')).status,401);assert.equal((await call('recovery-only','foreign')).status,403);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await call('recovery-only','default',method)).status,405);
  assert.equal(calls,0);assert.equal((await call()).status,200);assert.equal(calls,1);
});

test('old database outages and missing configuration remain explicit with no fallback or connection information disclosure',async()=>{
  for(const factory of [()=>{throw Error('postgres://private-credential@secret-host/db');},()=>async()=>{throw Error('quota exceeded postgres://secret');}]){
    const response=await originalMediaCatalogueResponse(factory,'default'),text=await response.text();assert.equal(response.status,503);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.doesNotMatch(text,/postgres:|private-credential|secret-host/);assert.equal(JSON.parse(text).code,'ORIGINAL_MEDIA_SOURCE_UNAVAILABLE');
  }
  const response=await originalMediaCatalogueResponse(()=>async()=>[],'default');assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual((await response.json()).assets,[]);
});

test('deployed Worker routing keeps v1 media on D1 but routes the protected recovery read to the independent old database',async()=>{
  let listings=0;const env={STATE_BACKEND:'d1',ALLOWED_WORKSPACE_ID:'default',APP_ACCESS_TOKEN:'ordinary-device',D1_RECOVERY_TOKEN:'recovery-only',LEDGER_DB:{},MEDIA_BUCKET:{list:async()=>{listings++;return{objects:[]};}}};
  const call=(path,token)=>worker.fetch(new Request('https://example.test/'+path+'?workspace=default',{headers:{Authorization:'Bearer '+token}}),env);
  assert.equal((await call('v1/media','ordinary-device')).status,200);assert.equal(listings,1);
  assert.equal((await call('v2/recovery/original-media-catalogue','ordinary-device')).status,401);
  const response=await call('v2/recovery/original-media-catalogue','recovery-only');assert.equal(response.status,503);assert.equal((await response.json()).source,'original-neon-media-index');assert.equal(listings,1);
});

test('a dedicated original-index audit credential works without enabling any recovery write or other recovery read',async()=>{
 const env={ALLOWED_WORKSPACE_ID:'default',ORIGINAL_MEDIA_AUDIT_TOKEN:'read-only-audit',LEDGER_DB:{},MEDIA_BUCKET:{}};let calls=0;
 const call=(path,method='GET',token='read-only-audit')=>d1Api(new Request('https://example.test/v2/recovery/'+path+'?workspace=default',{method,headers:{Authorization:'Bearer '+token}}),env,async()=>false,async()=>{calls++;return new Response('{"ok":true}');});
 assert.equal((await call('original-media-catalogue')).status,200);assert.equal(calls,1);
 assert.equal((await call('original-media-catalogue','POST')).status,405);
 for(const [path,method]of [['document','POST'],['task','POST'],['archive','POST'],['proof','GET'],['status','GET']])assert.equal((await call(path,method)).status,401);
 assert.equal((await call('original-media-catalogue','GET','ordinary-device')).status,401);assert.equal(calls,1);
});

test('dedicated media-audit credentials reach the old source through the complete Worker router without a recovery secret',async()=>{
 const env={STATE_BACKEND:'d1',ORIGINAL_MEDIA_AUDIT_TOKEN:'read-only-audit',LEDGER_DB:{},MEDIA_BUCKET:{}};
 const response=await worker.fetch(new Request('https://example.test/v2/recovery/original-media-catalogue',{headers:{Authorization:'Bearer read-only-audit'}}),env);
 assert.equal(response.status,503);assert.equal((await response.json()).code,'ORIGINAL_MEDIA_SOURCE_UNAVAILABLE');
});
