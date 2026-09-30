import test from 'node:test';import assert from 'node:assert/strict';
import {Runtime} from '../executor/src/runtime.mjs';import {Store} from '../executor/src/store.mjs';
test('workbench takeover preserves original task and evidence when the old browser is gone',async()=>{
 const store=new Store(':memory:');store.set('paused',true);const task={id:'t',runId:'original',profileId:'JevPlay',url:'https://example.com/submit',status:'needs_manual',siteStatus:'not_submitted',version:2,controllerId:'executor',artifactRef:'keep',reason:'缺少必填字段'};store.set('task:t',task);
 const runtime=new Runtime(store,'.');runtime.synchronize=async()=>{};runtime.findPage=async()=>{throw Error('old browser gone');};let handoffs=0;
 Object.defineProperty(runtime,'cloud',{value:{request:async(route,input)=>{assert.equal(route,'handoff');assert.equal(input.taskId,'t');assert.equal(input.version,2);handoffs++;return{version:3};}}});
 const result=await runtime.control('takeover',{taskId:'t',surface:'workbench'});const saved=store.get('task:t');assert.equal(handoffs,1);assert.equal(saved.runId,'original');assert.equal(saved.artifactRef,'keep');assert.equal(saved.status,'needs_manual');assert.equal(saved.controller,'supervisor');assert.equal(saved.workbenchHandoff.previousReason,task.reason);assert.equal(result.takeover.url,task.url);assert.equal(result.takeover.surface,'workbench');assert.equal(store.get('paused'),true);
 await assert.rejects(runtime.control('continueTask',{taskId:'t',supervisorDisconnected:true}),/工作台接管/);store.close();
});
test('workbench takeover cannot reopen attempts, receipts, finished tasks or unsafe URLs',async()=>{
 for(const patch of [{attemptBoundary:'keep'},{receipt:{evidence:'keep'}},{status:'finished'},{url:'javascript:alert(1)'}]){
  const store=new Store(':memory:');store.set('paused',true);store.set('task:t',{id:'t',version:2,status:'needs_manual',url:'https://example.com/submit',...patch});const runtime=new Runtime(store,'.');runtime.synchronize=async()=>{};runtime.findPage=async()=>{throw Error('old browser gone');};let calls=0;Object.defineProperty(runtime,'cloud',{value:{request:async()=>{calls++;return{version:3};}}});await assert.rejects(runtime.control('takeover',{taskId:'t',surface:'workbench'}),/未提交/);assert.equal(calls,0);assert.equal(store.get('task:t').version,2);store.close();
 }
});
test('a failed handoff before page access does not change the cloud controller',async()=>{
 const store=new Store(':memory:');store.set('paused',true);store.set('task:t',{id:'t',version:2,controllerId:'executor',targetId:'old'});
 const runtime=new Runtime(store,'.');runtime.synchronize=async()=>{};runtime.findPage=async()=>{throw new Error('old browser gone');};
 let handoffs=0;Object.defineProperty(runtime,'cloud',{value:{request:async()=>{handoffs++;return {version:3};}}});
 await assert.rejects(runtime.control('takeover',{taskId:'t'}),/old browser/);assert.equal(handoffs,0);assert.equal(store.get('task:t').version,2);store.close();
});
test('version-only lost handoff is refreshed through a new CAS lease, preserving attempts',async()=>{
 const store=new Store(':memory:');const runtime=new Runtime(store,'.');
 const task={id:'t',version:2,controllerId:runtime.controllerId,attemptBoundary:'keep',status:'submitted_unconfirmed'};store.set('task:t',task);
 const calls=[];Object.defineProperty(runtime,'cloud',{value:{request:async(route,input)=>{calls.push([route,input]);if(route==='runs')return {tasks:[{...task,version:3}]};if(calls.length===1)throw Object.assign(new Error('控制权版本已变化'),{status:409});return {version:4};}}});
 await runtime.lease(task);assert.equal(calls[2][1].version,3);assert.equal(task.version,4);assert.equal(task.attemptBoundary,'keep');store.close();
});
test('concurrent task changes or pending events cannot be overwritten by version refresh',async()=>{
 for(const changed of [true,false]){const store=new Store(':memory:');const runtime=new Runtime(store,'.');const task={id:'t',version:2,status:'needs_manual'};store.set('task:t',task);if(!changed)store.transition(task,'pending');
 let leases=0;Object.defineProperty(runtime,'cloud',{value:{request:async route=>{if(route==='runs')return {tasks:[{...task,version:3,status:changed?'finished':task.status}]};leases++;throw Object.assign(new Error('控制权版本已变化'),{status:409});}}});
 await assert.rejects(runtime.lease(task));assert.equal(leases,1);assert.equal(store.get('task:t').version,2);store.close();}
});
