import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../executor/src/store.mjs';import {Cloud} from '../executor/src/cloud.mjs';import {enqueueLibraryMutation,flushApplicationMutations} from '../executor/src/application-mutations.mjs';import {workbenchScope} from '../executor/src/workbench-sync.mjs';import {libraryMutation} from '../core/library-mutation.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
test('paused background retries an isolated pending media upload without releasing submission tasks',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example'});store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13});store.set('mediaUpload:asset',{scope:workbenchScope(store.get('pair')),status:'pending'});
 const runtime=Object.create(Runtime.prototype);runtime.store=store;runtime.hydrated=true;let syncCalls=0;runtime.synchronize=async()=>{syncCalls++;};runtime.work=async()=>{throw Error('Must not submit while paused');};
 runtime.tick();assert.equal(syncCalls,1);await runtime.job;assert.equal(store.get('paused'),true);assert.equal(store.get('acceptanceBatch').cursor,13);store.close();
});
test('real connection loss and SQLite reopen preserve local edits, pause and unknown boundaries without replaying writes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-app-recovery-'));let store=new Store(join(home,'outbox.sqlite')),writes=0,snapshot={documents:{siteAnnotations:{}},revisions:{siteAnnotations:1}};
 const server=createServer(async(req,res)=>{const route=new URL(req.url,'http://localhost').pathname;if(route.endsWith('/snapshot')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot));return;}let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);writes++;snapshot.documents.siteAnnotations=libraryMutation(snapshot.documents,input.operation).data;snapshot.revisions.siteAnnotations++;req.socket.destroy();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const pair={endpoint:'http://127.0.0.1:'+port,workspaceId:'fixture',storageBackend:'d1',deviceToken:'test-only-token'};store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{id:'original-fixed',cursor:13,count:30,status:'paused'});store.set('task:unknown',{id:'unknown',status:'submitting',attemptBoundary:'2026-09-30T00:00:00Z',aiTakeover:{actions:20,calls:9}});store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});
 let runtime={store,cloud:new Cloud(pair)};
 try{
  const saved=await enqueueLibraryMutation(runtime,{operation:{type:'mark',url:'https://site.example/submit',status:'needs_login'}});assert.equal(saved.pending,1);const originalId=store.values('appMutation:')[0].id;
  store.close();store=new Store(join(home,'outbox.sqlite'));store.recover();runtime={store,cloud:new Cloud(pair)};assert.equal(store.get('paused'),true);assert.equal(store.get('acceptanceBatch').cursor,13);assert.equal(store.get('task:unknown').status,'submitted_unconfirmed');assert.equal(store.get('task:unknown').aiTakeover.actions,20);assert.equal(store.values('appMutation:')[0].id,originalId);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));await flushApplicationMutations(runtime);assert.equal(writes,1);
  store.close();store=new Store(join(home,'outbox.sqlite'));await flushApplicationMutations({store,cloud:new Cloud(pair)});assert.equal(writes,1);assert.equal(store.get('appMutation:'+originalId).status,'confirmed');assert.equal(store.get('task:unknown').attemptBoundary,'2026-09-30T00:00:00Z');
 }finally{store.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});}
});
