import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,rmdirSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{Runtime}from'../executor/src/runtime.mjs';import{Store}from'../executor/src/store.mjs';
function runtimeFor(store,request){const runtime=new Runtime(store,'.');Object.defineProperty(runtime,'cloud',{value:{request}});return runtime;}
test('workbench progress survives executor restart and is acknowledged only after exact remote readback',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'externallink-sync-')),file=join(directory,'state.sqlite');let store=new Store(file);store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one'});let online=false,remote=[];
 const request=async(route,input)=>{if(!online)throw Error('offline');if(route==='workspace/timeline'){if(!remote.some(e=>e.id===input.event.id))remote.push(input.event);return{ok:true};}return{ok:true,documents:{siteProfiles:{JevPlay:{id:'JevPlay'}},submissionTimeline:{'example.com::JevPlay':remote},timelineSchemaVersion:1},revisions:{siteProfiles:1}};};
 try{let runtime=runtimeFor(store,request);const event={id:'progress',profileId:'JevPlay',destinationUrl:'https://example.com',type:'note',note:'真实待办',occurredAt:'2026-09-30T00:00:00Z'};
  assert.equal((await runtime.control('journalProgress',{event})).pending,1);store.close();store=new Store(file);runtime=runtimeFor(store,request);assert.equal(store.get('workbenchJournalPending').length,1);
  online=true;assert.equal((await runtime.control('journalFlush',{})).pending,0);assert.equal(remote.length,1);assert.equal(remote[0].note,event.note);assert.equal(store.get('workbenchJournalPending').length,0);
 }finally{store.close();for(const suffix of['','-wal','-shm'])rmSync(file+suffix,{force:true});rmdirSync(directory);}
});
test('workbench caches documents for offline reopening but never crosses workspace boundaries',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one'});let online=true;
 const runtime=runtimeFor(store,async()=>{if(!online)throw Error('offline');return{ok:true,documents:{siteProfiles:{A:{id:'A'}}},revisions:{siteProfiles:4}};});
 assert.equal((await runtime.control('workbenchDocuments',{})).cached,false);online=false;assert.equal((await runtime.control('workbenchDocuments',{})).documents.siteProfiles.A.id,'A');
 store.set('pair',{endpoint:'https://cloud.test',workspaceId:'two'});await assert.rejects(runtime.control('workbenchDocuments',{}),/offline/);store.close();
});
test('workspace changes or mismatched proofs retain pending workbench progress',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one'});let writes=0;
 const runtime=runtimeFor(store,async(route)=>{if(route==='workspace/timeline'){writes++;return{ok:true};}return{ok:true,documents:{submissionTimeline:{}}};});
 const saved=await runtime.control('journalProgress',{event:{id:'p',profileId:'A',destinationUrl:'https://example.com',type:'note',note:'keep'}});assert.equal(saved.pending,1);
 store.set('pair',{endpoint:'https://cloud.test',workspaceId:'two'});assert.equal((await runtime.control('journalFlush',{})).pending,0);assert.equal(writes,1);assert.equal(store.get('workbenchJournalPending').length,1);store.close();
});
test('a paused app with no submission tasks still retries durable workbench progress',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one'});store.set('paused',true);store.set('workbenchJournalPending',[{scope:'https://cloud.test|one',event:{id:'p'}}]);
 const runtime=runtimeFor(store,async()=>({}));runtime.hydrated=true;let flushes=0;runtime.synchronize=async()=>{flushes++;return{};};runtime.tick();if(runtime.job)await runtime.job;assert.equal(flushes,1);store.close();
});
