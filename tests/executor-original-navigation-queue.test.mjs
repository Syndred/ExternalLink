import test from 'node:test';
import assert from 'node:assert/strict';
import * as queues from '../core/submission-queue.mjs';
import {originalLibraryBatchQueue,originalNavigationState,originalLibraryQuickOpen} from './helpers/original-library-catalog.mjs';
import {submissionQueue} from '../executor/src/submission-queue.mjs';
import {quickOpenLibrary} from '../executor/src/quick-open.mjs';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueLibraryMutation,overlayApplication} from '../executor/src/application-mutations.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const urls=['https://first.fixture.invalid/form','https://second.fixture.invalid/form'];
function snapshot(){return{documents:{siteProfiles:{p:{id:'p',name:'Original P',fields:{Name:'Original P',Url:'https://product.fixture.invalid'}},q:{id:'q',name:'Original Q',fields:{Name:'Original Q',Url:'https://other.fixture.invalid'}}},selectedSiteIds:['p','q'],activeSiteId:'p',urlList:'https://plugin.fixture.invalid/form',sheetTableData:{entries:urls.map((link,n)=>({link,note:'AI tool directory',metrics:{dr:n?40:95,da:n?30:90}}))},submissionRecords:{},domainBlacklist:[],targetFilters:{},cfgName:'Original contact',cfgEmail:'contact@fixture.invalid'},revisions:{siteProfiles:1,sheetTableData:1,urlList:1}};}
const fields=['id','key','destinationKey','url','domain','platformType','source','note','quality','status','index'];
const shape=group=>Object.fromEntries(fields.map(key=>[key,group[key]]));
const legacyJob=job=>{const {eligible,exclusionReason,...value}=job;const {mediaDisabled,...config}=value.config;assert.deepEqual(mediaDisabled,{});return{...value,config};};
const legacyTask=task=>{const {mediaDisabled,...config}=task.config;assert.deepEqual(mediaDisabled,{});return{...task,config};};
const originalMetadata=['gatedByBlacklist','gatedByDomainAge','gatedByQuality','fromTable','fromPlugin','beforeFilter','excluded','total','destinationTotal','category','group','selectedProfileTotal','successfulSkipped'];

test('navigation retains the complete frozen original source range, order, jobs and local contact configuration',async()=>{
 const saved=snapshot(),before=structuredClone(saved),expected=await originalLibraryBatchQueue(saved),actual=queues.originalNavigationQueue(saved);
 assert.ok(expected.groups.length>100);assert.deepEqual(actual.groups.map(shape),expected.groups.map(shape));
 for(let n=0;n<expected.groups.length;n++)assert.deepEqual(actual.groups[n].jobs.map(legacyJob),expected.groups[n].jobs);
 for(const key of originalMetadata)assert.deepEqual(actual.meta[key],expected.meta[key],key);assert.deepEqual(saved,before);
});

test('original browse range preserves quality and blacklist gated destinations with explicit current eligibility',async()=>{
 const saved=snapshot();saved.documents.domainBlacklist=['first.fixture.invalid'];saved.documents.targetFilters={minOpportunityScore:40};
 const expected=await originalLibraryBatchQueue(saved),actual=queues.originalNavigationQueue(saved);
 assert.deepEqual(actual.groups.map(shape),expected.groups.map(shape));for(const key of originalMetadata)assert.deepEqual(actual.meta[key],expected.meta[key],key);
 const blocked=actual.groups.find(group=>group.url===urls[0]);assert.ok(blocked);assert.equal(blocked.jobs.every(job=>job.eligible===false),true);assert.equal(blocked.jobs.every(job=>job.exclusionReason==='域名黑名单'),true);assert.ok(expected.tasks.length);assert.deepEqual(actual.tasks.map(legacyTask),expected.tasks);
});

test('native navigation cursor matches frozen get, advance, both wraps and refresh after insertion without opening',async()=>{
 const store=new Store(':memory:'),saved=snapshot();store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'original-nav'});store.set('paused',true);const runtime={store,cloud:{async request(route){assert.equal(route,'snapshot');return structuredClone(saved);}}};let cursor={};
 try{
  for(const [input,advance]of [[{},false],[{delta:1,open:false},true],[{delta:-1,open:false},true],[{delta:-1,open:false},true],[{delta:1,open:false},true]]){
   const expected=await originalNavigationState(saved,{input,cursor,advance}),actual=await submissionQueue(runtime,input,advance);assert.equal(actual.total,expected.result.total);assert.equal(actual.index,expected.result.index);assert.equal(actual.task.key,expected.cursor.key);cursor=expected.cursor;
  }
  saved.documents.sheetTableData.entries.unshift({link:'https://inserted.fixture.invalid/form',note:'AI tool directory',metrics:{dr:100,da:100}});
  const expected=await originalNavigationState(saved,{cursor}),actual=await submissionQueue(runtime);assert.equal(actual.index,expected.result.index);assert.equal(actual.task.key,expected.cursor.key);assert.equal(runtime.context,undefined);assert.equal(store.get('paused'),true);
 }finally{store.close();}
});

test('navigation uses pending local blacklist, contact and new-target edits while leaving raw remote documents unchanged',async()=>{
 const store=new Store(':memory:'),saved=snapshot(),before=structuredClone(saved),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'pending-nav'};store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:structuredClone(saved)});
 const runtime={store,cloud:{async request(route){if(route==='snapshot')return structuredClone(saved);assert.equal(route,'library');throw Error('Fixture writes unavailable');}}};
 try{
  for(const [key,value]of [['domainBlacklist',['first.fixture.invalid']],['cfgEmail','saved@fixture.invalid']])await enqueueLibraryMutation(runtime,{operation:{type:'settings',key,value}});await enqueueLibraryMutation(runtime,{operation:{type:'create',url:'https://new.fixture.invalid/form',fields:{note:'AI tool directory'}}});
  const local=overlayApplication(runtime,saved),expected=await originalLibraryBatchQueue(local),actual=await submissionQueue(runtime);
  assert.deepEqual(actual.tasks.map(shape),expected.groups.map(shape));const first=actual.tasks.find(group=>group.url===urls[0]);assert.ok(first);assert.equal(first.jobs.every(job=>job.eligible===false),true);assert.equal(actual.task.url,urls[0]);assert.equal(actual.task.jobs.every(job=>job.config.email==='saved@fixture.invalid'),true);assert.ok(actual.tasks.some(group=>group.url==='https://new.fixture.invalid/form'));assert.deepEqual(saved,before);assert.equal(store.values('task:').length,0);assert.equal(store.values('run:').length,0);
 }finally{store.close();}
});

test('quick open accepts a locally saved pending target exactly as the frozen original catalogue and retains its job on browser failure',async()=>{
 const store=new Store(':memory:'),saved=snapshot(),before=structuredClone(saved),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'pending-open'};store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:structuredClone(saved)});let connected=false;const visited=[];
 const runtime={store,cloud:{async request(route){if(route==='snapshot')return structuredClone(saved);assert.equal(route,'library');throw Error('Fixture writes unavailable');}},async connect(){if(!connected)throw Error('Fixture browser unavailable');runtime.context={async newPage(){return{isClosed:()=>false,async goto(url){visited.push(url);}};},async newCDPSession(){return{async send(){return{targetInfo:{targetId:'fixture-page'}};},async detach(){}};}};}};
 try{
  const url='https://new.fixture.invalid/form';await enqueueLibraryMutation(runtime,{operation:{type:'create',url,fields:{note:'AI tool directory'}}});const expected=await originalLibraryQuickOpen(overlayApplication(runtime,saved),{urls:[url],batchSize:1});
  const result=await quickOpenLibrary(runtime,{urls:[url],batchSize:1});await runtime.quickOpenJob;assert.equal(store.get('quickOpenJob:'+result.job.id).status,'paused');connected=true;await quickOpenLibrary(runtime,{jobId:result.job.id});await runtime.quickOpenJob;
  assert.deepEqual(visited,expected);assert.equal(store.get('quickOpenJob:'+result.job.id).id,result.job.id);assert.deepEqual(store.get('quickOpenJob:'+result.job.id).history.map(row=>row.phase),['paused','resume_previous_error']);assert.deepEqual(saved,before);assert.equal(store.values('task:').length,0);assert.equal(store.values('run:').length,0);assert.equal(store.get('paused'),true);
 }finally{store.close();}
});

test('original getter summaries and compact UI navigation avoid repeating embedded media while legacy advance retains full configurations',async()=>{
 const store=new Store(':memory:'),saved=snapshot();saved.documents.siteProfiles.p.logoDataUrl='data:image/png;base64,'+'A'.repeat(200000);store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'summary-nav'});store.set('paused',true);const runtime={store,cloud:{async request(){return structuredClone(saved);}}};
 try{
  const reference=await originalNavigationState(saved),actual=await submissionQueue(runtime),summaryKeys=Object.keys(reference.result.tasks[0]);
  assert.deepEqual(actual.tasks.map(group=>Object.fromEntries(summaryKeys.map(key=>[key,group[key]]))),reference.result.tasks);assert.equal(actual.tasks.every(group=>group.jobs.every(job=>!Object.hasOwn(job,'config'))),true);assert.ok(actual.task.jobs[0].config.logoDataUrl.length>100000);
  const complete=queues.originalNavigationQueue(saved);assert.ok(JSON.stringify(actual).length<JSON.stringify(complete.groups).length/20);
  const legacy=await submissionQueue(runtime,{delta:1,open:false},true);assert.ok(legacy.tasks.every(group=>group.jobs.every(job=>Object.hasOwn(job,'config'))));assert.ok(legacy.jobs.every(job=>Object.hasOwn(job,'config')));
  const compact=await submissionQueue(runtime,{delta:-1,open:false,compact:true},true);assert.equal(compact.tasks.every(group=>group.jobs.every(job=>!Object.hasOwn(job,'config'))),true);assert.ok(compact.task.jobs[0].config.logoDataUrl.length>100000);assert.equal(compact.task.key,actual.task.key);assert.equal(store.get('paused'),true);
 }finally{store.close();}
});

test('actual services, original navigation UI and isolated Chrome open the same locally saved pending target',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-navigation-queue.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.ok(evidence.originalDestinations>100);for(const key of ['completeOriginalRangeBothServices','scopedCategoryBothServices','actualUiNextAndPrevious','actualUiOpensOriginalDestinations','sameUnclaimedQueuePageReused','actualUiPendingBlacklistExplanation','pendingNewTargetVisible','actualChromeOpenedPendingTarget','offlineQueueAndAdvanceBothServices','actualUiOfflineChineseExplanation','actualUiSelectionRuleChineseExplanation','offlineChromeOpenedPendingTarget','remoteDocumentsAndRevisionsUnchanged','originalFixedBatchUnchanged'])assert.equal(evidence[key],true);assert.equal(evidence.ownedTargetGetRequests,3);for(const key of ['registeredTasks','posts','externalRequests','productionWrites','realModelCalls','realSubmissions'])assert.equal(evidence[key],0);
});
