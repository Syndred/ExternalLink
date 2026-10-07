import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {originalLibraryBatchScope} from '../core/library-batch-scope.mjs';
import {libraryRecords} from '../core/library-records.mjs';
import {batchManifest,batchScopeRows,batchJson,batchRunMetadata,validateBatchRunMetadata} from '../core/workbench-batch-recovery.mjs';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {previewWorkbenchBatch} from '../executor/src/workbench-features.mjs';
import {recoverCloudBatchRecords} from '../executor/src/workbench-batch-recovery.mjs';

const sha='bd916b2944a577b160a6afcb8a7d73d263044c0c',source=execFileSync('git',['show',sha+':extension/background.js'],{encoding:'utf8',maxBuffer:5*1024*1024}),migrated=readFileSync(new URL('../core/library-batch-scope.mjs',import.meta.url),'utf8');
function fn(text,name){const found=text.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^\\}','m'));if(!found)throw Error('original function missing '+name);return found[0];}
const names=['scopeDestinationGroupsByLibraryCategory','scopeDestinationGroupsByLibraryGroup','expandSubmissionRecordsForQueue'];
async function original(snapshot,input){
 const docs=snapshot.documents,self=Object.fromEntries(['Queue','Profiles','LibraryClassifier','LibraryGroups','OpportunityScore','UrlLibrary'].map(key=>['ExtLink'+key,globalThis['ExtLink'+key]]));
 const context=vm.createContext({self,chrome:{storage:{local:{get:async()=>structuredClone(docs)}}},loadTableLibrary:async()=>structuredClone(docs.sheetTableData),ensureProfilesFromTable:async()=>({profiles:docs.siteProfiles,activeSiteId:docs.activeSiteId||'p',idRemap:{}}),ensureSubmissionSchema:async()=>libraryRecords(docs),canonicalDestinationKey:globalThis.ExtLinkQueue.normalizeLibraryDestinationKey,recordsForDestination:(records,key)=>Object.entries(records).filter(([,r])=>globalThis.ExtLinkQueue.normalizeLibraryDestinationKey(r.destinationKey||r.destinationUrl||'')===globalThis.ExtLinkQueue.normalizeLibraryDestinationKey(key)),options:{selectedProfileIds:input.profileIds,category:input.category,group:input.group}});
 return JSON.parse(JSON.stringify(await vm.runInContext(names.map(name=>fn(source,name)).join('\n')+'\n'+fn(source,'normalizeTargetFilters')+'\n'+fn(source,'loadPendingSubmissionTasks')+'\nloadPendingSubmissionTasks(options)',context)));
}
function snapshot(){return{revisions:{siteProfiles:2},documents:{siteProfiles:{p:{id:'p',name:'Original P',fields:{Name:'Original P',Url:'https://product-p.example'}},q:{id:'q',name:'Original Q',fields:{Name:'Original Q',Url:'https://product-q.example'}}},selectedSiteIds:['q','p'],activeSiteId:'p',sheetTableData:{entries:[{link:'https://first.example/form',category:'AI 工具目录',metrics:{dr:80,da:70},projects:['p']},{link:'https://second.example/form',category:'启动发布',metrics:{dr:90,da:80}},{link:'https://third.example/form',category:'AI 工具目录',metrics:{dr:50,da:40}}]},urlList:'https://saved.example/form\tSaved\tdirectory',siteAnnotations:{'third.example/form':{library:{groups:['free_submit'],profileIds:['q']}}},submissionRecords:{},domainMetricsCache:{},targetFilters:{},linkMonitorResults:{}}};}
const taskShape=task=>({url:task.url,profileId:task.profileId,source:task.source,category:task.category,quality:task.quality,destinationGroupKey:task.destinationGroupKey,groupJobIndex:task.groupJobIndex});

test('the original category and group scope functions are copied exactly from the pre-refactor baseline',()=>{for(const name of names)assert.equal(fn(migrated,name).replaceAll('\r\n','\n'),fn(source,name).replaceAll('\r\n','\n'));});

test('category and group queues match original functions including assignment, profile order, quality and compiled defaults',async()=>{
 for(const options of [{category:'AI 工具目录'},{category:'启动发布'},{group:'high_quality'},{group:'free_submit'},{category:'AI 工具目录',group:'high_quality'}]){
  const data=snapshot(),input={profileIds:['q','p'],...options},before=JSON.stringify(data),reference=await original(data,input),actual=originalLibraryBatchScope(data,input);
  assert.deepEqual(actual.tasks.map(taskShape),reference.tasks.map(taskShape),JSON.stringify(options));assert.equal(actual.meta.total,reference.meta.total);assert.equal(actual.meta.beforeFilter,reference.meta.beforeFilter);assert.deepEqual(actual.selectedProfileIds,reference.selectedProfileIds);assert.equal(JSON.stringify(data),before);
 }
});

test('original receipt aliases, explicit group removals, age blacklist and quality gates survive scoped queue selection',async()=>{
 const data=snapshot();data.documents.sheetTableData.entries.push({link:'https://tipseason.com/old',category:'AI 工具目录',metrics:{dr:90,da:90}});
 data.documents.submissionRecords={'tipseason.com::p':{profileId:'p',destinationKey:'tipseason.com',destinationUrl:'https://tipseason.com/another',status:'success',confirmedBy:'manual',evidence:'Original historical receipt'}};
 data.documents.siteAnnotations['second.example/form']={library:{groups:[]}};data.documents.targetFilters={blacklistEnabled:true,minDomainAgeMonths:12,requireKnownDomainAge:true,minOpportunityScore:40};data.documents.domainBlacklist=['first.example'];data.documents.domainMetricsCache={'third.example':{ageMonths:5},'tipseason.com':{ageMonths:30}};
 for(const options of [{category:'AI 工具目录'},{group:'high_quality'},{group:'free_submit'}]){const input={profileIds:['p','q'],...options},reference=await original(data,input),actual=originalLibraryBatchScope(data,input);assert.deepEqual(actual.tasks.map(taskShape),reference.tasks.map(taskShape));assert.equal(actual.meta.excluded,reference.meta.excluded);}
});

test('scoped preview freezes the original job sequence instead of expanding it into a different Cartesian scope',async()=>{
 const data=snapshot(),store=new Store(':memory:'),runtime=new Runtime(store,'isolated');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',true);Object.defineProperty(runtime,'cloud',{value:{request:async route=>route==='snapshot'?data:{tasks:[]}}});
 try{const originalScope=originalLibraryBatchScope(data,{profileIds:['q','p'],category:'AI 工具目录'}),result=await previewWorkbenchBatch(runtime,{profileIds:['q','p'],libraryScope:{kind:'category',value:'AI 工具目录'}});
  assert.deepEqual(result.batch.items.map(i=>[i.url,i.profileId]),originalScope.tasks.map(i=>[i.url,i.profileId]));assert.equal(result.batch.count,originalScope.tasks.length);assert.equal(result.batch.libraryScope.value,'AI 工具目录');assert.equal(result.batch.status,'preview');assert.equal(store.get('paused'),true);assert.equal(store.values('run:').length,0);
  await assert.rejects(previewWorkbenchBatch(runtime,{profileIds:['p'],urls:['https://first.example/form'],libraryScope:{kind:'category',value:'AI 工具目录'}}),/原分类或分组/);
 }finally{store.close();}
});

test('a complete original scoped range above five hundred keeps all identities with compact profiles and cloud recovery',async()=>{
 const data=snapshot();data.documents.sheetTableData.entries=Array.from({length:601},(_,n)=>({link:'https://large'+n+'.example/form',category:'AI 工具目录',metrics:{dr:80}}));data.documents.siteProfiles.p.fields.Description='Original profile '.repeat(1000);
 const store=new Store(':memory:'),runtime=new Runtime(store,'isolated');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',true);Object.defineProperty(runtime,'cloud',{value:{request:async route=>route==='snapshot'?data:{tasks:[]}}});
 try{const {batch}=await previewWorkbenchBatch(runtime,{profileIds:['p'],libraryScope:{kind:'category',value:'AI 工具目录'},config:{fillOnly:true}});assert.equal(batch.count,601);const manifest=batchManifest(batch);assert.equal(manifest.items[0].profile,undefined);assert.deepEqual(manifest.profileSnapshots.p,batch.items[0].profile);assert.equal(batchJson(batchScopeRows(manifest)),batchJson(batchScopeRows(batch)));assert.ok(JSON.stringify(manifest).length<JSON.stringify(batch).length/3);
  const anchor=batch.items[0];batch.cloudManifestTaskId=anchor.taskId;const run={id:anchor.runId,profileId:'p',tasks:[{id:anchor.taskId,url:anchor.url,destinationKey:anchor.destinationKey}],...batchRunMetadata(batch,anchor)};await validateBatchRunMetadata(run,'default',async value=>createHash('sha256').update(value).digest('hex'));
  const tasks=batch.items.map(item=>({id:item.taskId,runId:item.runId,profileId:item.profileId,url:item.url,destinationKey:item.destinationKey,status:'pending'})),removed=store.db.prepare('DELETE FROM state WHERE id=?').run('workbenchBatch:'+batch.id),recovered=recoverCloudBatchRecords(runtime,[run],tasks)[0];assert.equal(recovered.count,601);assert.deepEqual(recovered.items.map(i=>i.taskId),batch.items.map(i=>i.taskId));assert.deepEqual(recovered.items[600].profile,batch.items[600].profile);assert.equal(recovered.libraryScope.value,'AI 工具目录');assert.equal(recovered.status,'paused');
 }finally{store.close();}
});

test('unknown category, unknown group and empty original queue reject without creating or replacing any batch',async()=>{
 const data=snapshot(),store=new Store(':memory:'),runtime=new Runtime(store,'isolated');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',true);store.set('workbenchBatch:original',{id:'original',status:'paused',count:9});Object.defineProperty(runtime,'cloud',{value:{request:async route=>route==='snapshot'?data:{tasks:[]}}});
 try{for(const scope of [{kind:'category',value:'invalid'},{kind:'group',value:'invalid'},{kind:'category',value:'设计 / 作品展示'}])await assert.rejects(previewWorkbenchBatch(runtime,{profileIds:['p'],libraryScope:scope}));assert.equal(store.values('workbenchBatch:').length,1);assert.equal(store.get('workbenchBatch:original').count,9);assert.equal(store.values('task:').length,0);}finally{store.close();}
});

test('another pending path on the same host stays excluded with its original reference instead of adopting mismatched recovery identities',async()=>{
 const data=snapshot(),store=new Store(':memory:'),runtime=new Runtime(store,'isolated');delete data.documents.siteAnnotations['third.example/form'];store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',true);
 const originalTask={id:'original-alias',runId:'original-run',profileId:'p',url:'https://first.example/old',destinationKey:'first.example/old',status:'pending'};store.set('task:'+originalTask.id,originalTask);
 Object.defineProperty(runtime,'cloud',{value:{request:async route=>route==='snapshot'?data:{tasks:[]}}});
 try{
  const {batch}=await previewWorkbenchBatch(runtime,{profileIds:['p'],libraryScope:{kind:'category',value:'AI 工具目录'}}),alias=batch.items.find(item=>item.url==='https://first.example/form'),anchor=batch.items.find(item=>item.status==='ready');
  assert.equal(alias.status,'excluded');assert.match(alias.reason,/其他入口/);assert.equal(alias.existingTask,false);assert.equal(alias.relatedOriginalTaskId,originalTask.id);assert.notEqual(alias.taskId,originalTask.id);assert.deepEqual(store.get('task:'+originalTask.id),originalTask);
  batch.cloudManifestTaskId=anchor.taskId;
  const run={id:anchor.runId,profileId:'p',tasks:[{id:anchor.taskId,url:anchor.url,destinationKey:anchor.destinationKey}],...batchRunMetadata(batch,anchor)};
  await validateBatchRunMetadata(run,'default',async value=>createHash('sha256').update(value).digest('hex'));
  store.db.prepare('DELETE FROM state WHERE id=?').run('workbenchBatch:'+batch.id);
  const recovered=recoverCloudBatchRecords(runtime,[run],[originalTask])[0];assert.equal(recovered.items.find(item=>item.taskId===alias.taskId).relatedOriginalTaskId,originalTask.id);assert.deepEqual(store.get('task:'+originalTask.id),originalTask);
 }finally{store.close();}
});

test('same-host duplicate previews keep unique frozen identities and stronger cloud boundaries prevent local pending task reuse',async()=>{
 const data=snapshot();data.documents.sheetTableData.entries.push({link:'https://first.example/another',category:'AI 工具目录'});
 const store=new Store(':memory:'),runtime=new Runtime(store,'isolated');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',true);
 const originalTask={id:'original-exact',runId:'original-run',profileId:'p',url:'https://first.example/form',destinationKey:'first.example/form',status:'pending'};store.set('task:'+originalTask.id,originalTask);let inventory=[];
 Object.defineProperty(runtime,'cloud',{value:{request:async route=>route==='snapshot'?data:{tasks:inventory}}});
 try{
  const {batch}=await previewWorkbenchBatch(runtime,{profileIds:['p'],urls:['https://first.example/form','https://first.example/another','https://third.example/form']});
  assert.equal(batch.items[0].taskId,originalTask.id);assert.equal(batch.items[0].existingTask,true);assert.equal(batch.items[1].status,'excluded');assert.notEqual(batch.items[1].taskId,originalTask.id);assert.equal(new Set(batch.items.map(item=>item.taskId)).size,batch.count);
  inventory=[{...originalTask,attemptBoundary:'cloud-unknown',status:'submitted_unconfirmed'}];
  const next=await previewWorkbenchBatch(runtime,{profileIds:['p'],libraryScope:{kind:'category',value:'AI 工具目录'}});assert.equal(next.batch.items.filter(item=>item.url.startsWith('https://first.example/')).every(item=>item.status==='excluded'&&!item.existingTask),true);assert.deepEqual(store.get('task:'+originalTask.id),originalTask);
 }finally{store.close();}
});
