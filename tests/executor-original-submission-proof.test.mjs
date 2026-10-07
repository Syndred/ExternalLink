import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {automationLedger,queue,plain} from '../executor/src/shared.mjs';
import {originalJudgeSuccessDecision,originalSubmitSuccessDecision,nativeSuccessRecord,nativeReceiptReadbackMatches} from '../executor/src/original-submission-proof.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {isDeepStrictEqual} from 'node:util';
import {closeAcceptanceTask} from '../executor/src/acceptance-cleanup.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const original=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const signal={type:'visible_confirmation',text:'Submission received',matched:true,url:'https://site.example/submit'};

test('native judge proof and baseline rejection match the complete original success function across evidence branches',async()=>{
 const start=original.indexOf('function completeTaskFromJudge('),end=original.indexOf('\nfunction markTaskUnconfirmed(',start),shortStart=original.indexOf('function shortText('),shortEnd=original.indexOf('\nfunction handleTerminalJudge(',shortStart);
 for(const input of [
  {judge:{status:'success',reason:'Model guessed success'}},
  {judge:{evidence:signal.text,evidenceSignals:[signal]}},
  {entry:{submissionAttempted:true},judge:{evidence:signal.text,evidenceSignals:[signal]}},
  {judge:{source:'deterministic_submit',actionObserved:true,evidence:signal.text,evidenceSignals:[signal]}},
  {entry:{submissionAttempted:true},judge:{source:'deterministic_submit',evidence:signal.text,evidenceSignals:[signal]}},
  {entry:{submissionAttempted:true,submissionEvidenceBaseline:signal.text,submissionUrlBaseline:signal.url},judge:{source:'deterministic_submit',evidence:signal.text,evidenceSignals:[signal],evidenceUrl:signal.url}},
  {entry:{submissionAttempted:true,submissionEvidenceBaseline:signal.text,submissionUrlBaseline:signal.url},judge:{source:'deterministic_submit',evidence:signal.text,evidenceSignals:[{...signal,url:'https://site.example/thanks'}],evidenceUrl:'https://site.example/thanks'}},
  {judge:{evidence:'Published Original',publicationStatus:'published',publicUrl:'https://site.example/listing/original',evidenceSignals:[{...signal,type:'public_listing',text:'Published Original',url:'https://site.example/listing/original'}]}},
  {judge:{evidence:'Published Original',publicationStatus:'published',publicUrl:'https://site.example/listing/other',evidenceSignals:[{...signal,type:'public_listing',text:'Published Original',url:'https://site.example/listing/original'}]}},
  {judge:{evidence:signal.text,evidenceSignals:[signal],networkEvidence:{matched:true,status:201}}},
  {judge:{evidence:signal.text,evidenceSignals:[signal],networkEvidence:{matched:true,status:403}}},
  {entry:{submissionAttempted:true},judge:{source:'deterministic_submit',evidence:'under review',publicationStatus:'pending_moderation',evidenceSignals:[{...signal,text:'under review'}]}},
  {entry:{submissionAttempted:true,submissionEvidenceBaseline:'a'.repeat(2100),submissionUrlBaseline:signal.url},judge:{source:'deterministic_submit',evidence:'a'.repeat(2100),evidenceSignals:[{...signal,text:'a'.repeat(2100)}],evidenceUrl:signal.url}}
 ]){
  const entry=structuredClone(input.entry||{}),task={id:'t',profileId:'p',url:signal.url};let captured,unconfirmed=false,accepted=false;
  const sandbox=vm.createContext({state:{activeTabs:new Map([[1,entry]]),config:{}},self:{ExtLinkQueue:queue,ExtLinkAutomationLedger:{validateSuccessProof:value=>{captured=plain(automationLedger.validateSuccessProof(value));return captured;}}},log(){},broadcastTaskUpdate(){},recordAutomationEvent(){},markTaskUnconfirmed(){unconfirmed=true;},recordSubmittedProject:async()=>{accepted=true;return{status:'success',profileId:'p'};},confirmSubmissionRecordInCloud:async()=>({synced:true}),recordUnattendedSuccess(){},advanceDestinationGroup:async()=>{},pingIndexNow(){}});
  vm.runInContext(original.slice(shortStart,shortEnd)+original.slice(start,end),sandbox);const terminal=sandbox.completeTaskFromJudge(1,task,input.judge),decision=originalJudgeSuccessDecision({url:signal.url},input.entry,input.judge);await Promise.resolve();
  assert.deepEqual(decision.proof,captured);assert.equal(decision.terminal,terminal);assert.equal(decision.unconfirmed===true,unconfirmed);assert.equal(!!decision.receipt,accepted);
  if(decision.receipt){assert.equal(decision.receipt.evidence,task.successEvidence);assert.equal(decision.receipt.evidenceType,task.evidenceType);assert.equal(decision.receipt.publicationStatus,task.publicationStatus);assert.equal(decision.receipt.publicUrl,task.publicUrl);assert.equal(decision.receipt.evidenceUrl,task.evidenceUrl);assert.deepEqual(decision.receipt.successProof,plain(task.successProof));}
 }
});

test('the complete original success function parks a local receipt and advances only after its independent cloud confirmation',async()=>{
 const start=original.indexOf('function completeTaskFromJudge('),end=original.indexOf('\nfunction markTaskUnconfirmed(',start),shortStart=original.indexOf('function shortText('),shortEnd=original.indexOf('\nfunction handleTerminalJudge(',shortStart);
 for(const synced of [false,true]){
  let release,entered,finished;const proofWait=new Promise(done=>release=done),proofEntered=new Promise(done=>entered=done),terminal=new Promise(done=>finished=done),events=[],entry={submissionAttempted:true},task={id:'t',profileId:'p',url:signal.url};
  const sandbox=vm.createContext({state:{activeTabs:new Map([[1,entry]]),config:{}},self:{ExtLinkQueue:queue,ExtLinkAutomationLedger:automationLedger},log(){},broadcastTaskUpdate(){},recordAutomationEvent(){events.push('success_recorded');},recordSubmittedProject:async()=>{events.push('local_record');return{status:'success',profileId:'p'};},confirmSubmissionRecordInCloud:async()=>{events.push('independent_cloud_readback');entered();return proofWait;},recordUnattendedSuccess(){events.push('budget_success');},advanceDestinationGroup:async()=>{events.push('advance');finished();},parkTaskEntry(){events.push('park_original');finished();},pingIndexNow(){}});
  vm.runInContext(original.slice(shortStart,shortEnd)+original.slice(start,end),sandbox);assert.equal(sandbox.completeTaskFromJudge(1,task,{source:'deterministic_submit',evidence:signal.text,evidenceSignals:[signal]}),true);await proofEntered;assert.equal(task.status,'verifying');assert.deepEqual(events,['local_record','independent_cloud_readback']);release({synced,reason:'fixture proof pending'});await terminal;
  assert.equal(task.status,synced?'ok':'verifying');assert.deepEqual(events,synced?['local_record','independent_cloud_readback','success_recorded','budget_success','advance']:['local_record','independent_cloud_readback','park_original']);
 }
});

test('deterministic submit proof keeps publication, public URL and signal details while refusing identical baseline evidence',()=>{
 const task={id:'t',url:signal.url,attemptBoundary:'original-attempt'},result={matched:true,evidence:'Published Original',publicationStatus:'published',publicUrl:'https://site.example/listing/original',evidenceUrl:'https://site.example/listing/original',evidenceSignals:[{...signal,type:'public_listing',text:'Published Original',url:'https://site.example/listing/original'}]};
 const accepted=originalSubmitSuccessDecision(task,result);assert.equal(accepted.proof.ok,true);assert.equal(accepted.receipt.publicationStatus,'published');assert.equal(accepted.receipt.publicUrl,result.publicUrl);assert.equal(accepted.receipt.evidenceType,'public_listing');assert.deepEqual(accepted.receipt.successProof.evidenceSignals,result.evidenceSignals);
 const rejected=originalSubmitSuccessDecision({...task,baselineEvidence:signal.text},{matched:true,evidence:signal.text,evidenceUrl:signal.url});assert.equal(rejected.proof.ok,false);assert.equal(rejected.unconfirmed,true);
 assert.equal(originalSubmitSuccessDecision({url:signal.url},{matched:true,evidence:signal.text}).proof.ok,false);
});

function fixture(){const store=new Store(':memory:'),runtime=new Runtime(store,'unused-proof-fixture'),task={id:'t',runId:'r',profileId:'p',destinationKey:'site.example/submit',url:signal.url,version:1,controller:'executor',status:'submitting',attemptBoundary:'original-attempt',profileSnapshot:{id:'p',fields:{Name:'Original'}},actualSubmission:{fields:[{label:'Product name',value:'Original'}]}};store.set('pair',{endpoint:'https://fixture.example',workspaceId:'default'});store.set('task:t',task);return{store,runtime,task};}

test('native accept retains the original proof in its durable receipt and a changed task cannot receive a late screenshot',async()=>{
 for(const mode of ['ordinary','late-owner','late-unknown','late-workspace']){const f=fixture();try{
  const page={url:()=>signal.url,isClosed:()=>false},sandbox=vm.createContext({originalSubmitSuccessDecision,workbenchScope,isDeepStrictEqual,plain,path,prepareIndexNotification:()=>({status:'disabled'}),capturePageEvidence:async()=>{if(mode==='ordinary')return;if(mode==='late-workspace')f.store.set('pair',{endpoint:'https://other.example'});else f.store.set('task:t',{...f.store.get('task:t'),...(mode==='late-owner'?{controller:'supervisor',version:2,reason:'Keep owner'}:{status:'submitted_unconfirmed',attemptBoundary:'late-unknown',reason:'Keep unknown'})});}}),accept=vm.runInContext('({'+Runtime.prototype.accept.toString()+'}).accept',sandbox);
  const operation=accept.call(f.runtime,f.task,page,{matched:true,evidence:signal.text,publicationStatus:'pending_moderation',evidenceSignals:[signal]});
  if(mode==='ordinary'){await operation;assert.equal(f.task.receipt.evidenceType,'visible_confirmation');assert.equal(f.task.receipt.publicationStatus,'pending_moderation');assert.equal(f.task.receipt.confirmedBy,'agent');assert.deepEqual(f.task.receipt.successProof.evidenceSignals,[signal]);assert.ok(f.task.screenshot);assert.equal(f.task.cloudVerified,false);}else{await assert.rejects(operation,error=>error.staleTask===true);const saved=f.store.get('task:t');assert.equal(saved.screenshot,undefined);if(mode==='late-owner')assert.equal(saved.controller,'supervisor');if(mode==='late-unknown')assert.equal(saved.attemptBoundary,'late-unknown');}
 }finally{f.store.close();}}
});

test('unproven and repeated native acceptance cannot create or replace a receipt',async()=>{
 for(const mode of ['unmatched','no-action','same-baseline','already-received']){const f=fixture();try{if(mode==='no-action')delete f.task.attemptBoundary;if(mode==='same-baseline')f.task.baselineEvidence=signal.text;if(mode==='already-received')f.task.receipt={evidence:'Keep original'};f.store.set('task:t',f.task);const before=structuredClone(f.store.get('task:t'));
  await assert.rejects(f.runtime.accept(f.task,{url:()=>signal.url,isClosed:()=>false},{matched:mode!=='unmatched',evidence:signal.text,evidenceUrl:signal.url}));assert.deepEqual(f.store.get('task:t'),before);assert.equal(f.store.pendingCount(),0);
 }finally{f.store.close();}}
});

test('native cloud record and readback preserve published and proof metadata instead of demoting or acknowledging truncation',()=>{
 const decision=originalSubmitSuccessDecision({url:signal.url,attemptBoundary:'original-attempt'},{evidence:'Published Original',publicationStatus:'published',publicUrl:'https://site.example/listing/original',evidenceUrl:'https://site.example/listing/original'}),record=nativeSuccessRecord({id:'t',runId:'r',profileId:'p',url:signal.url,destinationKey:'site.example/submit',attemptBoundary:'original-attempt',actualSubmission:{fields:[]},receipt:{...decision.receipt,url:signal.url}});
 assert.equal(record.publicationStatus,'published');assert.equal(record.publicUrl,'https://site.example/listing/original');assert.equal(record.evidenceUrl,record.publicUrl);assert.equal(record.evidenceType,'public_listing');assert.equal(nativeReceiptReadbackMatches(structuredClone(record),record),true);
 for(const field of ['publicationStatus','publicUrl','evidenceUrl','confirmedBy','evidenceType','successProof']){const truncated=structuredClone(record);delete truncated[field];assert.equal(nativeReceiptReadbackMatches(truncated,record),false,field);}
 const legacy={taskId:'old',evidence:'Keep original',actualSubmission:{fields:[]}};assert.equal(nativeReceiptReadbackMatches({...legacy,publicationStatus:'pending_moderation'},legacy),true);
});

test('an unsynced original receipt keeps its verification page even when acceptance cleanup is otherwise eligible',async()=>{
 const f=fixture();try{Object.assign(f.task,{workbenchBatchId:'b',status:'finished',screenshot:'not-read-before-cloud-proof',receipt:{evidence:'Keep site receipt'},targetId:'original-target',cloudVerified:false});f.store.set('task:t',f.task);f.runtime.findPage=async()=>{throw Error('Cloud proof must precede page access');};await closeAcceptanceTask(f.runtime,f.task);assert.equal(f.store.pendingCount(),0);assert.equal(f.task.tabClosedAt,undefined);}finally{f.store.close();}
});

test('late artifact and receipt readbacks cannot overwrite a changed original task or workspace',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'el-proof-sync-'));
 try{for(const stage of ['artifact','artifact-read','receipt','snapshot','conflict-snapshot'])for(const change of ['owner','unknown','workspace','active']){
  const f=fixture();try{
   const receipt=originalSubmitSuccessDecision(f.task,{evidence:signal.text,evidenceSignals:[signal],publicationStatus:'submitted'}).receipt;
   Object.assign(f.task,{status:'finished',receipt,cloudVerified:false});
   const bytes=Buffer.from('isolated screenshot bytes');if(stage.startsWith('artifact')){f.task.screenshot=path.join(home,'evidence.png');await writeFile(f.task.screenshot,bytes);}f.store.set('task:t',f.task);
   let saved,changed=false;
   const replace=()=>{changed=true;if(change==='workspace')f.store.set('pair',{endpoint:'https://new-workspace.example',workspaceId:'new'});else if(change==='active')f.runtime.activeTaskIds=new Set(['t']);else f.store.set('task:t',{...f.store.get('task:t'),...(change==='owner'?{controller:'supervisor',version:99,reason:'Keep new owner'}:{status:'submitted_unconfirmed',attemptBoundary:'Keep unknown',reason:'Keep unknown'})});saved=structuredClone(f.store.get('task:t'));};
   const {createHash}=await import('node:crypto');
   Object.defineProperty(f.runtime,'cloud',{value:{flush:async store=>{for(const e of store.pending())store.ack(e.id);},request:async(route,input)=>{
    if(route===stage||stage==='conflict-snapshot'&&route==='snapshot')replace();
    if(route==='artifact')return{ref:'isolated-artifact',sha256:createHash('sha256').update(bytes).digest('hex')};
    if(route==='artifact-read')return{dataUrl:'data:image/png;base64,'+bytes.toString('base64')};
    if(route==='receipt'){if(stage==='conflict-snapshot')throw Object.assign(Error('Conflict reply'),{status:409});return{ok:true};}
    if(route==='snapshot')return{documents:{submissionRecords:{[queue.submissionRecordKey(f.task.destinationKey,f.task.profileId)]:nativeSuccessRecord(f.task)}},revisions:{submissionRecords:3}};
    throw Error('Unexpected route '+route);
   }}});
   await assert.rejects(f.runtime.synchronize(),error=>error.staleTask===true,stage+'/'+change);assert.equal(changed,true);assert.deepEqual(f.store.get('task:t'),saved);assert.equal(f.store.get('task:t').cloudVerified,false);assert.equal(f.store.get('task:t').artifactRef,undefined);
  }finally{f.store.close();}
 }}finally{assert.ok(path.resolve(home).startsWith(path.resolve(tmpdir())+path.sep)&&home.includes('el-proof-sync-'));await rm(home,{recursive:true,force:true});}
});

test('original proof public result and pending receipt event survive a real SQLite close and reopen',async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'el-proof-reopen-')),file=path.join(home,'ledger.sqlite');let store;
 try{
  store=new Store(file);const task={id:'original-task',runId:'original-run',profileId:'original-product',version:1,url:signal.url,destinationKey:'site.example/submit',attemptBoundary:'Keep original attempt',status:'finished',actualSubmission:{fields:[{label:'Name',value:'Original'}]}};
  task.receipt={...originalSubmitSuccessDecision(task,{evidence:'Original is published',publicationStatus:'published',publicUrl:'https://site.example/listing/original',evidenceUrl:'https://site.example/listing/original'}).receipt,syncStatus:'pending'};task.cloudVerified=false;const event=store.transition(task,'receipt');store.close();store=new Store(file);
  assert.deepEqual(store.get('task:'+task.id),task);assert.deepEqual(store.pending().find(row=>row.id===event.id),event);assert.deepEqual(nativeSuccessRecord(store.get('task:'+task.id)),nativeSuccessRecord(task));
 }finally{store?.close();assert.ok(path.resolve(home).startsWith(path.resolve(tmpdir())+path.sep)&&home.includes('el-proof-reopen-'));await rm(home,{recursive:true,force:true});}
});
