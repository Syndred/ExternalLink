import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../executor/src/store.mjs';
import {runOriginalAgentSubmission,originalVisualActions,originalVisualSubmissionAction} from '../executor/src/original-submission-flow.mjs';
import {waitForOriginalSubmissionContent} from '../executor/src/original-navigation-rejudge.mjs';
import {createOriginalSubmissionAdapter} from '../executor/src/original-submission-adapter.mjs';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const extract=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};

function fixture({store=new Store(':memory:'),task=store.get('task:t')}={}){
 task=task||{id:'t',runId:'r',profileId:'p',profileSnapshot:{fields:{Name:'Original',Url:'https://product.example'}},url:'https://directory.example/form',version:1,controller:'executor',status:'filling'};store.set('task:t',task);let boundary;const routes=[],actions=[],events=[];
 const runtime={store,update(t,patch,type){Object.assign(t,patch);store.transition(t,type);events.push(type);}};
 const canRelease=current=>current.version===task.version&&current.attemptBoundary===boundary&&JSON.stringify(current.profileSnapshot)===JSON.stringify(task.profileSnapshot);
 const io={authorized:true,ownedAttemptBoundary:()=>boundary,canRelease,assertCurrent:async()=>{const current=store.get('task:t');if(!canRelease(current)||current.controller!==task.controller)throw Object.assign(Error('stale original task'),{staleTask:true});},observe:async()=>({url:task.url,domHash:'stable',viewport:{height:900},meta:{},evidenceSignals:[]}),model:async kind=>{routes.push(kind);return kind==='judge'?{status:'incomplete'}:{status:'act',actions:[{type:'wait',timeout_ms:1}]};},act:async action=>{actions.push(action);return{ok:true};},settle:async()=>{},complete:async()=>{throw Error('unproven receipt');}};
 return{store,task,runtime,io,routes,actions,events,setBoundary:value=>{boundary=value;runtime.update(task,{attemptBoundary:value},'fixture_attempt');},run:()=>runOriginalAgentSubmission(runtime,{task,io})};
}

test('full visual actions and final classification match original source selectors and coordinates',()=>{
 const sandbox=vm.createContext({});vm.runInContext(extract('function resolveVisualCoordinateTarget(', '\nasync function createVisualActionPlan('),sandbox);
 const elements=[{selector:'#outer',rect:{x:10,y:10,width:100,height:100}},{selector:'#submit',label:'Publish product',rect:{x:20,y:20,width:10,height:10}},{selector:'#field',type:'text'}];
 for(const actions of [[{type:'click',x:25,y:25},{type:'fill',selector:'#field',value:'Original'},{type:'click',selector:'#foreign'}],[{type:'click',x:500,y:500},{type:'click',x:'NaN',y:1},{type:'wait'},{type:'scroll',delta_y:100}],[{type:'click',selector:'#submit'},{type:'click',selector:'#outer'},{type:'upload',selector:'#field'}]]){
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.safeVisualActions(actions,elements))),originalVisualActions(actions,elements));for(const action of actions)assert.equal(sandbox.isVisualSubmissionAction(action,elements),originalVisualSubmissionAction(action,elements));
 }
});

test('complete original visual loop and native full loop keep judge screenshot action judge order and eight rounds',async()=>{
 for(const mode of ['eight','visual','dom']){
  const calls=[],actions=[],entry={},originalTask={domain:'directory.example'},snapshot={url:'https://directory.example/form',domHash:'stable',evidenceSignals:[],meta:{}},sandbox=vm.createContext({MAX_AGENT_LOOPS:8,AGENT_ACTION_SETTLE_MS:600,state:{stopped:false},self:{ExtLinkProfiles:{taskConfigIdentityMismatch:()=>false},ExtLinkQueue:globalThis.ExtLinkQueue},getTaskConfig:()=>({fillOnly:false}),nextEntryRunId:entry=>entry.runId=1,persistActiveBatchStatus:async()=>{},broadcastTaskUpdate:()=>{},getTabSnapshot:async()=>snapshot,recordAutomationEvent:async()=>{},assertRunCurrent:()=>{},productHuntVisualFillReachedFinalConfirmation:()=>false,agentPayload:()=>({}),callCloudAgent:async route=>{calls.push(route);return route==='/judge'?{status:'success'}:{status:'act',actions:[{type:'wait'}]};},completeTaskFromJudge:()=>false,log:()=>{},createVisualActionPlan:async()=>{calls.push('vision');if(mode==='dom')throw Error('fixture vision failure');return{plan:{status:'act',visualAgent:true,actions:[{type:'wait'}]}};},summarizePlanActions:()=>'',executeTabActions:async(_tab,plan)=>{actions.push(plan[0].type);return{ok:true,results:[]};},summarizeActionResults:()=>'',sleep:async()=>{},waitForTabContentReady:async()=>{},tryAgentDeterministicSubmit:async()=>mode==='dom',markTaskNeedsManual:()=>{},markTaskBlocked:()=>{},resumePendingRejudgeAfterRun:()=>{},unattendedEnabled:()=>false,isAgentUnavailableError:()=>false,recordUnattendedFailure:async()=>{}});
  vm.runInContext(extract('function handleTerminalJudge(', '\nfunction completeTaskFromSubmit(')+extract('async function runAgentLoop(', '\nasync function tryAgentDeterministicSubmit('),sandbox);
  // A successful later judge must still run the complete loop's terminal path.
  if(mode==='visual'){let judged=0;sandbox.completeTaskFromJudge=()=>++judged>1;}
  await sandbox.runAgentLoop(1,originalTask,entry,{visualEscalation:true});
  const f=fixture();try{let judged=0;f.io.model=async kind=>{f.routes.push(kind);if(kind==='judge')return mode==='visual'&&++judged>1?{status:'success',networkEvidence:{matched:true,status:200}}:{status:'success'};if(kind==='vision-plan'&&mode==='dom')throw Error('fixture vision failure');return{status:'act',actions:[{type:'wait'}]};};if(mode==='visual'){let observed=0;f.io.observe=async()=>({...snapshot,evidenceSignals:++observed>1?[{matched:true,type:'visible_confirmation',text:'Original submission received',url:snapshot.url}]:[]});f.io.complete=async()=>{};}if(mode==='dom')f.io.deterministicSubmit=async()=>({ok:true,receiptRecorded:true});const result=await f.run();
   assert.deepEqual(f.routes.map(kind=>kind==='judge'?'/judge':kind==='vision-plan'?'vision':'/plan'),calls);assert.deepEqual(f.actions.map(action=>action.type),actions);if(mode==='eight'){assert.equal(result.needs_manual,true);assert.equal(f.task.aiTakeover.submissionPhase.loops,8);assert.equal(f.task.aiTakeover.calls,17);}else assert.equal(result.receiptRecorded,true);
  }finally{f.store.close();}
 }
});

test('an actual submission followed by unproven model success becomes unknown rather than a second post',async()=>{
 const f=fixture();try{f.io.model=async kind=>{f.routes.push(kind);return kind==='judge'?{status:'success'}:{status:'act',actions:[{type:'click',selector:'#submit'}]};};f.io.act=async action=>{f.actions.push(action);f.setBoundary('owned');return{ok:true,results:[{ok:true,submitted:true,beforeUrl:f.task.url,evidenceBaseline:'Old thanks'}]};};const result=await f.run();assert.equal(result.unconfirmed,true);assert.equal(f.actions.length,1);assert.equal(f.task.attemptBoundary,'owned');assert.equal(f.task.receipt,undefined);assert.equal(f.task.controller,'executor');assert.deepEqual(f.routes,['judge','vision-plan','judge']);}finally{f.store.close();}
});

test('hard proof records a real receipt and keeps the original submission baseline and cumulative usage',async()=>{
 const f=fixture();let snapshots=0;try{f.io.observe=async()=>({url:f.task.url,domHash:'snapshot-'+snapshots,evidenceSignals:++snapshots>1?[{matched:true,type:'visible_confirmation',text:'New original receipt',url:f.task.url}]:[],meta:{}});f.io.model=async kind=>{f.routes.push(kind);return kind==='judge'?{status:snapshots>1?'success':'incomplete',evidence:'New original receipt',publicationStatus:'pending_moderation',networkEvidence:{matched:true,status:201}}:{status:'act',actions:[{type:'click',selector:'#submit'}]};};f.io.act=async()=>{f.setBoundary('owned');return{ok:true,submitted:true,evidenceBaseline:'Old receipt',beforeUrl:f.task.url};};f.io.complete=async({decision,entry})=>{assert.equal(entry.submissionEvidenceBaseline,'Old receipt');assert.equal(decision.proof.evidenceType,'network_receipt');f.runtime.update(f.task,{receipt:decision.receipt},'receipt');};const result=await f.run();assert.equal(result.receiptRecorded,true);assert.equal(f.task.receipt.publicationStatus,'pending_moderation');assert.equal(f.task.aiTakeover.calls,3);assert.equal(f.task.aiTakeover.actions,1);assert.equal(f.task.controller,'executor');}finally{f.store.close();}
});

test('late model control or unknown attempts and sync failures cannot mutate the original task or retry actions',async()=>{
 for(const mode of ['late','sync','pause','after-attempt-outage']){const f=fixture();try{
  if(mode==='after-attempt-outage'){f.io.act=async()=>{f.setBoundary('owned');throw Object.assign(Error('worker unavailable after click'),{status:503});};f.io.model=async kind=>kind==='judge'?{status:'incomplete'}:{status:'act',actions:[{type:'click',selector:'#submit'}]};}
  else f.io.model=async()=>{if(mode==='late'){f.store.set('task:t',{...f.task,controller:'supervisor',version:2,attemptBoundary:'foreign',reason:'Keep foreign'});return{status:'act',actions:[]};}throw Object.assign(Error(mode),mode==='sync'?{originalTaskSyncFailure:true}:{batchPaused:true});};const result=await f.run();if(mode==='late'){assert.equal(result.staleTask,true);assert.equal(f.store.get('task:t').reason,'Keep foreign');assert.equal(f.store.get('task:t').controller,'supervisor');}else if(mode==='after-attempt-outage'){assert.equal(result.unconfirmed,true);assert.equal(result.originalAgentUnavailable,undefined);assert.equal(f.task.attemptBoundary,'owned');}else{assert.equal(result.interrupted,true);assert.equal(result.originalTaskSyncFailure,mode==='sync'?true:undefined);}assert.equal(f.task.receipt,undefined);
 }finally{f.store.close();}}
});

test('SQLite restart retains visual submission history and spent usage while a durable unknown cannot be adopted',async()=>{
 const home=mkdtempSync(join(tmpdir(),'el-submission-restart-')),file=join(home,'outbox.sqlite');let store=new Store(file);
 try{const f=fixture({store});f.io.model=async()=>{throw Object.assign(Error('User paused'),{batchPaused:true});};await f.run();assert.equal(f.task.aiTakeover.calls,1);store.close();store=new Store(file);const g=fixture({store});g.io.model=async()=>({status:'needs_manual',reason:'Login required'});await g.run();assert.equal(g.task.aiTakeover.calls,2);g.runtime.update(g.task,{attemptBoundary:'durable unknown'},'unknown');await assert.rejects(g.run(),/stale original task/);assert.equal(store.get('task:t').attemptBoundary,'durable unknown');assert.equal(store.get('task:t').aiTakeover.calls,2);}finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-submission-restart-'));rmSync(home,{recursive:true,force:true});}
});

test('original full post-action readiness waits for two stable snapshots without acting and preserves timeout and pause',async()=>{
 for(const mode of ['ready','timeout','pause']){let time=0,probes=0,checks=0;const options={assertCurrent:async()=>{checks++;if(mode==='pause'&&probes)throw Object.assign(Error('user paused'),{batchPaused:true});},probe:async()=>{probes++;if(probes===1)throw Error('snapshot unavailable during navigation');return{tabStatus:'complete',snapshot:{url:'https://directory.example/done',text:mode==='timeout'?'Loading':'Your submission has been received. '+('Original site review details '.repeat(4))},detection:{}};},wait:async ms=>{time+=ms;},now:()=>time};
  if(mode==='ready'){const result=await waitForOriginalSubmissionContent(options);assert.equal(result.stableChecks,2);assert.equal(probes,3);assert.equal(time,1000);}
  else await assert.rejects(waitForOriginalSubmissionContent(options),error=>mode==='pause'?error.batchPaused===true:error.readinessTimeout===true);if(mode==='timeout')assert.equal(time,30000);assert.ok(checks>=2);
 }
});

test('actual isolated original submission keeps full preparation fallback navigation evidence and unknown guards',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-agent-submission.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:180000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(proof.ok,true);assert.equal(proof.results.length,9);assert.equal(proof.posts,5);for(const key of ['externalRequests','realModelCalls','productionWrites'])assert.equal(proof[key],0);for(const mode of ['visual','iframe','dom','navigation'])assert.equal(proof.results.find(row=>row.mode===mode).receiptRecorded,true);assert.equal(proof.results.find(row=>row.mode==='unconfirmed').unconfirmed,true);assert.equal(proof.results.find(row=>row.mode==='late-unknown').staleRejected,true);assert.equal(proof.fullMigrationComplete,false);
});

test('original full DOM submit rechecks the frozen product and changed required fields after authorization before any boundary',async()=>{
 for(const mode of ['wrong-product','changed-required']){const f=fixture(),page={on(){},off(){},url:()=>f.task.url},report={allValid:mode!=='changed-required',fields:[{label:'Product name',name:'productName',type:'text',value:mode==='wrong-product'?'Other product':'Original'},{label:'Website URL',name:'url',type:'url',value:'https://product.example'}]};let clicks=0;
  const engine={async call(input){if(input.action==='collectFormValidation')return{validationFailed:false};if(input.action==='countEmptyFields')return{emptyCount:0,invalidCount:0};if(input.action==='inspectSubmitAction')return{finalFound:true,allowed:true};if(input.action==='getFilledFieldsReport')return structuredClone(report);if(input.action==='classifySubmitEvidence')return{matched:false};if(input.action==='submitFilledForm'){clicks++;throw Error('Must not click');}throw Error('unexpected '+input.action);}};
  f.runtime.cloud={request:async()=>({documents:{autoSubmitDirectoryListings:true,submissionRecords:{}}})};f.runtime.reconcileTextInputs=async()=>{};
  const adapter=createOriginalSubmissionAdapter(f.runtime,{task:f.task,page,config:{autoSubmitDirectory:true},active:()=>true,assertDocument:async()=>{},candidate:()=>({engine,detection:{platform:'directory'}}),visual:()=>({}),ownership:{}});
  try{await assert.rejects(adapter.deterministicSubmit({},{}),mode==='wrong-product'?/产品名称与资料品牌不一致/:/必填项已变化/);assert.equal(clicks,0);assert.equal(f.task.attemptBoundary,undefined);assert.equal(f.task.actualSubmission,undefined);}finally{adapter.dispose();f.store.close();}
 }
});
