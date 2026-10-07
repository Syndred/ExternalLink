import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {Runtime} from '../src/runtime.mjs';
import {Store} from '../src/store.mjs';
import {profiles,plain} from '../src/shared.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';

let posts=0,externalRequests=0,scenario,currentTask,currentPage,routes,visionSteps;
const posted=[];
const form=mode=>`<h1>Submit your product for free</h1><form onsubmit="event.preventDefault();submitFixtureProduct()"><label>Product name<input id="product" name="productName" required></label><label>Website URL<input id="website" name="websiteUrl" type="url" required></label><label>Directory section<input id="section" name="portalSection" required pattern="^SECTION-A$"></label><button id="send" type="button" onclick="submitFixtureProduct()">${mode==='gate'?'Buy premium plan':'Publish product'}</button></form><div id="receipt"></div><script>async function submitFixtureProduct(){if(!document.querySelector('form').reportValidity())return;const response=await fetch('/receipt/${mode}',{method:'POST',body:new URLSearchParams(new FormData(document.querySelector('form')))});${mode==='navigation'?"location.assign('/done')":"document.querySelector('#receipt').textContent=await response.text()"};}</script>`;
const server=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','text/html');
 if(req.method==='POST'){posts++;let body='';for await(const bytes of req)body+=bytes;posted.push({path:req.url,fields:Object.fromEntries(new URLSearchParams(body))});res.end(req.url.includes('unconfirmed')?'Form action processed without a confirmation':'Thank you for your submission. Your submission is under review.');return;}
 if(req.url==='/done')res.end('<h1>Your submission has been received and is under review.</h1><p>Our directory team will review your original product and contact you when it is published.</p>');else if(req.url.startsWith('/iframe'))res.end('<h1>Original embedded form</h1><iframe src="/child" style="margin-top:90px;width:900px;height:700px"></iframe>');else res.end(form(req.url.slice(1)));
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const portServer=http.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const home=await mkdtemp(join(tmpdir(),'el-original-submission-')),browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions','--remote-debugging-port='+port]}),context=await browser.newContext(),store=new Store(join(home,'outbox.sqlite')),runtime=new Runtime(store,home),artifacts=new Map(),results=[];
const profile={id:'p',name:'Original frozen product',fields:{Name:'Original frozen product',Url:'https://product.example'}},pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original-submission'},snapshot={documents:{siteProfiles:{p:profile},autoSubmitDirectoryListings:true,siteAnnotations:{},submissionRecords:{}},revisions:{siteProfiles:7,siteAnnotations:1}};
store.set('pair',pair);store.set('paused',false);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});runtime.context=context;runtime.host={endpoint:'http://127.0.0.1:'+port,startedAt:'isolated-submission-'+Date.now()};runtime.preparePublicPage=async()=>{};runtime.lease=async()=>{};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():(externalRequests++,route.abort()));
Object.defineProperty(runtime,'cloud',{value:{flush:async store=>{for(const event of store.pending())store.ack(event.id);},async request(route,input){
 if(route==='artifact'){const ref='isolated-'+artifacts.size;artifacts.set(ref,input.dataUrl);return{ref};}
 if(route==='artifact-read'){assert.ok(artifacts.has(input.ref));return{dataUrl:artifacts.get(input.ref)};}
 if(route==='snapshot')return structuredClone(snapshot);
 if(route==='library')return{ok:true};
 routes.push(route);assert.equal(input.config.projectKey,'p');assert.equal(input.fillOnly??input.config.fillOnly,scenario==='disabled');
 if(route==='ai/judge')return{status:input.snapshot.evidenceSignals?.length||scenario==='unconfirmed'&&visionSteps?'success':'incomplete',evidence:'Model cannot supply proof',networkEvidence:{matched:true,status:200},publicationStatus:'pending_moderation'};
 if(route==='ai/vision-plan'){
  visionSteps++;assert.ok(input.screenshot.startsWith('data:image/png;base64,'));assert.equal(sha(Buffer.from(input.screenshot.split(',')[1],'base64')),sha(Buffer.from(artifacts.get(input.artifactRef).split(',')[1],'base64')));
  if(scenario==='dom')throw Error('fixture vision unavailable');
  if(scenario==='pause')store.set('paused',true);
  if(scenario==='late-unknown')store.set('task:'+currentTask.id,{...store.get('task:'+currentTask.id),attemptBoundary:'foreign-unknown',status:'submitted_unconfirmed',reason:'Keep foreign attempt'});
  const section=input.snapshot.fields.find(field=>field.id==='section'),button=input.elements.find(element=>element.selector==='#send'||element.label?.includes(scenario==='gate'?'Buy premium':'Publish product'));
  assert.ok(section);assert.ok(button,JSON.stringify(input.elements));if(scenario==='iframe')assert.ok(button.rect.y>90);
  return{status:'act',actions:[{type:'fill',selector:section.selector,value:'SECTION-A'},{type:'click',selector:button.selector}]};
 }
 assert.equal(route,'plan');assert.equal(input.mode,undefined);return{status:'act',actions:[{type:'fill',selector:input.snapshot.fields.find(field=>field.id==='section').selector,value:'SECTION-A'}]};
}}});
try{
 for(const mode of ['visual','iframe','dom','navigation','unconfirmed','gate','pause','late-unknown','disabled']){
  scenario=mode;routes=[];visionSteps=0;store.set('paused',false);currentPage=await context.newPage();await currentPage.goto('http://127.0.0.1:'+server.address().port+'/'+mode);const frame=mode==='iframe'?currentPage.frames().find(frame=>frame.parentFrame()):currentPage.mainFrame();await frame.locator('#section').waitFor();const target=await getTargetInfo(context,currentPage),beforePosts=posts;
  currentTask={id:'original-'+mode,runId:'run-'+mode,profileId:'p',profileRevision:7,profileSnapshot:structuredClone(profile),controller:'executor',version:1,targetId:target.targetId,browserInstance:runtime.host.startedAt,url:currentPage.url(),status:'filling'};store.set('task:'+currentTask.id,currentTask);store.set('run:'+currentTask.runId,{id:currentTask.runId,profileId:'p',profile:structuredClone(profile),tasks:[currentTask.id],mediaManifest:[]});store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:structuredClone(snapshot)});
  let navigationFailed=false;runtime.preparePublicPage=async()=>{if(mode==='navigation'&&currentPage.url().endsWith('/done')&&currentTask.attemptBoundary&&!navigationFailed){navigationFailed=true;throw Error('snapshot unavailable during original navigation');}};
  let result,error;try{result=await runtime.prepareWithAi(currentPage,currentTask,{...plain(profiles.buildAgentConfigFromProfile(profile)),fillOnly:false,autoSubmitDirectory:mode!=='disabled'},()=>store.get('paused')===false,{submission:true});}catch(caught){error=caught;}
  const saved=store.get('task:'+currentTask.id);
  if(['visual','iframe','dom','navigation'].includes(mode)){
   assert.equal(result?.ok,true,error?.stack||JSON.stringify({mode,result,routes,saved}));assert.equal(result.receiptRecorded,true);assert.equal(posts-beforePosts,1);assert.equal(saved.receipt.publicationStatus,'pending_moderation');assert.equal(saved.cloudVerified,false);assert.equal(saved.controller,'executor');assert.ok(saved.attemptBoundary);assert.equal(saved.actualSubmission.fields.find(field=>field.value==='Original frozen product')?.value,'Original frozen product');assert.ok(saved.screenshot);assert.equal(saved.aiTakeover.actions,mode==='dom'?1:2);assert.deepEqual(routes,mode==='dom'?['ai/judge','ai/vision-plan','plan']:['ai/judge','ai/vision-plan','ai/judge']);
   if(mode!=='dom'){assert.equal(saved.receipt.evidenceType,'network_receipt');assert.equal(saved.receipt.successProof.networkEvidence.matched,true);assert.equal(saved.receipt.successProof.actionObserved,true);}
   if(mode==='navigation'){assert.equal(navigationFailed,true);assert.equal(saved.aiTakeover.originalVisual.pendingRejudge.status,'completed');assert.equal(saved.aiTakeover.originalVisual.pendingRejudge.submissionPhase,true);assert.equal(saved.aiTakeover.originalVisual.pendingRejudge.stableChecks,2);assert.equal(currentPage.url().endsWith('/done'),true);}
   assert.deepEqual(posted.at(-1).fields,{productName:'Original frozen product',websiteUrl:'https://product.example',portalSection:'SECTION-A'});
  }else if(mode==='unconfirmed'){assert.equal(result.unconfirmed,true,error?.stack);assert.equal(posts-beforePosts,1);assert.ok(saved.attemptBoundary);assert.equal(saved.receipt,undefined);assert.equal(visionSteps,1);await assert.rejects(runtime.prepareWithAi(currentPage,saved,{autoSubmitDirectory:true},()=>true,{submission:true}),error=>error.staleTask===true);assert.equal(posts-beforePosts,1);}
  else if(mode==='gate'){assert.equal(result.needs_manual,true,error?.stack||JSON.stringify(result));assert.equal(saved.attemptBoundary,undefined);assert.equal(posts-beforePosts,0);assert.equal(saved.controller,'executor');}
  else if(mode==='pause'){assert.equal(result.interrupted,true,error?.stack);assert.equal(saved.attemptBoundary,undefined);assert.equal(posts-beforePosts,0);}
  else if(mode==='late-unknown'){assert.equal(error?.staleTask,true,error?.stack);assert.equal(saved.attemptBoundary,'foreign-unknown');assert.equal(saved.reason,'Keep foreign attempt');assert.equal(posts-beforePosts,0);}
  else if(mode==='disabled'){assert.equal(result.ok,true,error?.stack);assert.equal(saved.attemptBoundary,undefined);assert.equal(saved.receipt,undefined);assert.equal(posts-beforePosts,0);}
  assert.equal((await getTargetInfo(context,currentPage)).targetId,target.targetId);assert.deepEqual(store.get('acceptanceBatch'),{status:'paused',cursor:13,count:30});await result?.candidate?.engine.detach();results.push({mode,receiptRecorded:result?.receiptRecorded===true,unconfirmed:result?.unconfirmed===true,interrupted:result?.interrupted===true,staleRejected:error?.staleTask===true,posts:posts-beforePosts,sameTarget:true});await currentPage.close();
 }
 assert.equal(externalRequests,0);assert.equal(posts,5);assert.deepEqual(snapshot.documents.siteProfiles,{p:profile});assert.deepEqual(snapshot.documents.submissionRecords,{});console.log(JSON.stringify({ok:true,kind:'actual_isolated_original_visual_submission',results,posts,externalRequests,artifacts:artifacts.size,realModelCalls:0,productionWrites:0,fullMigrationComplete:false}));
}finally{await browser.close();store.close();await new Promise(resolve=>server.close(resolve));assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-submission-'));await rm(home,{recursive:true,force:true});}
