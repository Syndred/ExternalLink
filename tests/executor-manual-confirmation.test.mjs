import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {nativeSuccessRecord} from '../executor/src/original-submission-proof.mjs';

function fixture(file=':memory:'){
 const store=new Store(file),runtime=new Runtime(store,'unused-confirmation-home'),task={id:'original',runId:'original-run',profileId:'p',profileRevision:2,profileSnapshot:{id:'p',fields:{Name:'Original',Url:'https://product.example'}},url:'https://target.example/submit',destinationKey:'target.example/submit',status:'needs_manual',siteStatus:'not_submitted',controller:'executor',targetId:'original-page',browserInstance:'original-browser',indexNotificationPreference:false};
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one',deviceId:'original',storageBackend:'d1'});store.set('paused',true);store.set('task:'+task.id,task);
 Object.defineProperty(runtime,'cloud',{value:{request:async()=>({documents:{submissionRecords:{}}})}});
 runtime.activeTaskIds=new Set();runtime.lease=async()=>{};runtime.tick=()=>{};runtime.synchronize=async()=>{const current=store.get('task:original');runtime.update(current,{cloudVerified:true},'fixture_independent_readback');};
 const input={taskId:task.id,runId:task.runId,expectedTargetId:task.targetId};
 return{runtime,store,task,input,preview:()=>runtime.control('previewManualConfirmation',input)};
}

test('manual confirmation retains original nonce, run and parked-status requirements and default evidence',async()=>{
 const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),start=source.indexOf('async function confirmSubmissionSuccess('),body=source.slice(start,source.indexOf('\nasync function ',start+1));
 for(const kind of ['valid','wrong_run','wrong_nonce','not_parked']){
  const f=fixture();try{const p=await f.preview(),message={...f.input,confirmationNonce:p.confirmationNonce};if(kind==='wrong_run')message.runId='changed';if(kind==='wrong_nonce')message.confirmationNonce='changed';if(kind==='not_parked')f.store.set('task:original',{...f.task,status:'pending'});
   const originalTask={id:f.task.id,status:kind==='not_parked'?'pending':'needs_manual',confirmationNonce:p.confirmationNonce},saved=[],state={tasks:[originalTask],runId:f.task.runId,parkedTaskIds:new Set([f.task.id]),activeTabs:new Map()};
   const context=vm.createContext({state,recordSubmittedProject:async t=>{saved.push(t);return{status:'success'};},recordUnattendedSuccess:async()=>{},broadcastTaskUpdate:()=>{},unattendedEnabled:()=>false,persistParkedTaskIds:async()=>{},syncUnattendedManualCapacity:async()=>{},message});vm.runInContext(body,context);
   if(kind==='valid'){await vm.runInContext('confirmSubmissionSuccess(message)',context);await f.runtime.control('confirmSubmissionSuccess',message);const result=f.store.get('task:original');assert.equal(result.receipt.evidence,saved[0].successEvidence);assert.equal(result.confirmedBy,originalTask.confirmedBy);assert.equal(result.receipt.evidenceType,'manual_confirmation');assert.equal(result.status,'finished');assert.equal(result.attemptBoundary,undefined);assert.deepEqual(result.actualSubmission.fields,{});assert.equal(f.store.get('paused'),true);assert.equal(nativeSuccessRecord(result).submittedAt,result.receipt.receivedAt);}
   else{await assert.rejects(vm.runInContext('confirmSubmissionSuccess(message)',context));await assert.rejects(f.runtime.control('confirmSubmissionSuccess',message));assert.equal(f.store.get('task:original').receipt,undefined);assert.equal(f.store.pendingCount(),0);}
  }finally{f.store.close();}
 }
});

test('unknown attempt, actual fields and pending receipt survive failed sync and SQLite restart; retry creates no second receipt',async()=>{
 const home=mkdtempSync(join(tmpdir(),'el-manual-confirm-')),file=join(home,'outbox.sqlite'),f=fixture(file);let reopened;
 try{const actual={fields:{Name:'Actual original'},attachments:[{sha256:'original-media'}]},task={...f.task,status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:'original-attempt',actualSubmission:actual};f.store.set('task:original',task);const p=await f.preview(),message={...f.input,confirmationNonce:p.confirmationNonce,evidence:'I checked the original account receipt'};f.runtime.synchronize=async()=>{throw Error('Independent readback unavailable');};let result=await f.runtime.control('confirmSubmissionSuccess',message);assert.equal(result.pending,true);const pending=f.store.get('task:original');assert.equal(pending.status,'submitted_unconfirmed');assert.equal(pending.cloudVerified,false);assert.equal(pending.attemptBoundary,task.attemptBoundary);assert.deepEqual(pending.actualSubmission,actual);f.store.close();
  reopened=new Store(file);f.runtime.store=reopened;f.runtime.synchronize=async()=>{const current=reopened.get('task:original');if(current.cloudVerified!==true)f.runtime.update(current,{cloudVerified:true},'fixture_independent_readback');};const nonce=(await f.preview()).confirmationNonce;assert.equal(nonce,p.confirmationNonce);result=await f.runtime.control('confirmSubmissionSuccess',message);assert.equal(result.confirmed,true);const completed=reopened.get('task:original');assert.deepEqual(completed.receipt,pending.receipt);assert.equal(completed.status,'finished');assert.equal(completed.attemptBoundary,task.attemptBoundary);assert.deepEqual(completed.actualSubmission,actual);const count=reopened.pendingCount();assert.equal((await f.runtime.control('confirmSubmissionSuccess',message)).confirmed,true);assert.equal(reopened.pendingCount(),count);
 }finally{reopened?.close();if(!reopened)f.store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep));rmSync(home,{recursive:true,force:true});}
});

test('late cloud, task, product, device and controller changes cannot create or overwrite manual receipts',async()=>{
 for(const stage of ['snapshot','lease','sync'])for(const kind of ['workspace','device','product','target','attempt','controller','nonce']){
  const f=fixture();try{const p=await f.preview(),message={...f.input,confirmationNonce:p.confirmationNonce,evidence:'Original account receipt'},mutate=()=>{if(kind==='workspace'||kind==='device')f.store.set('pair',{...f.store.get('pair'),[kind==='workspace'?'workspaceId':'deviceId']:'changed'});else if(kind==='nonce')f.store.set('manualConfirmation:original',{...f.store.get('manualConfirmation:original'),id:'changed'});else f.store.set('task:original',{...f.store.get('task:original'),...({product:{profileId:'other'},target:{targetId:'other'},attempt:{attemptBoundary:'foreign-attempt'},controller:{controller:'supervisor'}}[kind])});};
   if(stage==='snapshot')f.runtime.cloud.request=async()=>{mutate();return{documents:{submissionRecords:{}}};};if(stage==='lease')f.runtime.lease=async()=>{mutate();};if(stage==='sync')f.runtime.synchronize=async()=>{mutate();};
   await assert.rejects(f.runtime.control('confirmSubmissionSuccess',message));const current=f.store.get('task:original');assert.equal(current.cloudVerified,stage==='sync'?false:undefined);if(stage!=='sync')assert.equal(current.receipt,undefined);else assert.equal(current.status,'needs_manual');
  }finally{f.store.close();}
 }
});

test('active workers, existing receipts and cloud duplicates refuse manual confirmation before receipt creation',async()=>{
 for(const kind of ['worker','receipt','cloud_duplicate']){const f=fixture();try{const p=await f.preview();if(kind==='worker')f.runtime.activeTaskIds.add(f.task.id);if(kind==='receipt')f.store.set('task:original',{...f.task,receipt:{evidence:'Protected'}});if(kind==='cloud_duplicate')f.runtime.cloud.request=async()=>({documents:{submissionRecords:{'target.example::p':{profileId:'p',destinationUrl:f.task.url,status:'success',confirmedBy:'manual',evidence:'Original real receipt'}}}});await assert.rejects(f.runtime.control('confirmSubmissionSuccess',{...f.input,confirmationNonce:p.confirmationNonce,evidence:'New'}));assert.equal(f.store.pendingCount(),0);}finally{f.store.close();}}
});

test('manual public results retain publication metadata and the page bridge cannot request or confirm success',async()=>{
 const f=fixture();try{f.store.set('task:original',{...f.task,publicUrl:'https://target.example/products/original',publicationStatus:'published',evidenceUrl:'https://target.example/products/original'});for(const action of ['previewManualConfirmation','confirmSubmissionSuccess']){assert.equal((await f.runtime.bridge(f.task,{action,runId:f.task.runId,taskId:f.task.id})).ok,false);assert.equal(f.store.get('manualConfirmation:original'),null);}const p=await f.preview();await f.runtime.control('confirmSubmissionSuccess',{...f.input,confirmationNonce:p.confirmationNonce,evidence:'I verified the public product listing'});const record=nativeSuccessRecord(f.store.get('task:original'));assert.equal(record.publicUrl,'https://target.example/products/original');assert.equal(record.publicationStatus,'published');assert.equal(record.evidenceUrl,record.publicUrl);assert.equal(record.confirmedBy,'manual');assert.equal(record.evidenceType,'manual_confirmation');}finally{f.store.close();}
});

test('authenticated native services and actual workbench save original manual confirmation through D1',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../executor/test/manual-confirmation.mjs',import.meta.url))],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/"passed":true/);
});

test('empty native stores recover pending original confirmation including legacy markers, without replacing human evidence',async()=>{
 for(const legacy of [false,true]){const f=fixture();try{f.runtime.synchronize=async()=>{throw Error('Receipt readback unavailable');};const preview=await f.preview(),input={...f.input,confirmationNonce:preview.confirmationNonce,evidence:'Original owner receipt'};await f.runtime.control('confirmSubmissionSuccess',input);const source=f.store.get('task:original');if(legacy)for(const key of ['scope','frozenSha256','receiptSha256'])delete source.manualConfirmation[key];f.store.db.prepare('DELETE FROM state WHERE id IN (?,?)').run('task:original','manualConfirmation:original');f.runtime.cloud.request=async route=>route.includes('view=inventory')?{runs:[{id:f.task.runId}],tasks:[{id:f.task.id}]}:{runs:[{id:f.task.runId,profileId:f.task.profileId}],tasks:[source]};await f.runtime.restoreCloud();const continued=await f.preview();assert.equal(continued.pending,true);assert.equal(continued.confirmationNonce,preview.confirmationNonce);assert.equal(f.store.get('manualConfirmation:original').recoveryOnly,true);f.runtime.synchronize=async()=>{const current=f.store.get('task:original');if(!current.cloudVerified)f.runtime.update(current,{cloudVerified:true},'fixture_independent_readback');};const result=await f.runtime.control('confirmSubmissionSuccess',{...input,evidence:'Cannot replace original evidence'});assert.equal(result.confirmed,true);assert.equal(f.store.get('task:original').receipt.evidence,source.receipt.evidence);assert.equal(f.store.get('paused'),true);}finally{f.store.close();}}
});

test('manual recovery rejects changed proof, actual fields or scope atomically and never adopts an arbitrary legacy local receipt',async()=>{
 for(const mode of ['scope','fields','profile','evidence','proof_id','hash','legacy_local']){const f=fixture();try{f.runtime.synchronize=async()=>{throw Error('Original pending readback');};const p=await f.preview();await f.runtime.control('confirmSubmissionSuccess',{...f.input,confirmationNonce:p.confirmationNonce,evidence:'Original'});const source=f.store.get('task:original');if(mode==='scope')source.manualConfirmation.scope='other-scope';if(mode==='fields')source.actualSubmission.fields.Name='Foreign';if(mode==='profile')source.profileSnapshot.fields.Name='Foreign';if(mode==='evidence')source.receipt.evidence='Foreign';if(mode==='proof_id')source.manualConfirmation.id='other-proof';if(mode==='hash')source.manualConfirmation.receiptSha256='0'.repeat(64);f.store.db.prepare('DELETE FROM state WHERE id IN (?,?)').run('task:original','manualConfirmation:original');if(mode==='legacy_local'){for(const key of ['scope','frozenSha256','receiptSha256'])delete source.manualConfirmation[key];f.store.set('task:original',source);await assert.rejects(f.preview());assert.equal(f.store.get('manualConfirmation:original'),null);}else{f.runtime.cloud.request=async route=>route.includes('view=inventory')?{runs:[{id:f.task.runId}],tasks:[{id:f.task.id}]}:{runs:[{id:f.task.runId}],tasks:[source]};await assert.rejects(f.runtime.restoreCloud());assert.equal(f.store.get('task:original'),null);assert.equal(f.store.get('run:'+f.task.runId),null);assert.equal(f.store.get('manualConfirmation:original'),null);}assert.equal(f.store.get('paused'),true);}finally{f.store.close();}}
});

test('device and backend switches during original cloud restore abandon all late tasks and confirmation credentials',async()=>{
 for(const change of [{deviceId:'other'},{storageBackend:'neon'}]){const f=fixture();try{f.store.db.prepare('DELETE FROM state WHERE id=?').run('task:original');f.runtime.cloud.request=async()=>{f.store.set('pair',{...f.store.get('pair'),...change});return{runs:[{id:'old-run'}],tasks:[f.task]};};await assert.rejects(f.runtime.restoreCloud(),/工作区|设备|后端/);assert.equal(f.store.get('task:original'),null);assert.equal(f.store.get('run:old-run'),null);assert.equal(f.store.values('manualConfirmation:').length,0);assert.equal(f.runtime.hydrating,false);}finally{f.store.close();}}
});

for(const stage of ['after','before'])test('actual authenticated D1 workbench resumes a pending confirmation from an empty store: '+stage,()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../executor/test/manual-confirmation.mjs',import.meta.url)),'--empty-recovery-'+stage],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/"emptyRecovery":true/);
});
