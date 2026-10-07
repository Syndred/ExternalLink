import test from 'node:test';
import assert from 'node:assert/strict';
import {localRecoveryDocuments} from '../core/local-recovery.mjs';
import {applicationModel} from '../core/application-model.mjs';
import {originalProfileSource,originalLibraryCatalog} from './helpers/original-library-catalog.mjs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {applicationMutation} from '../core/application-mutation.mjs';
import {localRecoverySources,previewLocalRecovery,recoverLocalDocuments} from '../executor/src/local-recovery.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {resolveApplicationConflict} from '../executor/src/application-mutations.mjs';

const source=()=>({
 sheetTableData:{projects:{OldPhotoLive:{Name:'OldPhotoLive AI',Url:'https://old-photo.example',Pricing:'table'},TextComparison:{Name:'Comparison Text',Url:'https://comparison.example'}},entries:[{link:'https://target.example/submit',projects:['oldphotolive-ai'],time:'2026-09-20T12:00:00Z',note:'Original row note',rawFields:{Projects:'oldphotolive-ai'}}]},
 siteProfiles:{'oldphotolive-ai':{id:'oldphotolive-ai',name:'OldPhotoLive AI',source:'user',url:'https://owner-photo.example',fields:{Name:'Owner name',Pricing:'owner'},learnedFieldMappings:{'#name':'Name'},mediaVersions:[{assetId:'original-logo',kind:'logo',sha256:'original-hash'}]}},
 activeSiteId:'oldphotolive-ai',selectedSiteIds:['oldphotolive-ai','missing','oldphotolive-ai'],
 submissionRecords:{'target.example/submit::oldphotolive-ai':{destinationKey:'target.example/submit',destinationUrl:'https://target.example/submit',profileId:'oldphotolive-ai',taskId:'original-task',attemptBoundary:'original-attempt',status:'success',confirmedBy:'manual',evidence:'Original site receipt',submittedAt:'2026-09-20T12:00:00Z'}},
 submissionTimeline:{},siteAnnotations:{'target.example/submit':{library:{favorite:true,groups:['high_quality']},projects:['oldphotolive-ai'],formKnowledge:{name:'#name'}}},
 linkMonitorResults:{'target.example/submit::oldphotolive-ai':{status:'live',targetFound:true}},
});
test('table-only original sources restore product seeds and original current/batch defaults without changing the source',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,7)});
 const raw={sheetTableData:{projects:{OldPhotoLive:{Name:'OldPhotoLive AI',Url:'https://old-photo.example'}},entries:[{link:'https://target.example'}]}},before=structuredClone(raw),original=await originalProfileSource(raw),prepared=localRecoveryDocuments(raw);
 assert.deepEqual(prepared.siteProfiles,original.result.profiles);
 assert.equal(prepared.activeSiteId,original.result.activeSiteId);
 assert.deepEqual(prepared.selectedSiteIds,original.result.selectedSiteIds);
 assert.deepEqual(prepared.sheetTableData,raw.sheetTableData);
 assert.deepEqual(raw,before);
});
test('old profile aliases restore original product fields, choices, strong receipts, monitoring and original catalog history',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,7)});
 const raw=source(),before=structuredClone(raw),original=await originalProfileSource(raw),reference={...raw,linkMonitorResults:{'target.example/submit::OldPhotoLive':raw.linkMonitorResults['target.example/submit::oldphotolive-ai']}},catalog=await originalLibraryCatalog({documents:reference},{seedOriginalProfiles:true}),prepared=localRecoveryDocuments(raw);
 assert.deepEqual(prepared.siteProfiles,original.result.profiles);
 assert.equal(prepared.activeSiteId,original.result.activeSiteId);
 assert.deepEqual(prepared.selectedSiteIds,original.result.selectedSiteIds);
 const record=prepared.submissionRecords['target.example/submit::OldPhotoLive'];
 assert.equal(record.taskId,'original-task');assert.equal(record.attemptBoundary,'original-attempt');assert.equal(record.confirmedBy,'manual');assert.equal(record.evidence,'Original site receipt');
 assert.equal(prepared.linkMonitorResults['target.example/submit::OldPhotoLive'].status,'live');
 assert.deepEqual(prepared.siteAnnotations['target.example/submit'].projects,['OldPhotoLive']);
 assert.deepEqual(prepared.sheetTableData.entries[0].projects,['OldPhotoLive']);assert.deepEqual(prepared.sheetTableData.entries[0].sourceProjects,['oldphotolive-ai']);
 assert.deepEqual(prepared.sheetTableData.entries[0].rawFields,raw.sheetTableData.entries[0].rawFields);
 const model=applicationModel({documents:prepared}),normalize=p=>({...p,profileStates:[...p.profileStates].sort()});
 assert.deepEqual(normalize(model.library[0].progress),normalize(globalThis.ExtLinkSubmissionTimeline.deriveLibraryProgress(catalog.items[0])));
 assert.deepEqual(model.library[0].events.map(e=>e.id).sort(),catalog.items[0].events.map(e=>e.id).sort());
 assert.deepEqual(raw,before);assert.deepEqual(localRecoveryDocuments(prepared),prepared,'prepared sources are stable when reopened');
});
test('original source validation rejects malformed table profile seeds rather than accepting an empty replacement',()=>{
 for(const projects of [[],{constructor:{Name:'unsafe'}},{'bad id':{Name:'invalid'}},{p:null}])assert.throws(()=>localRecoveryDocuments({sheetTableData:{projects,entries:[]}}));
});
test('source alias collisions retain strong original receipts and all immutable media versions; conflicting versions stop recovery',()=>{
 const raw=source();raw.siteProfiles.OldPhotoLive={id:'OldPhotoLive',source:'table',fields:{Name:'Table copy'},mediaVersions:[{assetId:'second-logo',kind:'logo',sha256:'second-hash'}]};
 raw.submissionRecords['target.example/submit::OldPhotoLive']={...raw.submissionRecords['target.example/submit::oldphotolive-ai'],profileId:'OldPhotoLive',status:'failed',confirmedBy:'migration',evidence:'Weak seed'};
 const prepared=localRecoveryDocuments(raw),record=prepared.submissionRecords['target.example/submit::OldPhotoLive'];
 assert.equal(record.status,'success');assert.equal(record.confirmedBy,'manual');assert.equal(record.evidence,'Original site receipt');assert.equal(record.taskId,'original-task');
 assert.deepEqual(new Set(prepared.siteProfiles.OldPhotoLive.mediaVersions.map(a=>a.assetId)),new Set(['original-logo','second-logo']));
 const bad=structuredClone(raw);bad.siteProfiles.OldPhotoLive.mediaVersions[0]={assetId:'original-logo',kind:'logo',sha256:'conflicting'};assert.throws(()=>localRecoveryDocuments(bad),/素材编号内容不一致/);
 const monitoring=structuredClone(raw);monitoring.linkMonitorResults['target.example/submit::OldPhotoLive']={status:'missing'};assert.throws(()=>localRecoveryDocuments(monitoring),/监测记录/);
});
test('unchanged original profile identities still normalize stale current and repeated batch selections',async()=>{
 const raw={siteProfiles:{p:{id:'p',name:'Owner'}},activeSiteId:'missing',selectedSiteIds:['p','missing','p']},original=await originalProfileSource(raw),prepared=localRecoveryDocuments(raw);
 assert.equal(prepared.activeSiteId,original.result.activeSiteId);assert.deepEqual(prepared.selectedSiteIds,original.result.selectedSiteIds);assert.deepEqual(prepared.siteProfiles,raw.siteProfiles);
});
test('restored original product assignments select the canonical profile and keep source preferences recoverable',()=>{
 const raw=source();raw.siteAnnotations['target.example/submit'].library.profileIds=['oldphotolive-ai'];
 const prepared=localRecoveryDocuments(raw),mark=prepared.siteAnnotations['target.example/submit'];
 assert.deepEqual(mark.library.profileIds,['OldPhotoLive']);assert.deepEqual(mark.library.sourceProfileIds,['oldphotolive-ai']);assert.equal(mark.library.favorite,true);assert.deepEqual(mark.library.groups,['high_quality']);
 assert.equal(globalThis.ExtLinkLibraryClassifier.libraryEligibility(mark,'OldPhotoLive').allowed,true);assert.equal(globalThis.ExtLinkLibraryClassifier.libraryEligibility(mark,'TextComparison').allowed,false);assert.deepEqual(raw.siteAnnotations['target.example/submit'].library.profileIds,['oldphotolive-ai']);
});
test('legacy table and annotation seeds retain canonical history without creating an old-profile success or receipt',()=>{
 const raw=source();raw.submissionRecords={};raw.sheetTableData.entries[0].submitted=true;raw.siteAnnotations['target.example/submit'].submittedProjects=['oldphotolive-ai'];raw.siteAnnotations['target.example/submit'].updatedAt='2026-09-20T12:00:00Z';
 const prepared=localRecoveryDocuments(raw),records=prepared.submissionRecords;
 assert.ok(records['target.example/submit::OldPhotoLive']);assert.equal(records['target.example/submit::oldphotolive-ai'],undefined);assert.equal(records['target.example/submit::OldPhotoLive'].confirmedBy,'migration');assert.equal(globalThis.ExtLinkQueue.isSubmissionSuccessful(records,'target.example/submit','OldPhotoLive'),false);
 assert.deepEqual(prepared.siteAnnotations['target.example/submit'].submittedProjects,['OldPhotoLive']);assert.deepEqual(prepared.siteAnnotations['target.example/submit'].sourceSubmittedProjects,['oldphotolive-ai']);assert.equal(prepared.sheetTableData.entries[0].submitted,true);assert.deepEqual(raw.siteAnnotations['target.example/submit'].submittedProjects,['oldphotolive-ai']);
});

async function fixture(raw=source()){
 const home=await mkdtemp(join(tmpdir(),'el-profile-source-')),backupRoot=join(home,'backups'),folder=join(backupRoot,'original-source');await mkdir(folder,{recursive:true});
 let store=new Store(join(home,'outbox.sqlite'));store.set('pair',{endpoint:'https://fixture.example',workspaceId:'profile-source',deviceToken:'PRIVATE_SOURCE_FIXTURE'});store.set('paused',true);store.set('acceptanceBatch',{id:'fixed-original',status:'paused',cursor:13,count:30});store.set('task:unknown',{id:'unknown',profileId:'oldphotolive-ai',status:'submitted_unconfirmed',attemptBoundary:'original-attempt'});
 const file=join(folder,'snapshot.json'),bytes=JSON.stringify({scope:workbenchScope(store.get('pair')),documents:raw});await writeFile(file,bytes);
 const snapshot={documents:{siteProfiles:{},submissionRecords:{},submissionTimeline:{},sheetTableData:{entries:[]},siteAnnotations:{},activeSiteId:'',selectedSiteIds:[]},revisions:{}},writes=[];
 const runtime={home,backupRoot,store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0}),cloud:{async request(route,input){if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'library');const plan=runtime.store.values('localRecoveryPlan:').find(p=>p.applicationPlanId);assert.ok(plan?.backupDirectory);assert.ok(runtime.store.get('applicationPlan:'+plan.applicationPlanId));const change=applicationMutation(snapshot.documents,input.operation);assert.equal(input.revision,snapshot.revisions[change.key]||0);snapshot.documents[change.key]=change.data;snapshot.revisions[change.key]=(snapshot.revisions[change.key]||0)+1;writes.push(input.operation.id);await runtime.afterWrite?.(input);return{ok:true};}}};
 return{runtime,snapshot,file,bytes,writes,async preview(){const listing=await localRecoverySources(runtime),source=listing.sources.find(s=>s.label.startsWith('original-source'));assert.ok(source&&!source.unavailable);return(await previewLocalRecovery(runtime,{sourceId:source.id})).preview;},async reopen(){store.close();store=new Store(join(home,'outbox.sqlite'));runtime.store=store;},async close(){store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&basename(home).startsWith('el-profile-source-'));await rm(home,{recursive:true,force:true});}};
}
test('reviewed profile sources couple old identities and history, preserve raw local cache, and resume exact SQLite ids after a lost reply',async()=>{
 const f=await fixture();try{
  const scope=workbenchScope(f.runtime.store.get('pair'));f.runtime.store.set('applicationSnapshot',{scope,snapshot:{documents:source(),revisions:{siteProfiles:3}}});
  const preview=await f.preview();assert.ok(preview.dependencyKeys.includes('siteProfiles'));assert.ok(preview.dependencyKeys.includes('submissionRecords'));assert.ok(preview.dependencyKeys.includes('sheetTableData'));assert.equal(f.writes.length,0);
  const cache=(await readdir(f.runtime.backupRoot)).find(name=>name.startsWith('local-cache-')),original=JSON.parse(await readFile(join(f.runtime.backupRoot,cache,'snapshot.json'),'utf8'));
  assert.ok(original.documents.siteProfiles['oldphotolive-ai']);assert.equal(original.documents.siteProfiles.OldPhotoLive,undefined);assert.deepEqual(original.documents.sheetTableData.entries[0].projects,['oldphotolive-ai']);assert.equal(JSON.stringify(original).includes('PRIVATE_SOURCE_FIXTURE'),false);
  await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料',keys:['siteProfiles']}),/需要一起恢复/);assert.equal(f.writes.length,0);
  let lost=true;f.runtime.afterWrite=async()=>{if(lost){lost=false;throw Error('reply lost after durable commit');}};
  let result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'});assert.ok(result.remaining);
  const parent=f.runtime.store.get('localRecoveryPlan:'+preview.id),plan=f.runtime.store.get('applicationPlan:'+parent.applicationPlanId),ids=plan.items.map(i=>i.id);assert.equal(plan.kind,'profile_recovery');assert.equal(plan.items[0].key,'siteProfiles');assert.ok(plan.items.slice(1).every((item,i)=>item.dependsOn===ids[i]));
  await f.reopen();result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'});assert.equal(result.status,'completed');assert.equal(result.remaining,0);assert.deepEqual(f.runtime.store.get('applicationPlan:'+plan.id).items.map(i=>i.id),ids);assert.equal(f.writes.length,new Set(f.writes).size);
  assert.ok(f.snapshot.documents.siteProfiles.OldPhotoLive);assert.equal(f.snapshot.documents.activeSiteId,'OldPhotoLive');assert.deepEqual(f.snapshot.documents.selectedSiteIds,['OldPhotoLive']);assert.equal(f.snapshot.documents.submissionRecords['target.example/submit::OldPhotoLive'].taskId,'original-task');assert.equal(f.snapshot.documents.siteAnnotations['target.example/submit'].library.favorite,true);
  assert.equal(await readFile(f.file,'utf8'),f.bytes);assert.equal(f.runtime.store.get('acceptanceBatch').cursor,13);assert.equal(f.runtime.store.get('paused'),true);assert.equal(f.runtime.store.get('task:unknown').attemptBoundary,'original-attempt');
  const previous=f.writes.length;await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'});assert.equal(f.writes.length,previous);
 }finally{await f.close();}
});
test('keeping a concurrent cloud product cancels its coupled old-profile history without writing detached identities',async()=>{
 const f=await fixture();try{
  const preview=await f.preview(),request=f.runtime.cloud.request;f.runtime.cloud.request=async(route,...args)=>{if(route==='library')throw Error('offline before write');return request(route,...args);};await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'});
  f.runtime.cloud.request=request;const parent=f.runtime.store.get('localRecoveryPlan:'+preview.id),plan=f.runtime.store.get('applicationPlan:'+parent.applicationPlanId),profile=plan.items[0];f.snapshot.documents.siteProfiles={owner:{id:'owner',fields:{Name:'Concurrent owner'}}};f.snapshot.revisions.siteProfiles=1;
  await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'});assert.equal(f.runtime.store.get('appMutation:'+profile.id).status,'conflict');await resolveApplicationConflict(f.runtime,{id:profile.id,choice:'cloud',revision:1});
  const result=await recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'});assert.equal(result.status,'completed_with_exclusions');assert.equal(result.remaining,0);assert.equal(f.writes.length,0);assert.ok(plan.items.every(i=>f.runtime.store.get('appMutation:'+i.id).status==='discarded'));assert.ok(result.excludedKeys.includes('submissionRecords'));assert.equal(f.snapshot.documents.activeSiteId,'');assert.deepEqual(f.snapshot.documents.submissionRecords,{});assert.equal(await readFile(f.file,'utf8'),f.bytes);
 }finally{await f.close();}
});
test('failure to persist a coupled profile recovery child rolls back the parent and all mutations before network writes',async()=>{
 const f=await fixture();try{
  const preview=await f.preview(),set=f.runtime.store.set.bind(f.runtime.store);f.runtime.store.set=(key,value)=>{if(key.startsWith('appMutation:')&&value.key==='activeSiteId')throw Error('fixture persistence failed');return set(key,value);};
  await assert.rejects(recoverLocalDocuments(f.runtime,{id:preview.id,confirmation:'恢复所选本机资料'}),/persistence failed/);assert.equal(f.writes.length,0);assert.equal(f.runtime.store.values('applicationPlan:').length,0);assert.equal(f.runtime.store.values('appMutation:').length,0);assert.equal(f.runtime.store.get('localRecoveryPlan:'+preview.id).status,'preview');assert.equal(await readFile(f.file,'utf8'),f.bytes);
 }finally{await f.close();}
});
