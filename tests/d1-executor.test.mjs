import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {D1Store} from '../cloud/worker/src/d1-store.mjs';
import {d1Executor} from '../cloud/worker/src/d1-executor.mjs';
import {Cloud} from '../executor/src/cloud.mjs';
test('device media catalogue is read-only and scoped to its enrolled workspace',async()=>{
 const f=fixture();let listed=0;f.env.MEDIA_BUCKET.list=async options=>{listed++;assert.equal(options.prefix,'workspaces/default/media/');return{objects:[{key:options.prefix+'asset',size:24,customMetadata:{profileId:'p',kind:'logo',fileName:'标志.png'},httpMetadata:{contentType:'image/png'}}],truncated:false};};
 const call=(route,token,scope='default',method='GET')=>d1Executor(new Request('https://cloud.test/v2/executor/'+route,{method,headers:{Authorization:'Bearer '+token},...(method==='POST'?{body:'{}'}:{})}),f.env,scope,async()=>({}));
 const enrollment=await call('devices','admin-test','default','POST'),device=await enrollment.json(),token=device.deviceToken;
 const page=await(await call('workspace/media',token)).json();assert.equal(page.assets[0].file_name,'标志.png');assert.equal(page.assets[0].profile_id,'p');assert.equal(listed,1);
 assert.equal((await call('workspace/media',token,'other')).status,401);assert.equal((await call('workspace/media','wrong')).status,401);assert.equal((await call('workspace/media',token,'default','POST')).status,403);assert.equal(listed,1);
});
function fixture(){
 const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../cloud/worker/migrations/'+f,import.meta.url),'utf8'));
 const db={prepare(sql){let args=[];return{bind(...v){args=v;return this;},first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const q=sqlite.prepare(sql);return q.columns().length?{results:q.all(...args),meta:{changes:0}}:{results:[],meta:{changes:q.run(...args).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const objects=new Map(),bucket={head:async k=>objects.has(k)?{}:null,put:async(k,v,meta)=>objects.set(k,{bytes:new Uint8Array(v),meta}),get:async k=>{const v=objects.get(k);return v?{arrayBuffer:async()=>v.bytes.slice().buffer,httpMetadata:v.meta?.httpMetadata}:null;}};
 const env={LEDGER_DB:db,MEDIA_BUCKET:bucket,APP_ACCESS_TOKEN:'admin-test'};return{sqlite,db,env,store:new D1Store(db,bucket,'default')};
}
test('D1 executor preserves ownership, atomic run creation, lease fences, immutable receipts and paginated recovery',async()=>{
 const f=fixture(),profile={id:'JevPlay',name:'JevPlay',fields:{Name:'JevPlay',Url:'https://jevplay.com'}};
 for(const [key,value]of Object.entries({siteProfiles:{JevPlay:profile},sheetTableData:{entries:Array.from({length:20},(_,i)=>({link:`https://new${i}.example/submit`}))},submissionRecords:{'protected::Other':{status:'success',manual:true}},submissionTimeline:{},siteAnnotations:{}}))await f.store.putDocument(key,value,0);
 const call=async(route,token,body,scope='default')=>{const r=await d1Executor(new Request('https://cloud.test/v2/executor/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}),f.env,scope,async()=>({}));return{http:r.status,...await r.json()};};
 assert.equal((await call('devices','wrong',{name:'x'})).http,401);
 const device=await call('devices','admin-test',{name:'test'}),token=device.deviceToken;
 assert.equal(device.http,200);assert.equal((await call('snapshot',token,undefined,'other')).http,401);
 assert.equal((await call('workspace/journal-documents',token)).documents.siteProfiles.JevPlay.name,'JevPlay');
 assert.equal((await call('workspace/state/siteProfiles',token,{data:{}})).http,403);
 assert.equal((await call('workspace/journal-documents','wrong')).http,401);
 const makeTask=i=>({id:'task'+i,url:`https://new${i}.example/submit`,destinationKey:`new${i}.example/submit`});
 const run={id:'run1',profileId:'JevPlay',profileRevision:1,tasks:[makeTask(0)]};
 const started=await call('runs',token,{run});assert.equal(started.http,200,JSON.stringify(started));
 const blocked=await call('runs',token,{run:{...run,id:'conflicting-run',tasks:[makeTask(1),makeTask(0)]}});assert.equal(blocked.http,409,JSON.stringify(blocked));
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM journal_tasks').get().n,1);
 const other=await call('devices','admin-test',{name:'other'});assert.equal((await call('tasks/task0',other.deviceToken)).http,403);
 assert.equal((await call('lease',token,{taskId:'task0',version:1,controllerId:'one'})).http,200);
 assert.equal((await call('lease',token,{taskId:'task0',version:1,controllerId:'two'})).http,409);
 assert.equal((await call('plan',token,{mode:'prepare_takeover',taskId:'task0',version:1,controllerId:'one'})).http,200);
 assert.equal((await call('plan',token,{mode:'prepare_takeover',taskId:'task0',version:1,controllerId:'two'})).http,409);
 const event={id:'evt',taskId:'task0',version:1,type:'attempt_boundary',at:'2026-09-29T00:00:00Z',state:{...started.tasks[0],controllerId:'one',status:'submitting',actualSubmission:{website:'https://jevplay.com'},attemptBoundary:'2026-09-29T00:00:00Z'}};
 const written=await call('event',token,event);assert.equal(written.http,200,JSON.stringify(written));assert.equal((await call('event',token,event)).duplicate,true);
 assert.deepEqual((await call('events/evt',token)).event,event);assert.equal((await call('events/evt?proof=1',token)).checksum,written.checksum);
 assert.equal((await call('event',token,{...event,type:'changed'})).http,409);
 assert.equal((await call('tasks/task0',token)).task.status,'submitting');
 assert.equal((await call('plan',token,{mode:'prepare_takeover',taskId:'task0',version:1,controllerId:'one'})).http,409);
 const handoff=await call('handoff',token,{taskId:'task0',version:1,previousControllerId:'one',controllerId:'two'});assert.equal(handoff.version,2);
 assert.equal((await call('event',token,{...event,id:'stale'})).http,409);assert.equal((await call('event',token,event)).duplicate,true);
 const record={taskId:'task0',profileId:'JevPlay',destinationKey:makeTask(0).destinationKey,status:'success',evidence:'Submission received',actualSubmission:{website:'https://jevplay.com'},publicationStatus:'submitted',submittedAt:'2026-09-29T00:00:00Z'};
 assert.equal((await call('receipt',token,{taskId:'task0',version:2,record})).http,200);
 const correction=await call('receipt-status',token,{taskId:'task0',status:'pending_moderation',expectedEvidence:record.evidence});assert.equal(correction.http,200);assert.equal(correction.record.publicationStatus,'pending_moderation');
 assert.equal((await call('review',token,{taskId:'task0',reviewStatus:'reviewed'})).http,200);
 assert.equal((await f.store.document('submissionRecords')).data['protected::Other'].manual,true);
 const batch=await call('runs',token,{run:{...run,id:'run2',tasks:Array.from({length:12},(_,i)=>makeTask(i+1))}});assert.equal(batch.http,200,JSON.stringify(batch));
 const page=await call('runs',token);assert.equal(page.tasks.length,10);assert.ok(page.next);
 const original=globalThis.fetch;globalThis.fetch=(url,options)=>d1Executor(new Request(url,options),f.env,'default',async()=>({}));
 try{const cloud=new Cloud({endpoint:'https://cloud.test',workspaceId:'default',deviceToken:token,storageBackend:'d1'});const all=await cloud.request('runs');assert.equal(all.tasks.length,13);assert.equal(new Set(all.tasks.map(t=>t.id)).size,13);assert.equal(all.runs.length,2);}finally{globalThis.fetch=original;}
 assert.equal((await f.store.journal(new URLSearchParams('taskId=task5'))).task.id,'task5');
 const inventory=await call('runs?view=inventory',token);assert.equal(JSON.stringify(inventory).includes('actualSubmission'),false);
});

test('device workbench restores library preferences, timeline editing, settings and authenticated AI without exposing admin routes',async()=>{
 const f=fixture();for(const [key,value]of Object.entries({siteProfiles:{p:{id:'p',name:'P',url:'https://product.example'}},sheetTableData:{entries:[]},siteAnnotations:{},submissionTimeline:{'site.example::p':[{id:'manual',profileId:'p',destinationKey:'site.example',type:'note',note:'Original',occurredAt:'2026-09-30T00:00:00Z'}]},submissionRecords:{receipt:{status:'success',evidence:'Original',profileId:'p',publicUrl:'https://publisher.example/post'}},targetFilters:{}}))await f.store.putDocument(key,value,0);
 let aiCalls=0;const call=async(route,token,body)=>{const response=await d1Executor(new Request('https://cloud.test/v2/executor/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}),f.env,'default',async()=>({}),async(action,input)=>{aiCalls++;return{ok:true,action,input};});return{http:response.status,...await response.json()};};
 const device=await call('devices','admin-test',{name:'workbench'}),token=device.deviceToken;
 const create={type:'create',id:'new',at:'now',url:'https://site.example/submit',fields:{name:'Target',dr:'80'}};assert.equal((await call('library',token,{operation:create,revision:1})).http,200);
 const prefs={type:'preferences',id:'prefs',at:'now',url:create.url,preferences:{favorite:true,groups:['high_quality'],profileIds:['p']}};assert.equal((await call('library',token,{operation:prefs,revision:1})).http,200);assert.equal((await f.store.document('siteAnnotations')).data['site.example/submit'].library.favorite,true);
 assert.equal((await call('library',token,{operation:{type:'timeline',id:'edit',at:'now',action:'update',eventId:'manual',patch:{note:'Revised'}},revision:1})).http,200);assert.equal((await f.store.document('submissionRecords')).data.receipt.evidence,'Original');
 assert.equal((await call('library',token,{operation:{type:'settings',id:'filter',at:'now',key:'targetFilters',value:{aiComments:true,minOpportunityScore:55}},revision:1})).http,200);
 assert.equal((await call('ai/extract-site','wrong',{url:'https://product.example'})).http,401);assert.equal(aiCalls,0);assert.equal((await call('ai/extract-site',token,{url:'https://product.example'})).action,'extract-site');assert.equal(aiCalls,1);assert.equal((await call('ai/domain-metrics','wrong',{domains:['site.example']})).http,401);assert.equal(aiCalls,1);assert.equal((await call('ai/domain-metrics',token,{domains:['site.example']})).action,'domain-metrics');assert.equal(aiCalls,2);assert.equal((await call('library',token,{operation:{id:'metrics',at:'now',type:'domain_metrics',results:[{domain:'site.example',status:'ok',ageMonths:20}]},revision:0})).http,200);assert.equal((await f.store.document('domainMetricsCache')).data['site.example'].ageMonths,20);assert.equal((await call('library',token,{operation:{id:'backup',at:'now',type:'backup_merge',key:'siteProfiles',backup:{format:'externallink-submission-backup',submissionRecords:{},siteProfiles:{imported:{id:'imported',fields:{Name:'Imported'}}}}},revision:1})).http,200);assert.equal((await f.store.document('siteProfiles')).data.p.id,'p');assert.equal((await f.store.document('siteProfiles')).data.imported.id,'imported');assert.equal((await call('library',token,{operation:{id:'monitor',at:'now',type:'monitor_result',recordKey:'receipt',jobId:'monitor-job',result:{status:'live',targetFound:true,targetHost:'product.example',inputUrl:'https://publisher.example/post',url:'https://publisher.example/post'}},revision:0})).http,200);assert.equal((await call('library',token,{operation:{id:'publish',at:'now',type:'monitor_publication',recordKey:'receipt',jobId:'monitor-job'},revision:1})).http,200);assert.equal((await f.store.document('submissionRecords')).data.receipt.evidence,'Original');assert.equal((await f.store.document('submissionRecords')).data.receipt.publicationStatus,'published');assert.equal((await call('workspace/state/siteProfiles',token,{data:{}})).http,403);
});
