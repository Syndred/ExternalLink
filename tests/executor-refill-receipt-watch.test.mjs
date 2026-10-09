import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {observedRefillReceiptKeys} from '../core/observed-refill-receipt.mjs';
import {existingReceiptTimelineEvent} from '../core/existing-receipt.mjs';
import {applicationMutationDependencies} from '../core/application-mutation-dependencies.mjs';
import {originalLibraryGlobals} from './helpers/original-library-catalog.mjs';
const Q=globalThis.ExtLinkQueue,T=globalThis.ExtLinkSubmissionTimeline,url='https://bai.tools/submit',record=Q.buildSuccessRecord({destinationUrl:url,profileId:'p',profileName:'Original p',submittedAt:'2026-01-01T00:00:00Z',evidence:'Original old receipt'}),key=Q.submissionRecordKey(record.destinationKey,'p');
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),extract=name=>source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^}','m'))[0];
export const observedRefillFixture=()=>({documents:{submissionRecords:{[key]:structuredClone(record)},submissionTimeline:T.append({},existingReceiptTimelineEvent(key,record))},operation:{id:'observation',at:'2026-10-09T01:00:02Z',type:'observed_refill_receipt',destinationUrl:url,profileId:'p',profileName:'Original p',previousRecordKey:key,previousRecord:structuredClone(record),expectedRecords:{[key]:structuredClone(record)},observation:{token:'original-token',refillId:'original-refill',actionObserved:true,clickedAt:'2026-10-09T01:00:00Z',observedAt:'2026-10-09T01:00:02Z',pageUrl:url,currentPageUrl:url,evidenceUrl:url,baseline:'Prior visible page'},receipt:{matched:true,evidence:'Original new receipt',publicationStatus:'pending_moderation'}},key});

test('observed refill mutation matches frozen record replacement and preserves prior timeline; lost replies are idempotent',async()=>{
 for(const identical of [false,true]){
  const f=observedRefillFixture();if(identical)f.operation.receipt={matched:true,evidence:record.evidence,publicationStatus:record.publicationStatus};
  const stored=structuredClone(f.documents),context=vm.createContext({self:{...originalLibraryGlobals},URL,state:{runId:''},chrome:{storage:{local:{get:async()=>stored,set:async patch=>Object.assign(stored,structuredClone(patch))}}},siteKeyForUrl:value=>Q.normalizeDestinationKey(value),SUBMISSION_SCHEMA_VERSION:Q.SUBMISSION_SCHEMA_VERSION,isPersistedSuccessRecord:()=>true,backfillVerifiedSiteMarkers:async()=>{},log(){}});
  vm.runInContext(execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/lib/automation-ledger.js'],{encoding:'utf8'}),context);for(const name of ['buildSubmissionTimelineEventForRecord','submissionTimelineContainsRecord','recordSubmittedProjectUnlocked'])vm.runInContext(extract(name),context);
  const r=f.operation.receipt,original=structuredClone(await context.recordSubmittedProjectUnlocked({url,profileId:'p',profileName:'Original p',confirmedBy:'agent',successEvidence:r.evidence,publicationStatus:r.publicationStatus,evidenceUrl:url,successProof:{source:'deterministic_submit',actionObserved:true,evidenceSignals:[{type:'visible_confirmation',text:r.evidence,url,matched:true}]}})),before=structuredClone(f.documents),change=applicationMutation(f.documents,f.operation),native=change.record;
  if(!identical){delete original.submittedAt;const copy={...native};delete copy.submittedAt;assert.deepEqual(copy,original);}else assert.deepEqual(native,record);
  assert.deepEqual(f.documents,before);assert.deepEqual(applicationMutationDependencies(f.operation),observedRefillReceiptKeys);Object.assign(f.documents,change.updates);assert.equal(applicationMutationSatisfied(f.documents,f.operation),true);assert.deepEqual(applicationMutation(f.documents,f.operation).updates,change.updates);assert.deepEqual(f.documents.submissionTimeline[key][0],before.submissionTimeline[key][0]);assert.equal(f.documents.submissionTimeline[key].length,identical?1:2);
 }
});

test('observed refill mutation rejects stale records missing clicks old evidence and unexpected navigation',()=>{
 for(const kind of ['record','click','baseline','navigation','profile','record-scope']){
  const f=observedRefillFixture();if(kind==='record')f.documents.submissionRecords[key].evidence='Concurrent edit';if(kind==='click')f.operation.observation.actionObserved=false;if(kind==='baseline')f.operation.receipt.evidence=f.operation.observation.baseline;if(kind==='navigation')f.operation.observation.currentPageUrl='https://other.example/';if(kind==='profile')f.operation.profileId='another';if(kind==='record-scope')delete f.operation.expectedRecords[key];
  assert.throws(()=>applicationMutation(f.documents,f.operation),/原|回执|范围|身份/);assert.equal(applicationMutationSatisfied(f.documents,f.operation),false);
 }
});

test('observed refill at another entry on the same host retains the previous exact record and records the clicked destination',()=>{
 const f=observedRefillFixture();f.operation.destinationUrl='https://bai.tools/other-submit';const target=Q.submissionRecordKey(Q.normalizeDestinationKey(f.operation.destinationUrl),'p');f.operation.expectedRecords[target]=null;const change=applicationMutation(f.documents,f.operation);assert.deepEqual(change.updates.submissionRecords[key],record);assert.equal(change.updates.submissionRecords[target].destinationUrl,f.operation.destinationUrl);assert.deepEqual(change.updates.submissionTimeline[key],f.documents.submissionTimeline[key]);assert.equal(change.updates.submissionTimeline[target].length,1);
});

test('observed refill restores original verified site markers and preserves manual gates and legacy receipt addresses',()=>{
 for(const gated of [false,true]){
  const f=observedRefillFixture();delete f.documents.submissionRecords[key].destinationUrl;delete f.operation.previousRecord.destinationUrl;delete f.operation.expectedRecords[key].destinationUrl;
  f.documents.siteAnnotations={'bai.tools':{note:'Original note',library:{favorite:true,groups:['directory']},...(gated?{status:'needs_login',statuses:['needs_login'],auto:false}:{})}};
  const before=structuredClone(f.documents),change=applicationMutation(f.documents,f.operation),expected=Q.verifiedSubmissionSiteAnnotationUpdates(change.updates.submissionRecords,before.siteAnnotations,Q.normalizeDestinationKey,f.operation.at);
  assert.deepEqual(change.updates.siteAnnotations,expected.annotations);assert.equal(change.updates.siteAnnotations['bai.tools'].library.favorite,true);
  assert.equal(change.updates.siteAnnotations['bai.tools'].status,gated?'needs_login':'can_submit');assert.deepEqual(f.documents,before);
  Object.assign(f.documents,change.updates);assert.equal(applicationMutationSatisfied(f.documents,f.operation),true);assert.deepEqual(applicationMutation(f.documents,f.operation).updates,change.updates);
 }
});

test('frozen manual observer ignores unchanged evidence, accepts a new receipt and keeps the page',async()=>{
 for(const fresh of [false,true]){
  const records=[],stored={watch:{token:'t',createdAt:Date.now(),url,pageUrl:url,destinationUrl:url,profileId:'p',profileName:'Original p',frameBaselines:{0:{evidence:'Old visible receipt',url}}}},context=vm.createContext({URL,Date,manualReceiptChecks:new Set(),chrome:{storage:{local:{get:async()=>({'manualSubmissionWatch:7':stored.watch}),remove:async()=>{delete stored.watch;}}}},sleep:async()=>{},getTabUrlSafe:async()=>url,sendTabMessageToFrame:async()=>({matched:true,evidence:fresh?'New visible receipt':'Old visible receipt'}),recordSubmittedProject:async record=>{records.push(structuredClone(record));return record;},broadcastAutoFillUpdate(){},log(){}});
  vm.runInContext(extract('observeManualSubmissionReceipt'),context);const result=await context.observeManualSubmissionReceipt(7,'t',0,{frameUrl:url});assert.equal(result.ok,fresh);assert.equal(records.length,fresh?1:0);assert.equal(!!stored.watch,!fresh);if(fresh)assert.equal(records[0].successProof.actionObserved,true);
 }
});

test('frozen original new-document registration refreshes frame baselines while keeping the original watch token and lifetime',async()=>{
 const watch={token:'original-token',createdAt:123,url,profileId:'p',frameBaselines:{0:{evidence:'Old document',url}}},stored={'manualSubmissionWatch:7':structuredClone(watch)},context=vm.createContext({chrome:{storage:{local:{get:async()=>structuredClone(stored),set:async patch=>Object.assign(stored,structuredClone(patch))}}},submissionLedgerWrite:async callback=>callback()});
 vm.runInContext(extract('registerManualSubmissionWatchFrame'),context);
 for(const [frameId,frameUrl,evidence]of [[0,url,'New document'],[3,'https://formsubmit.co/original-fixture','New iframe']]){
  const result=await context.registerManualSubmissionWatchFrame(7,'original-token',frameId,{frameUrl,baseline:{evidence,matched:false}});assert.equal(result.ok,true);assert.equal(stored['manualSubmissionWatch:7'].frameBaselines[frameId].evidence,evidence);
 }
 assert.equal(stored['manualSubmissionWatch:7'].token,watch.token);assert.equal(stored['manualSubmissionWatch:7'].createdAt,watch.createdAt);assert.equal((await context.registerManualSubmissionWatchFrame(7,'old-token',0,{baseline:{evidence:'Unrelated'}})).ok,false);assert.equal(stored['manualSubmissionWatch:7'].frameBaselines[0].evidence,'New document');
});
