import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Runtime} from '../executor/src/runtime.mjs';
import {Store} from '../executor/src/store.mjs';
import {closeAcceptanceTask} from '../executor/src/acceptance-cleanup.mjs';
import * as registration from '../executor/src/task-page-registration.mjs';
const task=()=>({id:'original',runId:'run',workbenchBatchId:'batch',profileId:'photo',profileRevision:20,controller:'executor',status:'pending',siteStatus:'not_submitted',url:'https://directory.example/form',targetId:'old-target',browserInstance:'browser',tabClosedAt:'2026-10-14T03:57:04.185Z',closedTargetIds:['old-target'],closeReason:'Old blocker',attentionType:'site_form_unavailable',reason:'Old blocker',recoveryCheckpoint:{sourceTargetId:'old-target',sourceBrowserInstance:'browser',closedAt:'2026-10-14T03:57:04.185Z',evidencePath:'old-blocker.png',blockedReason:'Old blocker'}});

for(const entry of ['automatic','prepare'])test(`${entry} new-page registration archives the old closure and clears current page blockers`,async()=>{
 const t=task(),previous=structuredClone(t.recoveryCheckpoint),source=(entry==='automatic'?Runtime.prototype.work:Runtime.prototype.control).toString(),start=source.indexOf(entry==='automatic'?'const target = targetInfo.targetId;':'const {targetId}=await getTargetInfo(this.context,page);'),end=source.indexOf(entry==='automatic'?'if(!active())return;':'await page.goto(recovery',start);assert.ok(start>=0&&end>start);
 const sandbox=vm.createContext({task:t,reused:false,recovery:t.url,page:{},targetInfo:{targetId:'new-target'},hasPendingNavigation:()=>false,getTargetInfo:async()=>({targetId:'new-target'}),...registration}),updates=[];
 const register=vm.runInContext('(async function(){'+source.slice(start,end)+'})',sandbox);await register.call({host:{startedAt:'browser'},context:{},update(current,patch){Object.assign(current,patch);updates.push(patch);}});
 assert.equal(t.targetId,'new-target');assert.equal(t.tabClosedAt,null);assert.deepEqual(t.closedTargetIds,[]);assert.equal(t.closeReason,'');assert.equal(t.attentionType,'');assert.equal(t.recoveryCheckpoint,null);assert.deepEqual(t.recoveryHistory[0].previous.recoveryCheckpoint,previous);assert.equal(t.recoveryHistory[0].previous.targetId,'old-target');assert.equal(t.pageHistory,undefined);assert.equal(t.pageOwnership,undefined);assert.equal(updates.length,1);
});

for(const field of ['attemptBoundary','receipt'])test(`an automated new-page allocation rejects an existing ${field} before creating a page`,async()=>{
 const t={...task(),[field]:field==='receipt'?{evidence:'Retained receipt'}:'keep-boundary'},source=Runtime.prototype.work.toString(),start=source.indexOf('if (!page) {'),end=source.indexOf("page.on('dialog'",start);assert.ok(start>=0&&end>start);let allocations=0;
 const sandbox=vm.createContext({task:t,page:null,continuous:false,...registration}),allocate=vm.runInContext('(async function(){'+source.slice(start,end)+'})',sandbox);
 await assert.rejects(()=>allocate.call({context:{newPage:async()=>{allocations++;return{};}}}));assert.equal(allocations,0);assert.equal(t[field],field==='receipt'?t.receipt:'keep-boundary');
});

async function fixture(mode){
 const home=await mkdtemp(join(tmpdir(),'el-current-page-close-')),screenshot=join(home,'new-receipt.png');await writeFile(screenshot,'new receipt screenshot');const store=new Store(':memory:'),t={...task(),targetId:'new-target',status:'finished',siteStatus:'accepted',screenshot,receipt:{evidence:'Form submitted'},cloudVerified:true,attemptBoundary:'new-attempt',actualSubmission:{fields:[{name:'toolName',value:'OldPhotoLive AI'}]}};
 if(mode==='current-closed')t.closedTargetIds=['new-target'];
 if(mode==='missing-closed-targets')delete t.closedTargetIds;
 if(mode==='unknown-browser')delete t.recoveryCheckpoint.sourceBrowserInstance;
 if(mode==='other-browser')t.recoveryCheckpoint.sourceBrowserInstance='other-browser';
 if(mode==='checkpoint-other-close')t.recoveryCheckpoint.closedAt='other-close-time';
 if(mode==='checkpoint-other-target')t.recoveryCheckpoint.sourceTargetId='unrelated-target';
 if(mode==='unconfirmed-receipt')t.cloudVerified=false;
 if(mode==='unknown-attempt'){delete t.receipt;t.status='submitted_unconfirmed';t.siteStatus='sent_unconfirmed';}
 store.set('task:original',t);store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});store.set('paused',false);store.set('workbenchBatch:batch',{id:'batch',scope:'https://cloud.example|default',status:mode==='user-pause'?'paused':'running',pauseReasonCode:mode==='user-pause'?'user_pause':undefined,pausedTaskIds:mode==='user-pause'?['original']:[],config:{unattended:false},items:[{taskId:t.id}]});const oldAcceptance={status:'paused',cursor:13,count:30};store.set('acceptanceBatch',oldAcceptance);if(mode==='user-pause')store.set('paused',true);
 const closed=[],owned={url:()=>t.url,isClosed:()=>false,close:async()=>{if(mode==='reopened'){const current=store.get('task:original');assert.ok(current.recoveryCheckpoint.screenshotSha256);assert.equal(current.recoveryCheckpoint.sourceTargetId,'new-target');assert.equal(current.recoveryHistory[0].previous.targetId,'old-target');}closed.push('new-target');}},personal={url:()=> 'https://personal.example',isClosed:()=>false,close:async()=>closed.push('personal')};
 const runtime={store,home,host:{startedAt:'browser'},findPage:async()=>owned,update(current,patch,type){Object.assign(current,patch);store.transition(current,type);},context:{pages:()=>[owned,personal],newCDPSession:async page=>({detach:async()=>{},send:async()=>({targetInfo:{targetId:page===owned?'new-target':'personal'}})})}};
 return{store,t,runtime,closed,oldAcceptance,async close(){store.close();const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-current-page-close-'));await rm(absolute,{recursive:true,force:true});}};
}

test('a verified receipt page with a proven previous-target closure closes the current owned target',async()=>{
 const f=await fixture('reopened');try{await closeAcceptanceTask(f.runtime,f.t);assert.deepEqual(f.closed,['new-target']);assert.deepEqual(f.t.closedTargetIds,['new-target']);assert.notEqual(f.t.tabClosedAt,'2026-10-14T03:57:04.185Z');assert.equal(f.t.recoveryCheckpoint.stage,'receipt_verification');assert.equal(f.t.attentionType,'');assert.equal(f.t.receipt.evidence,'Form submitted');assert.equal(f.t.attemptBoundary,'new-attempt');assert.deepEqual(f.store.get('acceptanceBatch'),f.oldAcceptance);assert.equal(f.t.pageHistory,undefined);}finally{await f.close();}
});

test('normal receipt synchronization reaches cleanup for an old closure attached to a new target',async()=>{
 const f=await fixture('reopened');try{f.t.artifactRef='cloud-artifact://verified-screenshot';f.store.set('task:original',f.t);f.runtime.cloud={flush:async()=>{},request:async()=>{throw Error('No network request expected for a cloud-verified receipt');}};f.runtime.status=()=>({ok:true});await Runtime.prototype.synchronizeNow.call(f.runtime);assert.deepEqual(f.closed,['new-target']);assert.deepEqual(f.store.get('task:original').closedTargetIds,['new-target']);assert.equal(f.store.get('task:original').receipt.evidence,'Form submitted');assert.equal(f.store.get('task:original').attemptBoundary,'new-attempt');}
 finally{await f.close();}
});

for(const mode of ['current-closed','missing-closed-targets','unknown-browser','other-browser','checkpoint-other-close','checkpoint-other-target','unconfirmed-receipt','unknown-attempt','user-pause'])test(`current-page cleanup preserves ${mode} evidence and ownership`,async()=>{
 const f=await fixture(mode);try{const before=f.store.get('task:original');await closeAcceptanceTask(f.runtime,f.t);assert.deepEqual(f.closed,[]);assert.deepEqual(f.store.get('task:original'),before);assert.deepEqual(f.store.get('acceptanceBatch'),f.oldAcceptance);}finally{await f.close();}
});
