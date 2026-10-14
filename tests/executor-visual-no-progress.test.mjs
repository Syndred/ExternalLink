import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {runOriginalAgentPreparation} from '../executor/src/original-agent-flow.mjs';
import {runOriginalAgentSubmission,originalVisualActions} from '../executor/src/original-submission-flow.mjs';
import Worker from '../cloud/worker/src/index.mjs';
import {aiCloudFixture} from '../executor/test/fixtures/ai-cloud.mjs';

// These cases catch empty/wait plans resetting stalled-page feedback and missing
// hash observations being accepted as proof of progress in either original loop.
for(const [phase,run]of [['preparation',runOriginalAgentPreparation],['submission',runOriginalAgentSubmission]]){
 for(const [name,actions,hashes,changed]of [
  ['empty actions',[],['same','same'],false],
  ['wait-only',[{type:'wait',timeout_ms:1}],['same','same'],false],
  ['missing hashes',[],[undefined,undefined],false],
  ['changed page',[],['before','after'],true],
  ['accepted fill',[{type:'fill',selector:'#field',value:'Frozen'}],['same','same'],false],
 ])test(`${phase}: ${name} records observed progress and sends stalled feedback`,async()=>{
  const store=new Store(':memory:'),task={id:'fixture',profileId:'p',version:1,controller:'executor',url:'https://fixture.invalid/form',profileSnapshot:{fields:{Name:'Frozen'}}};store.set('task:fixture',task);
  const runtime={store,update(t,patch,type){Object.assign(t,patch);store.transition(t,type);}},plans=[];let observations=0;
  const io={authorized:true,ownedAttemptBoundary:()=>undefined,assertCurrent:async()=>{},canRelease:()=>true,ready:async()=>false,settle:async()=>{},act:async()=>({ok:true}),observe:async()=>({url:task.url,domHash:hashes[Math.min(observations++,hashes.length-1)],meta:{}}),model:async(kind,input)=>{
   if(kind==='judge')return{status:'incomplete'};plans.push(input);return plans.length===1?{status:'act',actions,actionFilter:{cloud:{inputCount:1,outputCount:0,rejected:[{type:'fill',selector:'#email',reason:'selector_not_visible'}]}}}:{status:'blocked',reason:'Fixture complete'};
  }};
  try{await run(runtime,{task,io});const history=task.aiTakeover.originalVisual.history;assert.equal(history.length,1);assert.equal(history[0].changed,changed);assert.equal(task.aiTakeover.originalVisual.noProgressCount,changed?0:1);if(!changed){assert.match(plans[1].failure,/no visible page change/i);assert.match(plans[1].failure,/#email/);assert.match(plans[1].failure,/selector_not_visible/);}else assert.equal(plans[1].failure,'');assert.deepEqual(history[0].actionFilter.cloud.rejected,[{type:'fill',selector:'#email',reason:'selector_not_visible'}]);}
  finally{store.close();}
 });
}

test('local visual filter reports rejected selectors without executing reason text',()=>{
 const diagnostics={};const actions=originalVisualActions([{type:'fill',selector:'#email',value:'do-not-log-value'},{type:'fill',selector:'#visible',value:'Frozen'}],[{selector:'#visible',type:'text'}],{diagnostics,snapshot:{fields:[{selector:'#email',visible:true}]}});
 assert.deepEqual(actions,[{type:'fill',selector:'#visible',value:'Frozen'}]);assert.equal(diagnostics.inputCount,2);assert.equal(diagnostics.outputCount,1);assert.deepEqual(diagnostics.rejected,[{index:0,type:'fill',selector:'#email',reason:'selector_not_visible'}]);assert.ok(!JSON.stringify(diagnostics).includes('do-not-log-value'));
});

test('diagnostic visual filtering preserves fill-only final-click and unknown-target gates',()=>{
 const elements=[{selector:'#final',label:'Publish product',rect:{x:10,y:10,width:30,height:30}},{selector:'#field',type:'text'}],diagnostics={};
 const actions=originalVisualActions([{type:'click',x:20,y:20},{type:'click',x:600,y:500},{type:'fill',selector:'#unknown',value:'No'},{type:'fill',selector:'#field',value:'Frozen'}],elements,{fillOnly:true,diagnostics});
 assert.deepEqual(actions,[{type:'fill',selector:'#field',value:'Frozen'}]);assert.deepEqual(diagnostics.rejected.map(action=>action.reason),['final_submission_disallowed','invalid_coordinates','unknown_selector']);
});

test('cloud visual planner marks offscreen fields and exposes first-layer filtering reasons',async()=>{
 const f=aiCloudFixture(),realFetch=globalThis.fetch;globalThis.fetch=f.fetch;
 const call=async(route,token,body)=>{const response=await Worker.fetch(new Request('https://fixture.invalid/v2/executor/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),f.env);assert.equal(response.status,200);return response.json();};
 try{
  const token=(await call('devices','fixture-admin',{})).deviceToken;
  f.state.modelResult={status:'act',reason:'Fill email then continue',actions:[{type:'fill',selector:'#email',value:'do-not-log-value'},{type:'fill',selector:'#visible',value:'Frozen'},{type:'click',selector:'#continue'},{type:'fill',selector:'#visible',value:'Late'},{type:'submit'}]};
  const input={screenshot:'data:image/png;base64,aW1hZ2U=',elements:[{selector:'#visible',type:'text'},{selector:'#continue',type:'button'}],viewport:{width:800,height:600},snapshot:{fields:[{selector:'#email',visible:true},{selector:'#visible',visible:true}],buttons:[{selector:'#continue',visible:true}]}};
  const result=await call('ai/vision-plan',token,input),snapshot=f.state.requests.at(-1).snapshot;
  assert.equal(snapshot.fields[0].visibleInScreenshot,false);assert.match(snapshot.fields[0].visibilityReason,/not visible.*scroll/i);assert.equal(snapshot.fields[1].visibleInScreenshot,true);assert.equal(snapshot.buttons[0].visibleInScreenshot,true);assert.equal(input.snapshot.fields[0].visibleInScreenshot,undefined);
  assert.deepEqual(result.actions,[{type:'fill',selector:'#visible',value:'Frozen'},{type:'click',selector:'#continue'}]);const diagnostics=result.actionFilter.cloud;assert.equal(diagnostics.inputCount,5);assert.equal(diagnostics.outputCount,2);assert.deepEqual(diagnostics.rejected,[{index:0,type:'fill',selector:'#email',reason:'selector_not_visible'},{index:3,type:'fill',selector:'#visible',reason:'after_click_requires_observation'},{index:4,type:'submit',reason:'unsupported_type'}]);assert.ok(!JSON.stringify(diagnostics).includes('do-not-log-value'));
 }finally{globalThis.fetch=realFetch;f.sqlite.close();}
});
