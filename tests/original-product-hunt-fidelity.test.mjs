import test from 'node:test';
import assert from 'node:assert/strict';
import {runProductHuntLoop,productHuntVisualHandoff} from '../core/product-hunt-workflow.mjs';
import {originalProductHuntFlow,originalProductHuntVisualHandoff} from './helpers/original-product-hunt-projection.mjs';

async function nativeFlow(replies,entrypoint,{visualReplies,advanceAllowed=false}={}){
 const results=structuredClone(replies),visualResults=structuredClone(visualReplies||[]),calls=[],delays=[],checkpoints=[],actions=[];let result,error;
 try{result=await runProductHuntLoop({entrypoint,step:async message=>{calls.push(message);return results.length>1?results.shift():results[0];},delay:async ms=>delays.push(ms),checkpoint:async result=>checkpoints.push(structuredClone(result)),advance:async()=>{actions.push({type:'advance'});return advanceAllowed;},...(visualReplies?{visual:async()=>{actions.push({type:'visual'});return visualResults.length>1?visualResults.shift():visualResults[0];}}:{})});}catch(failure){error=failure.message;}
 return{result,error,calls,delays,checkpoints,actions};
}

test('no-progress main launch stops at the same original checkpoint without consuming the loading retry budget',async()=>{
 for(const reply of [{stage:'main_info',reason:'Original custom panel did not advance'},{stage:'images',ok:false},{ok:true},{}]){
  const replies=[{stage:'entry',entryOpened:true},reply],original=await originalProductHuntFlow(replies),native=await nativeFlow(replies,'launch');
  assert.equal(original.actions.at(-1).type,'park');assert.equal(original.entry.agentRunning,false);
  assert.equal(original.task.skipReason,'Product Hunt 自动化暂停：'+native.error);
  assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);assert.deepEqual(native.checkpoints,original.checkpoints);
 }
});

test('no-progress single-page filling returns the original waiting response immediately for all panel stages',async()=>{
 for(const stage of ['entry','main_info','images','makers','company_info','shoutouts','extras','investors','checklist',undefined]){
  const reply={ok:false,reason:'Original panel did not advance',...(stage?{stage}:{})},original=await originalProductHuntFlow([reply],{entrypoint:'sidepanel'}),native=await nativeFlow([reply],'sidepanel');
  assert.deepEqual(native.result,original.result);assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);
  assert.equal(native.calls.length,1);assert.equal(native.result.submittedAttempt,undefined);
 }
});

test('genuine original loading replies retain the 60-wait budget and original clamped delays through both entrances',async()=>{
 for(const retryAfterMs of [undefined,-10,0,150,1250,7000,'1000','bad'])for(const entrypoint of ['launch','sidepanel']){
  const reply={stage:'unknown',waiting:true,retryAfterMs},original=await originalProductHuntFlow([reply],{entrypoint}),native=await nativeFlow([reply],entrypoint);
  assert.equal(native.calls.length,60);assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);
  if(entrypoint==='sidepanel')assert.deepEqual(native.result,original.result);else assert.equal(original.task.skipReason,'Product Hunt 自动化暂停：'+native.error);
 }
});

test('the complete original nine stages and progress-only budget have equal requests and delays without creation',async()=>{
 const stages=[{stage:'entry',entryOpened:true},...['main_info','images','makers','company_info','shoutouts','extras','investors'].map(stage=>({stage,advanced:true})),{stage:'checklist',ready_to_create:true}];
 for(const entrypoint of ['launch','sidepanel'])for(const replies of [stages,[{stage:'main_info',stageCompleted:true}]]){
  const original=await originalProductHuntFlow(replies,{entrypoint}),native=await nativeFlow(replies,entrypoint);
  assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);assert.ok(native.calls.every(call=>call.confirmCreate===false));
  if(replies===stages)assert.equal(native.result.ready_to_create,true);
  else if(entrypoint==='sidepanel')assert.deepEqual(native.result,original.result);else assert.equal(original.task.skipReason,'Product Hunt 自动化暂停：'+native.error);
 }
});

test('main launch exits after one original screenshot handoff instead of starting another deterministic or visual cycle',async()=>{
 const waiting={stage:'images',waiting:true,missing:['Original custom component']},replies=[waiting],visualReplies=[{ok:true}];
 const original=await originalProductHuntFlow(replies),native=await nativeFlow(replies,'launch',{visualReplies});
 assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);assert.equal(native.actions.filter(action=>action.type==='visual').length,original.actions.filter(action=>action.type==='visual').length);
});

test('single-page screenshot retries restart each original 12-step budget and return a ready visual result without another step',async()=>{
 const advanced={stage:'main_info',advanced:true},waiting={stage:'images',waiting:true,missing:['Original custom component']};
 const replies=[...Array(10).fill(advanced),...Array(3).fill(waiting),...Array(10).fill(advanced),{stage:'checklist',ready_to_create:true}],visualReplies=[{ok:true}];
 const original=await originalProductHuntFlow(replies,{entrypoint:'sidepanel',visualReplies}),native=await nativeFlow(replies,'sidepanel',{visualReplies});
 assert.equal(native.result.ready_to_create,true);assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);
 for(const outcome of [{ready_to_create:true},{needs_manual:true,reason:'manual'},{blocked:true},{error:'failed'}]){
  const original=await originalProductHuntFlow([waiting],{entrypoint:'sidepanel',visualReplies:[outcome]}),native=await nativeFlow([waiting],'sidepanel',{visualReplies:[outcome]});
  assert.deepEqual(native.result,original.result);assert.equal(native.calls.length,original.calls.length);assert.equal(native.actions.filter(action=>action.type==='visual').length,original.actions.filter(action=>action.type==='visual').length);
 }
 const bounded=await originalProductHuntFlow([waiting],{entrypoint:'sidepanel',visualReplies:[{ok:true}]}),actual=await nativeFlow([waiting],'sidepanel',{visualReplies:[{ok:true}]});assert.equal(actual.calls.length,bounded.calls.length);assert.deepEqual(actual.result,bounded.result);assert.deepEqual(actual.delays,bounded.delays);
});

test('trusted non-final advancement belongs to the original main launch entrance',async()=>{
 const waiting={stage:'images',waiting:true,stageCompleted:true,stageAdvanced:false,advancePoint:{x:10,y:10}};
 for(const entrypoint of ['launch','sidepanel']){
  const replies=[waiting,{stage:'checklist',ready_to_create:true}],original=await originalProductHuntFlow(replies,{entrypoint,advanceAllowed:true}),native=await nativeFlow(replies,entrypoint,{advanceAllowed:true});
  assert.deepEqual(native.delays,original.delays);assert.equal(native.actions.filter(action=>action.type==='advance').length,original.actions.filter(action=>action.type==='advance').length);
 }
});

test('original visual handoff normalizes stage names and only considers array prerequisites',()=>{
 for(const stage of ['images',' Images ','UNKNOWN',' unknown ','',null,7])for(const missing of [['Custom component'],[],undefined,'Custom component'])for(const stable of [0,1,2,5]){
  const reply={stage,missing};assert.equal(productHuntVisualHandoff(reply,stable),originalProductHuntVisualHandoff(reply,stable));
 }
 for(const reason of ['Captcha','OTP','Terms','Privacy','Subscribe','登录','验证码','同意'])assert.equal(productHuntVisualHandoff({stage:' Images ',missing:[reason]},5),originalProductHuntVisualHandoff({stage:' Images ',missing:[reason]},5));
});

test('a nonwaiting progress reply does not erase the original stable custom-control history',async()=>{
 const waiting={stage:'images',waiting:true,missing:['Original custom component'],reason:'Original control still missing'};
 for(const entrypoint of ['launch','sidepanel']){
  const replies=[waiting,{stage:'images',advanced:true},waiting,waiting,waiting],original=await originalProductHuntFlow(replies,{entrypoint}),native=await nativeFlow(replies,entrypoint);
  assert.equal(native.result.visualEscalation,true);assert.equal(native.calls.length,original.calls.length);assert.deepEqual(native.delays,original.delays);
 }
});
