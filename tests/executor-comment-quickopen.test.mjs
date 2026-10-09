import {backgroundContext} from './helpers/background-browser-context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {saveCommentVersion,commentHistory} from '../executor/src/comment-history.mjs';
import {quickOpenLibrary} from '../executor/src/quick-open.mjs';
import {mediaLibrary} from '../executor/src/media-library.mjs';
test('unopened batch resumes with the same identity after the native browser connection is restored',async()=>{
 const store=new Store(':memory:');store.set('paused',true);store.set('pair',{endpoint:'https://cloud.test'});let connected=false,reads=0;const visited=[];const runtime={store,cloud:{async request(){reads++;return{revisions:{},documents:{sheetTableData:{entries:[{link:'https://one.test'}]}}};}},async connect(){if(!connected)throw Error('browser disconnected');runtime.context=backgroundContext(async url=>{visited.push(url);});}};
 const first=await quickOpenLibrary(runtime,{urls:['https://one.test']});await runtime.quickOpenJob;assert.equal(store.get('quickOpenJob:'+first.job.id).status,'paused');connected=true;const resumed=await quickOpenLibrary(runtime,{jobId:first.job.id});await runtime.quickOpenJob;assert.equal(resumed.job.id,first.job.id);assert.match(store.get('quickOpenJob:'+first.job.id).history[0].error,/browser disconnected/);assert.equal(reads,1);assert.equal(visited.length,1);assert.equal(store.get('quickOpenJob:'+first.job.id).cursor,1);store.close();
});
test('cloud media catalogue consumes all pages, identifies unresolved active references and refuses repeated cursors',async()=>{
 const calls=[],runtime={cloud:{async request(route){calls.push(route);if(route==='snapshot')return{documents:{siteProfiles:{p:{id:'p',media:{logo:'cloud-media://present',featured:'cloud-media://missing'}}}}};return route.includes('cursor=')?{assets:[{asset_id:'present'}],next:null}:{assets:[{asset_id:'other'}],next:'second'};}}};
 const result=await mediaLibrary(runtime);assert.equal(result.assets.length,2);assert.equal(result.missing.length,1);assert.equal(result.missing[0].kind,'featured');assert.deepEqual(calls,['workspace/media','workspace/media?cursor=second','snapshot']);
 await assert.rejects(mediaLibrary({cloud:{request:async()=>({assets:[],next:'same'})}}),/游标重复/);
});
test('edited comment versions survive reload, retain nine versions and isolate products, articles and cloud scopes',()=>{
 const store=new Store(':memory:'),runtime={store};store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one'});const input={profileId:'p',pageUrl:'https://article.test/post',drafts:[{text:'1'},{text:'2'},{text:'3'}]};
 saveCommentVersion(runtime,input);saveCommentVersion(runtime,input);assert.equal(commentHistory(runtime,input).versions.length,1);
 for(let i=0;i<12;i++)saveCommentVersion(runtime,{...input,drafts:[{text:'edited'+i},...input.drafts.slice(1)]});
 const versions=commentHistory({store},input).versions;assert.equal(versions.length,9);assert.equal(versions[0].payload.drafts[0].text,'edited11');assert.equal(versions[1].payload.drafts[0].text,'edited10');
 assert.equal(commentHistory(runtime,{...input,profileId:'q'}).versions.length,0);assert.equal(commentHistory(runtime,{...input,pageUrl:'https://other.test/post'}).versions.length,0);
 store.set('pair',{endpoint:'https://cloud.test',workspaceId:'two'});assert.equal(commentHistory(runtime,input).versions.length,0);saveCommentVersion(runtime,input);assert.equal(commentHistory(runtime,input).versions.length,1);store.close();
});
test('batch open freezes a library subset, deduplicates, retains failures and does not invoke a submission engine',async()=>{
 const store=new Store(':memory:'),visited=[];store.set('paused',true);store.set('pair',{endpoint:'https://cloud.test'});
 const runtime={store,cloud:{async request(route){assert.equal(route,'snapshot');return{revisions:{},documents:{sheetTableData:{entries:[{link:'https://one.test/add'},{link:'https://two.test/add'}]}}};}},context:backgroundContext(async url=>{visited.push(url);if(url.includes('two'))throw Error('tab creation failed');})};
 const result=await quickOpenLibrary(runtime,{urls:['chrome://extensions','https://unknown.test','https://one.test/add','https://one.test/add','https://two.test/add'],batchSize:5,intervalMs:100});await runtime.quickOpenJob;
 const job=store.get('quickOpenJob:'+result.job.id);assert.equal(job.items.length,2);assert.deepEqual(visited,['https://one.test/add','https://two.test/add']);assert.equal(job.cursor,2);assert.equal(job.items[0].status,'opened');assert.equal(job.items[1].status,'failed');assert.match(job.items[1].error,/tab creation failed/);assert.equal(store.values('task:').length,0);assert.equal(store.pendingCount(),0);store.close();
});
