import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../executor/node_modules/@electric-sql/pglite/dist/index.js';
import {executorApi} from '../cloud/worker/src/executor-api.mjs';
import {d1Executor} from '../cloud/worker/src/d1-executor.mjs';
import {aiCloudFixture} from '../executor/test/fixtures/ai-cloud.mjs';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {classifyOriginalTaskGate} from '../executor/src/original-site-classification.mjs';

async function cloudFixture(backend,documents){
 if(backend==='d1'){
  const fixture=aiCloudFixture();for(const [key,data]of Object.entries(documents))await fixture.ledger.putDocument(key,data,0);
  return{admin:'fixture-admin',request:request=>d1Executor(request,fixture.env,'default',async()=>{throw Error('No model calls permitted');}),close:async()=>fixture.sqlite.close()};
 }
 const db=new PGlite();await db.exec(await readFile(new URL('../cloud/worker/schema.sql',import.meta.url),'utf8'));
 const sql=(strings,...params)=>{const query=strings.reduce((value,part,index)=>value+part+(index<params.length?'$'+(index+1):''),'');return{query,params,then:(resolve,reject)=>db.query(query,params).then(value=>value.rows).then(resolve,reject)};};
 sql.transaction=queries=>db.transaction(async tx=>{const results=[];for(const query of queries)results.push((await tx.query(query.query,query.params)).rows);return results;});
 await sql`insert into externallink_workspaces(workspace_id) values('default')`;
 for(const [key,data]of Object.entries(documents))await sql`insert into externallink_workspace_documents(workspace_id,document_key,data) values('default',${key},${JSON.stringify(data)}::jsonb)`;
 const helpers={recordEvent:async()=>{},listSnapshot:async()=>{const rows=await sql`select document_key,data,revision from externallink_workspace_documents where workspace_id='default'`;return{documents:Object.fromEntries(rows.map(row=>[row.document_key,row.data])),revisions:Object.fromEntries(rows.map(row=>[row.document_key,Number(row.revision)]))};}};
 return{admin:'fixture-admin',request:request=>executorApi(request,{APP_ACCESS_TOKEN:'fixture-admin'},sql,'default',helpers),close:()=>db.close()};
}

for(const backend of ['d1','neon'])test('original human gates survive authenticated '+backend+' event readback and empty native restore without changing original business or unknown attempts',async()=>{
 const cases=[['login','Login required','needs_login','login'],['authentication','Authentication required','needs_login','login'],['oauth','OAuth required','needs_login','login'],['email-code','Email verification required','needs_otp','human_verification'],['otp','OTP verification code required','needs_otp','human_verification'],['captcha','CAPTCHA required','needs_captcha','human_verification'],['unknown','Login required','needs_login','unknown_receipt']],profile={id:'p',name:'Original product',fields:{Name:'Original product',Url:'https://product.fixture.invalid',Email:'original@example.invalid'}},manual={status:'can_submit',statuses:['can_submit'],auto:false,note:'Original owner verdict',library:{favorite:true,groups:['original-quality-group']}},documents={siteProfiles:{p:profile},sheetTableData:{entries:cases.map(([name])=>({link:'https://'+name+'.fixture.invalid/form'}))},siteAnnotations:Object.fromEntries(cases.map(([name])=>[name+'.fixture.invalid/form',structuredClone(manual)])),submissionRecords:{protected:{profileId:'other',destinationUrl:'https://other.fixture.invalid',status:'success',evidence:'Protected original receipt'}},submissionTimeline:{protected:[{id:'original-history',note:'Keep original timeline'}]},deletedSubmissionKeys:['retained.fixture.invalid/old'],cfgPingIndex:false},fixture=await cloudFixture(backend,documents),previousFetch=globalThis.fetch,stores=[],requests=[];let lostReply=false;
 try{
  globalThis.fetch=async(url,options)=>{
   const request=new Request(url,options),target=new URL(request.url);assert.equal(target.hostname,'cloud.fixture.invalid');assert.equal(target.searchParams.get('workspace'),'default');assert.equal(target.pathname.includes('/ai/'),false);requests.push({method:request.method,path:target.pathname});
   const response=await fixture.request(request);
   if(target.pathname.endsWith('/event')&&response.ok&&!lostReply){lostReply=true;return Response.json({ok:false,error:'Fixture lost reply after durable event write'},{status:503});}
   return response;
  };
  const enrollment=await fixture.request(new Request('https://cloud.fixture.invalid/'+(backend==='d1'?'v2':'v1')+'/executor/devices?workspace=default',{method:'POST',headers:{Authorization:'Bearer '+fixture.admin},body:'{}'}));assert.equal(enrollment.status,200);const device=await enrollment.json(),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'default',deviceId:device.deviceId,deviceToken:device.deviceToken,storageBackend:backend},make=()=>{const store=new Store(':memory:');stores.push(store);store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});const runtime=new Runtime(store,'unused-original-human-gate-cloud');runtime.tick=()=>{throw Error('Restore must not start execution');};return runtime;},runtime=make(),before=await runtime.cloud.request('snapshot'),run={id:'original-human-gate-run',profileId:'p',profileRevision:before.revisions.siteProfiles,profile,tasks:cases.map(([name])=>({id:'original-'+name,url:'https://'+name+'.fixture.invalid/form',destinationKey:name+'.fixture.invalid/form'}))},registered=await runtime.cloud.request('runs',{run});
  runtime.store.set('run:'+run.id,registered.run);for(const task of registered.tasks)runtime.store.set('task:'+task.id,task);
  for(const [name,reason,status,attention]of cases){
   const task=runtime.store.get('task:original-'+name);await runtime.lease(task);const unknown=name==='unknown',actualPreparation={fields:{Name:profile.fields.Name,Url:profile.fields.Url},attachments:[]};
   runtime.update(task,{status:unknown?'submitted_unconfirmed':'filling',siteStatus:unknown?'sent_unconfirmed':'not_submitted',controller:'executor',profileSnapshot:profile,profileRevision:run.profileRevision,targetId:'original-target-'+name,browserInstance:'original-browser',attentionType:unknown?'unknown_receipt':'missing_fields',actualPreparation,...(unknown?{attemptBoundary:'original-unknown-boundary',actualSubmission:actualPreparation}: {})},'fixture_original_before_gate');
   const page={url:()=>task.url,isClosed:()=>false},classification=await classifyOriginalTaskGate(runtime,{task,page,result:{needs_manual:true,reason}});assert.equal(classification.status,status);assert.equal(task.attentionType,attention);
   if(!unknown)runtime.update(task,{status:'needs_manual',reason},'attention');await runtime.synchronize();assert.equal(runtime.store.pendingCount(),0);
  }
  assert.equal(lostReply,true);const remote=await runtime.cloud.request('runs');assert.equal(remote.runs.length,1);assert.equal(remote.tasks.length,cases.length);
  for(const [name,,status,attention]of cases){const task=remote.tasks.find(task=>task.id==='original-'+name);assert.equal(task.attentionType,attention);assert.equal(task.siteAutomaticObservation.status,status);assert.deepEqual(task.profileSnapshot,profile);assert.equal(task.receipt,undefined);}
  const restored=make();assert.equal(restored.store.values('task:').length,0);await restored.restoreCloud();assert.equal(restored.store.values('run:').length,1);assert.equal(restored.store.values('task:').length,cases.length);assert.equal(restored.store.get('paused'),true);assert.deepEqual(restored.store.get('acceptanceBatch'),{status:'paused',cursor:13,count:30});assert.equal(restored.store.pendingCount(),0);
  for(const [name,,status,attention]of cases){const original=runtime.store.get('task:original-'+name),task=restored.store.get('task:'+original.id);assert.deepEqual(task,original);assert.equal(task.attentionType,attention);assert.equal(task.siteAutomaticObservation.status,status);if(name==='unknown'){assert.equal(task.attemptBoundary,'original-unknown-boundary');assert.equal(task.status,'submitted_unconfirmed');assert.deepEqual(task.actualSubmission,original.actualSubmission);}else{assert.equal(task.status,'needs_manual');assert.equal(task.attemptBoundary,undefined);}}
  const after=await restored.cloud.request('snapshot');for(const key of ['siteProfiles','sheetTableData','submissionRecords','submissionTimeline','deletedSubmissionKeys','cfgPingIndex']){assert.deepEqual(after.documents[key],before.documents[key]);assert.equal(after.revisions[key],before.revisions[key]);}
  for(const [name,,status]of cases){const annotation=structuredClone(after.documents.siteAnnotations[name+'.fixture.invalid/form']);assert.equal(annotation.lastAutomaticObservation.status,status);delete annotation.lastAutomaticObservation;assert.deepEqual(annotation,manual);}
  const denied=await fixture.request(new Request('https://cloud.fixture.invalid/'+(backend==='d1'?'v2':'v1')+'/executor/runs?workspace=default',{headers:{Authorization:'Bearer wrong-device'}}));assert.equal(denied.status,401);
  assert.ok(requests.some(row=>row.path.includes('/events/')));assert.equal(requests.filter(row=>row.path.endsWith('/receipt')).length,0);assert.equal(requests.filter(row=>row.path.endsWith('/runs')&&row.method==='POST').length,1);
 }finally{globalThis.fetch=previousFetch;for(const store of stores)store.close();await fixture.close();}
});
