import test from 'node:test';import assert from 'node:assert/strict';
import '../extension/lib/journal-sync.js';
function setup(){const state={};let workspaceId='one',offline=true,writes=0;const remote={};
 const storage={get:async k=>({[k]:structuredClone(state[k])}),set:async data=>Object.assign(state,structuredClone(data))};
 const sync=globalThis.ExtLinkJournalSync.create({storage,config:async()=>({endpoint:'https://test.invalid',workspaceId}),request:async(path,options,config)=>{
  if(offline)throw new Error('offline');const rows=remote[config.workspaceId]||=[];
  if(options.method==='POST'){writes++;if(!rows.some(e=>e.id===options.body.event.id))rows.push(structuredClone(options.body.event));return{ok:true};}
  return{ok:true,data:{group:structuredClone(rows)}};
 }});return{state,sync,remote,online:()=>offline=false,workspace:v=>workspaceId=v,writes:()=>writes};}
test('progress is durable before network failure, then acknowledged only after independent readback',async()=>{
 const f=setup(),event={id:'e',type:'email_reply',note:'receipt'};
 assert.equal((await f.sync.enqueue(event)).pending,1);assert.deepEqual(f.state.d1JournalPending[0].event,event);
 f.online();assert.equal((await f.sync.flush()).pending,0);assert.deepEqual(f.remote.one,[event]);assert.equal(f.state.d1JournalPending.length,0);
});
test('workspace switching never sends one workspace progress to another and concurrent additions are retained',async()=>{
 const f=setup();await Promise.all([f.sync.enqueue({id:'a'}),f.sync.enqueue({id:'b'})]);assert.equal(f.state.d1JournalPending.length,2);
 f.online();f.workspace('two');await f.sync.flush();assert.equal(f.writes(),0);assert.equal(f.state.d1JournalPending.length,2);
 f.workspace('one');await f.sync.flush();assert.equal(f.remote.one.length,2);
});
