import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {submissionQueue} from '../executor/src/submission-queue.mjs';
import {quickOpenLibrary} from '../executor/src/quick-open.mjs';
import {originalNavigationState,originalLibraryQuickOpen} from './helpers/original-library-catalog.mjs';
import {enqueueLibraryMutation,overlayApplication} from '../executor/src/application-mutations.mjs';

const saved=()=>({documents:{siteProfiles:{p:{id:'p',name:'Original P',fields:{Url:'https://product.fixture.invalid'}}},selectedSiteIds:['p'],activeSiteId:'p',sheetTableData:{entries:[{link:'https://first.fixture.invalid/form',note:'AI tool directory'}]},submissionRecords:{},domainBlacklist:[],targetFilters:{},autoFillOnVisit:false},revisions:{siteProfiles:1,sheetTableData:1}});
function fixture(){const store=new Store(':memory:'),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original-browse'},snapshot=saved(),calls=[];store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope:workbenchScope(pair),at:'2026-10-08T00:00:00.000Z',snapshot:structuredClone(snapshot)});const runtime={store,cloud:{async request(route){calls.push(route);throw Error('Fixture cloud offline');}}};return{store,pair,snapshot,calls,runtime};}

test('offline original navigation and advances use saved local data and locally saved new targets without remote writes',async()=>{
 const f=fixture();try{
  const before=structuredClone(f.snapshot);await enqueueLibraryMutation(f.runtime,{operation:{type:'create',url:'https://new.fixture.invalid/form',fields:{note:'AI tool directory'}}});
  const local=overlayApplication(f.runtime,f.snapshot),expected=await originalNavigationState(local),actual=await submissionQueue(f.runtime);
  assert.equal(actual.browseSource,'local');assert.match(actual.browseMessage,/云端暂不可用.*本机已保存/);assert.equal(actual.browseSavedAt,'2026-10-08T00:00:00.000Z');assert.equal(actual.total,expected.result.total);assert.deepEqual(actual.tasks.map(group=>group.key),expected.result.tasks.map(group=>group.key));assert.ok(actual.tasks.some(group=>group.url==='https://new.fixture.invalid/form'));
  const nextReference=await originalNavigationState(local,{cursor:expected.cursor,input:{delta:1,open:false},advance:true}),next=await submissionQueue(f.runtime,{delta:1,open:false},true);assert.equal(next.task.key,nextReference.cursor.key);assert.equal(next.browseSource,'local');
  assert.deepEqual(f.snapshot,before);assert.equal(f.store.values('task:').length,0);assert.equal(f.store.values('run:').length,0);assert.equal(f.store.get('paused'),true);
 }finally{f.store.close();}
});

test('offline batch opening follows the frozen original local catalogue and keeps the same browsing job after a connection failure',async()=>{
 const f=fixture(),visited=[];let connected=false;
 f.runtime.connect=async()=>{if(!connected)throw Error('Fixture browser unavailable');f.runtime.context={async newPage(){return{isClosed:()=>false,async goto(url){visited.push(url);}};},async newCDPSession(){return{async send(){return{targetInfo:{targetId:'owned-fixture-page'}};},async detach(){}};}};};
 try{
  const urls=['https://first.fixture.invalid/form'],expected=await originalLibraryQuickOpen(f.snapshot,{urls,batchSize:1}),result=await quickOpenLibrary(f.runtime,{urls,batchSize:1});await f.runtime.quickOpenJob;
  assert.equal(result.job.browseSource,'local');assert.equal(f.store.get('quickOpenJob:'+result.job.id).status,'paused');connected=true;const resumed=await quickOpenLibrary(f.runtime,{jobId:result.job.id});await f.runtime.quickOpenJob;
  assert.equal(resumed.job.id,result.job.id);assert.deepEqual(visited,expected);assert.equal(f.store.get('quickOpenJob:'+result.job.id).status,'completed');assert.equal(f.store.values('task:').length,0);assert.equal(f.store.values('run:').length,0);
 }finally{f.store.close();}
});

test('browsing cannot fall back across workspaces or a connection change and cannot create a job without a saved snapshot',async()=>{
 for(const kind of ['no-cache','other-workspace','switch-on-failure','switch-on-success']){
  for(const action of [runtime=>submissionQueue(runtime),runtime=>quickOpenLibrary(runtime,{urls:['https://first.fixture.invalid/form']})]){
   const f=fixture();try{
    const cursor={scope:workbenchScope(f.pair),index:17,key:'keep-original'};f.store.set('submissionQueue',cursor);
    if(kind==='no-cache')f.store.set('applicationSnapshot',null);if(kind==='other-workspace')f.store.set('applicationSnapshot',{scope:'other',snapshot:f.snapshot});
    if(kind.startsWith('switch-'))f.runtime.cloud.request=async()=>{f.store.set('pair',{...f.pair,deviceId:'changed-device'});if(kind==='switch-on-success')return structuredClone(f.snapshot);throw Error('Fixture connection changed');};
    await assert.rejects(action(f.runtime));assert.deepEqual(f.store.get('submissionQueue'),cursor);assert.equal(f.store.values('quickOpenJob:').length,0);assert.equal(f.store.values('task:').length,0);
   }finally{f.store.close();}
  }
 }
});

test('online navigation uses fresh remote data and persists it for the next offline browse without invoking registration',async()=>{
 const f=fixture(),remote=saved();remote.documents.sheetTableData.entries.push({link:'https://fresh.fixture.invalid/form'});remote.revisions.sheetTableData=2;let online=true;
 f.runtime.cloud.request=async route=>{assert.equal(route,'snapshot');if(!online)throw Error('Fixture offline');return structuredClone(remote);};
 try{
  const current=await submissionQueue(f.runtime);assert.equal(current.browseSource,'cloud');assert.ok(current.tasks.some(group=>group.url==='https://fresh.fixture.invalid/form'));online=false;
  const offline=await submissionQueue(f.runtime);assert.equal(offline.browseSource,'local');assert.deepEqual(offline.tasks.map(group=>group.key),current.tasks.map(group=>group.key));assert.equal(f.store.get('applicationSnapshot').snapshot.revisions.sheetTableData,2);assert.equal(f.store.values('task:').length,0);assert.equal(f.store.values('run:').length,0);
 }finally{f.store.close();}
});

test('malformed cloud reads and mismatched workspace or device provenance cannot overwrite saved browsing data or its cursor',async()=>{
 for(const kind of ['missing-revisions','missing-documents','other-workspace','other-device']){
  const f=fixture();try{
   f.store.set('pair',{...f.pair,deviceId:'original-device'});const before=f.store.get('applicationSnapshot'),cursor={scope:workbenchScope(f.pair),key:'original-key',index:17};f.store.set('submissionQueue',cursor);
   const remote=structuredClone(f.snapshot);if(kind==='missing-revisions')delete remote.revisions;if(kind==='missing-documents')delete remote.documents;if(kind==='other-workspace')remote.workspaceId='other';if(kind==='other-device')remote.deviceId='other';f.runtime.cloud.request=async()=>remote;
   await assert.rejects(submissionQueue(f.runtime));assert.deepEqual(f.store.get('applicationSnapshot'),before);assert.deepEqual(f.store.get('submissionQueue'),cursor);assert.equal(f.store.values('task:').length,0);
  }finally{f.store.close();}
 }
});
