import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {applicationMutation} from '../core/application-mutation.mjs';
import {exportApplicationBackup,mergeApplicationBackup} from '../core/application-backup.mjs';
import {workbenchBackup} from '../executor/src/workbench-backup.mjs';
import {startDomainAge} from '../executor/src/domain-age.mjs';
import {createHash} from 'node:crypto';
function fixture(){const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'test'});const snapshot={documents:{siteProfiles:{p:{id:'p',fields:{Name:'Original'},mediaVersions:[{assetId:'a',ref:'old'}]}},submissionRecords:{receipt:{status:'success',confirmedBy:'agent',evidence:'Received'}},submissionTimeline:{},sheetTableData:{entries:[{link:'https://old.example'}]},siteAnnotations:{}},revisions:{siteProfiles:1,submissionRecords:1,sheetTableData:1}};let lose=false,writes=0;const runtime={store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0}),cloud:{async request(route,input){if(route==='snapshot')return structuredClone(snapshot);if(route==='library'){writes++;const change=applicationMutation(snapshot.documents,input.operation);assert.equal(input.revision,snapshot.revisions[change.key]||0);snapshot.documents[change.key]=change.data;snapshot.revisions[change.key]=(snapshot.revisions[change.key]||0)+1;if(lose){lose=false;throw Error('Reply lost');}return{ok:true};}if(route==='ai/domain-metrics')return{ok:true,results:input.domains.map(domain=>({domain,status:'unknown',ageMonths:null,message:'Unavailable'}))};throw Error(route);}}};return{runtime,snapshot,get writes(){return writes;},loseNext(){lose=true;}};}
test('original-format backup merge retains strong receipts, existing targets and media history; excludes pairing credentials',()=>{
 const f=fixture(),original=f.snapshot.documents;original.pair={deviceToken:'DO NOT EXPORT'};const backup={format:'externallink-submission-backup',submissionRecords:{receipt:{status:'failed'},new:{status:'success'}},siteProfiles:{p:{id:'p',fields:{Name:'Restored'},mediaVersions:[{assetId:'b',ref:'new'}]}},sheetTableData:{entries:[{link:'https://new.example'}]}};
 const merged=mergeApplicationBackup(original,backup);assert.equal(merged.submissionRecords.receipt.status,'success');assert.equal(merged.siteProfiles.p.fields.Name,'Restored');assert.equal(merged.siteProfiles.p.mediaVersions.length,2);assert.equal(merged.sheetTableData.entries.length,2);assert.equal(exportApplicationBackup(original).pair,undefined);
 assert.throws(()=>mergeApplicationBackup(original,JSON.parse('{"format":"externallink-submission-backup","submissionRecords":{},"__proto__":{}}')),/不安全/);f.runtime.store.close();
});
test('backup preview writes nothing; lost cloud responses resume the exact durable mutations without discarding untouched data',async()=>{
 const f=fixture(),backup={format:'externallink-submission-backup',submissionRecords:{added:{status:'success',evidence:'Import'}},siteProfiles:{q:{id:'q',fields:{Name:'Imported'}}}};
 const preview=await workbenchBackup(f.runtime,'previewBackup',{backup});assert.equal(f.writes,0);f.loseNext();const first=await workbenchBackup(f.runtime,'importBackup',{id:preview.preview.id});assert.ok(first.remaining>0);const ids=f.runtime.store.get('backupImport:'+preview.preview.id).items;const second=await workbenchBackup(f.runtime,'importBackup',{id:preview.preview.id});assert.equal(second.status,'completed');assert.deepEqual(f.runtime.store.get('backupImport:'+preview.preview.id).items,ids);assert.equal(f.snapshot.documents.submissionRecords.receipt.status,'success');assert.equal(f.snapshot.documents.siteProfiles.p.fields.Name,'Original');assert.equal(f.snapshot.documents.siteProfiles.q.id,'q');assert.equal(f.snapshot.documents.submissionRecords.added.status,'success');f.runtime.store.close();
});
test('backup preview revision drift is rejected before any import write',async()=>{const f=fixture(),backup={format:'externallink-submission-backup',submissionRecords:{},siteProfiles:{q:{id:'q'}}};const preview=await workbenchBackup(f.runtime,'previewBackup',{backup});f.snapshot.revisions.siteProfiles++;await assert.rejects(workbenchBackup(f.runtime,'importBackup',{id:preview.preview.id}),/变化/);assert.equal(f.writes,0);f.runtime.store.close();});
test('an original queued backup plan without fragment metadata still resumes its original full-backup mutations',async()=>{
 const f=fixture();try{
  const backup={format:'externallink-submission-backup',submissionRecords:{added:{status:'success'}},siteProfiles:{q:{id:'q'}}},preview=await workbenchBackup(f.runtime,'previewBackup',{backup}),saved=f.runtime.store.get('backupImport:'+preview.preview.id);delete saved.operationFormat;f.runtime.store.set('backupImport:'+saved.id,saved);
  f.loseNext();const pending=await workbenchBackup(f.runtime,'importBackup',{id:saved.id});assert.ok(pending.remaining);const ids=f.runtime.store.get('backupImport:'+saved.id).items;
  assert.ok(f.runtime.store.values('appMutation:').every(item=>item.operation.type==='backup_merge'));
  const result=await workbenchBackup(f.runtime,'importBackup',{id:saved.id});assert.equal(result.status,'completed');assert.deepEqual(f.runtime.store.get('backupImport:'+saved.id).items,ids);assert.equal(f.snapshot.documents.submissionRecords.receipt.status,'success');assert.equal(f.snapshot.documents.siteProfiles.q.id,'q');
 }finally{f.runtime.store.close();}
});
test('backup import stores only each key fragment and preserves the complete original merge across all original documents',async()=>{
 const f=fixture();try{
  const backup={...exportApplicationBackup(f.snapshot.documents),siteProfiles:{q:{id:'q',fields:{Description:'large source '.repeat(10000)}}},selectedSiteIds:['q'],activeSiteId:'q',cfgName:'Imported default',domainBlacklist:['blocked.example'],targetFilters:{minDr:30},linkMonitorResults:{site:{status:'published'}}};
  const expected=mergeApplicationBackup(f.snapshot.documents,backup),preview=await workbenchBackup(f.runtime,'previewBackup',{backup});
  const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.preview.id});assert.equal(result.remaining,0);
  for(const key of preview.preview.changes)assert.deepEqual(f.snapshot.documents[key],expected[key],key);
  const items=f.runtime.store.values('appMutation:');assert.ok(items.every(i=>i.operation.type==='backup_prepared_key'));
  for(const item of items)if(item.key!=='siteProfiles')assert.ok(!JSON.stringify(item.operation).includes('large source '),'must not repeat another document data in each import item');
 }finally{f.runtime.store.close();}
});
test('backup import explicitly records excluded keys when conflict resolution keeps cloud content',async()=>{
 const f=fixture();try{
  const backup={format:'externallink-submission-backup',submissionRecords:{},siteProfiles:{q:{id:'q'}},cfgName:'Imported name'},preview=await workbenchBackup(f.runtime,'previewBackup',{backup});
  const request=f.runtime.cloud.request;f.runtime.cloud.request=async(...args)=>{if(args[0]==='library')throw Error('fixture offline before any write');return request(...args);};
  await workbenchBackup(f.runtime,'importBackup',{id:preview.preview.id});const plan=f.runtime.store.get('backupImport:'+preview.preview.id);f.runtime.cloud.request=request;
  const item=f.runtime.store.values('appMutation:').find(i=>i.key==='cfgName');assert.ok(item);f.runtime.store.set('appMutation:'+item.id,{...item,status:'discarded',resolution:{choice:'cloud'}});
  const result=await workbenchBackup(f.runtime,'importBackup',{id:plan.id});assert.equal(result.status,'completed_with_exclusions');assert.deepEqual(result.excludedKeys,['cfgName']);assert.equal(f.snapshot.documents.cfgName,undefined);
 }finally{f.runtime.store.close();}
});
test('chunked local backup staging resumes a stable source, validates full Unicode content and previews without cloud writes',async()=>{
 const f=fixture();try{
  const backup={format:'externallink-submission-backup',submissionRecords:{added:{status:'success'}},siteProfiles:{q:{id:'q',fields:{Description:'原资料😀'.repeat(800000)}}}},bytes=Buffer.from(JSON.stringify(backup)),sha256=createHash('sha256').update(bytes).digest('hex');
  assert.ok(bytes.length>8*1024*1024);
  const first=await workbenchBackup(f.runtime,'backupUploadStart',{sha256,bytes:bytes.length,name:'原插件大备份.json'});
  const upload=async index=>{const part=bytes.subarray(index*512*1024,Math.min((index+1)*512*1024,bytes.length));return workbenchBackup(f.runtime,'backupUploadPart',{id:first.upload.id,index,data:part.toString('base64'),sha256:createHash('sha256').update(part).digest('hex')});};
  await upload(0);const resumed=await workbenchBackup(f.runtime,'backupUploadStart',{sha256,bytes:bytes.length,name:'改名仍为同一文件.json'});assert.equal(resumed.upload.id,first.upload.id);assert.deepEqual(resumed.upload.present,[0]);
  await assert.rejects(workbenchBackup(f.runtime,'backupUploadComplete',{id:first.upload.id}),/未上传/);
  for(let i=1;i<Math.ceil(bytes.length/(512*1024));i++)await upload(i);
  const preview=await workbenchBackup(f.runtime,'backupUploadComplete',{id:first.upload.id});assert.equal(preview.preview.profilesImported,1);assert.equal(f.writes,0);
  const same=await workbenchBackup(f.runtime,'backupUploadComplete',{id:first.upload.id});assert.equal(same.preview.id,preview.preview.id);
  const saved=f.runtime.store.get('backupImport:'+preview.preview.id);assert.equal(saved.backup.siteProfiles.q.fields.Description,backup.siteProfiles.q.fields.Description);
  f.snapshot.revisions.siteProfiles++;const refreshed=await workbenchBackup(f.runtime,'backupUploadComplete',{id:first.upload.id});assert.notEqual(refreshed.preview.id,preview.preview.id,'a stale unconfirmed preview must be comparable again');assert.equal(f.runtime.store.get('backupImport:'+preview.preview.id).status,'superseded');
  f.runtime.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'other'});await assert.rejects(workbenchBackup(f.runtime,'backupUploadComplete',{id:first.upload.id}),/工作区|不存在/);
 }finally{f.runtime.store.close();}
});
test('domain prefetch checks every frozen domain in chunks and stores unknown as unknown',async()=>{const f=fixture();const result=await startDomainAge(f.runtime,{urls:Array.from({length:25},(_,i)=>'https://site'+i+'.example/path')});await f.runtime.domainAgeJob;const job=f.runtime.store.get('domainAgeJob:'+result.job.id);assert.equal(job.status,'completed');assert.equal(job.cursor,25);assert.equal(f.writes,2);assert.equal(Object.keys(f.snapshot.documents.domainMetricsCache).length,25);assert.equal(f.snapshot.documents.domainMetricsCache['site0.example'].ageMonths,null);assert.equal(f.snapshot.documents.domainMetricsCache['site0.example'].status,'unknown');assert.equal(f.runtime.store.values('task:').length,0);f.runtime.store.close();});
test('backup roundtrip preserves duplicate entrance rows and rows without a URL; immutable asset conflicts fail clearly',()=>{const f=fixture(),documents=f.snapshot.documents;documents.sheetTableData.entries.push({link:'https://old.example',note:'Separate original row'},{name:'Unresolved original row'});const backup=exportApplicationBackup(documents);assert.deepEqual(mergeApplicationBackup(documents,backup).sheetTableData,documents.sheetTableData);backup.siteProfiles.p.mediaVersions[0].ref='different';assert.throws(()=>mergeApplicationBackup(documents,backup),/不同内容/);assert.equal(globalThis.ExtLinkQueue.domainAgeGate('old.example',{minDomainAgeMonths:6,requireKnownDomainAge:true,domainMetrics:{'old.example':{ageMonths:null,status:'unknown'}}}),'domain_age_unknown');f.runtime.store.close();});
