import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope,journalSync} from '../executor/src/workbench-sync.mjs';
import {cloudStatus,pushLocalChanges} from '../executor/src/cloud-status.mjs';
import {pullCloudState,previewCloudPull,commitCloudPull} from '../executor/src/cloud-pull.mjs';
import {pendingApplication,flushApplicationMutations,enqueueLibraryMutation} from '../executor/src/application-mutations.mjs';
import {flushMediaUploads} from '../executor/src/media-uploads.mjs';
import {flushFillLearning} from '../executor/src/fill-learning.mjs';
import {applicationMutation} from '../core/application-mutation.mjs';
import {cloudDigest} from '../executor/src/cloud-sync-state.mjs';
import {resolveApplicationConflict} from '../executor/src/application-mutations.mjs';

const base={siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.example'}}},siteAnnotations:{},cfgName:'Original',urlList:'https://target.example/form',cfgEmail:'local@example.com'};
async function fixture(){
 const home=resolve(await mkdtemp(join(tmpdir(),'el-cloud-sync-'))),store=new Store(join(home,'outbox.sqlite')),pair={endpoint:'https://cloud.example',workspaceId:'original',deviceId:'original-device',storageBackend:'d1',deviceToken:'eld_private',localToken:'private-local'},scope=workbenchScope(pair),requests=[];
 const remote={ok:true,deviceId:pair.deviceId,workspaceId:pair.workspaceId,documents:structuredClone(base),revisions:Object.fromEntries(Object.keys(base).map(key=>[key,1]))};
 store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope,snapshot:structuredClone(remote)});store.set('acceptanceBatch',{id:'original-fixed',status:'paused',cursor:13,count:30});store.set('workbenchBatch:original',{id:'original',status:'paused',config:{concurrency:3,fillOnly:true},usedTasks:13,usedAiActions:4,deadlineAt:'2026-10-10T00:00:00Z',items:[{identity:'target.example::p',taskId:'unknown'}]});store.set('activeWorkbenchBatch','original');
 store.transition({id:'unknown',runId:'original',profileId:'p',url:'https://target.example/form',version:3,status:'submitted_unconfirmed',attemptBoundary:'original-send',profileSnapshot:base.siteProfiles.p},'original_unknown');
 const runtime={home,backupRoot:join(home,'backups'),store,cloud:{async request(route,input){requests.push({route,input});if(runtime.handle)return runtime.handle(route,input);if(route==='revisions')return{revisions:structuredClone(remote.revisions)};if(route==='snapshot')return structuredClone(remote);if(route==='library'){const change=applicationMutation(remote.documents,input.operation);assert.equal(input.revision,remote.revisions[change.key]||0);remote.documents[change.key]=change.data;remote.revisions[change.key]=(remote.revisions[change.key]||0)+1;return{ok:true};}throw Error('Unexpected cloud write: '+route);},async flush(){requests.push({route:'flush-events'});}}};
 return{runtime,store,home,pair,scope,remote,requests,async close(){store.close();assert.equal(dirname(home),resolve(tmpdir()));assert.match(home,/el-cloud-sync-/);await rm(home,{recursive:true,force:true});}};
}
function edit(f,id,key='cfgName',status='pending',extra={}){const saved=f.store.get('applicationSnapshot').snapshot,item={id,scope:f.scope,at:'2026-10-07T00:00:00Z',key,status,baseData:saved.documents[key],baseRevision:saved.revisions[key]||0,operation:{type:'settings',key,value:'Local '+id,id,at:'2026-10-07T00:00:00Z'},...extra};f.store.set('appMutation:'+id,item);return item;}
const business=f=>cloudDigest([f.store.values('task:'),f.store.pending(),f.store.logs({scope:f.scope}),f.store.get('acceptanceBatch'),f.store.get('workbenchBatch:original'),f.store.get('activeWorkbenchBatch'),f.store.get('paused')]);
const preview=async(f,mode)=>(await previewCloudPull(f.runtime,{mode})).preview;
const commit=(f,p)=>commitCloudPull(f.runtime,{previewId:p.id,confirmed:true});

test('lightweight status follows original conflict, pending, changed, empty and current priority without snapshots',async()=>{
 const f=await fixture();try{
  assert.equal((await cloudStatus(f.runtime)).status,'current');edit(f,'a');assert.equal((await cloudStatus(f.runtime)).status,'pending');edit(f,'b','cfgEmail','conflict');assert.equal((await cloudStatus(f.runtime)).status,'conflict');assert.ok(f.requests.every(item=>item.route==='revisions'));
  f.store.set('appMutation:a',{...f.store.get('appMutation:a'),status:'discarded'});f.store.set('appMutation:b',{...f.store.get('appMutation:b'),status:'discarded'});delete f.remote.revisions.cfgEmail;const localOnly=await cloudStatus(f.runtime);assert.equal(localOnly.status,'out_of_date');assert.deepEqual(localOnly.localOnlyKeys,['cfgEmail']);
  const saved=f.store.get('applicationSnapshot');delete saved.snapshot.documents.cfgName;f.store.set('applicationSnapshot',saved);assert.ok((await cloudStatus(f.runtime)).outOfDateKeys.includes('cfgName'));f.store.set('applicationSnapshot',{scope:f.scope,snapshot:{documents:{},revisions:{}}});f.remote.revisions={};assert.equal((await cloudStatus(f.runtime)).status,'empty');
 }finally{await f.close();}
});
test('invalid revision response and connection changes never report connected or current',async()=>{
 const f=await fixture();try{
  f.runtime.handle=async()=>({revisions:[]});assert.equal((await cloudStatus(f.runtime)).connected,false);f.runtime.handle=async()=>{f.store.set('pair',{...f.pair,deviceToken:'eld_rotated'});return{revisions:f.remote.revisions};};const result=await cloudStatus(f.runtime);assert.equal(result.connected,false);assert.match(result.error,/变化/);
 }finally{await f.close();}
});
test('normal pull refuses conflicts and pending before network, and preserves local-only documents when clean',async()=>{
 const f=await fixture();try{
  const before=business(f);edit(f,'a');assert.equal((await pullCloudState(f.runtime)).status,'pending');edit(f,'a','cfgName','conflict');assert.equal((await pullCloudState(f.runtime)).status,'conflict');assert.equal(f.requests.length,0);f.store.set('appMutation:a',{...f.store.get('appMutation:a'),status:'discarded'});delete f.remote.documents.cfgEmail;delete f.remote.revisions.cfgEmail;f.remote.documents.cfgName='Remote';f.remote.revisions.cfgName=2;await pullCloudState(f.runtime);assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgEmail,'local@example.com');assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgName,'Remote');assert.equal(business(f),before);await assert.rejects(pullCloudState(f.runtime,{discardLocalChanges:true}),/预览/);
 }finally{await f.close();}
});
test('backup before confirmation contains original pending intent, unknown attempt, event order and fixed budget',async()=>{
 const f=await fixture();try{
  edit(f,'a');const before=business(f),p=await preview(f,'discard_local');assert.equal(business(f),before);assert.equal(f.store.get('appMutation:a').status,'pending');assert.equal(JSON.stringify(p).includes('eld_'),false);
  const saved=new DatabaseSync(join(p.backupDirectory,'outbox.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(saved.prepare("SELECT value FROM state WHERE id='appMutation:a'").get().value).id,'a');assert.equal(JSON.parse(saved.prepare("SELECT value FROM state WHERE id='task:unknown'").get().value).attemptBoundary,'original-send');assert.equal(saved.prepare('SELECT count(*) AS n FROM outbox').get().n,1);}finally{saved.close();}
  const exported=JSON.parse(await readFile(join(p.backupDirectory,'snapshot.json'),'utf8'));assert.equal(exported.cfgName,'Local a');assert.equal(JSON.stringify(exported).includes('eld_'),false);await assert.rejects(commitCloudPull(f.runtime,{previewId:p.id}),/确认/);assert.equal(f.store.get('appMutation:a').status,'pending');assert.equal(business(f),before);
 }finally{await f.close();}
});
test('conflict-only adoption preserves independent pending edits exactly and leaves tasks and budgets untouched',async()=>{
 const f=await fixture();try{
  edit(f,'conflict','cfgName','conflict');const other=edit(f,'other','cfgEmail');f.remote.documents.cfgName='Remote';f.remote.revisions.cfgName=2;f.remote.documents.cfgEmail='remote@example.com';f.remote.revisions.cfgEmail=2;const before=business(f),p=await preview(f,'resolve_conflicts');assert.deepEqual(p.keys,['cfgName']);await commit(f,p);assert.deepEqual(f.store.get('appMutation:other'),other);assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgEmail,'local@example.com');assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgName,'Remote');assert.equal(f.store.get('appMutation:conflict').status,'discarded');assert.equal(business(f),before);assert.ok(f.requests.every(item=>item.route==='snapshot'));
 }finally{await f.close();}
});
test('missing cloud conflict remains unresolved whereas explicit full cloud adoption removes missing local keys',async()=>{
 const f=await fixture();try{
  edit(f,'conflict','cfgName','conflict');edit(f,'other','cfgEmail');delete f.remote.documents.cfgName;delete f.remote.revisions.cfgName;const p=await preview(f,'resolve_conflicts'),first=await commit(f,p);assert.equal(f.store.get('appMutation:conflict').status,'conflict');assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgName,'Original');assert.deepEqual(first.unresolvedKeys,['cfgName']);assert.equal(first.status,'conflict');
  const full=await preview(f,'discard_local');await commit(f,full);assert.equal(Object.hasOwn(f.store.get('applicationSnapshot').snapshot.documents,'cfgName'),false);assert.equal(pendingApplication(f.runtime).length,0);
 }finally{await f.close();}
});
test('local edits, cloud changes and expired previews block adoption without losing original intent',async()=>{
 const f=await fixture();try{
  edit(f,'a');let p=await preview(f,'discard_local');edit(f,'b','cfgEmail');await assert.rejects(commit(f,p),/本机资料/);assert.equal(f.store.get('appMutation:a').status,'pending');p=await preview(f,'discard_local');f.remote.documents.cfgName='newer';f.remote.revisions.cfgName++;await assert.rejects(commit(f,p),/云端资料/);p=await preview(f,'discard_local');const plan=f.store.get('cloudPullPreview:'+p.id);f.store.set('cloudPullPreview:'+p.id,{...plan,expiresAt:1});await assert.rejects(commit(f,p),/过期/);assert.equal(pendingApplication(f.runtime).length,2);
 }finally{await f.close();}
});
test('backup corruption blocks adoption and repeated previews never overwrite previous backups',async()=>{
 const f=await fixture();try{
  edit(f,'a');const p=await preview(f,'discard_local');await writeFile(join(p.backupDirectory,'manifest.json'),'{}');await assert.rejects(commit(f,p),/备份证明/);const next=await preview(f,'discard_local');assert.notEqual(next.backupDirectory,p.backupDirectory);assert.equal((await readdir(join(f.home,'backups'))).length,2);await commit(f,next);
 }finally{await f.close();}
});
test('adoption transaction failure rolls back cache, queues and receipt and permits original preview retry',async()=>{
 const f=await fixture();try{
  edit(f,'a');const p=await preview(f,'discard_local'),before=business(f),cache=f.store.get('applicationSnapshot'),set=f.store.set.bind(f.store);f.store.set=(key,value)=>{if(key==='cloudPullReceipt:'+p.id)throw Error('fixture commit failure');return set(key,value);};await assert.rejects(commit(f,p),/fixture/);f.store.set=set;assert.equal(f.store.get('appMutation:a').status,'pending');assert.deepEqual(f.store.get('applicationSnapshot'),cache);assert.equal(f.store.get('cloudPullReceipt:'+p.id),null);assert.equal(business(f),before);await commit(f,p);
 }finally{await f.close();}
});
test('lost adoption response recovers original receipt across runtime restart and preserves subsequent edits',async()=>{
 const f=await fixture();try{
  edit(f,'a');const p=await preview(f,'discard_local'),first=await commit(f,p);edit(f,'later','cfgEmail');const subsequent=f.store.get('appMutation:later'),count=f.requests.length,restarted={...f.runtime,cloudPullOperation:null},recovered=await commitCloudPull(restarted,{previewId:p.id,confirmed:true});assert.equal(recovered.recovered,true);assert.equal(recovered.backupDirectory,first.backupDirectory);assert.equal(f.requests.length,count);assert.deepEqual(f.store.get('appMutation:later'),subsequent);f.store.set('pair',{...f.pair,deviceToken:'eld_changed'});await assert.rejects(commit(f,p),/连接已变化/);
 }finally{await f.close();}
});
test('full adoption retains media bytes and learning evidence and cannot resurrect discarded timelines or dependencies',async()=>{
 const f=await fixture();try{
  const parent=edit(f,'parent','siteProfiles','conflict',{operation:{type:'profile',profileId:'p',profile:{name:'Local'},id:'parent'}}),child=edit(f,'child','activeSiteId','pending',{dependsOn:parent.id,operation:{type:'profile_selection',key:'activeSiteId',value:'p'}});f.store.set('applicationPlan:dependent',{id:'dependent',scope:f.scope,status:'queued',items:[parent,child]});
  f.store.set('mediaUpload:original',{assetId:'original',scope:f.scope,status:'pending',dataUrl:'data:image/png;base64,original-bytes'});f.store.set('fillLearning:original',{id:'original',scope:f.scope,status:'pending',profileId:'p',mappings:{Name:'name'},schema:{original:'schema'}});f.store.set('workbenchJournalPending',[{scope:f.scope,event:{id:'manual-original',destinationKey:'target.example',profileId:'p',at:'2026-10-07T00:00:00Z'}},{scope:'other',event:{id:'other'}}]);const before=business(f),p=await preview(f,'discard_local');await commit(f,p);assert.equal(f.store.get('appMutation:child').status,'discarded');assert.equal(f.store.get('applicationPlan:dependent').status,'completed');assert.equal(f.store.get('mediaUpload:original').dataUrl,'data:image/png;base64,original-bytes');assert.equal(f.store.get('mediaUpload:original').status,'retained');assert.equal(f.store.get('fillLearning:original').status,'completed_with_exclusions');assert.deepEqual(f.store.get('workbenchJournalPending'),[{scope:'other',event:{id:'other'}}]);assert.equal(f.store.get('cloudPullReceipt:'+p.id).discardedTimeline[0].event.id,'manual-original');await flushApplicationMutations(f.runtime);await flushMediaUploads(f.runtime);await flushFillLearning(f.runtime);assert.equal(business(f),before);assert.ok(f.requests.every(item=>item.route==='snapshot'));
 }finally{await f.close();}
});
test('conflict adoption excludes only affected unplanned learning and preserves independent learning evidence',async()=>{
 const f=await fixture();try{
  edit(f,'profile','siteProfiles','conflict',{operation:{type:'profile',profileId:'p',profile:{name:'Local'}}});edit(f,'other','cfgName');f.store.set('fillLearning:original',{id:'original',scope:f.scope,status:'pending',profileId:'p',identity:{name:'Original',url:'https://product.example'},url:'https://target.example/form',mappings:{Name:'name'},schema:{original:'schema'}});const p=await preview(f,'resolve_conflicts');await commit(f,p);const learning=f.store.get('fillLearning:original');assert.equal(learning.status,'pending');assert.deepEqual(learning.cloudExcludedKeys,['siteProfiles']);assert.deepEqual(learning.mappings,{Name:'name'});assert.equal(f.store.get('appMutation:other').status,'pending');
 }finally{await f.close();}
});
test('pending edits survive concurrent pull and stale snapshot cannot replace their baseline',async()=>{
 const f=await fixture();try{
  let release;const gate=new Promise(resolve=>release=resolve);f.runtime.handle=async route=>{assert.equal(route,'snapshot');await gate;return structuredClone(f.remote);};const pulling=pullCloudState(f.runtime);await new Promise(resolve=>setImmediate(resolve));edit(f,'during');release();await assert.rejects(pulling,/本机资料/);assert.equal(f.store.get('appMutation:during').status,'pending');assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgName,'Original');
 }finally{await f.close();}
});
test('original running batch does not forbid clean cloud pull and keeps its frozen profile and used budget',async()=>{
 const f=await fixture();try{
  f.store.set('paused',false);f.runtime.job=Promise.resolve();const before=business(f);f.remote.documents.siteProfiles.p.name='New cloud product';f.remote.revisions.siteProfiles++;await pullCloudState(f.runtime);assert.equal(business(f),before);assert.equal(f.store.get('task:unknown').profileSnapshot.name,'Original');
 }finally{await f.close();}
});
test('manual push rejects changed revisions before document or media writes and preserves durable edits',async()=>{
 const f=await fixture();try{
  const original=edit(f,'a');f.remote.revisions.cfgName=2;f.store.set('mediaUpload:original',{assetId:'original',scope:f.scope,status:'pending',dataUrl:'original'});await assert.rejects(pushLocalChanges(f.runtime),/暂停上传/);assert.deepEqual(f.requests.map(item=>item.route),['revisions']);assert.equal(f.store.get('appMutation:a').status,'conflict');assert.equal(f.store.get('appMutation:a').baseRevision,original.baseRevision);assert.equal(f.store.get('mediaUpload:original').status,'pending');
 }finally{await f.close();}
});
test('persisted conflict never uploads automatically even if remote later returns to base; independent documents still sync',async()=>{
 const f=await fixture();try{
  edit(f,'blocked','cfgName','conflict');edit(f,'independent','cfgEmail');await pushLocalChanges(f.runtime);assert.equal(f.remote.documents.cfgName,'Original');assert.equal(f.remote.documents.cfgEmail,'Local independent');assert.equal(f.store.get('appMutation:blocked').status,'conflict');assert.equal(f.store.get('appMutation:independent').status,'confirmed');
 }finally{await f.close();}
});
test('new queued edit stores its original revision even while offline and cache refresh cannot rebase manual upload',async()=>{
 const f=await fixture();try{
  f.runtime.handle=async()=>{throw Error('offline');};await enqueueLibraryMutation(f.runtime,{operation:{type:'settings',key:'cfgName',value:'Offline local'}});const item=pendingApplication(f.runtime)[0];assert.equal(item.baseRevision,1);f.runtime.handle=null;f.remote.revisions.cfgName=2;const saved=f.store.get('applicationSnapshot');saved.snapshot.revisions.cfgName=2;f.store.set('applicationSnapshot',saved);await assert.rejects(pushLocalChanges(f.runtime),/暂停上传/);assert.equal(f.store.get('appMutation:'+item.id).status,'conflict');assert.equal(f.remote.documents.cfgName,'Original');
 }finally{await f.close();}
});
test('active timeline writer rejects adoption preview until its original operation completes',async()=>{
 const f=await fixture();try{
  let release;const gate=new Promise(resolve=>release=resolve);f.runtime.handle=async()=>{await gate;return{documents:{submissionTimeline:{}}};};f.store.set('workbenchJournalPending',[{scope:f.scope,event:{id:'timeline',at:'2026-10-07T00:00:00Z'}}]);const flushing=journalSync(f.runtime).flush();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.runtime.workbenchTimelineBusy,1);assert.throws(()=>previewCloudPull(f.runtime),/正在同步/);release();await flushing;assert.equal(f.runtime.workbenchTimelineBusy,0);
 }finally{await f.close();}
});
test('ordinary synchronization and individual cloud conflict choice retain unrelated local-only documents',async()=>{
 const f=await fixture();try{
  delete f.remote.documents.cfgEmail;delete f.remote.revisions.cfgEmail;edit(f,'a');await flushApplicationMutations(f.runtime);assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgEmail,'local@example.com');assert.equal(Object.hasOwn(f.store.get('applicationSnapshot').remoteSnapshot.documents,'cfgEmail'),false);
  edit(f,'conflict','cfgName','conflict');await resolveApplicationConflict(f.runtime,{id:'conflict',choice:'cloud',revision:f.remote.revisions.cfgName});assert.equal(f.store.get('applicationSnapshot').snapshot.documents.cfgEmail,'local@example.com');assert.equal((await cloudStatus(f.runtime)).status,'out_of_date');
 }finally{await f.close();}
});
test('explicit individual local conflict choice can proceed while another edit of the same document remains held',async()=>{
 const f=await fixture();try{
  edit(f,'a','cfgName','conflict');edit(f,'b','cfgName','conflict');await resolveApplicationConflict(f.runtime,{id:'a',choice:'local',revision:1});assert.equal(f.remote.documents.cfgName,'Local a');assert.equal(f.store.get('appMutation:a').status,'confirmed');assert.equal(f.store.get('appMutation:b').status,'conflict');await resolveApplicationConflict(f.runtime,{id:'b',choice:'local',revision:2});assert.equal(f.remote.documents.cfgName,'Local b');assert.equal(pendingApplication(f.runtime).length,0);
 }finally{await f.close();}
});
