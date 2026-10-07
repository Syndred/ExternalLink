import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueLibraryMutation,overlayApplication} from '../executor/src/application-mutations.mjs';
import {previewWorkbenchBatch,startWorkbenchBatch} from '../executor/src/workbench-features.mjs';
import {originalLibraryBatchQueue} from './helpers/original-library-catalog.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const urls=['https://first.fixture.invalid/form','https://second.fixture.invalid/form'];
function fixture(){const store=new Store(':memory:'),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'pending-batch'},scope=workbenchScope(pair),snapshot={documents:{siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.fixture.invalid'}}},selectedSiteIds:['p'],activeSiteId:'p',sheetTableData:{entries:urls.map(link=>({link,note:'AI tool directory',metrics:{dr:80,da:70}}))},submissionRecords:{},cfgConcurrency:'1',targetFilters:{},domainBlacklist:[]},revisions:{siteProfiles:2,cfgConcurrency:1,domainBlacklist:1}},requests=[];store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope,snapshot:structuredClone(snapshot)});store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});const runtime={store,job:null,cloud:{async request(route){requests.push(route);if(route==='snapshot')return structuredClone(snapshot);if(route==='runs?view=inventory')return{tasks:[],runs:[]};if(route==='library')throw Error('Fixture setting write unavailable');throw Error('Unexpected registration '+route);}},tick(){}};return{store,runtime,snapshot,requests};}

test('batch preview uses locally saved concurrency and gates when setting writes fail, matching the original local queue',async()=>{
 const f=fixture();try{const before=structuredClone(f.snapshot);await enqueueLibraryMutation(f.runtime,{operation:{type:'settings',key:'cfgConcurrency',value:'4'}});await enqueueLibraryMutation(f.runtime,{operation:{type:'settings',key:'domainBlacklist',value:['first.fixture.invalid']}});const local=overlayApplication(f.runtime,f.snapshot),original=await originalLibraryBatchQueue(local,{profileIds:['p']}),{batch}=await previewWorkbenchBatch(f.runtime,{profileIds:['p'],urls});assert.equal(batch.config.concurrency,4);assert.equal(batch.count,2);assert.deepEqual(batch.items.map(item=>item.status),['excluded','ready']);assert.deepEqual(batch.items.filter(item=>item.status==='ready').map(item=>item.url),original.tasks.filter(task=>urls.includes(task.url)).map(task=>task.url));assert.deepEqual(f.snapshot,before);assert.equal(f.store.get('paused'),true);assert.equal(f.store.values('run:').length,0);assert.equal(f.store.values('task:').length,0);}finally{f.store.close();}
});

test('a pending blacklist edit after preview blocks registration at batch start while preserving the original scope and frozen configuration',async()=>{
 const f=fixture();try{const {batch}=await previewWorkbenchBatch(f.runtime,{profileIds:['p'],urls:[urls[0]]}),ids=batch.items.map(item=>[item.taskId,item.runId]),before=structuredClone(f.snapshot);await enqueueLibraryMutation(f.runtime,{operation:{type:'settings',key:'domainBlacklist',value:['first.fixture.invalid']}});await startWorkbenchBatch(f.runtime,{batchId:batch.id,ordinaryPermissionsAuthorized:true});assert.equal(f.requests.includes('runs'),false);const saved=f.store.get('workbenchBatch:'+batch.id);assert.equal(saved.items[0].status,'excluded');assert.deepEqual(saved.items.map(item=>[item.taskId,item.runId]),ids);assert.deepEqual(saved.config,batch.config);assert.equal(f.store.values('task:').length,0);assert.deepEqual(f.snapshot,before);assert.deepEqual(f.store.get('acceptanceBatch'),{status:'paused',cursor:13,count:30});}finally{f.store.close();}
});

test('actual native services and UI preserve pending batch settings and block new registration after preview',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-pending-batch-settings.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(evidence.actualUiPreviewConcurrency,4);for(const key of ['actualUiSavedPendingSettings','bothServicesReadPendingGates','afterPreviewPendingBlacklistBlocksRegistration','frozenTaskAndRunIdsUnchanged','frozenConfigUnchanged','originalFixedBatchUnchanged','remoteDocumentsAndRevisionsUnchanged'])assert.equal(evidence[key],true);assert.equal(evidence.pendingEdits,3);for(const key of ['registeredTasks','realSubmissions','realModelCalls','productionWrites','externalRequests'])assert.equal(evidence[key],0);
});
