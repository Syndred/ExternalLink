import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {Runtime} from '../src/runtime.mjs';
import {Store} from '../src/store.mjs';
import {fillAssistantTask,stopBrowserAssistant} from '../src/browser-assistant.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';
import {sidepanelOpened,sidepanelFill} from '../src/single-page.mjs';
const home=await mkdtemp(join(tmpdir(),'el-original-full-fill-')),browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']}),context=await browser.newContext(),store=new Store(join(home,'outbox.sqlite')),runtime=new Runtime(store,home);
const profile={id:'p',name:'Original Product',fields:{Name:'Original Product',Url:'https://product.example','Business mail':'owner@example.com','Long description (250-500 words)':'Original frozen product description.'}},snapshot={documents:{siteProfiles:{p:profile,q:{...profile,id:'q',name:'Other Product'}},submissionRecords:{old:{status:'success',evidence:'Keep original'}},sheetTableData:{entries:[]},siteAnnotations:{'full-fill.fixture.invalid':{note:'Original user note',auto:false,library:{favorite:true,groups:['original']}}}},revisions:{siteProfiles:2,sheetTableData:1}},pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original-full-fill'},scope=workbenchScope(pair),runs=new Map(),remoteTasks=new Map(),artifacts=new Map(),results=[];
let posts=0,external=0,scenario='planner',currentPage,modelCalls=[],currentPanel;const manualEntry=process.argv.includes('--manual');
const base='<label>Product name<input name="productName" id="name" required></label><label>Website<input name="website" id="website" type="url" required></label><label>Email<input name="email" type="email" required></label><label>Description<textarea name="description" required></textarea></label>';
const custom='<label>Directory section<input name="portalSection" id="portalSection" required pattern="^SECTION-A$"></label>';
await context.route('**/*',async route=>{const request=route.request();if(!new URL(request.url()).hostname.endsWith('.fixture.invalid')){external++;await route.abort();return;}if(request.method()==='POST')posts++;const child=new URL(request.url()).pathname==='/child',embedded=scenario==='iframe'&&!child;await route.fulfill({contentType:'text/html',body:'<!doctype html><h1>Submit your product</h1>'+(embedded?'<form><label>Website<input type="url" name="website" required></label></form><iframe src="/child" style="height:600px;width:800px"></iframe>':'<form>'+base+custom+'<button type="submit">Submit product</button></form>')});});
store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});runtime.context=context;runtime.host={startedAt:'original-full-fill-browser'};
const settings=()=>store.set('browserAssistantSettings',{scope,enabled:true,autoFillOnVisit:true,profileId:'p'});settings();
Object.defineProperty(runtime,'cloud',{value:{async request(route,input,method,options){
 if(route==='snapshot')return structuredClone(snapshot);if(route==='runs?view=inventory')return{runs:[...runs.values()],tasks:[...remoteTasks.values()]};if(route.startsWith('runs?runId=')){const id=decodeURIComponent(route.split('=')[1]);return{runs:runs.has(id)?[structuredClone(runs.get(id))]:[],tasks:[...remoteTasks.values()].filter(task=>task.runId===id)};}if(route.startsWith('tasks/'))return{task:structuredClone(remoteTasks.get(route.slice(6)))};
 if(route==='runs'){assert.equal(input.run.authorization,'fill_only');const run={...input.run,profile:structuredClone(profile)},task={...run.tasks[0],runId:run.id,profileId:run.profileId,status:manualEntry&&scenario==='false-ready'?'pending':'needs_manual',attentionType:'fill_only',version:1};runs.set(run.id,run);remoteTasks.set(task.id,task);return{ok:true,run,tasks:[task]};}
 if(route==='artifact'){const ref='cloud-artifact://'+artifacts.size;artifacts.set(ref,input.dataUrl);return{ref};}if(route==='artifact-read')return{dataUrl:artifacts.get(input.ref)};
 if(route.startsWith('ai/')){
  modelCalls.push({route,options:structuredClone(options),input:structuredClone(input)});assert.equal(input.config.projectKey||input.config.brandName,route==='ai/validate-fill'?'Original Product':'p');assert.equal(input.config.fillOnly??true,true);
  if(route==='ai/plan'){
   assert.equal(options.timeoutMs,25000);const selector=input.snapshot.fields.find(field=>field.id==='portalSection').selector;
   if(scenario==='profile-switch'){if(manualEntry)sidepanelOpened(runtime,{panelId:currentPanel.id,profileId:'q',targetId:currentPanel.selectedTargetId});else store.set('browserAssistantSettings',{scope,enabled:true,autoFillOnVisit:true,profileId:'q'});return{status:'act',actions:[{type:'fill',selector:'#portalSection',value:'SECTION-A'}]};}
   if(scenario==='reload'){await currentPage.reload();return{status:'act',actions:[{type:'fill',selector:'#portalSection',value:'SECTION-A'}]};}
   if(scenario==='late-unknown'){const info=await getTargetInfo(context,currentPage),task=store.values('task:').find(task=>task.targetId===info.targetId);runtime.update(task,{attentionType:'unknown_receipt',reason:'Unknown prior attempt; keep original'},'fixture_unknown_prior_attempt');return{status:'act',actions:[{type:'fill',selector,value:'SECTION-A'}]};}
   if(scenario==='schema-change'){await currentPage.evaluate(()=>document.querySelector('form').insertAdjacentHTML('beforeend','<input name="newRequired" required>'));return{status:'act',actions:[{type:'fill',selector:'#portalSection',value:'SECTION-A'}]};}
   if(scenario==='semantic')return{status:'blocked',reason:'Uncertain whether pricing means paid product or submission',actions:[]};
   if(['planner','iframe'].includes(scenario))return{status:'act',actions:[{type:'fill',selector,value:'SECTION-A'},{type:'click',selector:'button[type=submit]'}]};
   return{status:'act',actions:[]};
  }
  if(route==='ai/vision-plan'){assert.ok(input.screenshot.startsWith('data:image/png;base64,'));const selector=input.snapshot.fields.find(field=>field.id==='portalSection').selector;assert.ok(input.elements.some(element=>element.selector===selector));if(scenario==='human-gate')return{status:'needs_manual',reason:'CAPTCHA verification required',actions:[]};return{status:'act',stage:'original-custom-section',actions:[{type:'fill',selector,value:'BAD'},{type:'click',selector:input.elements.find(element=>element.type==='submit').selector}]};}
  if(route==='ai/validate-fill')return{status:'revise',submitReady:true,fields:[{selector:'#portalSection',value:scenario==='false-ready'?'BAD':'SECTION-A'}],issues:[]};
 }
 throw Error('Unexpected original fixture route '+route);
}}});
runtime.lease=async()=>{};runtime.synchronize=async()=>{for(const event of store.pending()){remoteTasks.set(event.taskId,event.state);store.ack(event.id);}};runtime.tick=()=>{throw Error('Fill-only must not start submission');};
const originalDocuments=structuredClone(snapshot.documents);
try{
 for(const mode of ['planner','visual-and-final-fix','false-ready','semantic','human-gate','schema-change','profile-switch','reload','late-unknown','iframe',...(manualEntry?['no-agent']:[])]){
  scenario=mode;settings();modelCalls=[];currentPage=await context.newPage();await currentPage.goto('https://'+mode+'.fixture.invalid/submit');if(mode==='iframe')await currentPage.frameLocator('iframe').locator('#portalSection').waitFor();snapshot.documents.sheetTableData.entries.push({link:currentPage.url(),indexPage:currentPage.url(),name:mode});store.set('applicationSnapshot',{scope,snapshot:structuredClone(snapshot)});
  const info=await getTargetInfo(context,currentPage);let result,error;try{if(manualEntry){currentPanel=sidepanelOpened(runtime,{profileId:'p',targetId:info.targetId}).panel;result=await sidepanelFill(runtime,{panelId:currentPanel.id,profileId:'p',targetId:info.targetId,expectedUrl:currentPage.url(),mode:'form',useAgent:mode!=='no-agent',submit:mode==='false-ready',ordinaryPermissionsAuthorized:mode==='false-ready'});}else result=await fillAssistantTask(runtime,{profileId:'p',targetId:info.targetId,url:currentPage.url()});}catch(caught){error=caught.message;}
  const frame=mode==='iframe'?currentPage.frames().find(candidate=>candidate.parentFrame()):currentPage.mainFrame(),value=await frame.locator('#portalSection').inputValue(),task=store.values('task:').find(task=>task.targetId===info.targetId);
  if(['planner','iframe'].includes(mode)){assert.equal(result.submitReady,true);assert.equal(value,'SECTION-A');assert.deepEqual(modelCalls.map(call=>call.route),['ai/plan']);}
  if(mode==='visual-and-final-fix'){assert.equal(result.submitReady,true);assert.equal(value,'SECTION-A');assert.deepEqual(modelCalls.map(call=>call.route),['ai/plan','ai/vision-plan','ai/vision-plan','ai/validate-fill']);assert.equal(task.visitFillVisualHistory.length,2);assert.ok(task.visitFillVisualHistory.every(step=>step.artifactRef));assert.ok(modelCalls[2].input.history.length===1);}
  if(mode==='false-ready'){assert.equal(result.submitReady,false);assert.equal(value,'BAD');assert.ok(result.counts.invalidCount>0);assert.equal(task.status,'needs_manual');}
  if(['semantic','schema-change'].includes(mode)){assert.equal(result.submitReady,false);assert.equal(value,'');assert.equal((manualEntry?task.singlePagePreparation:task.assistantPreparation).fill.agentResult.semanticReview,true);assert.equal(modelCalls.length,1);}
  if(mode==='human-gate'){assert.equal(result.submitReady,false);assert.equal(value,'');assert.equal(modelCalls.length,2);}
  if(['profile-switch','reload','late-unknown'].includes(mode)){assert.ok(error,error);assert.equal(value,'');assert.equal(modelCalls.length,1);assert.equal(manualEntry?task.singlePagePreparation:task.assistantPreparation,undefined);}if(mode==='late-unknown'){assert.equal(task.attentionType,'unknown_receipt');assert.equal(task.reason,'Unknown prior attempt; keep original');}if(mode==='no-agent'){assert.equal(result.submitReady,false);assert.equal(value,'');assert.equal(modelCalls.length,0);}
  assert.deepEqual(task.profileSnapshot,profile);assert.equal(task.attemptBoundary,undefined);assert.equal(task.receipt,undefined);assert.equal(store.get('run:'+task.runId).authorization,'fill_only');results.push({mode,submitReady:result?.submitReady,oldPlanRejected:!!error,fieldValue:value,modelRoutes:modelCalls.map(call=>call.route),pageKept:!currentPage.isClosed()});await currentPage.close();
 }
 for(const key of ['siteProfiles','siteAnnotations','submissionRecords'])assert.deepEqual(snapshot.documents[key],originalDocuments[key]);assert.equal(posts,0);assert.equal(external,0);assert.equal(store.get('paused'),true);assert.deepEqual(store.get('acceptanceBatch'),{status:'paused',cursor:13,count:30});console.log(JSON.stringify({ok:true,kind:manualEntry?'actual_isolated_native_original_manual_single_page_fill':'actual_isolated_native_original_full_visit_fill',results,posts,externalRequests:external,realModelCalls:0,productionWrites:0,originalFrozenProfileManualMarksFavoritesGroupsReceiptsAndFixedBatchKept:true,artifactIndependentReadbacks:artifacts.size}));
}finally{await stopBrowserAssistant(runtime);await browser.close();store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-full-fill-'));await rm(home,{recursive:true,force:true});}
