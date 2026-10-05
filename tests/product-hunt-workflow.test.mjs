import test from 'node:test';import assert from 'node:assert/strict';import {runProductHuntLoop,productHuntVisualHandoff} from '../core/product-hunt-workflow.mjs';
const harness=()=>({checkpoint:async()=>{},delay:async()=>{},active:()=>true});
test('original launch stages reach the final confirmation without invoking creation until explicitly authorized',async()=>{
 const history=[],results=[{stage:'entry',entryOpened:true},{stage:'main_info',advanced:true},{stage:'images',advanced:true},{stage:'makers',advanced:true},{stage:'company_info',advanced:true},{stage:'shoutouts',advanced:true},{stage:'extras',advanced:true},{stage:'investors',advanced:true},{stage:'checklist',ready_to_create:true}];let created=0;
 let result=await runProductHuntLoop({...harness(),step:async request=>{assert.equal(request.confirmCreate,false);return results.shift();},checkpoint:async r=>history.push(r.stage),create:async()=>{created++;}});assert.equal(result.ready_to_create,true);assert.equal(created,0);assert.equal(history.length,9);
 result=await runProductHuntLoop({...harness(),step:async()=>({stage:'checklist',ready_to_create:true}),confirmCreate:true,create:async()=>{created++;return{submittedAttempt:true,matched:true,evidence:'Draft created'};}});assert.equal(created,1);assert.equal(result.matched,true);
});
test('loaded custom controls use the original stable retry threshold and bounded visual handoff',async()=>{
 let calls=0,visuals=0;const result=await runProductHuntLoop({...harness(),step:async()=>{calls++;return calls>3?{stage:'checklist',ready_to_create:true}:{stage:'images',waiting:true,missing:['Screenshot upload'],reason:'Custom control'};},visual:async()=>{visuals++;return{ok:true};}});assert.equal(visuals,1);assert.equal(result.ready_to_create,true);assert.equal(calls,4);
 calls=0;visuals=0;const parked=await runProductHuntLoop({...harness(),step:async()=>{calls++;return{stage:'images',waiting:true,missing:['Screenshot upload'],reason:'Custom control'};},visual:async()=>{visuals++;return{ok:true};}});assert.equal(visuals,2);assert.equal(parked.visualEscalation,true);assert.equal(parked.needs_manual,true);
});
test('human gates, pause and an unknown submission outcome never invoke a create or visual action',async()=>{
 let actions=0;for(const reason of ['Login required','OTP verification code','Please accept terms','Captcha required','Payment checkout']){assert.equal(productHuntVisualHandoff({stage:'images',missing:[reason]},8),false);const result=await runProductHuntLoop({...harness(),step:async()=>({stage:'gate',needs_manual:true,reason}),confirmCreate:true,create:async()=>actions++,visual:async()=>actions++});assert.equal(result.needs_manual,true);}
 const paused=await runProductHuntLoop({...harness(),active:()=>false,step:async()=>actions++});assert.equal(paused.interrupted,true);assert.equal(actions,0);await assert.rejects(runProductHuntLoop({...harness(),step:async()=>({submittedAttempt:true})}),/必须先核验/);
 const unknown=await runProductHuntLoop({...harness(),confirmCreate:true,step:async()=>({ready_to_create:true}),create:async()=>{actions++;return{submittedAttempt:true,matched:false};}});assert.equal(unknown.matched,false);assert.equal(actions,1);
});
test('original waiting and step budgets remain fixed and non-final trusted advances are bounded',async()=>{
 let calls=0;const waiting=await runProductHuntLoop({...harness(),step:async()=>{calls++;return{stage:'unknown',waiting:true};}});assert.equal(calls,60);assert.equal(waiting.waitingRetries,60);
 calls=0;const steps=await runProductHuntLoop({...harness(),step:async()=>{calls++;return{stage:'main_info',advanced:true};}});assert.equal(calls,12);assert.equal(steps.completedSteps,12);
 let advances=0;calls=0;const result=await runProductHuntLoop({...harness(),step:async()=>++calls===1?{stage:'main_info',waiting:true,stageCompleted:true,stageAdvanced:false,advancePoint:{x:10,y:10}}:{stage:'checklist',ready_to_create:true},advance:async()=>{advances++;return true;}});assert.equal(advances,1);assert.equal(result.ready_to_create,true);
});
