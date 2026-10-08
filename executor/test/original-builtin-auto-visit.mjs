import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {Runtime} from '../src/runtime.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {checkBrowserAssistant,stopBrowserAssistant} from '../src/browser-assistant.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';
import {originalLibraryBatchQueue,originalLibraryGlobals} from '../../tests/helpers/original-library-catalog.mjs';
import {enqueueLibraryMutation,overlayVisitPreferences} from '../src/application-mutations.mjs';

// Ordinary compiled URLs are fulfilled by this owned fixture. No request reaches
// any listed provider. Do not add them to sheetTableData or the user's urlList.
const ownedHosts=new Set(['betalist.com','getapp.com','nextbigwhat.com','10words.io']);
const home=await mkdtemp(join(tmpdir(),'el-builtin-auto-visit-'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
const context=await browser.newContext();
let store=new Store(join(home,'outbox.sqlite')),runtime,registrations=0,posts=0,foreignRequests=0,fixtureGets=0,lostReply=false;
const form='<!doctype html><title>Submit product</title><form><label>Product name<input name="productName" id="name" required></label><label>Website<input name="website" id="website" type="url" required></label><label>Email<input name="email" id="email" type="email" required></label><label>Description<textarea name="description" id="description" required></textarea></label><button type="submit">Submit product</button></form>';
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(!ownedHosts.has(url.hostname)){foreignRequests++;await route.abort();return;}
 if(request.method()!=='GET'){posts++;await route.abort();return;}
 fixtureGets++;await route.fulfill({status:200,contentType:'text/html',body:form});
});
const profile={id:'p',name:'Original Product',fields:{Name:'Original Product',Url:'https://product.fixture.invalid','Business mail':'owner@fixture.invalid','Long description (250-500 words)':'The original product description for checking automatic form preparation.'}};
const snapshot={documents:{siteProfiles:{p:profile,q:{...profile,id:'q',name:'Original Q',fields:{...profile.fields,Name:'Original Q',Url:'https://q.fixture.invalid'}}},selectedSiteIds:['q'],activeSiteId:'p',submissionRecords:{},sheetTableData:{entries:[]},urlList:'',autoFillOnVisit:true,siteAnnotations:{},domainBlacklist:[],targetFilters:{},libraryPreferences:{favorites:['original.favorite.invalid'],qualityFirst:true}},revisions:{siteProfiles:2,sheetTableData:1,autoFillOnVisit:1,selectedSiteIds:1}};
const pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'builtin-auto-visit'},runs=new Map(),remoteTasks=new Map();
store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});
const preserved=structuredClone([snapshot.documents.libraryPreferences,store.get('acceptanceBatch')]);
const cloud={async request(route,input){
 if(route==='snapshot')return structuredClone(snapshot);
 if(route==='runs?view=inventory')return{runs:[...runs.values()],tasks:[...remoteTasks.values()]};
 if(route.startsWith('runs?runId=')){const id=decodeURIComponent(route.split('=')[1]);return{runs:runs.has(id)?[structuredClone(runs.get(id))]:[],tasks:[...remoteTasks.values()].filter(task=>task.runId===id)};}
 if(route.startsWith('tasks/'))return{task:structuredClone(remoteTasks.get(route.slice(6)))};
 if(route==='runs'){
  registrations++;assert.equal(input.run.authorization,'fill_only');assert.equal(input.run.mode,'single_page_preparation');
  assert.equal(input.run.tasks.length,1);assert.equal(input.run.feeLimit,0);
  assert.ok(store.values('singlePagePlan:').some(plan=>plan.run.id===input.run.id&&plan.status==='registering'));
  const run={...input.run,profile:structuredClone(snapshot.documents.siteProfiles.p)},task={...input.run.tasks[0],runId:run.id,profileId:'p',status:'needs_manual',attentionType:'fill_only',version:1};
  runs.set(run.id,run);remoteTasks.set(task.id,task);
  if(lostReply){lostReply=false;throw Error('Fixture lost reply after registration');}
  return{ok:true,run,tasks:[task]};
 }
 throw Error('Fixture has no external model or artifact service: '+route);
}};
function bind(){
 runtime=new Runtime(store,home);runtime.context=context;runtime.host={startedAt:'owned-fixture-browser'};
 Object.defineProperty(runtime,'cloud',{value:cloud});runtime.lease=async()=>{};
 runtime.synchronize=async()=>{for(const event of store.pending()){remoteTasks.set(event.taskId,event.state);store.ack(event.id);}};
 runtime.tick=()=>{throw Error('Automatic visiting must only prepare');};
 runtime.dispatchControl=(action,input)=>runtime.control(action,input);
 runtime.findPage=async task=>{for(const page of context.pages())if((await getTargetInfo(context,page))?.targetId===task.targetId)return page;throw Error('Original target missing');};
 refresh();
}
function refresh(){store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:structuredClone(snapshot)});}
async function open(url){const page=await context.newPage();await page.goto(url);return page;}
async function check(){refresh();await checkBrowserAssistant(runtime);}
function assertOnlyCompiled(){assert.equal(snapshot.documents.sheetTableData.entries.length,0);assert.equal(snapshot.documents.urlList,'');}
try{
 bind();store.set('browserAssistantSettings',{scope:workbenchScope(pair),enabled:true,autoFillOnVisit:true,profileId:'p'});
 const page=await open('https://betalist.com/actual-form'),before=registrations;
 await check();assert.equal(await page.locator('#name').inputValue(),'');assert.equal(registrations,before);
 await enqueueLibraryMutation(runtime,{operation:{type:'profile',profileId:'p',profile:{id:'p',fields:{Name:'Unconfirmed local name'}}}});
 await enqueueLibraryMutation(runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:['p','q']}});
 await check();assert.equal(await page.locator('#name').inputValue(),'Original Product');assert.equal(await page.locator('#website').inputValue(),profile.fields.Url);assert.equal(await page.locator('#email').inputValue(),profile.fields['Business mail']);assert.equal(await page.locator('#description').inputValue(),profile.fields['Long description (250-500 words)']);
 const original=await originalLibraryBatchQueue(overlayVisitPreferences(runtime,snapshot)),expected=originalLibraryGlobals.ExtLinkQueue.matchSubmissionTarget(page.url(),original.tasks,'p'),task=store.values('task:')[0];
 assert.equal(task.url,expected.url);assert.equal(task.destinationKey,expected.destinationKey);assert.equal(task.profileRevision,2);assert.equal(task.attemptBoundary,undefined);assert.equal(task.receipt,undefined);assert.equal(registrations,before+1);assert.equal(store.get('submissionQueue').key,expected.destinationKey);
 assert.deepEqual(store.get('submissionQueue').selectedSiteIds,['p','q']);assert.equal(task.profileSnapshot.fields.Name,'Original Product');assert.deepEqual(snapshot.documents.selectedSiteIds,['q']);
 await check();assert.equal(registrations,before+1);assertOnlyCompiled();await page.close();

 const gated=await open('https://getapp.com/submit'),gateCount=registrations;
 const checks=[
  ()=>{snapshot.documents.domainBlacklist=['getapp.com'];},
  ()=>{snapshot.documents.domainBlacklist=[];snapshot.documents.targetFilters={minDr:60};},
  ()=>{snapshot.documents.targetFilters={minDa:60};},
  ()=>{snapshot.documents.targetFilters={};snapshot.documents.deletedSubmissionKeys=['getapp.com'];},
  ()=>{snapshot.documents.deletedSubmissionKeys=[];snapshot.documents.siteAnnotations={'getapp.com/submit':{status:'paid'}};},
  ()=>{snapshot.documents.siteAnnotations={};snapshot.documents.submissionRecords={'getapp.com/older::p':{profileId:'p',destinationUrl:'https://getapp.com/older',status:'success',confirmedBy:'agent',evidence:'Fixture original receipt'}};},
 ];
 for(const change of checks){change();await check();assert.equal(await gated.locator('#name').inputValue(),'');assert.equal(registrations,gateCount);}
 snapshot.documents.submissionRecords={};refresh();const gateInfo=await getTargetInfo(context,gated);let selectionChanged=false;
 runtime.lease=async()=>{if(!selectionChanged){selectionChanged=true;await enqueueLibraryMutation(runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:['q']}});}};
 await assert.rejects(runtime.control('fillAssistantTask',{profileId:'p',targetId:gateInfo.targetId,url:gated.url()}),/取消批量勾选/);assert.equal(await gated.locator('#name').inputValue(),'');assert.equal(registrations,gateCount+1);const gatedTask=store.values('task:').find(task=>new URL(task.url).hostname==='getapp.com');assert.ok(gatedTask);assert.equal(gatedTask.targetId,undefined);
 runtime.lease=async()=>{};await enqueueLibraryMutation(runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:['p','q']}});const continued=await runtime.control('fillAssistantTask',{profileId:'p',targetId:gateInfo.targetId,url:gated.url()});assert.equal(continued.taskId,gatedTask.id);assert.equal(await gated.locator('#name').inputValue(),'Original Product');assert.equal(registrations,gateCount+1);assertOnlyCompiled();await gated.close();

 const parked=await open('https://nextbigwhat.com/submit'),parkedCount=registrations;
 remoteTasks.set('original-login',{id:'original-login',runId:'original-login-run',profileId:'p',url:'http://nextbigwhat.com/',status:'needs_manual',attentionType:'login'});
 await check();assert.equal(await parked.locator('#name').inputValue(),'');assert.equal(registrations,parkedCount);assert.equal(remoteTasks.get('original-login').attentionType,'login');await parked.close();

 const recovery=await open('https://10words.io/actual-form'),recoveryCount=registrations;lostReply=true;
 await check();assert.equal(await recovery.locator('#name').inputValue(),'');assert.equal(registrations,recoveryCount+1);
 const plan=store.values('singlePagePlan:').find(item=>item.status==='registration_unknown'),originalId=plan.run.tasks[0].id,info=await getTargetInfo(context,recovery);
 assert.ok(originalId);await stopBrowserAssistant(runtime);store.close();store=new Store(join(home,'outbox.sqlite'));
 snapshot.documents.siteProfiles.p={...profile,fields:{...profile.fields,Name:'Later cloud name'}};snapshot.revisions.siteProfiles=7;bind();
 const resumed=await runtime.control('fillAssistantTask',{profileId:'p',targetId:info.targetId,url:recovery.url()});
 assert.equal(resumed.taskId,originalId);assert.equal(resumed.submitted,false);assert.equal(registrations,recoveryCount+1);assert.equal(await recovery.locator('#name').inputValue(),'Original Product');assert.equal(store.get('task:'+originalId).profileRevision,2);assert.equal(store.get('task:'+originalId).url,'https://10words.io/');
 assert.equal(posts,0);assert.equal(foreignRequests,0);assertOnlyCompiled();assert.equal(store.get('paused'),true);assert.deepEqual([snapshot.documents.libraryPreferences,store.get('acceptanceBatch')],preserved);
 console.log(JSON.stringify({ok:true,kind:'actual_native_compiled_auto_visit_with_owned_browser_responses',ordinaryProviderUrlsInterceptedByFixture:true,noCompiledUrlAddedToTableOrUserList:true,actualFourFieldsReadBack:true,originalDestinationAndQueuePosition:true,blacklistDrDaDeletedCurrentPathAndHostReceiptGates:true,unselectedProductNotFilledOrRegistered:true,pendingBatchChoiceAppliedBeforeCloudSync:true,pendingProductPayloadExcluded:true,visitQueueKeepsAllSelectedProducts:true,deselectionDuringLeaseStopsBeforeFieldWrites:true,reselectionContinuesSameTask:true,remoteLoginTaskPreserved:true,lostReplyAndSqliteRestart:true,originalTaskIdProfileAndRevisionRetained:true,duplicateRegistrationPrevented:true,favoritesAndPausedFixedBatchUnchanged:true,fixtureGets,registrations,posts,externalRequests:foreignRequests,productionWrites:0,realModelCalls:0,realSubmissions:0}));
}finally{
 await stopBrowserAssistant(runtime);store.close();await browser.close();
 assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-builtin-auto-visit-'));await rm(home,{recursive:true,force:true});
}
