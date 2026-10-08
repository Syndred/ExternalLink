import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {localRecoveryDocuments,recoveryDocument} from '../core/local-recovery.mjs';
import {libraryMutation} from '../core/library-mutation.mjs';
import {localRecoverySources,previewLocalRecovery,recoverLocalDocuments,localRecoveryPlans,readLocalRecoverySource} from '../executor/src/local-recovery.mjs';
import {resolveApplicationConflict} from '../executor/src/application-mutations.mjs';
const confirmation='恢复所选本机资料';
const base=()=>({siteProfiles:{p:{id:'p',name:'Current',fields:{Name:'Current',Url:'https://product.example'},mediaVersions:[{assetId:'new',sha256:'new-hash'}]}},siteAnnotations:{'target.example':{note:'Cloud note'}},urlList:'https://cloud.example',sheetTableData:{entries:[]},submissionRecords:{'target.example::p':{taskId:'original',profileId:'p',status:'success',evidence:'Original receipt',submittedAt:'2026-10-01T00:00:00Z'}},submissionTimeline:{},timelineSchemaVersion:3});
const legacy=()=>({siteProfiles:{p:{id:'p',name:'Original local',fields:{Name:'Original local',Url:'https://product.example'},learnedFieldMappings:{'#name':'Name'},mediaVersions:[{assetId:'old',sha256:'old-hash'}]}},siteAnnotations:{'target.example':{library:{favorite:true,groups:['high_quality']},formKnowledge:{name:'#name'},note:'Original local note'}},urlList:'https://restored.example',sheetTableData:{entries:[{link:'https://restored.example/submit'}]},submissionRecords:{'target.example::p':{profileId:'p',status:'failed',evidence:'Old result'},'older.example::p':{profileId:'p',status:'success',evidence:'Older receipt'}},timelineSchemaVersion:1});
async function fixture(){
 const home=await mkdtemp(join(tmpdir(),'el-local-recovery-')),backupRoot=join(home,'backups'),folder=join(backupRoot,'original-plugin');await mkdir(folder,{recursive:true});
 let store=new Store(join(home,'outbox.sqlite'));store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one',deviceToken:'PRIVATE_FIXTURE_TOKEN'});store.set('paused',true);store.set('acceptanceBatch',{id:'original-fixed',cursor:13,count:30,status:'paused'});store.set('task:unknown',{id:'unknown',status:'submitted_unconfirmed',attemptBoundary:'original-boundary'});
 let saved={documents:base(),revisions:Object.fromEntries(Object.keys(base()).map(key=>[key,1]))},writes=[];const file=join(folder,'snapshot.json');await writeFile(file,JSON.stringify({scope:workbenchScope(store.get('pair')),workspaceId:'one',documents:legacy()}));
 const runtime={home,backupRoot,store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0}),cloud:{async request(route,input){if(route==='snapshot')return structuredClone(saved);assert.equal(route,'library');const plan=runtime.store.values('localRecoveryPlan:').find(p=>p.applicationPlanId);assert.ok(plan);assert.equal((await stat(join(plan.backupDirectory,'outbox.sqlite'))).isFile(),true);assert.equal(runtime.store.get('applicationPlan:'+plan.applicationPlanId).items.some(i=>i.id===input.operation.id),true);writes.push(input.operation.id);const change=libraryMutation(saved.documents,input.operation);saved.documents[change.key]=change.data;saved.revisions[change.key]=(saved.revisions[change.key]||0)+1;await runtime.afterWrite?.(input);return{ok:true};}}};
 return{runtime,file,get saved(){return saved;},set saved(value){saved=value;},writes,async reopen(){store.close();store=new Store(join(home,'outbox.sqlite'));runtime.store=store;},async close(){store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-local-recovery-'));await rm(home,{recursive:true,force:true});}};
}
async function prepare(f){const sources=await localRecoverySources(f.runtime),source=sources.sources.find(s=>s.label.startsWith('original-plugin'));assert.ok(source?.id);const result=await previewLocalRecovery(f.runtime,{sourceId:source.id});return result.preview;}
async function companion(f,pair=f.runtime.store.get('pair'),{file='outbox.sqlite',scope=workbenchScope(pair)}={}){
 const path=join(dirname(f.file),file),store=new Store(path);try{store.set('pair',pair);store.set('applicationSnapshot',{scope,snapshot:{documents:legacy(),revisions:{}}});store.set('task:original-unknown',{id:'original-unknown',status:'submitted_unconfirmed',attemptBoundary:'keep-original'});}finally{store.close();}return path;
}
const fileDigest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');

test('unscoped JSON uses its original SQLite identity and rejects foreign endpoints or workspaces without exposing credentials',async()=>{
 const f=await fixture();try{
  await writeFile(f.file,JSON.stringify({documents:legacy()}));
  for(const pair of [{...f.runtime.store.get('pair'),workspaceId:'other'},{...f.runtime.store.get('pair'),endpoint:'https://other-cloud.example'}]){
   const file=await companion(f,pair),before=await fileDigest(file);await assert.rejects(readLocalRecoverySource(f.runtime,f.file),/其他工作区/);const listing=await localRecoverySources(f.runtime),source=listing.sources.find(s=>s.label==='original-plugin / snapshot.json');assert.equal(source.unavailable,true);assert.equal(source.id,undefined);assert.equal(JSON.stringify(listing).includes('PRIVATE_FIXTURE_TOKEN'),false);assert.equal(await fileDigest(file),before);
  }
  assert.equal(f.writes.length,0);assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-boundary');assert.equal(f.runtime.store.get('acceptanceBatch').cursor,13);
 }finally{await f.close();}
});

test('same-workspace original companion restores unscoped legacy favorites and history while keeping both backup files unchanged',async()=>{
 const f=await fixture();try{
  await writeFile(f.file,JSON.stringify({documents:legacy()}));const database=await companion(f),before=[await fileDigest(f.file),await fileDigest(database)],value=await readLocalRecoverySource(f.runtime,f.file);assert.equal(value.scopeVerified,true);assert.equal(value.scopeVerification,'full');const preview=await prepare(f);assert.equal(preview.scopeVerification,'full');await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.equal(f.saved.documents.siteAnnotations['target.example'].library.favorite,true);assert.deepEqual(f.saved.documents.siteAnnotations['target.example'].library.groups,['high_quality']);assert.equal(f.saved.documents.submissionRecords['target.example::p'].evidence,'Original receipt');assert.equal(f.saved.documents.submissionRecords['older.example::p'].evidence,'Older receipt');assert.deepEqual([await fileDigest(f.file),await fileDigest(database)],before);assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-boundary');assert.equal(f.runtime.store.get('paused'),true);
 }finally{await f.close();}
});

test('genuine standalone legacy JSON remains explicitly unscoped and restores without inventing a workspace',async()=>{
 const f=await fixture();try{
  await writeFile(f.file,JSON.stringify({...legacy(),pair:{deviceToken:'DO_NOT_IMPORT'}}));const value=await readLocalRecoverySource(f.runtime,f.file);assert.equal(value.scopeVerified,false);assert.equal(value.scopeVerification,'unscoped');const preview=await prepare(f);assert.equal(preview.scopeVerification,'unscoped');await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.equal(f.saved.documents.siteAnnotations['target.example'].library.favorite,true);assert.equal(f.runtime.store.get('pair').deviceToken,'PRIVATE_FIXTURE_TOKEN');assert.equal(f.saved.documents.pair,undefined);
 }finally{await f.close();}
});

test('JSON cannot contradict companion identity or bypass a conflicting second SQLite, stale database scope or nonempty WAL',async()=>{
 const f=await fixture();try{
  const current=f.runtime.store.get('pair'),database=await companion(f,{...current,workspaceId:'other'});await assert.rejects(readLocalRecoverySource(f.runtime,f.file),/标识不一致/);
  await companion(f);await companion(f,{...current,workspaceId:'other'},{file:'before.sqlite'});await assert.rejects(readLocalRecoverySource(f.runtime,f.file),/标识不一致/);await rm(join(dirname(f.file),'before.sqlite'));
  await companion(f,current,{scope:workbenchScope({...current,workspaceId:'other'})});await assert.rejects(readLocalRecoverySource(f.runtime,f.file),/快照与连接/);await companion(f);await writeFile(database+'-wal','unmerged-original');await assert.rejects(readLocalRecoverySource(f.runtime,f.file),/未合入日志/);assert.equal(f.writes.length,0);
 }finally{await f.close();}
});

test('companion deletion or identity changes after preview stop recovery before writing and retain the original plan',async()=>{
 const f=await fixture();try{
  await writeFile(f.file,JSON.stringify({documents:legacy()}));const database=await companion(f);let preview=await prepare(f);await rm(database);await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/来源已经变化/);assert.equal(f.runtime.store.get('localRecoveryPlan:'+preview.id).status,'preview');await companion(f);preview=await prepare(f);await companion(f,{...f.runtime.store.get('pair'),workspaceId:'other'});await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/其他工作区/);assert.equal(f.writes.length,0);assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-boundary');
 }finally{await f.close();}
});

test('source changes during cloud comparison stop before the first restore write while retaining the verified local backup',async()=>{
 const f=await fixture();try{const preview=await prepare(f),original=f.runtime.cloud.request;f.runtime.cloud.request=async(...args)=>{const result=await original(...args);if(args[0]==='snapshot')await writeFile(f.file,JSON.stringify({documents:{...legacy(),cfgName:'Changed during backup'}}));return result;};
 await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/来源在备份期间变化/);assert.equal(f.writes.length,0);const plan=f.runtime.store.get('localRecoveryPlan:'+preview.id);assert.equal(plan.status,'preview');assert.ok(plan.backupDirectory);assert.equal((await stat(join(plan.backupDirectory,'outbox.sqlite'))).isFile(),true);
 }finally{await f.close();}
});
test('explicitly keeping a cloud version records an exclusion instead of claiming that document was restored',async()=>{
 const f=await fixture();try{const preview=await prepare(f);let first=true;f.runtime.afterWrite=async()=>{if(first){first=false;throw Error('Reply lost');}};await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});f.saved.documents.siteAnnotations={'remote.example':{note:'New remote change'}};f.saved.revisions.siteAnnotations++;
 let result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.ok(result.remaining);const item=f.runtime.store.values('appMutation:').find(i=>i.key==='siteAnnotations');assert.equal(item.status,'conflict');await resolveApplicationConflict(f.runtime,{id:item.id,choice:'cloud',revision:f.saved.revisions.siteAnnotations});result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.equal(result.remaining,0);assert.equal(result.status,'completed_with_exclusions');assert.deepEqual(result.excludedKeys,['siteAnnotations']);assert.equal(f.saved.documents.siteAnnotations['remote.example'].note,'New remote change');assert.equal(f.saved.documents.submissionRecords['target.example::p'].evidence,'Original receipt');
 }finally{await f.close();}
});
test('local recovery accepts original state keys, omits credentials and batch state, and preserves original receipt, timeline and media history',()=>{
 const raw={...legacy(),pair:{deviceToken:'SECRET'},activeBatchRun:{cursor:99},cloudSyncConfig:{accessToken:'SECRET'}};
 const docs=localRecoveryDocuments(raw);assert.equal(docs.pair,undefined);assert.equal(docs.activeBatchRun,undefined);assert.equal(docs.cloudSyncConfig,undefined);
 const records=recoveryDocument(base(),'submissionRecords',docs.submissionRecords);assert.deepEqual(records['target.example::p'],base().submissionRecords['target.example::p']);assert.equal(records['older.example::p'].status,'success');
 const profiles=recoveryDocument(base(),'siteProfiles',docs.siteProfiles);assert.deepEqual(profiles.p.mediaVersions.map(v=>v.assetId),['new','old']);assert.equal(profiles.p.learnedFieldMappings['#name'],'Name');assert.equal(recoveryDocument(base(),'timelineSchemaVersion',1),3);
 assert.throws(()=>recoveryDocument(base(),'siteProfiles',{p:{...docs.siteProfiles.p,mediaVersions:[{assetId:'new',sha256:'conflicting-hash'}]}}),/内容不一致/);
 const event={id:'receipt-event',destinationKey:'target.example',profileId:'p',occurredAt:'2026-10-01T00:00:00Z',type:'submitted',note:'Original note'};
 const identicalTimeline={'target.example::p':[{...event,oldFields:{retained:true}}]};assert.deepEqual(recoveryDocument({submissionTimeline:identicalTimeline},'submissionTimeline',identicalTimeline),identicalTimeline);
 const timeline=recoveryDocument({submissionTimeline:{'target.example::p':[event]}},'submissionTimeline',{'target.example::p':[{...event,note:'Old changed note'},{...event,id:'older-event',occurredAt:'2026-09-30T00:00:00Z'}]});assert.equal(timeline['target.example::p'].length,2);assert.equal(timeline['target.example::p'].find(e=>e.id===event.id).note,'Original note');
 for(const bad of [{siteProfiles:{}},{...legacy(),selectedSiteIds:'p'},{...legacy(),targetFilters:[]},{...legacy(),autoSubmitDirectoryListings:'yes'},JSON.parse('{"siteProfiles":{"p":{"id":"p","__proto__":{"polluted":true}}}}')])assert.throws(()=>localRecoveryDocuments(bad));assert.throws(()=>recoveryDocument(base(),'pair',{}),/未授权/);
});
test('catalogue exposes only summaries, captures the original cache before cloud refresh and rejects foreign sources',async()=>{
 const f=await fixture();try{const scope=workbenchScope(f.runtime.store.get('pair'));f.runtime.store.set('applicationSnapshot',{scope,snapshot:{documents:legacy(),revisions:{}},at:'original-cache-time'});await mkdir(join(f.runtime.backupRoot,'foreign'));await writeFile(join(f.runtime.backupRoot,'foreign','snapshot.json'),JSON.stringify({workspaceId:'other',documents:legacy()}));
 const listing=await localRecoverySources(f.runtime);assert.equal(JSON.stringify(listing).includes('PRIVATE_FIXTURE_TOKEN'),false);assert.equal(JSON.stringify(listing).includes('Original local note'),false);assert.ok(listing.sources.some(s=>s.label.startsWith('本机缓存资料')&&s.scopeVerified));assert.match(listing.sources.find(s=>s.unavailable).error,/其他工作区/);
 const source=listing.sources.find(s=>s.label.startsWith('本机缓存资料')),preview=await previewLocalRecovery(f.runtime,{sourceId:source.id});assert.ok(preview.preview.changes.includes('siteAnnotations'));assert.equal(f.runtime.store.get('applicationSnapshot').snapshot.documents.siteProfiles.p.name,'Current');assert.equal(f.runtime.store.get('localRecoveryPlan:'+preview.preview.id).documents.siteProfiles.p.name,'Original local');assert.equal(f.writes.length,0);
 }finally{await f.close();}
});
test('lost cloud reply and SQLite restart continue the exact recovery plan after verified backup, without replaying writes or releasing submission',async()=>{
 const f=await fixture();try{const preview=await prepare(f);let first=true;f.runtime.afterWrite=async()=>{if(first){first=false;throw Error('Lost reply after commit');}};
 let result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.ok(result.remaining);const plan=f.runtime.store.get('localRecoveryPlan:'+preview.id),ids=f.runtime.store.get('applicationPlan:'+plan.applicationPlanId).items.map(i=>i.id);const originalReceipt=base().submissionRecords['target.example::p'];assert.deepEqual(f.saved.documents.submissionRecords['target.example::p'],originalReceipt);
 await f.reopen();assert.equal(localRecoveryPlans(f.runtime)[0].id,preview.id);result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.equal(result.remaining,0);assert.equal(f.writes.length,new Set(f.writes).size);assert.deepEqual(f.runtime.store.get('applicationPlan:'+plan.applicationPlanId).items.map(i=>i.id),ids);assert.equal(f.saved.documents.siteAnnotations['target.example'].library.favorite,true);assert.deepEqual(f.saved.documents.siteProfiles.p.mediaVersions.map(v=>v.assetId),['new','old']);assert.deepEqual(f.saved.documents.submissionRecords['target.example::p'],originalReceipt);assert.equal(f.runtime.store.get('acceptanceBatch').cursor,13);assert.equal(f.runtime.store.get('paused'),true);assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-boundary');assert.equal(f.runtime.store.get('pair').deviceToken,'PRIVATE_FIXTURE_TOKEN');
 const backup=new Store(join(plan.backupDirectory,'outbox.sqlite'),{readOnly:true});try{assert.equal(backup.get('acceptanceBatch').cursor,13);assert.equal(backup.get('task:unknown').attemptBoundary,'original-boundary');}finally{backup.close();}
 const before=f.writes.length;await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});assert.equal(f.writes.length,before);
 }finally{await f.close();}
});
test('source changes, reviewed remote changes, invalid selection and concurrent activity reject before any restore write',async()=>{
 const f=await fixture();try{let preview=await prepare(f);await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'yes'}),/确认文字/);await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation,keys:['pair']}),/请选择/);
 await writeFile(f.file,JSON.stringify({documents:{...legacy(),cfgName:'Changed source'}}));await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/来源已经变化/);preview=await prepare(f);f.saved.revisions.siteAnnotations++;await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/云端已变化/);
 preview=await prepare(f);f.runtime.store.set('browserAssistantSettings',{enabled:true});await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/关闭自动填写/);f.runtime.store.set('browserAssistantSettings',{enabled:false});f.runtime.store.set('manualWatch:live',{status:'checking'});await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/监听/);f.runtime.store.set('manualWatch:live',{status:'cancelled'});
 const originalRequest=f.runtime.cloud.request;let release;f.runtime.cloud.request=async(...args)=>{if(args[0]==='snapshot')await new Promise(resolve=>release=resolve);return originalRequest(...args);};const original=recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(release);assert.throws(()=>recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/已有本机恢复/);f.runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'other'});release();await assert.rejects(original,/工作区已切换/);assert.equal(f.writes.length,0);assert.equal(f.runtime.store.get('localRecoveryPlan:'+preview.id).status,'preview');
 }finally{await f.close();}
});

test('paused original recovery joins an existing sync writer and continues the same saved plan without duplicate writes',async()=>{
 const f=await fixture();try{
  const preview=await prepare(f),request=f.runtime.cloud.request;let failOnce=true;
  f.runtime.cloud.request=async(...args)=>{if(args[0]==='library'&&failOnce){failOnce=false;throw Error('Cloud HTTP 503');}return request(...args);};
  const first=await recoverLocalDocuments(f.runtime,{id:preview.id,keys:['siteAnnotations'],confirmation});assert.equal(first.remaining,1);
  const plan=f.runtime.store.get('localRecoveryPlan:'+preview.id),ids=f.runtime.store.get('applicationPlan:'+plan.applicationPlanId).items.map(item=>item.id);let release,finished=false;
  f.runtime.job=new Promise(resolve=>release=()=>{f.runtime.job=null;resolve();});
  const resumed=recoverLocalDocuments(f.runtime,{id:preview.id,keys:['siteAnnotations'],confirmation}).then(result=>{finished=true;return result;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(f.writes.length,0);assert.throws(()=>recoverLocalDocuments(f.runtime,{id:preview.id,confirmation}),/已有本机恢复/);
  release();const result=await resumed;assert.equal(result.remaining,0);assert.equal(result.status,'completed');assert.deepEqual(f.writes,ids);assert.equal(f.saved.documents.siteAnnotations['target.example'].library.favorite,true);
  assert.equal(f.runtime.store.get('localRecoveryPlan:'+preview.id).backupDirectory,plan.backupDirectory);assert.equal(f.runtime.store.get('paused'),true);assert.equal(f.runtime.store.get('acceptanceBatch').cursor,13);assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-boundary');assert.equal(f.runtime.store.pendingCount(),0);
 }finally{await f.close();}
});

test('waiting for original restore sync still rejects a new workspace before continuing the retained mutation',async()=>{
 const f=await fixture();try{
  const preview=await prepare(f),request=f.runtime.cloud.request;f.runtime.cloud.request=async(...args)=>{if(args[0]==='library')throw Error('Cloud HTTP 503');return request(...args);};
  assert.equal((await recoverLocalDocuments(f.runtime,{id:preview.id,keys:['siteAnnotations'],confirmation})).remaining,1);
  let release;f.runtime.job=new Promise(resolve=>release=()=>{f.runtime.job=null;resolve();});const resumed=recoverLocalDocuments(f.runtime,{id:preview.id,confirmation});
  f.runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'other'});release();await assert.rejects(resumed,/工作区已切换/);assert.equal(f.writes.length,0);assert.equal(f.runtime.store.get('localRecoveryPlan:'+preview.id).status,'queued');assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-boundary');
 }finally{await f.close();}
});
