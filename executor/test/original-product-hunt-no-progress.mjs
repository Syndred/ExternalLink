import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {Runtime} from '../src/runtime.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {sidepanelOpened,sidepanelFill} from '../src/single-page.mjs';
import {fillAssistantTask} from '../src/browser-assistant.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';
import {queue,profiles} from '../src/shared.mjs';
import {runProductHuntWorkflow} from '../src/product-hunt.mjs';
import {attachEngine} from '../src/engine.mjs';

const home=await mkdtemp(join(tmpdir(),'el-original-hunt-no-progress-'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']}),context=await browser.newContext(),store=new Store(join(home,'outbox.sqlite')),runtime=new Runtime(store,home);
let posts=0,externalRequests=0,modelCalls=0,stepCalls=0;const rows=[];
const reply={ok:false,stage:'main_info',reason:'Original pane did not advance'},profile={id:'p',name:'Original Product',fields:{Name:'Original Product',Url:'https://original-product.example','Business mail':'original@example.com'}};
const snapshot={documents:{siteProfiles:{p:profile},selectedSiteIds:['p'],activeSiteId:'p',submissionRecords:{},sheetTableData:{entries:[{link:'https://www.producthunt.com/posts/new',name:'Product Hunt'}]},autoFillOnVisit:true},revisions:{siteProfiles:2}};
const pair={endpoint:'https://owned-hunt-cloud.invalid',workspaceId:'original-hunt'};
runtime.context=context;runtime.host={startedAt:'owned-no-progress-browser'};runtime.lease=async()=>{};
runtime.synchronize=async()=>{for(const event of store.pending())store.ack(event.id);};
runtime.prepareWithAi=async()=>{modelCalls++;throw Error('No-progress reply must not trigger AI');};
Object.defineProperty(runtime,'cloud',{value:{async request(route){
 if(route==='snapshot')return structuredClone(snapshot);
 if(route==='runs?view=inventory')return{tasks:store.values('task:'),runs:store.values('run:')};
 throw Error('Unexpected fixture cloud route '+route);
}}});
// Inject one deterministic protocol reply into this owned CDP context, after
// the normal native engine attaches. This tests actual caller routing and
// task persistence, not real-site Product Hunt DOM interpretation.
const sessionFor=context.newCDPSession.bind(context);
context.newCDPSession=async(...args)=>{const session=await sessionFor(...args),send=session.send.bind(session);session.send=async(command,params)=>{
 if(command==='Runtime.evaluate'&&params.expression?.startsWith('new Promise((resolve,reject)=>')&&params.expression.includes('"action":"runProductHuntStep"')){stepCalls++;return{result:{type:'object',value:structuredClone(reply)}};}
 return send(command,params);
};return session;};
await context.route('**/*',async route=>{
 const request=route.request();if(request.method()!=='GET'){posts++;await route.abort();return;}
 const url=new URL(request.url());if(url.hostname==='www.producthunt.com'&&url.pathname==='/posts/new'){await route.fulfill({contentType:'text/html',body:'<main><h1>Main info</h1><label>Product name<input name="name"></label><button type="button" onclick="window.created=(window.created||0)+1">Create draft</button></main>'});return;}
 externalRequests++;await route.abort();
});
try{
 store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});store.set('task:unknown',{id:'unknown',status:'submitted_unconfirmed',attemptBoundary:'Keep original unknown boundary'});
 store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:structuredClone(snapshot)});
 const page=await context.newPage();await page.goto('https://www.producthunt.com/posts/new');const target=await getTargetInfo(context,page);
 const task={id:'original-hunt',runId:'original-run',profileId:'p',profileSnapshot:structuredClone(profile),profileRevision:2,url:page.url(),destinationKey:queue.normalizeDestinationKey(page.url()),targetId:target.targetId,browserInstance:runtime.host.startedAt,status:'pending',controller:'executor',version:1};
 const run={id:task.runId,profileId:task.profileId,profile:structuredClone(profile),profileRevision:2,tasks:[{id:task.id,url:task.url}]};store.set('task:'+task.id,task);store.set('run:'+run.id,run);
 const protectedRun=structuredClone(store.get('run:'+run.id)),protectedUnknown=structuredClone(store.get('task:unknown'));
 const assertKept=()=>{const current=store.get('task:'+task.id);assert.equal(current.id,task.id);assert.equal(current.runId,task.runId);assert.equal(current.targetId,target.targetId);assert.equal(current.profileRevision,2);assert.deepEqual(current.profileSnapshot,profile);assert.equal(current.attemptBoundary,undefined);assert.equal(current.receipt,undefined);assert.deepEqual(store.get('run:'+run.id),protectedRun);assert.deepEqual(store.get('task:unknown'),protectedUnknown);assert.deepEqual(store.get('acceptanceBatch'),{status:'paused',cursor:13,count:30});assert.equal(store.values('task:').length,2);assert.equal(page.isClosed(),false);};
 store.set('paused',false);let before=stepCalls;await runtime.work({taskId:task.id});assert.equal(stepCalls-before,1);assertKept();assert.equal(store.get('task:'+task.id).status,'needs_manual');assert.equal(store.get('task:'+task.id).reason,reply.reason);assert.equal(store.get('task:'+task.id).productHunt.history.length,1);rows.push({entrypoint:'launch',stepRequests:1,parkedOriginalTask:true});
 // Resume the same original task without creating or replacing its identity.
 runtime.update(store.get('task:'+task.id),{status:'pending'},'fixture_resume_original');before=stepCalls;await runtime.work({taskId:task.id});assert.equal(stepCalls-before,1);assertKept();assert.equal(store.get('task:'+task.id).productHunt.history.length,2);rows.push({entrypoint:'launch_resume',stepRequests:1,sameOriginalTask:true});
 store.set('paused',true);const opened=sidepanelOpened(runtime,{profileId:'p',targetId:target.targetId}),input={panelId:opened.panel.id,profileId:'p',targetId:target.targetId,expectedUrl:page.url(),mode:'form'};
 before=stepCalls;const panel=await sidepanelFill(runtime,input);assert.equal(stepCalls-before,1);assert.equal(panel.taskId,task.id);assert.equal(panel.fill.waiting,true);assert.equal(panel.fill.retryAfterMs,800);assert.equal(panel.readyToCreate,false);assertKept();rows.push({entrypoint:'sidepanel',stepRequests:1,waiting:true,retryAfterMs:800});
 store.set('browserAssistantSettings',{scope:workbenchScope(pair),enabled:true,autoFillOnVisit:true,profileId:'p'});before=stepCalls;const assistant=await fillAssistantTask(runtime,{taskId:task.id,targetId:target.targetId,url:page.url(),panelId:opened.panel.id,panelGeneration:opened.panel.generation});assert.equal(stepCalls-before,1);assert.equal(assistant.taskId,task.id);assert.equal(assistant.readyToCreate,false);assertKept();rows.push({entrypoint:'visit_auto_fill',stepRequests:1,sameOriginalTask:true});
 assert.equal(store.get('task:'+task.id).productHunt.history.length,4);assert.equal(await page.evaluate(()=>window.created||0),0);assert.equal(posts,0);assert.equal(externalRequests,0);assert.equal(modelCalls,0);assert.equal(store.get('paused'),true);
 // Simulate the screenshot operator changing this owned DOM. The final
 // readiness check uses the real attached engine, while no real model runs.
 const originalSessionFor=context.newCDPSession;context.newCDPSession=sessionFor;
 for(const entrypoint of ['launch','sidepanel']){
  const current=store.get('task:'+task.id),identity=Object.fromEntries(['runId','profileId','targetId','profileRevision','browserInstance'].map(key=>[key,current[key]]));runtime.update(current,{productHuntCreationConsent:identity},'fixture_original_consent');
  let visualCalls=0,requests=0;runtime.prepareWithAi=async(_page,_task,config,active,options)=>{
   visualCalls++;assert.equal(config.productHuntPrepared,true);assert.equal(config.visualFillOnly,true);assert.equal(active(),true);
   await page.evaluate(()=>{document.querySelector('main').innerHTML='<h1>Launch checklist</h1><div role="progressbar" aria-valuenow="100">All steps complete</div><button id="create" type="button" onclick="window.created=(window.created||0)+1">Create draft</button>';});
   const engine=await attachEngine(context,page.mainFrame());assert.equal(await options.readyCheck(engine),true);return{ok:true,candidate:{engine,frame:page.mainFrame()}};
  };
  const outcome=await runProductHuntWorkflow(runtime,current,page,profiles.buildAgentConfigFromProfile(profile),{active:()=>true,entrypoint,confirmCreate:true,callEngine:async message=>{assert.equal(message.action,'runProductHuntStep');assert.equal(message.confirmCreate,false);requests++;return{stage:'images',waiting:true,missing:['Original custom component']};}});
  assert.equal(requests,3);assert.equal(visualCalls,1);assert.equal(outcome.ready_to_create,true);assert.equal(outcome.submittedAttempt,false);assert.doesNotThrow(()=>JSON.stringify(outcome));assert.equal(Object.hasOwn(outcome,'candidate'),false);assert.equal(await page.evaluate(()=>window.created||0),0);assert.equal(store.get('task:'+task.id).attentionType,'producthunt_create_confirmation');assertKept();rows.push({entrypoint:entrypoint+'_visual_ready',stepRequests:3,visualCalls:1,actualFinalReadinessCheck:true,priorConsentDidNotCreate:true,serializableWithoutBrowserInternals:true});
 }
 context.newCDPSession=originalSessionFor;assert.equal(store.get('task:'+task.id).productHunt.history.length,12);
 console.log(JSON.stringify({ok:true,kind:'owned_native_product_hunt_injected_no_progress_protocol',rows,allEntrancesAndSameTaskResume:true,originalCheckpointHistory:12,actualVisualReadinessPreservedWithoutAnotherStepOrCreate:true,profileRunTargetAndUnknownBoundaryKept:true,posts,externalRequests,modelCalls,productionWrites:0}));
}finally{store.close();await browser.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-hunt-no-progress-'));await rm(home,{recursive:true,force:true});}
