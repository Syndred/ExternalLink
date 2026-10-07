import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {sidepanelOpened,sidepanelClosed,captureSinglePageContext} from '../executor/src/single-page.mjs';
import {manualSubmit} from '../executor/src/manual-controls.mjs';
function fixture(){
 const store=new Store(':memory:'),runtime=new Runtime(store,'isolated');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'original'});store.set('paused',true);
 const profile={id:'p',name:'Original P',fields:{Name:'Original P',Url:'https://product.example'}},task={id:'original',runId:'original-run',profileId:'p',url:'https://target.example/form',destinationKey:'target.example/form',targetId:'original-target',browserInstance:'original-browser',status:'needs_manual',profileSnapshot:profile,profileRevision:2};
 store.set('run:'+task.runId,{id:task.runId,profile});store.set('task:'+task.id,task);store.set('acceptanceBatch',{id:'fixed',status:'paused',cursor:13,count:30});
 const {panel}=sidepanelOpened(runtime,{profileId:'p',targetId:task.targetId}),input={panelId:panel.id,profileId:'p',targetId:task.targetId};let ticks=0;
 Object.defineProperty(runtime,'cloud',{value:{request:async()=>({documents:{siteProfiles:{p:profile},submissionRecords:{}},revisions:{siteProfiles:2}})}});
 runtime.lease=async()=>{};runtime.findPage=async()=>({url:()=>task.url});runtime.synchronize=async()=>{for(const event of store.pending())store.ack(event.id);};runtime.tick=()=>ticks++;
 return{store,runtime,task,input,ticks:()=>ticks};
}
test('captured single-page selection becomes stale on another product, another page and a repeated selection generation',()=>{
 for(const change of [{profileId:'q'},{targetId:'other-target'},{}]){const f=fixture();try{const check=captureSinglePageContext(f.runtime,f.input);check();sidepanelOpened(f.runtime,{...f.input,...change});assert.throws(check,/切换/);assert.deepEqual(f.store.get('task:'+f.task.id),f.task);assert.equal(f.store.get('acceptanceBatch').cursor,13);assert.equal(f.ticks(),0);}finally{f.store.close();}}
});
test('single-page context rejects mismatched initial selection and cannot survive panel close, workspace switch or queue activation',()=>{
 for(const mode of ['mismatch','closed','workspace','running']){const f=fixture();try{
  if(mode==='mismatch'){assert.throws(()=>captureSinglePageContext(f.runtime,{...f.input,targetId:'other-target'}),/切换/);continue;}
  const check=captureSinglePageContext(f.runtime,f.input);if(mode==='closed')sidepanelClosed(f.runtime,{panelId:f.input.panelId});if(mode==='workspace')f.store.set('pair',{endpoint:'https://cloud.example',workspaceId:'another'});if(mode==='running')f.store.set('paused',false);assert.throws(check,/关闭|变化|切换/);assert.equal(f.ticks(),0);assert.equal(f.store.get('singleTaskId'),null);
 }finally{f.store.close();}}
});
test('manual single-page continuation cannot activate after the selected page changes during lease or cloud acknowledgement',async()=>{
 for(const boundary of ['lease','acknowledgement']){const f=fixture();try{
  const check=captureSinglePageContext(f.runtime,f.input),change=()=>sidepanelOpened(f.runtime,{...f.input,targetId:'new-target'});
  if(boundary==='lease')f.runtime.lease=async()=>change();else f.runtime.synchronize=async()=>change();
  await assert.rejects(manualSubmit(f.runtime,{taskId:f.task.id,expectedRunId:f.task.runId,expectedTargetId:f.task.targetId,ordinaryPermissionsAuthorized:true},{assertContext:check}),/切换/);
  assert.equal(f.ticks(),0);assert.equal(f.store.get('paused'),true);assert.equal(f.store.get('singleTaskId'),null);assert.equal(f.store.get('task:'+f.task.id).attemptBoundary,undefined);assert.equal(f.store.get('acceptanceBatch').cursor,13);
  if(boundary==='acknowledgement'){assert.equal(f.store.get('task:'+f.task.id).manualSubmissionConsent,null);assert.equal(f.store.get('task:'+f.task.id).fillOnlyRun,true);assert.equal(f.store.get('task:'+f.task.id).status,'needs_manual');assert.equal(f.store.pendingCount(),2);}
 }finally{f.store.close();}}
});
test('unchanged original single-page selection permits exactly one explicitly authorized continuation',async()=>{
 const f=fixture();try{const result=await manualSubmit(f.runtime,{taskId:f.task.id,expectedRunId:f.task.runId,expectedTargetId:f.task.targetId,ordinaryPermissionsAuthorized:true},{assertContext:captureSinglePageContext(f.runtime,f.input)});assert.equal(result.taskId,f.task.id);assert.equal(f.ticks(),1);assert.equal(f.store.get('singleTaskId'),f.task.id);assert.equal(f.store.get('task:'+f.task.id).profileRevision,2);assert.equal(f.store.get('task:'+f.task.id).attemptBoundary,undefined);assert.equal(f.store.get('acceptanceBatch').cursor,13);}finally{f.store.close();}
});
