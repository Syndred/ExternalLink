import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {continueOriginalForm,originalFormContinuationKind,originalFormPriorStageFields} from '../executor/src/original-form-continuation.mjs';
import {originalSubmissionSequence} from './helpers/original-single-page-gates.mjs';

const stage={stageAdvanced:true,submitted:false,clickedSubmit:true,matched:false},invalid={validationFailed:true,submitted:false,clickedSubmit:true,issues:['Original error']},receipt={submitted:true,matched:true,evidence:'Original receipt'};
function fixture(){
 const store=new Store(':memory:'),task={id:'t',runId:'r',url:'https://directory.example/submit',profileId:'p',profileRevision:1,profileSnapshot:{id:'p',fields:{Name:'Original',Url:'https://original.example'}},version:1,controller:'executor',controllerId:'owner',targetId:'tab',browserInstance:'browser',attemptBoundary:'attempt-1',actualSubmission:{fields:[{name:'name',value:'Original'}]},baselineEvidence:'',networkResponses:[{status:200}],status:'submitting'};
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'original'});store.set('task:t',task);store.set('run:r',{id:'r',mediaManifest:{original:'asset'}});store.set('paused',false);
 let fills=0,change=()=>{},url=task.url;const page={url:()=>url,isClosed:()=>false,mainFrame:()=>frame},frame={url:()=>url,isDetached:()=>false},counts={ok:true,totalCount:1,emptyCount:0,invalidCount:0,allValid:true,validationFailed:false,issues:[]},engine={isCurrentDocument:async()=>true,call:async({action})=>{if(action==='smartFill'){fills++;return{ok:true,filledCount:1};}if(action==='getFilledFieldsReport')return{fields:[{name:'category',value:'Tools'}],allValid:true,invalidCount:0,issues:[]};if(['countEmptyFields','collectFormValidation'].includes(action))return counts;throw Error('Unexpected '+action);}},candidate={frame,engine,url,detection:{platform:'directory'}};candidate.url=url;
 const runtime={store,host:{startedAt:'browser'},context:{newCDPSession:async()=>({send:async()=>{change();return{targetInfo:{targetId:'tab'}};},detach:async()=>{}})},cloud:{flush:async()=>{}},update(t,patch,type){Object.assign(t,patch);store.transition(t,type);}};
 return{store,task,runtime,page,candidate,counts:()=>({fills}),change(fn){change=fn;},navigate(){url='https://directory.example/other';},call:result=>continueOriginalForm(runtime,{task,page,candidate,engines:[candidate],config:{},result,active:()=>store.get('paused')===false,invocationId:'same-call'})};
}
test('ordinary form continuation matches frozen original stage and validation retry limits',async()=>{
 for(const results of [[stage],[invalid],[stage,invalid,receipt],[invalid,stage,receipt],[{...invalid,clickedSubmit:false},receipt],[{...stage,clickedSubmit:undefined},receipt]]){
  const original=await originalSubmissionSequence(results),f=fixture();let submits=0;
  try{while(true){const result=results[Math.min(submits++,results.length-1)];f.runtime.update(f.task,{attemptBoundary:'attempt-'+submits,status:'submitting'},'test_click');const next=await f.call(result);if(!next.handled||!next.ready)break;}
   assert.equal(submits,original.submits);assert.equal(f.counts().fills,original.fills*2);assert.equal(f.task.attemptHistory.length,submits-(results.includes(receipt)?1:0));assert.ok(f.task.attemptHistory.every(item=>item.actualSubmission.fields[0].value==='Original'));if(results[0]===stage&&results.length===1)assert.equal(f.task.originalFormContinuation.phase,'stage_limit');if(results[0]===invalid&&results.length===1)assert.equal(f.task.originalFormContinuation.phase,'validation_limit');
  }finally{f.store.close();}
 }
});
test('unknown, contradictory, receipt and blocked results never resolve a click into another attempt',async()=>{
 for(const result of [{},{...stage,submitted:true},{...stage,matched:true},{...stage,evidence:'new'},{...stage,error:'transport'},{...stage,needs_manual:true},{...stage,captcha:true},{...stage,blocked:true},{...invalid,submitted:undefined},receipt]){const f=fixture();try{assert.equal(originalFormContinuationKind(result),null);assert.deepEqual(await f.call(result),{handled:false});assert.equal(f.store.get('task:t').attemptBoundary,'attempt-1');assert.equal(f.counts().fills,0);}finally{f.store.close();}}
});
test('late page, task, profile, consent, evidence, workspace and stop changes preserve the newer task before refill',async()=>{
 for(const mode of ['profile','owner','version','fields','network','consent','receipt','boundary','history','continuation','workspace','stop','pause','page','media']){
  const f=fixture();let changed=false;
  try{f.change(()=>{if(changed)return;changed=true;const latest=f.store.get('task:t');if(mode==='profile')latest.profileSnapshot.fields.Name='New';if(mode==='owner')latest.controllerId='other';if(mode==='version')latest.version++;if(mode==='fields')latest.actualSubmission.fields[0].value='New';if(mode==='network')latest.networkResponses=[{status:503}];if(mode==='consent')latest.manualSubmissionConsent={revoked:true};if(mode==='receipt')latest.receipt={evidence:'Late'};if(mode==='boundary')latest.attemptBoundary='new';if(mode==='history')latest.attemptHistory=[{kind:'new'}];if(mode==='continuation')latest.originalFormContinuation={phase:'new'};if(mode==='workspace')f.store.set('pair',{endpoint:'https://other.example'});if(mode==='stop')f.store.set('executionStopped',true);if(mode==='pause')f.store.set('paused',true);if(mode==='page')f.navigate();if(mode==='media')f.store.set('run:r',{id:'r',mediaManifest:{original:'changed'}});f.store.set('task:t',latest);});
   await assert.rejects(f.call(invalid));assert.equal(f.counts().fills,0,mode);assert.equal(f.store.get('task:t').attemptBoundary,mode==='boundary'?'new':'attempt-1',mode);
  }finally{f.store.close();}
 }
});
test('prior stage identity is scoped to its original form invocation, target and frozen product',async()=>{
 const f=fixture();try{await f.call(stage);assert.equal(originalFormPriorStageFields(f.task).length,1);for(const patch of [{targetId:'other'},{browserInstance:'other'},{url:'https://other.example'},{profileSnapshot:{fields:{Name:'Other'}}},{originalFormContinuation:{invocationId:'other'}}])assert.deepEqual(originalFormPriorStageFields({...f.task,...patch}),[]);}finally{f.store.close();}
});
test('sync failure after a proven rejection retains durable attempt history and does not refill',async()=>{
 const f=fixture();try{f.runtime.cloud.flush=async()=>{throw Error('Controlled sync failure');};await assert.rejects(f.call(invalid),/Controlled sync failure/);const saved=f.store.get('task:t');assert.equal(saved.attemptBoundary,null);assert.equal(saved.attemptHistory.length,1);assert.equal(saved.attemptHistory[0].attemptBoundary,'attempt-1');assert.equal(saved.originalFormContinuation.phase,'refill');assert.equal(f.counts().fills,0);}finally{f.store.close();}
});
