import test from 'node:test';
import assert from 'node:assert/strict';
import {autoVisitTarget,createAutoVisitMatcher} from '../executor/src/browser-assistant.mjs';
import {originalLibraryBatchQueue,originalAutoVisitRequest,originalLibraryGlobals} from './helpers/original-library-catalog.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const profile={id:'p',name:'Original Product',fields:{Name:'Original Product',Url:'https://product.fixture.invalid'}};
const snapshot=()=>({documents:{siteProfiles:{p:structuredClone(profile),q:{...profile,id:'q'}},selectedSiteIds:['p'],activeSiteId:'p',sheetTableData:{entries:[]},submissionRecords:{},siteAnnotations:{},urlList:'',targetFilters:{},domainBlacklist:[]},revisions:{siteProfiles:2}});
const identity=task=>task?{url:task.url,key:task.key,destinationKey:task.destinationKey,profileId:task.profileId}:null;

test('built-in visit matching follows the frozen original candidate order and destination identity on every original route and form-stage URL',async()=>{
 const saved=snapshot(),before=structuredClone(saved),original=await originalLibraryBatchQueue(saved);assert.ok(original.tasks.length>100);
 for(const task of original.tasks){
  for(const url of [task.url,new URL('/actual-form',task.url).href]){
   const expected=originalLibraryGlobals.ExtLinkQueue.matchSubmissionTarget(url,original.tasks,'p');
   assert.deepEqual(identity(autoVisitTarget(saved,'p',url)),identity(expected),url);
  }
 }
 assert.deepEqual(saved,before);
});

test('the frozen auto-visit request actually reaches fill-only on a built-in form and the native matcher retains the same original target',async()=>{
 const saved=snapshot(),url='https://betalist.com/actual-form',reference=await originalAutoVisitRequest(saved,{url});
 assert.equal(reference.fills.length,1);assert.deepEqual(reference.fills[0],{tabId:9,mode:'form',useAgent:true,auto:true,fillOnly:true,expectedUrl:url,profileId:'p'});
 const expected=originalLibraryGlobals.ExtLinkQueue.matchSubmissionTarget(url,reference.pending.tasks,'p');assert.ok(expected);assert.deepEqual(identity(autoVisitTarget(saved,'p',url)),identity(expected));
 assert.equal(reference.documents.submissionQueueIndex,reference.pending.tasks.findIndex(task=>task.id===expected.id));
});

test('one scan reuses its immutable candidate snapshot and the next scan reads new candidates and gates',async()=>{
 const saved=snapshot(),original=await originalLibraryBatchQueue(saved),before=structuredClone(saved),matcher=createAutoVisitMatcher(saved,'p');
 for(const task of original.tasks)assert.deepEqual(identity(matcher(new URL('/actual-form',task.url).href)),identity(originalLibraryGlobals.ExtLinkQueue.matchSubmissionTarget(new URL('/actual-form',task.url).href,original.tasks,'p')));
 assert.deepEqual(saved,before);
 const next=structuredClone(saved);next.documents.urlList='https://new.fixture.invalid/form';next.documents.domainBlacklist=['betalist.com'];const nextMatcher=createAutoVisitMatcher(next,'p');
 assert.equal(nextMatcher('https://betalist.com/actual-form'),null);assert.equal(nextMatcher('https://new.fixture.invalid/form').url,'https://new.fixture.invalid/form');assert.equal(matcher('https://new.fixture.invalid/form'),null);
});

test('original visit exclusions still apply to built-in URLs and current host receipts and DR DA gates also stop them',async()=>{
 const url='https://betalist.com/actual-form';
 for(const change of [
  docs=>{docs.domainBlacklist=['betalist.com'];},
  docs=>{docs.deletedSubmissionKeys=['betalist.com'];},
  docs=>{docs.siteAnnotations={'betalist.com':{status:'paid'}};},
  docs=>{docs.siteAnnotations={'betalist.com/actual-form':{status:'paid'}};},
  docs=>{docs.targetFilters={minOpportunityScore:100};},
 ]){
  const saved=snapshot();change(saved.documents);const reference=await originalAutoVisitRequest(saved,{url});assert.equal(reference.fills.length,0,JSON.stringify(saved.documents));assert.equal(autoVisitTarget(saved,'p',url),null);
 }
 for(const change of [
  docs=>{docs.targetFilters={minDr:60};},docs=>{docs.targetFilters={minDa:60};},
  docs=>{docs.submissionRecords={'betalist.com/older::p':{profileId:'p',destinationUrl:'https://betalist.com/older',status:'success',confirmedBy:'agent',evidence:'Original receipt'}};},
  docs=>{docs.siteProfiles.p.archived=true;},
 ]){const saved=snapshot();change(saved.documents);assert.equal(autoVisitTarget(saved,'p',url),null);}
 assert.equal(autoVisitTarget(snapshot(),'p','https://arbitrary.fixture.invalid/form'),null);
});

test('the original request keeps active-tab profile URL parked-task payment and existing-product guards before calling fill',async()=>{
 const saved=snapshot(),url='https://betalist.com/actual-form';
 for(const options of [
  {flag:false},{activeTabId:10},{activeTask:true},{beforeTimer:{activeTabId:10}},
  {beforeTimer:{url:'https://betalist.com/other-form'}},{beforeTimer:{activeSiteId:'q'}},
  {detection:{platform:'wordpress'}},{detection:{operable:false,formFieldCount:0}},
  {detection:{submitBlocker:{blocked:true}}},{detection:{submitBlocker:{payment_uncertain:true}}},
  {guard:{blocked:true}},
  {unattended:true,parkedTasks:[{id:'original-parked',profileId:'p',destinationKey:'betalist.com/actual-form',status:'needs_login'}]},
 ]){const result=await originalAutoVisitRequest(saved,{url,...options});assert.equal(result.fills.length,0,JSON.stringify(options));}
});

test('native compiled auto-visit fills actual browser fields without changing the library and recovers the same task after a lost reply',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-builtin-auto-visit.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);
 for(const key of ['ordinaryProviderUrlsInterceptedByFixture','noCompiledUrlAddedToTableOrUserList','actualFourFieldsReadBack','originalDestinationAndQueuePosition','blacklistDrDaDeletedCurrentPathAndHostReceiptGates','remoteLoginTaskPreserved','lostReplyAndSqliteRestart','originalTaskIdProfileAndRevisionRetained','duplicateRegistrationPrevented','favoritesAndPausedFixedBatchUnchanged'])assert.equal(evidence[key],true);
 assert.equal(evidence.registrations,3);for(const key of ['posts','externalRequests','productionWrites','realModelCalls','realSubmissions'])assert.equal(evidence[key],0);
});

test('complete original auto-visit browser regression retains dynamic iframe cancellation document scope and existing-task recovery behavior',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/auto-visit.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);
 for(const key of ['alreadyConnectedPreferenceChange','liveLibraryAddition','dynamicFormMount','iframePrepared','differentProductGuard','articleExcluded','unknownAttemptPreserved','lostRegistrationReplyAndSqliteRestart','originalTaskAndProfileRetained','originalQueuePosition','cancelledOriginalPageResumesOnReenable','stageUrlKeepsLibraryDestination','remoteLoginGatePreserved','boundTaskSameHostUnknownPreserved','disabledDuringLeaseStopsFill','scopeChangeAndClosedPanelStopFill','fixedBatchPaused'])assert.equal(evidence[key],true);
 assert.equal(evidence.posts,0);assert.equal(evidence.externalRequests,0);
});
