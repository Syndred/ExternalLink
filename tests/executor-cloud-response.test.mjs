import test from 'node:test';import assert from 'node:assert/strict';import{Cloud}from'../executor/src/cloud.mjs';
import{Store}from'../executor/src/store.mjs';
import{createHash}from'node:crypto';
test('preparation model gets a bounded longer deadline while ledger calls keep their original timeout',async()=>{
 const oldFetch=globalThis.fetch,oldTimeout=AbortSignal.timeout,deadlines=[];
 try{AbortSignal.timeout=ms=>{deadlines.push(ms);return oldTimeout(ms);};globalThis.fetch=async()=>Response.json({ok:true});
  const cloud=new Cloud({endpoint:'https://cloud.test',workspaceId:'default',deviceToken:'private'});
  await cloud.request('plan',{mode:'prepare_takeover'});await cloud.request('snapshot');assert.deepEqual(deadlines,[60000,20000]);
 }finally{globalThis.fetch=oldFetch;AbortSignal.timeout=oldTimeout;}
});
test('quota failure stops flush without another read and preserves pending event',async()=>{
 const calls=[],acked=[],cloud=new Cloud({});cloud.request=async route=>{calls.push(route);throw Object.assign(new Error('quota exceeded'),{cloudQuota:true});};
 await assert.rejects(cloud.flush({pending:()=>[{id:'e'}],ack:id=>acked.push(id)}));assert.deepEqual(calls,['event']);assert.deepEqual(acked,[]);
});
test('matching independent compact proof acknowledges only the exact event id',async()=>{
 const event={id:'e',taskId:'t'},calls=[],acked=[],cloud=new Cloud({});cloud.request=async route=>{calls.push(route);return {ok:true,eventId:'e',checksum:createHash('sha256').update(JSON.stringify(event)).digest('hex')};};
 await cloud.flush({pending:()=>[event],ack:id=>acked.push(id)});assert.deepEqual(calls,['event','events/e?proof=1']);assert.deepEqual(acked,['e']);
});
test('original Neon jsonb MD5 proof uses full independent event values before acknowledging',async()=>{
 const event={id:'original-event',taskId:'original-task',type:'media_upload_success',state:{profileId:'p',runId:'original-run',attemptBoundary:'retained',mediaUploadState:{uploaded:[{source:'原任务冻结备份',name:'original.png'}]}}},calls=[],acked=[],cloud=new Cloud({});
 cloud.request=async route=>{calls.push(route);if(route==='event')return{ok:true,eventId:event.id,checksum:'a'.repeat(32)};return{ok:true,event:{state:{mediaUploadState:{uploaded:[{name:'original.png',source:'原任务冻结备份'}]},attemptBoundary:'retained',runId:'original-run',profileId:'p'},type:event.type,taskId:event.taskId,id:event.id}};};
 await cloud.flush({pending:()=>[event],ack:id=>acked.push(id)});assert.deepEqual(calls,['event','events/original-event']);assert.deepEqual(acked,[event.id]);
});
test('original Neon MD5 acknowledgement cannot hide missing or changed receipt attempt or image evidence',async()=>{
 const event={id:'original-event',taskId:'original-task',state:{attemptBoundary:'original',receipt:{evidence:'original-receipt'},mediaUploadState:{uploaded:[{sourceSha256:'a'.repeat(64)}]}}};
 for(const change of [null,{...event,id:'other'},{...event,state:{...event.state,attemptBoundary:'changed'}},{...event,state:{...event.state,receipt:{evidence:'changed'}}},{...event,state:{...event.state,mediaUploadState:{uploaded:[]}}}]){const cloud=new Cloud({}),acked=[];cloud.request=async route=>route==='event'?{ok:true,eventId:event.id,checksum:'a'.repeat(32)}:{ok:true,event:change};await assert.rejects(cloud.flush({pending:()=>[event],ack:id=>acked.push(id)}),/回读不一致/);assert.deepEqual(acked,[]);}
});
test('matching server proofs of changed content never acknowledge the local event',async()=>{
 const cloud=new Cloud({}),acked=[];cloud.request=async()=>({ok:true,eventId:'e',checksum:'incorrect'});
 await assert.rejects(cloud.flush({pending:()=>[{id:'e',taskId:'t'}],ack:id=>acked.push(id)}),/不一致/);assert.deepEqual(acked,[]);
});
test('A transient connection reset retries only GET; writes and certificate errors are never replayed',async()=>{
 const old=globalThis.fetch;const cloud=new Cloud({endpoint:'https://example.test',workspaceId:'workspace',deviceToken:'private-token'});let count=0;
 const reset=()=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});
 try{globalThis.fetch=async()=>{if(++count===1)throw reset();return Response.json({ok:true});};assert.equal((await cloud.request('snapshot')).ok,true);assert.equal(count,2);
  count=0;globalThis.fetch=async()=>{count++;throw reset();};await assert.rejects(cloud.request('lease',{taskId:'task'}));assert.equal(count,1);
  count=0;globalThis.fetch=async()=>{count++;throw Object.assign(new Error('certificate'),{cause:{code:'ERR_TLS_CERT_ALTNAME_INVALID'}});};await assert.rejects(cloud.request('snapshot'));assert.equal(count,1);
 }finally{globalThis.fetch=old;}
});
test('a transient gateway read can recover while mutation requests are never replayed',async()=>{
 const old=globalThis.fetch;let count=0;const cloud=new Cloud({endpoint:'https://example.test',workspaceId:'workspace',deviceToken:'private-token'});
 try{globalThis.fetch=async()=>++count===1?new Response('gateway',{status:503}):Response.json({ok:true});assert.equal((await cloud.request('snapshot')).ok,true);assert.equal(count,2);
 count=0;globalThis.fetch=async()=>{count++;return new Response('gateway',{status:503});};await assert.rejects(cloud.request('lease',{taskId:'task'}),/HTTP 503/);assert.equal(count,1);
 }finally{globalThis.fetch=old;}
});
test('Non-JSON cloud errors include status for diagnosis without exposing response contents or credentials',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response('<!DOCTYPE html><title>blocked</title>private-response',{status:413,headers:{'content-type':'text/html'}});
 try{await assert.rejects(new Cloud({endpoint:'https://example.test',workspaceId:'workspace',deviceToken:'private-token'}).request('snapshot'),error=>/HTTP 413/.test(error.message)&&!error.message.includes('private'));}finally{globalThis.fetch=old;}
});
test('A lost write response is accepted only after independent exact immutable event readback',async()=>{
 const event={id:'event',taskId:'task',payload:{status:'needs_manual'}},acked=[];
 const cloud=new Cloud({});cloud.request=async route=>{if(route==='event')throw new Error('gateway reply lost');return{event:structuredClone(event)};};
 await cloud.flush({pending:()=>[event],ack:id=>acked.push(id)});assert.deepEqual(acked,['event']);
});
test('A failed write with missing or changed readback preserves the original outbox event',async()=>{
 const event={id:'event'},acked=[];const cloud=new Cloud({});cloud.request=async route=>{if(route==='event')throw new Error('gateway reply lost');return{event:{id:'changed'}};};
 await assert.rejects(cloud.flush({pending:()=>[event],ack:id=>acked.push(id)}));assert.deepEqual(acked,[]);
});
test('offline sync conflict holds only that task event while later safe events remain syncable',async()=>{
 const store=new Store(':memory:');
 const blocked=store.transition({id:'blocked',runId:'r',profileId:'JevPlay',destinationKey:'blocked.example',version:1,status:'finished',syncConflict:true},'offline_receipt');
 const safe=store.transition({id:'safe',runId:'r',profileId:'JevPlay',destinationKey:'safe.example',version:1,status:'needs_manual'},'offline_gate');
 const cloud=new Cloud({}),calls=[];cloud.request=async route=>{calls.push(route);return route==='events/'+safe.id?{event:safe}:{ok:true,eventId:safe.id};};
 await cloud.flush(store);assert.deepEqual(calls,['event','events/'+safe.id]);assert.deepEqual(store.pending().map(e=>e.id),[blocked.id]);store.close();
});
test('a Neon quota response remains a global quota gate even when wrapped as HTTP 500',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({ok:false,error:'Server error (HTTP status 402): {"message":"Your account or project has exceeded the quota. Upgrade your plan to increase limits."}'},{status:500});
 try{await assert.rejects(new Cloud({endpoint:'https://example.test',workspaceId:'w',deviceToken:'private'}).request('snapshot'),e=>e.cloudQuota===true&&e.status===500);}
 finally{globalThis.fetch=old;}
});
