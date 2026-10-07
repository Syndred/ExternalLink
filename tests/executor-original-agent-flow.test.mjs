import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {runOriginalAgentPreparation,originalExplicitHumanGate,originalJudgeTerminal,originalAgentLimits} from '../executor/src/original-agent-flow.mjs';

function fixture({store=new Store(':memory:'),task=store.get('task:original'),model,ready=async()=>false}={}){
 task=task||{id:'original',runId:'original-run',profileId:'p',profileRevision:7,profileSnapshot:{fields:{Name:'Original',Url:'https://original.example'}},controller:'executor',version:1,status:'filling'};
 store.set('task:'+task.id,task);const routes=[],actions=[],settles=[],events=[];let observations=0;
 const runtime={store,update(t,patch,type){Object.assign(t,patch);store.transition(t,type);events.push(type);}};
 const canRelease=current=>current.version===task.version&&current.profileId===task.profileId&&!current.receipt&&!current.attemptBoundary&&JSON.stringify(current.profileSnapshot)===JSON.stringify(task.profileSnapshot);
 const io={assertCurrent:async()=>{const current=store.get('task:'+task.id);if(!canRelease(current)||current.controller!==task.controller)throw Object.assign(Error('stale original task'),{staleTask:true});},canRelease,
  observe:async()=>({url:'https://directory.example/submit',domHash:'page-'+(++observations),viewport:{height:1000},meta:{}}),ready,
  model:async(kind,input)=>{routes.push({kind,input:structuredClone(input)});return model?model(kind,input):{status:kind==='judge'?'incomplete':'act',actions:[{type:'fill',selector:'#field',value:'Original'}]};},
  act:async(action,options)=>{actions.push({action,options});return{ok:true};},settle:async ms=>settles.push(ms)};
 return{store,task,runtime,io,routes,actions,settles,events,run:()=>runOriginalAgentPreparation(runtime,{task,io})};
}

test('explicit human gates and terminal judge decisions match the original pre-executor functions',()=>{
 const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),start=source.indexOf('function handleTerminalJudge('),end=source.indexOf('\nfunction completeTaskFromSubmit(',start),calls=[];
 assert.ok(start>=0&&end>start);const sandbox=vm.createContext({self:{ExtLinkQueue:globalThis.ExtLinkQueue},markTaskNeedsManual(_tab,_task,_entry,reason){calls.push({needs_manual:true,reason});},markTaskBlocked(_tab,_task,_entry,reason){calls.push({blocked:true,reason});}});vm.runInContext(source.slice(start,end),sandbox);
 for(const [reply,snapshot]of [[null,{}],[{status:'incomplete'},{}],[{status:'success',reason:'Model guessed success'},{}],[{status:'blocked'},{}],[{status:'error'},{}],[{status:'needs_manual',reason:'Not sure what to do'},{}],[{status:'needs_manual',message:'Login required'},{}],[{status:'needs_manual',reason:'Submission requires payment'},{}],[{status:'needs_manual',reason:'OTP verification code'},{}],[{status:'needs_manual',reason:'Accept terms'},{}],[{status:'needs_manual',reason:'Needs a closer look'},{meta:{hasCaptcha:true}}]]){
  assert.equal(originalExplicitHumanGate(reply,snapshot),sandbox.isExplicitHumanGateJudge(reply,snapshot));calls.length=0;
  // The original loop normalizes non-explicit manual decisions before this handler.
  const normalized=reply?.status==='needs_manual'&&!sandbox.isExplicitHumanGateJudge(reply,snapshot)?{...reply,status:'incomplete'}:reply;
  sandbox.handleTerminalJudge(1,{}, {},normalized);assert.deepEqual(originalJudgeTerminal(reply,snapshot),calls[0]||null);
 }
 assert.equal(originalAgentLimits.loops,Number(source.match(/const MAX_AGENT_LOOPS = (\d+)/)[1]));assert.equal(originalAgentLimits.settleMs,Number(source.match(/const AGENT_ACTION_SETTLE_MS = (\d+)/)[1]));
});

test('native preparation judges before and after screenshot actions and ignores unproven model success',async()=>{
 let complete=false;const f=fixture({model:async kind=>kind==='judge'?{status:'success',reason:'Model guessed accepted'}:{status:'act',actions:[{type:'fill',selector:'#field',value:'Original'}]},ready:async()=>complete});
 f.io.act=async action=>{f.actions.push(action);complete=true;return{ok:true};};try{const result=await f.run();assert.equal(result.ok,true);assert.deepEqual(f.routes.map(r=>r.kind),['judge','vision-plan','judge']);assert.deepEqual(f.settles,[600]);assert.equal(f.task.aiTakeover.calls,3);assert.equal(f.task.aiTakeover.actions,1);assert.equal(f.task.controller,'executor');assert.equal(f.task.receipt,undefined);assert.equal(f.task.attemptBoundary,undefined);}finally{f.store.close();}
});

test('non-explicit manual decisions keep observing while explicit login stops before any action',async()=>{
 for(const explicit of [false,true]){let judged=0;const f=fixture({model:async kind=>kind==='judge'?{status:'needs_manual',reason:explicit?'Login required':(++judged,'Need a closer look')}:{status:'needs_manual',reason:'Insufficient screenshot context'},ready:async()=>!explicit});try{const result=await f.run();if(explicit){assert.equal(result.needs_manual,true);assert.equal(result.reason,'Login required');assert.equal(f.actions.length,0);assert.equal(f.routes.length,1);}else{assert.equal(result.ok,true);assert.equal(judged,2);assert.deepEqual(f.actions[0].action,{type:'scroll',delta_y:720});}}finally{f.store.close();}}
});

test('eight rounds exhaust the original loop without a model-success receipt or an extra round',async()=>{
 const f=fixture({model:async kind=>kind==='judge'?{status:'success',reason:'No hard evidence'}:{status:'act',actions:[{type:'wait',timeout_ms:1}]}});try{const result=await f.run();assert.equal(result.needs_manual,true);assert.match(result.reason,/8 轮/);assert.equal(f.routes.length,17);assert.equal(f.routes.filter(r=>r.kind==='vision-plan').length,8);assert.equal(f.task.aiTakeover.originalVisual.loops,8);assert.equal(f.task.aiTakeover.originalVisual.history.length,8);assert.deepEqual(f.settles,Array(8).fill(600));assert.equal(f.task.receipt,undefined);}finally{f.store.close();}
});

test('an already classified public gate returns its exact disposition before a candidate or model is available',async()=>{
 const f=fixture();f.io.observe=async()=>{throw Object.assign(Error('Original public CAPTCHA'),{originalPublicGateClassified:true,originalPublicGateResult:{captcha:true}});};try{const result=await f.run();assert.equal(result.captcha,true);assert.equal(result.originalPublicGateClassified,true);assert.equal(result.reason,'Original public CAPTCHA');assert.equal(f.routes.length,0);assert.equal(f.task.controller,'executor');assert.equal(f.task.aiTakeover.calls,0);assert.equal(f.task.attemptBoundary,undefined);assert.equal(f.task.receipt,undefined);}finally{f.store.close();}
});

test('visual service failures use original DOM planning and a DOM exception can escalate back to visual actions',async()=>{
 const f=fixture({model:async kind=>{if(kind==='judge')return{status:'incomplete'};if(kind==='vision-plan')throw Error('Fixture visual unavailable');return{status:'act',actions:[{type:'fill',selector:'#field',value:'Original'}]};},ready:async()=>true});
 f.io.act=async(_action,{visual})=>{if(!visual)throw Error('DOM control changed');return{ok:true};};f.io.visualFallback=async(snapshot,error,model,execute)=>{assert.equal(error,'DOM control changed');f.io.model=async kind=>{f.routes.push({kind});return{status:'act',actions:[{type:'check',selector:'#choice'}]};};await model('vision-plan',{snapshot});return execute({type:'check',selector:'#choice'});};
 try{const result=await f.run();assert.equal(result.ok,true);assert.deepEqual(f.routes.map(r=>r.kind),['judge','vision-plan','plan','vision-plan','judge']);assert.equal(f.task.aiTakeover.actions,2);assert.equal(f.task.aiTakeover.history[1].visualFallback,true);}finally{f.store.close();}
});

test('visual action gates preserve CAPTCHA and uncertain-payment meaning; judge error and plan error retain different dispositions',async()=>{
 for(const outcome of [{ok:false,results:[{needs_manual:true,humanGate:'captcha',error:'Complete verification'}]},{ok:false,results:[{needs_manual:true,humanGate:'payment_uncertain',uncertain:true,error:'Unclear pricing'}]}]){const f=fixture();f.io.act=async()=>outcome;try{const result=await f.run();assert.equal(result.needs_manual,true);assert.equal(result.humanGate,outcome.results[0].humanGate);assert.equal(result.semanticReview,outcome.results[0].uncertain===true);assert.equal(f.routes.length,2);}finally{f.store.close();}}
 for(const kind of ['judge','vision-plan']){const f=fixture({model:async route=>({status:route===kind?'error':'incomplete',reason:route===kind?'Original reason':''})});try{const result=await f.run();assert.equal(result.reason,'Original reason');assert.equal(kind==='judge'?result.needs_manual:result.blocked,true);}finally{f.store.close();}}
});

test('late result does not return foreign control, replace a frozen product or clear an unknown attempt',async()=>{
 for(const change of [{controller:'supervisor',reason:'Foreign owner'},{profileSnapshot:{fields:{Name:'Other'}}},{version:2,reason:'Newer state'},{status:'submitted_unconfirmed',attemptBoundary:'unknown',reason:'Keep unknown'}]){const f=fixture({model:async()=>{const next={...f.store.get('task:'+f.task.id),...change};f.store.set('task:'+f.task.id,next);return{status:'act',actions:[{type:'fill',selector:'#field',value:'Wrong'}]};}});try{const result=await f.run();assert.equal(result.staleTask,true);assert.equal(f.actions.length,0);const saved=f.store.get('task:'+f.task.id);for(const [key,value]of Object.entries(change))assert.deepEqual(saved[key],value);assert.equal(f.events.includes('original_agent_model_observed'),false);assert.equal(f.events.includes('original_agent_returned'),false);}finally{f.store.close();}}
});

test('SQLite restart preserves spent calls, actions and rounds, and repeats the original initial judgment on recovery',async()=>{
 const home=mkdtempSync(join(tmpdir(),'el-agent-recovery-')),file=join(home,'outbox.sqlite');let store=new Store(file);
 try{const f=fixture({store,model:async()=>{throw Object.assign(Error('User paused'),{batchPaused:true});}});const first=await f.run();assert.equal(first.interrupted,true);assert.equal(f.task.aiTakeover.calls,1);store.close();store=new Store(file);const g=fixture({store,model:async kind=>kind==='judge'?{status:'incomplete'}:{status:'blocked',reason:'Cannot submit'}});const next=await g.run();assert.equal(next.blocked,true);assert.equal(g.task.aiTakeover.calls,3);assert.equal(g.task.aiTakeover.originalVisual.loops,1);assert.deepEqual(g.routes.map(r=>r.kind),['judge','vision-plan']);}finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-agent-recovery-'));rmSync(home,{recursive:true,force:true});}
});

test('legacy ceilings and original batch interruption prevent additional model or action work',async()=>{
 const f=fixture({task:{id:'original',profileId:'p',controller:'executor',version:1,aiTakeover:{id:'original-takeover',calls:10,actions:4}}});try{const result=await f.run();assert.equal(result.interrupted,true);assert.equal(f.routes.length,0);assert.equal(f.actions.length,0);assert.equal(f.task.aiTakeover.calls,10);assert.deepEqual(f.task.aiTakeover.legacyCeilings,{calls:10,actions:20});}finally{f.store.close();}
 const g=fixture({model:async kind=>{if(kind==='judge')return{status:'incomplete'};throw Object.assign(Error('Original batch budget exhausted'),{unattendedBudget:true});}});try{const result=await g.run();assert.equal(result.interrupted,true);assert.deepEqual(g.routes.map(r=>r.kind),['judge','vision-plan']);assert.equal(g.actions.length,0);}finally{g.store.close();}
});
