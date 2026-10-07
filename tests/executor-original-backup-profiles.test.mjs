import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeApplicationBackup} from '../core/application-backup.mjs';
import {originalProfileSource} from './helpers/original-library-catalog.mjs';
import {Store} from '../executor/src/store.mjs';
import {applicationMutation} from '../core/application-mutation.mjs';
import {workbenchBackup} from '../executor/src/workbench-backup.mjs';
import {resolveApplicationConflict,flushApplicationMutations} from '../executor/src/application-mutations.mjs';
import {applicationData} from '../executor/src/application-data.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';

const backup=()=>({format:'externallink-submission-backup',version:2,siteProfiles:{'oldphotolive-ai':{id:'oldphotolive-ai',name:'OldPhotoLive AI',source:'user',fields:{Name:'Original owner',Url:'https://owner-photo.example'}}},activeSiteId:'oldphotolive-ai',selectedSiteIds:['oldphotolive-ai'],sheetTableData:{projects:{OldPhotoLive:{Name:'OldPhotoLive AI',Url:'https://table-photo.example'},TextComparison:{Name:'Comparison Text',Url:'https://comparison.example'}},entries:[{link:'https://old-target.example/form',projects:['oldphotolive-ai'],time:'2026-09-20T12:00:00Z',note:'Original source history',rawFields:{Projects:'oldphotolive-ai'}}]},submissionRecords:{'old-target.example/form::oldphotolive-ai':{profileId:'oldphotolive-ai',destinationKey:'old-target.example/form',destinationUrl:'https://old-target.example/form',taskId:'original-source-task',status:'success',confirmedBy:'manual',evidence:'Original historical site receipt',submittedAt:'2026-09-20T12:00:00Z'}},siteAnnotations:{'old-target.example/form':{library:{favorite:true,groups:['high_quality'],profileIds:['oldphotolive-ai']}}}});
test('original-format backup merges restore table seeds, stable profile identities and source history while keeping current rows and receipts',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,7)});
 const raw=backup(),before=structuredClone(raw),current={siteProfiles:{p:{id:'p',name:'Current product'}},submissionRecords:{opaque:{status:'success',confirmedBy:'manual',evidence:'Protected opaque original'}},sheetTableData:{projects:{p:{Name:'Current product'}},entries:[{link:'https://current-target.example'}]}},merged=mergeApplicationBackup(current,raw),reference=await originalProfileSource({...globalThis.ExtLinkBackup.mergeBackup(current,raw,2),sheetTableData:raw.sheetTableData});
 assert.ok(merged.siteProfiles.TextComparison);assert.ok(merged.siteProfiles.OldPhotoLive);assert.equal(merged.siteProfiles['oldphotolive-ai'],undefined);assert.ok(merged.siteProfiles.p);
 assert.deepEqual(merged.siteProfiles.OldPhotoLive,reference.result.profiles.OldPhotoLive);assert.equal(merged.activeSiteId,'OldPhotoLive');assert.deepEqual(merged.selectedSiteIds,['OldPhotoLive']);assert.equal(merged.submissionRecords['old-target.example/form::OldPhotoLive'].taskId,'original-source-task');assert.equal(merged.submissionRecords.opaque.evidence,'Protected opaque original');
 assert.deepEqual(merged.sheetTableData.entries.map(r=>r.link),['https://current-target.example','https://old-target.example/form']);assert.ok(merged.sheetTableData.projects.p);assert.equal(merged.siteAnnotations['old-target.example/form'].library.profileIds[0],'OldPhotoLive');assert.ok(Object.values(merged.submissionTimeline).flat().some(e=>e.profileId==='OldPhotoLive'&&e.note.includes('Original source history')));assert.deepEqual(raw,before);
});
function fixture(database=':memory:'){
 const store=new Store(database);store.set('pair',{endpoint:'https://fixture.example',workspaceId:'backup-profiles'});store.set('paused',true);store.set('acceptanceBatch',{id:'original-fixed',status:'paused',cursor:13,count:30});
 const snapshot={documents:{siteProfiles:{p:{id:'p',name:'Current product',fields:{Name:'Current product'}}},submissionRecords:{'protected.example::p':{taskId:'current-task',profileId:'p',destinationKey:'protected.example',destinationUrl:'https://protected.example',status:'success',confirmedBy:'manual',evidence:'Current strong site receipt'}},siteAnnotations:{},sheetTableData:{entries:[{link:'https://current-target.example'}]},submissionTimeline:{},activeSiteId:'p',selectedSiteIds:['p']},revisions:{siteProfiles:1,submissionRecords:1,sheetTableData:1}},writes=[];
 const runtime={store,status:()=>({paused:true,busy:false,pendingEvents:0,tasks:[]}),cloud:{async request(route,input){if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'library');const change=applicationMutation(snapshot.documents,input.operation);assert.equal(input.revision,snapshot.revisions[change.key]||0);snapshot.documents[change.key]=change.data;snapshot.revisions[change.key]=(snapshot.revisions[change.key]||0)+1;writes.push(input.operation);await runtime.afterWrite?.(input);return{ok:true};}}};return{runtime,snapshot,writes};
}
test('backup preview and actual per-key import restore the same seeded products and canonical history after a lost reply',async()=>{
 const f=fixture();try{
  const raw=backup(),preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:raw})).preview;assert.equal(f.writes.length,0);assert.equal(preview.profilesPrepared,2);let lost=true;f.runtime.afterWrite=async()=>{if(lost){lost=false;throw Error('lost response after commit');}};
  let result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.ok(result.remaining);const parent=f.runtime.store.get('backupImport:'+preview.id),ids=[...parent.items];result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed');assert.equal(result.remaining,0);assert.deepEqual(f.runtime.store.get('backupImport:'+preview.id).items,ids);assert.equal(f.writes.length,new Set(f.writes.map(o=>o.id)).size);
  assert.ok(f.snapshot.documents.siteProfiles.TextComparison);assert.equal(f.snapshot.documents.siteProfiles['oldphotolive-ai'],undefined);assert.equal(f.snapshot.documents.submissionRecords['old-target.example/form::OldPhotoLive'].taskId,'original-source-task');assert.equal(f.snapshot.documents.submissionRecords['protected.example::p'].taskId,'current-task');assert.equal(f.snapshot.documents.activeSiteId,'OldPhotoLive');assert.deepEqual(f.snapshot.documents.selectedSiteIds,['OldPhotoLive']);assert.deepEqual(f.runtime.store.get('backupImport:'+preview.id).backup,raw);assert.equal(f.runtime.store.get('paused'),true);assert.equal(f.runtime.store.get('acceptanceBatch').cursor,13);
 }finally{f.runtime.store.close();}
});
test('table-only backups expose recovered source products and import both seeds without counting legacy flags as receipts',async()=>{
 const f=fixture();try{
  const raw=backup();raw.siteProfiles={};raw.activeSiteId='';raw.selectedSiteIds=[];raw.submissionRecords={};raw.sheetTableData.entries[0].projects=['OldPhotoLive'];raw.sheetTableData.entries[0].submitted=true;
  const preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:raw})).preview;assert.equal(preview.profilesImported,0);assert.equal(preview.profilesPrepared,2);assert.equal(f.writes.length,0);
  const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed');assert.ok(f.snapshot.documents.siteProfiles.OldPhotoLive);assert.ok(f.snapshot.documents.siteProfiles.TextComparison);assert.ok(f.snapshot.documents.siteProfiles.p);const record=f.snapshot.documents.submissionRecords['old-target.example/form::OldPhotoLive'];assert.equal(record.confirmedBy,'migration');assert.equal(globalThis.ExtLinkQueue.isSubmissionSuccessful(f.snapshot.documents.submissionRecords,'old-target.example/form','OldPhotoLive'),false);assert.equal(f.snapshot.documents.submissionRecords['protected.example::p'].taskId,'current-task');
 }finally{f.runtime.store.close();}
});
async function queued(f,raw=backup()){
 const preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:raw})).preview,request=f.runtime.cloud.request;f.runtime.cloud.request=async(route,...args)=>{if(route==='library')throw Error('fixture offline before write');return request(route,...args);};
 const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.ok(result.remaining);f.runtime.cloud.request=request;return{preview,plan:f.runtime.store.get('backupImport:'+preview.id)};
}
test('keeping a concurrent cloud product excludes related backup history while independent settings still merge',async()=>{
 const f=fixture();try{
  const raw=backup();raw.cfgName='Original independent contact';const {preview,plan}=await queued(f,raw),head=f.runtime.store.get('appMutation:'+plan.items[0]);assert.equal(head.key,'siteProfiles');
  f.snapshot.documents.siteProfiles.p.fields.Name='Concurrent cloud owner';f.snapshot.revisions.siteProfiles++;await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(f.runtime.store.get('appMutation:'+head.id).status,'conflict');
  await resolveApplicationConflict(f.runtime,{id:head.id,choice:'cloud',revision:f.snapshot.revisions.siteProfiles});const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed_with_exclusions');assert.ok(result.excludedKeys.includes('submissionRecords'));assert.ok(result.excludedKeys.includes('sheetTableData'));assert.equal(f.snapshot.documents.siteProfiles.OldPhotoLive,undefined);assert.equal(f.snapshot.documents.submissionRecords['old-target.example/form::OldPhotoLive'],undefined);assert.equal(f.snapshot.documents.siteProfiles.p.fields.Name,'Concurrent cloud owner');assert.equal(f.snapshot.documents.cfgName,'Original independent contact');assert.equal(f.writes.filter(o=>plan.dependencyKeys.includes(o.key)).length,0);
 }finally{f.runtime.store.close();}
});
test('ordinary new backup products also couple their current and batch selections when cloud conflict keeps them excluded',async()=>{
 const f=fixture();try{
  const raw={format:'externallink-submission-backup',siteProfiles:{q:{id:'q',name:'Ordinary new site'}},submissionRecords:{},activeSiteId:'q',selectedSiteIds:['q']},queuedPlan=await queued(f,raw),head=f.runtime.store.get('appMutation:'+queuedPlan.plan.items[0]);
  assert.ok(queuedPlan.plan.dependencyKeys.includes('activeSiteId'));assert.ok(queuedPlan.plan.dependencyKeys.includes('selectedSiteIds'));f.snapshot.documents.siteProfiles.p.fields.Name='Cloud owner';f.snapshot.revisions.siteProfiles++;
  await workbenchBackup(f.runtime,'importBackup',{id:queuedPlan.preview.id});await resolveApplicationConflict(f.runtime,{id:head.id,choice:'cloud',revision:f.snapshot.revisions.siteProfiles});const result=await workbenchBackup(f.runtime,'importBackup',{id:queuedPlan.preview.id});assert.equal(result.status,'completed_with_exclusions');assert.equal(f.snapshot.documents.siteProfiles.q,undefined);assert.equal(f.snapshot.documents.activeSiteId,'p');assert.deepEqual(f.snapshot.documents.selectedSiteIds,['p']);assert.ok(result.excludedKeys.includes('activeSiteId'));assert.ok(result.excludedKeys.includes('selectedSiteIds'));
 }finally{f.runtime.store.close();}
});
test('local conflict choice applies the original frozen import changes while retaining newer cloud products, receipts, rows and media',async()=>{
 const f=fixture();try{
  const raw=backup();raw.siteProfiles.p={id:'p',fields:{Name:'Imported name'},mediaVersions:[{assetId:'imported-asset',kind:'logo',sha256:'imported-hash'}]};const {preview,plan}=await queued(f,raw),head=f.runtime.store.get('appMutation:'+plan.items[0]),originalOperations=plan.items.map(id=>f.runtime.store.get('appMutation:'+id).operation);
  f.snapshot.documents.siteProfiles.p.fields.Name='Concurrent cloud name';f.snapshot.documents.siteProfiles.p.mediaVersions=[{assetId:'cloud-asset',kind:'logo',sha256:'cloud-hash'}];f.snapshot.documents.siteProfiles.newCloud={id:'newCloud',name:'Added on cloud'};f.snapshot.revisions.siteProfiles++;
  f.snapshot.documents.submissionRecords['new-receipt.example::p']={taskId:'new-cloud-task',profileId:'p',destinationKey:'new-receipt.example',destinationUrl:'https://new-receipt.example',status:'success',confirmedBy:'manual',evidence:'New cloud receipt'};f.snapshot.revisions.submissionRecords=2;
  f.snapshot.documents.sheetTableData.entries.push({link:'https://new-cloud-target.example'});f.snapshot.revisions.sheetTableData=2;
  await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(f.runtime.store.get('appMutation:'+head.id).status,'conflict');await resolveApplicationConflict(f.runtime,{id:head.id,choice:'local',revision:f.snapshot.revisions.siteProfiles});
  for(let i=0;i<10;i++){const item=f.runtime.store.values('appMutation:').find(item=>item.status==='conflict');if(!item)break;await resolveApplicationConflict(f.runtime,{id:item.id,choice:'local',revision:f.snapshot.revisions[item.key]});}
  const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed');assert.equal(result.remaining,0);assert.equal(f.snapshot.documents.siteProfiles.p.fields.Name,'Imported name');assert.ok(f.snapshot.documents.siteProfiles.newCloud);assert.deepEqual(new Set(f.snapshot.documents.siteProfiles.p.mediaVersions.map(a=>a.assetId)),new Set(['cloud-asset','imported-asset']));assert.equal(f.snapshot.documents.submissionRecords['new-receipt.example::p'].taskId,'new-cloud-task');assert.ok(f.snapshot.documents.sheetTableData.entries.some(r=>r.link==='https://new-cloud-target.example'));assert.deepEqual(plan.items.map(id=>f.runtime.store.get('appMutation:'+id).operation),originalOperations);assert.equal(f.snapshot.documents.submissionRecords['protected.example::p'].taskId,'current-task');
 }finally{f.runtime.store.close();}
});
test('SQLite reopen restores a missing original import child and its dependency without duplicating a committed request',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-backup-profile-')),database=join(home,'outbox.sqlite'),f=fixture(database);try{
  const preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:backup()})).preview;let dropped=true;f.runtime.afterWrite=async()=>{if(dropped){dropped=false;throw Error('lost committed response');}};await workbenchBackup(f.runtime,'importBackup',{id:preview.id});const plan=f.runtime.store.get('backupImport:'+preview.id),ids=[...plan.items],missing=f.runtime.store.get('appMutation:'+ids[1]);f.runtime.store.db.prepare('DELETE FROM state WHERE id=?').run('appMutation:'+missing.id);
  f.runtime.store.close();f.runtime.store=new Store(database);const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed');assert.deepEqual(f.runtime.store.get('backupImport:'+preview.id).items,ids);assert.equal(f.runtime.store.get('appMutation:'+missing.id).dependsOn,plan.itemDependencies[missing.id]);assert.equal(f.writes.length,new Set(f.writes.map(o=>o.id)).size);assert.equal(f.runtime.store.get('acceptanceBatch').cursor,13);
 }finally{f.runtime.store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&basename(home).startsWith('el-backup-profile-'));await rm(home,{recursive:true,force:true});}
});
test('queued import dependency metadata repairs a saved child before direct cloud conflict resolution',async()=>{
 const f=fixture();try{
  const {preview,plan}=await queued(f),head=f.runtime.store.get('appMutation:'+plan.items[0]);for(const id of plan.items){const item=f.runtime.store.get('appMutation:'+id);delete item.dependsOn;f.runtime.store.set('appMutation:'+id,item);}
  f.snapshot.documents.siteProfiles.p.fields.Name='Cloud choice';f.snapshot.revisions.siteProfiles++;await flushApplicationMutations(f.runtime);assert.equal(f.runtime.store.get('appMutation:'+head.id).status,'conflict');await resolveApplicationConflict(f.runtime,{id:head.id,choice:'cloud',revision:f.snapshot.revisions.siteProfiles});const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed_with_exclusions');assert.ok(plan.dependencyKeys.every(key=>f.writes.filter(o=>o.key===key).length===0));assert.equal(f.snapshot.documents.submissionRecords['old-target.example/form::OldPhotoLive'],undefined);
 }finally{f.runtime.store.close();}
});
test('failure to persist an import child rolls back its parent and every mutation before a cloud request',async()=>{
 const f=fixture();try{
  const preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:backup()})).preview,set=f.runtime.store.set.bind(f.runtime.store);f.runtime.store.set=(id,value)=>{if(id.startsWith('appMutation:')&&value.key==='activeSiteId')throw Error('fixture persistence failed');return set(id,value);};await assert.rejects(workbenchBackup(f.runtime,'importBackup',{id:preview.id}),/persistence failed/);assert.equal(f.runtime.store.get('backupImport:'+preview.id).status,'preview');assert.equal(f.runtime.store.values('appMutation:').length,0);assert.equal(f.writes.length,0);
 }finally{f.runtime.store.close();}
});
test('parallel confirmations share one original import and expose its running state until the same operation finishes',async()=>{
 const f=fixture();try{
  const preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:backup()})).preview,request=f.runtime.cloud.request;let release,first=true;f.runtime.cloud.request=async(route,...args)=>{if(route==='snapshot'&&first){first=false;await new Promise(resolve=>release=resolve);}return request(route,...args);};
  const a=workbenchBackup(f.runtime,'importBackup',{id:preview.id}),b=workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.ok(release);assert.equal((await applicationData(f.runtime)).runtime.busy,true);release();const results=await Promise.all([a,b]);assert.equal(results[0].status,'completed');assert.deepEqual(results[1],results[0]);assert.equal(f.runtime.backupImportOperations.size,0);assert.equal(f.writes.length,new Set(f.writes.map(o=>o.id)).size);assert.equal(f.runtime.store.values('backupImport:').length,1);assert.equal((await applicationData(f.runtime)).runtime.busy,false);
 }finally{f.runtime.store.close();}
});
test('prepared import requests reject unsafe fields and invalid product maps without changing records',()=>{
 const current={siteProfiles:{p:{id:'p'}},submissionRecords:{protected:{status:'success'}}},before=structuredClone(current);
 for(const operation of [{key:'siteProfiles',patch:[{path:['__proto__','p'],value:{}}]},{key:'siteProfiles',profileIdMap:{p:'constructor'},patch:[]},{key:'siteProfiles',patch:[{path:[],value:{p:{id:'other'}}}]},{key:'activeSiteId',patch:[{path:[],value:[]}]}])assert.throws(()=>applicationMutation(current,{...operation,type:'backup_prepared_key',id:'invalid-fixture',at:'2026-10-07T00:00:00Z'}));assert.deepEqual(current,before);
});
test('separate backup imports retain sparse original task receipts exactly and accept only publication additions',async()=>{
 const f=fixture();try{
  const receipt={taskId:'current-task',profileId:'p',status:'success',evidence:'Original receipt',attemptId:'original-attempt',submittedAt:'2026-09-01T00:00:00Z'};f.snapshot.documents.submissionRecords['protected.example::p']=structuredClone(receipt);
  const prepared=mergeApplicationBackup(f.snapshot.documents,backup());assert.deepEqual(prepared.submissionRecords['protected.example::p'],receipt);
  const preview=(await workbenchBackup(f.runtime,'previewBackup',{backup:backup()})).preview,result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.status,'completed');assert.deepEqual(f.snapshot.documents.submissionRecords,prepared.submissionRecords);
  const operation={type:'backup_prepared_key',id:'publication-only',at:'2026-10-07T00:00:00Z',key:'submissionRecords',patch:[{path:['protected.example::p'],value:{taskId:'foreign-task',status:'success',evidence:'Foreign receipt',publicationStatus:'published',publicUrl:'https://protected.example/public',evidenceUrl:'https://protected.example/proof'}}]};const changed=applicationMutation(f.snapshot.documents,operation);
  assert.deepEqual(changed.data['protected.example::p'],{...receipt,publicationStatus:'published',publicUrl:'https://protected.example/public',evidenceUrl:'https://protected.example/proof'});
 }finally{f.runtime.store.close();}
});
test('prepared imports reject absent whole-field content rather than writing undefined documents',()=>{
 for(const key of ['siteProfiles','submissionRecords','siteAnnotations','sheetTableData','linkMonitorResults'])assert.throws(()=>applicationMutation({},{type:'backup_prepared_key',id:'missing-'+key,at:'2026-10-07T00:00:00Z',key,patch:[]}),error=>error.status===400&&/未包含/.test(error.message));
});
test('continuing an original queued import waits for its background flush and keeps the same mutations',async()=>{
 const f=fixture();try{
  const {preview,plan}=await queued(f),request=f.runtime.cloud.request;let release,first=true;f.runtime.cloud.request=async(route,...args)=>{if(route==='snapshot'&&first){first=false;await new Promise(resolve=>release=resolve);}return request(route,...args);};
  const flush=flushApplicationMutations(f.runtime);f.runtime.job=flush.finally(()=>f.runtime.job=null);const continuing=workbenchBackup(f.runtime,'importBackup',{id:preview.id}).then(value=>({value}),error=>({error}));assert.ok(release);release();await flush;const result=await continuing;assert.equal(result.error,undefined,result.error?.message);assert.equal(result.value.status,'completed');assert.deepEqual(f.runtime.store.get('backupImport:'+preview.id).items,plan.items);assert.equal(f.writes.length,new Set(f.writes.map(o=>o.id)).size);
 }finally{f.runtime.store.close();}
});
