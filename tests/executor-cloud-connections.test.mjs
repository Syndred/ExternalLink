import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {resetWorkspace} from '../executor/src/workspace-reset.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {connectionIdentity,connectionProfiles,connectionHistory,previewConnection,commitConnection,assertConnectionIdle} from '../executor/src/workbench-connections.mjs';

const config=(workspaceId='original',deviceId='device-original')=>({endpoint:'https://cloud.example',workspaceId,deviceId,storageBackend:'d1',deviceToken:'eld_'+deviceId});
const documents=name=>({siteProfiles:{p:{id:'p',name,fields:{Name:name,Url:'https://product.example'},mediaVersions:[{assetId:'original-media',sha256:'original-sha'}]}},activeSiteId:'p',selectedSiteIds:['p'],siteAnnotations:{'target.example':{library:{favorite:true,groups:['high_quality']}}},submissionRecords:{'target.example::p':{status:'success',evidence:'original-receipt'}},submissionTimeline:{'target.example::p':[{id:'original-history',at:'2026-09-30T00:00:00Z'}]},urlList:'https://target.example/form'});
const snapshot=c=>({ok:true,workspaceId:c.workspaceId,deviceId:c.deviceId,documents:documents(c.workspaceId),revisions:{siteProfiles:1,siteAnnotations:2}});
const activeRows=store=>({tasks:store.db.prepare("SELECT id,value,rowid FROM state WHERE id LIKE 'task:%' ORDER BY rowid").all(),events:store.db.prepare('SELECT * FROM outbox ORDER BY seq').all(),logs:store.db.prepare('SELECT * FROM audit_log ORDER BY seq').all()});
async function fixture(){
 const home=resolve(await mkdtemp(join(tmpdir(),'el-connections-'))),store=new Store(join(home,'outbox.sqlite')),requests=[];
 const pair={...config(),localToken:'fixture-local-token',origin:'chrome-extension://fixture',extra:'original-pair-metadata'};
 store.set('pair',pair);store.set('paused',true);store.set('executorControllerId','controller-original');store.set('applicationSnapshot',{scope:workbenchScope(pair),at:'original-cache-time',snapshot:snapshot(pair)});
 store.set('acceptanceBatch',{id:'original-fixed',status:'paused',cursor:13,count:30,attempts:{original:{taskId:'unknown',status:'submitted_unconfirmed'}}});
 store.set('workbenchBatch:original',{id:'original',status:'paused',config:{fillOnly:true,concurrency:3,unattended:false},cursor:2,usedTasks:2,usedAiActions:4,deadlineAt:'2026-10-10T00:00:00Z',items:[{identity:'target.example::p',taskId:'unknown'}]});
 store.set('activeWorkbenchBatch','original');store.set('appMutation:original',{id:'original',scope:workbenchScope(pair),status:'queued',baseRevision:1,baseData:{p:{name:'original-base'}},operation:{type:'profile',profileId:'p'}});
 store.set('gmail',{legacyMigration:{complete:true},emailAddress:'original@example.com'});
 store.transition({id:'unknown',runId:'run-original',profileId:'p',url:'https://target.example/form',version:3,status:'submitted_unconfirmed',attemptBoundary:'original-boundary',preparedAt:'original-time',reason:'原结果未知',profileSnapshot:documents('frozen-original').siteProfiles.p},'original_unknown');
 store.transition({id:'pending',runId:'run-original',profileId:'p',url:'https://second.example/form',version:1,status:'pending'},'original_pending');
 const runtime={home,store,backupRoot:join(home,'backups'),controllerId:'controller-original',hydrated:true,activeTaskIds:new Set(),CloudClass:class{constructor(c){this.config=c;}async request(route){requests.push({route,config:this.config});assert.equal(route,'snapshot');return runtime.cloudReply?runtime.cloudReply(this.config):snapshot(this.config);}}};
 return{home,store,runtime,pair,requests,async close(){store.close();assert.equal(dirname(home),resolve(tmpdir()));assert.ok(home.includes('el-connections-'));await rm(home,{recursive:true,force:true});}};
}
const prepare=async(f,enrollment)=> (await previewConnection(f.runtime,{enrollment})).preview;
const apply=(f,p)=>commitConnection(f.runtime,{previewId:p.id,confirmed:true},{expectedId:connectionIdentity(f.store.get('pair'))});

test('same-device credential update preserves frozen tasks, pending events, logs, original scope and private backup',async()=>{
 const f=await fixture();try{
  const original=activeRows(f.store),batch=f.store.get('workbenchBatch:original'),mutation=f.store.get('appMutation:original'),cache=f.store.get('applicationSnapshot');
  const target={...config(),deviceToken:'eld_rotated'},p=await prepare(f,target);assert.equal(p.kind,'update');assert.equal(JSON.stringify(p).includes('eld_'),false);
  const result=await apply(f,p);assert.equal(result.kind,'update');assert.equal(result.backupIntegrity,'ok');assert.equal(f.store.get('pair').deviceToken,'eld_rotated');assert.equal(f.store.get('pair').extra,'original-pair-metadata');assert.equal(f.store.get('pair').localToken,f.pair.localToken);
  assert.deepEqual(activeRows(f.store),original);assert.deepEqual(f.store.get('workbenchBatch:original'),batch);assert.deepEqual(f.store.get('appMutation:original'),mutation);assert.deepEqual(f.store.get('applicationSnapshot'),cache);assert.equal(f.store.get('paused'),true);assert.equal(f.store.get('acceptanceBatch').cursor,13);assert.equal(f.store.get('connectionExecutionHold').connectionId,connectionIdentity(target));
  const backup=new Store(join(result.backupDirectory,'outbox.sqlite'),{readOnly:true});try{assert.equal(backup.get('pair').deviceToken,f.pair.deviceToken);assert.deepEqual(activeRows(backup),original);}finally{backup.close();}
  assert.equal(f.requests.length,2);assert.equal(f.requests.some(r=>r.route!=='snapshot'),false);
 }finally{await f.close();}
});

test('switch and restore retain each connection exact task IDs, pending event order, logs, original policy and credential vault',async()=>{
 const f=await fixture();try{
  const oldId=connectionIdentity(f.pair),original=activeRows(f.store),batch=f.store.get('workbenchBatch:original'),mutation=f.store.get('appMutation:original'),target=config('second','device-second');
  let p=await prepare(f,target);assert.equal(p.kind,'switch');await apply(f,p);assert.equal(f.store.values('task:').length,0);assert.equal(f.store.pendingCount(),0);assert.equal(f.store.get('activeWorkbenchBatch'),null);assert.equal(f.store.get('applicationSnapshot').snapshot.documents.siteProfiles.p.name,'second');assert.notEqual(f.runtime.controllerId,'controller-original');
  const newVault=f.store.get('gmailCredentialScope');assert.ok(newVault.endsWith('connection-vault-'+connectionIdentity(target)));assert.equal(f.store.get('gmail'),null);
  f.store.transition({id:'other-only',runId:'other-run',profileId:'p',url:'https://other.example',version:1,status:'pending'},'other-pending');const otherRows=activeRows(f.store);
  const history=connectionHistory(f.runtime,{connectionId:oldId});assert.equal(history.readOnly,true);assert.deepEqual(history.tasks.map(t=>t.id),['unknown','pending']);assert.equal(history.tasks[0].attemptBoundary,'original-boundary');assert.equal(history.products[0].name,'original');
  const listing=await connectionProfiles(f.runtime);assert.equal(listing.saved[0].tasks,2);assert.equal(listing.saved[0].pendingEvents,2);assert.equal(JSON.stringify(listing).includes(f.pair.deviceToken),false);
  p=(await previewConnection(f.runtime,{connectionId:oldId})).preview;assert.equal(p.kind,'restore');await apply(f,p);
  assert.deepEqual(activeRows(f.store),original);assert.deepEqual(f.store.get('workbenchBatch:original'),batch);assert.deepEqual(f.store.get('appMutation:original'),mutation);assert.equal(f.store.get('acceptanceBatch').cursor,13);assert.equal(f.runtime.controllerId,'controller-original');assert.equal(f.store.get('gmailCredentialScope'),null);assert.equal(f.store.get('gmail').emailAddress,'original@example.com');assert.equal(f.store.get('task:other-only'),null);
  p=(await previewConnection(f.runtime,{connectionId:connectionIdentity(target)})).preview;await apply(f,p);assert.deepEqual(activeRows(f.store),otherRows);assert.equal(f.store.get('gmailCredentialScope'),newVault);assert.equal(f.store.get('paused'),true);
 }finally{await f.close();}
});

test('same workspace different device and endpoint have separate saved task and outbox ownership',async()=>{
 const f=await fixture();try{
  const second=config('original','another-device');assert.notEqual(connectionIdentity(second),connectionIdentity(f.pair));await apply(f,await prepare(f,second));assert.equal(f.store.values('task:').length,0);assert.equal(f.store.pendingCount(),0);
  const elsewhere={...second,endpoint:'https://other-cloud.example'};assert.notEqual(connectionIdentity(elsewhere),connectionIdentity(second));await apply(f,await prepare(f,elsewhere));assert.equal(f.store.pendingCount(),0);const saved=await connectionProfiles(f.runtime);assert.equal(saved.saved.length,2);assert.equal(saved.saved.find(c=>c.deviceId==='device-original').pendingEvents,2);
 }finally{await f.close();}
});

test('commit response loss recovers original receipt across SQLite restart without another cloud call or backup',async()=>{
 const f=await fixture();try{
  const p=await prepare(f,config('second','other')),from=connectionIdentity(f.pair),first=await apply(f,p),rows=activeRows(f.store),requests=f.requests.length,backups=await readdir(f.runtime.backupRoot);
  f.store.close();f.store.db=new Store(join(f.home,'outbox.sqlite')).db;
  const recovered=await commitConnection(f.runtime,{previewId:p.id,confirmed:true},{expectedId:from});assert.equal(recovered.recovered,true);assert.equal(recovered.backupDirectory,first.backupDirectory);assert.deepEqual(activeRows(f.store),rows);assert.equal(f.requests.length,requests);assert.deepEqual(await readdir(f.runtime.backupRoot),backups);
  await assert.rejects(commitConnection(f.runtime,{previewId:p.id,confirmed:true},{expectedId:'unrelated'}),/再次变化/);
 }finally{await f.close();}
});

test('transaction failure leaves active and archived records intact and same preview retry makes a new private backup',async()=>{
 const f=await fixture();try{
  const p=await prepare(f,config('second','other')),rows=activeRows(f.store),pair=f.store.get('pair');let aborted=0;f.runtime.onConnectionChangeAborted=()=>aborted++;
  f.store.db.exec("CREATE TRIGGER reject_connection_insert BEFORE INSERT ON connection_commits BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END");
  await assert.rejects(apply(f,p),/fixture transaction failure/);assert.deepEqual(f.store.get('pair'),pair);assert.deepEqual(activeRows(f.store),rows);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM connection_profiles').get().n,0);assert.equal(f.store.get('connectionExecutionHold'),null);assert.equal(aborted,1);assert.equal(f.runtime.connectionBusy,false);
  const originalBackups=await readdir(f.runtime.backupRoot);assert.equal(originalBackups.length,1);f.store.db.exec('DROP TRIGGER reject_connection_insert');const result=await apply(f,p);assert.equal(result.kind,'switch');assert.equal((await readdir(f.runtime.backupRoot)).length,2);assert.ok(!(result.backupDirectory.endsWith(originalBackups[0])));
 }finally{await f.close();}
});

test('post-commit initialization failure truthfully reports saved connection and retries original lifecycle only',async()=>{
 const f=await fixture();try{
  let attempts=0;f.runtime.onConnectionChanged=()=>{if(++attempts===1)throw Error('fixture init failed');};const p=await prepare(f,config('second','other')),result=await apply(f,p),requests=f.requests.length;
  assert.equal(result.ok,true);assert.equal(result.lifecyclePending,true);assert.match(result.lifecycleWarning,/已保存/);assert.equal(f.store.get('pair').workspaceId,'second');assert.equal((await connectionProfiles(f.runtime)).lifecyclePending.previewId,p.id);
  const retried=await apply(f,p);assert.equal(retried.recovered,true);assert.equal(retried.lifecyclePending,undefined);assert.equal(f.store.get('connectionLifecyclePending'),null);assert.equal(attempts,2);assert.equal(f.requests.length,requests);assert.equal((await readdir(f.runtime.backupRoot)).length,1);
 }finally{await f.close();}
});

test('an older unchanged-key receipt cannot clear a newer failed lifecycle or restart an already running background',async()=>{
 const f=await fixture();try{
  let attempts=0;f.runtime.onConnectionChanged=()=>{if(++attempts===2)throw Error('new lifecycle failed');};const target={...config(),deviceToken:'eld_updated'},first=await prepare(f,target);await apply(f,first);const second=await prepare(f,target);const failed=await apply(f,second);assert.equal(failed.lifecyclePending,true);
  const old=await apply(f,first);assert.equal(old.recovered,true);assert.equal(old.lifecyclePending,true);assert.equal(attempts,2);assert.equal(f.store.get('connectionLifecyclePending').previewId,second.id);
  await apply(f,second);assert.equal(attempts,3);assert.equal(f.store.get('connectionLifecyclePending'),null);f.store.set('paused',false);f.runtime.job=Promise.resolve();const running=await apply(f,first);assert.equal(running.paused,false);assert.equal(attempts,3);assert.equal(f.store.get('paused'),false);
 }finally{await f.close();}
});

test('changed local task, event, cached document, old identity or expired preview prevents replacement',async()=>{
 const f=await fixture();try{
  let p=await prepare(f,config('second','other'));await assert.rejects(commitConnection(f.runtime,{previewId:p.id,confirmed:true},{expectedId:'different'}),/不存在或已变化/);
  const task=f.store.get('task:pending');f.store.set('task:pending',{...task,reason:'updated'});await assert.rejects(apply(f,p),/已变化/);
  p=await prepare(f,config('second','other'));const cache=f.store.get('applicationSnapshot');cache.snapshot.documents.siteProfiles.p.name='updated local cache';f.store.set('applicationSnapshot',cache);await assert.rejects(apply(f,p),/已变化/);
  p=await prepare(f,config('second','other'));f.store.ack(f.store.pendingBatch()[0].id);await assert.rejects(apply(f,p),/已变化/);
  p=await prepare(f,config('second','other'));f.store.set('connectionPreview:'+p.id,{...f.store.get('connectionPreview:'+p.id),expiresAt:0});await assert.rejects(apply(f,p),/已变化/);assert.equal(f.store.get('pair').workspaceId,'original');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM connection_profiles').get().n,0);
 }finally{await f.close();}
});

test('remote revision changes and target identity mismatch reject before backup; stable revision key order is accepted',async()=>{
 const f=await fixture();try{
  let p=await prepare(f,config('second','other'));f.runtime.cloudReply=c=>({...snapshot(c),revisions:{siteProfiles:2,siteAnnotations:2}});await assert.rejects(apply(f,p),/已有新版本/);assert.equal(f.store.get('pair').workspaceId,'original');
  f.runtime.cloudReply=c=>({...snapshot(c),deviceId:'wrong'});await assert.rejects(prepare(f,config('second','other')),/不一致/);
  f.runtime.cloudReply=undefined;p=await prepare(f,config('second','other'));f.runtime.cloudReply=c=>({...snapshot(c),revisions:{siteAnnotations:2,siteProfiles:1}});await apply(f,p);assert.equal(f.store.get('pair').workspaceId,'second');
 }finally{await f.close();}
});

test('saved history is available offline, read-only and paginated without missing or duplicating original IDs',async()=>{
 const f=await fixture();try{
  for(let n=0;n<105;n++)f.store.set('task:old-'+n,{id:'old-'+n,profileId:'p',url:'https://history.example/'+n,status:'finished',receipt:{evidence:'original-'+n}});
  const expected=f.store.valuesByInsertion('task:').map(t=>t.id),oldId=connectionIdentity(f.pair);await apply(f,await prepare(f,config('second','other')));const before=activeRows(f.store),requests=f.requests.length;f.runtime.cloudReply=()=>{throw Error('old cloud unavailable');};
  const ids=[];let after=0;do{const page=connectionHistory(f.runtime,{connectionId:oldId,after});assert.equal(page.readOnly,true);assert.ok(page.tasks.length<=50);ids.push(...page.tasks.map(t=>t.id));after=page.next;}while(after);
  assert.deepEqual(ids,expected);assert.equal(f.requests.length,requests);assert.deepEqual(activeRows(f.store),before);assert.throws(()=>connectionHistory(f.runtime,{connectionId:oldId,after:-1}),/游标/);await assert.rejects(previewConnection(f.runtime,{connectionId:oldId}),/unavailable/);
 }finally{await f.close();}
});

test('invalid enrollment, busy operations and local changes during target readback retain original identity',async()=>{
 const f=await fixture();try{
  for(const bad of [null,[],{...config(),deviceToken:'bad'},{...config(),endpoint:'http://public.example'},{...config(),endpoint:'https://cloud.example/path'},{...config(),endpoint:'https://owner:secret@cloud.example'}])await assert.rejects(previewConnection(f.runtime,{enrollment:bad}));
  for(const key of ['job','hydrating','singlePageFill','localRecoveryOperation','mediaUploadFlush','manualWatchJob']){f.runtime[key]=true;assert.throws(()=>assertConnectionIdle(f.runtime),/暂停并等待/);f.runtime[key]=false;}
  f.runtime.activeTaskIds.add('old');assert.throws(()=>assertConnectionIdle(f.runtime),/暂停并等待/);f.runtime.activeTaskIds.clear();f.runtime.connectionExternalBusy=()=>true;assert.throws(()=>assertConnectionIdle(f.runtime),/暂停并等待/);f.runtime.connectionExternalBusy=()=>false;
  f.runtime.cloudReply=c=>{f.store.set('task:pending',{...f.store.get('task:pending'),reason:'changed while reading'});return snapshot(c);};await assert.rejects(prepare(f,config('second','other')),/核验期间/);assert.equal(f.store.get('pair').workspaceId,'original');
 }finally{await f.close();}
});

test('connection hold permits original-device restoration and pending synchronization while preventing automatic execution recovery',async()=>{
 const f=await fixture();try{
  await apply(f,await prepare(f,{...config(),deviceToken:'eld_updated'}));f.store.set('libraryPlan',{id:'original-plan',status:'active',globalPause:{attentionType:'cloud_connection',resumeEligible:true,nextProbeAt:0}});f.store.set('acceptanceBatch',null);
  const runtime=new Runtime(f.store,f.home);let restores=0,syncs=0,executions=0;runtime.restoreCloud=()=>{restores++;return Promise.resolve();};runtime.synchronize=()=>{syncs++;return Promise.resolve();};runtime.recoverContinuousConnection=()=>{executions++;return Promise.resolve();};runtime.work=()=>{executions++;return Promise.resolve();};runtime.hydrated=false;runtime.tick();assert.equal(restores,1);assert.equal(executions,0);assert.equal(f.store.get('paused'),true);assert.equal(f.store.pendingCount(),2);
  runtime.hydrated=true;runtime.tick();await runtime.job;assert.equal(syncs,1);assert.equal(executions,0);assert.ok(f.store.get('connectionExecutionHold'));f.store.set('activeWorkbenchBatch',null);f.store.set('paused',false);runtime.tick();await runtime.job;assert.equal(executions,1);assert.equal(f.store.get('connectionExecutionHold'),null);
 }finally{await f.close();}
});

test('original Neon device can update its key, switch to D1 and restore original legacy scope without losing task ownership',async()=>{
 const f=await fixture();try{
  const legacy={...f.pair,storageBackend:'neon',endpoint:f.pair.endpoint+'/'},cache=f.store.get('applicationSnapshot');f.store.set('pair',legacy);f.store.set('applicationSnapshot',{...cache,scope:workbenchScope(legacy)});const original=activeRows(f.store);
  let p=await prepare(f,{...legacy,deviceToken:'eld_neon_updated'});assert.equal(p.kind,'update');await apply(f,p);assert.equal(f.store.get('pair').endpoint,legacy.endpoint);assert.deepEqual(activeRows(f.store),original);const legacyId=connectionIdentity(legacy);
  p=await prepare(f,config());assert.equal(p.kind,'switch');await apply(f,p);assert.equal(f.store.values('task:').length,0);
  p=(await previewConnection(f.runtime,{connectionId:legacyId})).preview;assert.equal(p.kind,'restore');await apply(f,p);assert.equal(f.store.get('pair').storageBackend,'neon');assert.equal(f.store.get('pair').deviceToken,'eld_neon_updated');assert.equal(workbenchScope(f.store.get('pair')),workbenchScope(legacy));assert.deepEqual(activeRows(f.store),original);
  assert.equal(connectionIdentity({...legacy,storageBackend:undefined}),legacyId);assert.equal(connectionIdentity({...legacy,storageBackend:'legacy'}),legacyId);f.store.set('pair',{...f.store.get('pair'),storageBackend:'legacy'});p=await prepare(f,{...legacy,storageBackend:'legacy',deviceToken:'eld_original_legacy_updated'});assert.equal(p.kind,'update');await apply(f,p);assert.deepEqual(activeRows(f.store),original);assert.equal(f.store.get('pair').storageBackend,'legacy');assert.equal(f.store.get('pair').deviceToken,'eld_original_legacy_updated');
 }finally{await f.close();}
});

test('workspace clear backs up all saved connection records and receipts before clearing active and archived data',async()=>{
 const f=await fixture();try{
  const oldId=connectionIdentity(f.pair),p=await prepare(f,config('second','other'));await apply(f,p);const result=await resetWorkspace(f.runtime,{confirmation:'清空本机工作区'});
  const backup=new Store(join(result.backupDirectory,'outbox.sqlite'),{readOnly:true});try{assert.equal(backup.db.prepare('SELECT count(*) AS n FROM connection_profiles').get().n,1);assert.equal(backup.db.prepare('SELECT count(*) AS n FROM connection_outbox WHERE connection_id=?').get(oldId).n,2);assert.equal(backup.db.prepare('SELECT count(*) AS n FROM connection_commits').get().n,1);}finally{backup.close();}
  for(const table of ['connection_profiles','connection_state','connection_outbox','connection_audit','connection_commits'])assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM '+table).get().n,0);assert.equal(f.store.get('pair'),null);assert.equal(f.store.get('paused'),true);
 }finally{await f.close();}
});
