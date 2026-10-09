import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {originalLibraryGlobals as self} from './helpers/original-library-catalog.mjs';
import {originalSinglePageReceipt} from './helpers/original-single-page-receipt.mjs';
import {existingReceiptTimelineEvent,existingReceiptTimelineContains} from '../core/existing-receipt.mjs';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {applicationMutationDependencies} from '../core/application-mutation-dependencies.mjs';
import {queue,timeline} from '../executor/src/shared.mjs';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),extract=name=>{const code=source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^}','m'))?.[0];assert.ok(code,name);return code;};
const record=structuredClone(queue.buildSuccessRecord({destinationUrl:'https://bai.tools/submit',profileId:'p',submittedAt:'2026-01-01T00:00:00Z',evidence:'Original old receipt'})),key=queue.submissionRecordKey(record.destinationKey,'p');

test('frozen ordinary and comment fill-only paths fill even with an existing receipt and never request submission',async()=>{
 for(const mode of ['form','comment']){
  const calls=[],profile={id:'p',fields:{Name:'Original',Url:'https://product.example'}},context=vm.createContext({self,state:{activeTabs:new Map()},chrome:{storage:{local:{get:async()=>({siteProfiles:{p:profile},activeSiteId:'p'})}}},resolveTargetTabId:async()=>7,getTabUrlSafe:async()=> 'https://bai.tools/submit',sendTabMessage:async(_id,message)=>{if(message.action==='executeSubmit'){assert.equal(message.config.fillOnly,true);calls.push('comment-fill');return{ok:true,fillOnly:true};}return{platform:'directory',operable:true,commentFound:true};},sendTabMessageToFrame:async()=>({blocked:false}),isCustomLaunchUrl:()=>false,broadcastAutoFillUpdate(){},existingSubmissionRecord:async()=>{calls.push('receipt');return record;},armManualSubmissionWatch:async()=>calls.push('watch'),persistFillLearnings:async()=>[],fillFormUntilReady:async()=>{calls.push('form-fill');return{smartTotal:2,lastEmpty:{emptyCount:0,invalidCount:0,totalCount:2},validation:{submitReady:true},agentResult:{}};},submitUntilAccepted:async()=>{throw Error('unexpected submission');}});
  vm.runInContext(extract('runSidepanelFill'),context);const result=await context.runSidepanelFill({tabId:7,profileId:'p',expectedUrl:'https://bai.tools/submit',mode,fillOnly:true,commentText:'Original comment'});
  assert.equal(result.ok,true);assert.equal(result.fillOnly,true);assert.deepEqual(calls,mode==='comment'?['comment-fill']:['watch','form-fill']);
 }
});

test('frozen ordinary manual watch saves the original page baseline before observing later user clicks',async()=>{
 const writes=[],messages=[],context=vm.createContext({state:{activeTabs:new Map()},crypto:{randomUUID:()=> 'original-watch-token'},getTabUrlSafe:async()=> 'https://bai.tools/submit',sendTopTabMessage:async(_tab,message)=>message.action==='classifySubmitEvidence'?{evidence:'Original visible baseline',matched:true}:{},isStandaloneExternalFormUrl:()=>false,chrome:{storage:{local:{set:async value=>writes.push(structuredClone(value))}}},refreshContentScriptsForManualWatch:async()=>[{frameId:0}],sendManualSubmissionWatchToFrames:async(...args)=>messages.push(structuredClone(args))});
 vm.runInContext(extract('armManualSubmissionWatch'),context);await context.armManualSubmissionWatch(7,{id:'p',name:'Original'},{targetDomain:'https://product.example'});
 const watch=writes[0]['manualSubmissionWatch:7'];assert.equal(watch.profileId,'p');assert.equal(watch.destinationUrl,'https://bai.tools/submit');assert.equal(watch.frameBaselines[0].evidence,'Original visible baseline');assert.equal(messages[0][1].action,'watchManualSubmission');assert.equal(messages[0][1].token,watch.token);
});

test('frozen existing receipt submit flow advances only after exact cloud confirmation without a new submission',async()=>{
 const profile={id:'p',fields:{Name:'Original',Url:'https://product.example'}},config=self.ExtLinkProfiles.buildAgentConfigFromProfile(profile,{});
 for(const synced of [false,true]){
  const pending=[],context=vm.createContext({self,state:{activeTabs:new Map()},getTabUrlSafe:async()=> 'https://bai.tools/submit',isCustomLaunchUrl:()=>false,broadcastAutoFillUpdate:()=>{},existingSubmissionRecord:async()=>structuredClone(record),confirmSubmissionRecordInCloud:async()=>({synced}),rememberPendingSubmissionCloudTab:async(...args)=>pending.push(args)});
  vm.runInContext(extract('tryAutoSubmitFilledForm'),context);const result=structuredClone(await context.tryAutoSubmitFilledForm(7,config,profile,'directory')),ui=await originalSinglePageReceipt({fillResult:result});assert.equal(result.existingSubmission,true);assert.equal(result.advance,synced);assert.equal(result.keepTab,!synced);assert.equal(pending.length,1);assert.deepEqual(ui.calls.map(c=>c.type),synced?['close','open']:[]);
 }
});
test('frozen Product Hunt fill-only verifies an existing receipt without immediate advance, while delayed confirmation keeps original notification behavior',async()=>{
 for(const fillOnly of [false,true])for(const synced of [false,true]){
  const url='https://www.producthunt.com/launch',profile={id:'p',fields:{Name:'Original',Url:'https://product.example'}},pending=[],context=vm.createContext({self,state:{activeTabs:new Map()},chrome:{storage:{local:{get:async()=>({siteProfiles:{p:profile},activeSiteId:'p'})}}},resolveTargetTabId:async()=>7,getTabUrlSafe:async()=>url,sendTabMessage:async()=>({platform:'product_hunt',operable:true}),sendTabMessageToFrame:async()=>({blocked:false}),isCustomLaunchUrl:()=>true,broadcastAutoFillUpdate:()=>{},existingSubmissionRecord:async()=>structuredClone(record),confirmSubmissionRecordInCloud:async()=>({synced}),rememberPendingSubmissionCloudTab:async(...args)=>pending.push(args)});
  vm.runInContext(extract('runSidepanelFill'),context);const result=structuredClone(await context.runSidepanelFill({tabId:7,profileId:'p',expectedUrl:url,mode:'form',fillOnly}));assert.equal(result.existingSubmission,true);assert.equal(result.advance,!fillOnly&&synced);assert.equal(result.keepTab,!synced);assert.equal(pending.length,1);const initial=await originalSinglePageReceipt({url,fillResult:result});assert.deepEqual(initial.calls.map(c=>c.type),synced?fillOnly?['close']:['close','open']:[]);
  if(!synced){const delayed=await originalSinglePageReceipt({url});assert.deepEqual(delayed.calls.map(c=>c.type),['close','open','ack']);}
 }
});
test('receipt timeline repair matches the frozen original tuple and preserves original ledger bytes and unrelated events',()=>{
 const context=vm.createContext({self:{ExtLinkSubmissionTimeline:timeline}});vm.runInContext(extract('buildSubmissionTimelineEventForRecord')+'\n'+extract('submissionTimelineContainsRecord'),context);
 const event=existingReceiptTimelineEvent(key,record),original=structuredClone(context.buildSubmissionTimelineEventForRecord(record,record.destinationKey,record.destinationUrl,'p',key));delete event.id;delete original.id;assert.deepEqual(event,original);
 for(const patch of [{},{type:'success',status:'success'},{recordKey:'different::p'},{note:'Other receipt'},{occurredAt:'2026-02-01T00:00:00Z'},{evidenceUrl:'https://evidence.example'},{publicUrl:'https://published.example'},{type:'published',status:'published'}]){const data=timeline.append({}, {...existingReceiptTimelineEvent(key,record),...patch});assert.equal(existingReceiptTimelineContains(data,key,record),context.submissionTimelineContainsRecord(data,key,record));}
 const docs={submissionRecords:{[key]:record},submissionTimeline:structuredClone(timeline.append({}, {destinationUrl:'https://other.example',profileId:'q',note:'Original other event',type:'note'}))},before=structuredClone(docs),operation={id:'repair',at:'2026-10-09T00:00:00Z',type:'receipt_timeline_repair',recordKey:key,expectedRecord:record},change=applicationMutation(docs,operation);
 assert.deepEqual(docs,before);assert.equal(Object.hasOwn(change.updates,'submissionRecords'),false);assert.deepEqual(applicationMutationDependencies(operation),['submissionTimeline','timelineSchemaVersion','submissionRecords']);Object.assign(docs,change.updates);assert.equal(applicationMutationSatisfied(docs,operation),true);assert.equal(existingReceiptTimelineContains(docs.submissionTimeline,key,record),true);assert.deepEqual(applicationMutation(docs,operation).data,docs.submissionTimeline);assert.deepEqual(docs.submissionRecords,before.submissionRecords);
 assert.throws(()=>applicationMutation({...docs,submissionRecords:{[key]:{...record,evidence:'Changed'}}},operation),/已变化/);
});
