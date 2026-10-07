import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'playwright';
import {Runtime} from '../src/runtime.mjs';
import {Store} from '../src/store.mjs';
import {profiles,plain} from '../src/shared.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {navigationScope,pendingNavigationMarker} from '../src/original-navigation-rejudge.mjs';

// Real isolated Chrome/navigation/native preparation; fixture model and ledger.
// No original browser profile, real AI service, external request or submission.
let posts=0,external=0;
const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(req.url==='/start'?'<h1>Add a product</h1><a id="next" href="/form">Continue to product form</a>':'<h1>Submit your product</h1><form method="POST"><label>Product name<input id="name" name="name" required></label><label>Website URL<input id="website" name="url" type="url" required></label><button type="submit">Submit product</button></form>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const portServer=http.createServer();await new Promise(done=>portServer.listen(0,'127.0.0.1',done));const port=portServer.address().port;await new Promise(done=>portServer.close(done));
const home=await mkdtemp(join(tmpdir(),'el-navigation-browser-')),browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions','--remote-debugging-port='+port]}),context=await browser.newContext(),store=new Store(join(home,'outbox.sqlite')),runtime=new Runtime(store,home),results=[];
const profile={id:'p',name:'Frozen original product',fields:{Name:'Frozen original product',Url:'https://product.example'}},snapshot={documents:{siteProfiles:{p:profile},siteAnnotations:{},deletedSubmissionKeys:[],submissionRecords:{}},revisions:{siteProfiles:2,siteAnnotations:1,deletedSubmissionKeys:1}};
store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'navigation'});store.set('paused',false);runtime.context=context;runtime.host={endpoint:'http://127.0.0.1:'+port,startedAt:'isolated-navigation-browser'};runtime.lease=async()=>{};
const flush=async()=>{for(const event of store.pending())store.ack(event.id);};runtime.synchronize=flush;
let page,task,modelCalls,plans,navigationFailure,mode;
runtime.preparePublicPage=async()=>{if(mode==='after-action'&&navigationFailure&&page.url().endsWith('/form')){navigationFailure=false;throw Error('snapshot unavailable during post-action navigation');}};
runtime.prepareKnownPage=async()=>{};
Object.defineProperty(runtime,'cloud',{value:{flush,async request(route,input){
 if(route==='snapshot')return structuredClone(snapshot);
 if(route==='artifact')return{ref:'isolated-navigation-artifact'};
 if(route==='ai/judge'){modelCalls++;return{status:'incomplete'};}
 if(route==='ai/vision-plan'){modelCalls++;plans++;assert.equal(input.config.projectKey,'p');assert.equal(input.config.fillOnly,true);const link=input.snapshot.buttons.find(element=>element.href?.endsWith('/form')),next=input.elements.find(element=>element.selector===link?.selector);assert.ok(next,'Only the observed original navigation link can be clicked');return{status:'act',actions:[{type:'click',selector:next.selector}]};}
 throw Error('Unexpected fixture route: '+route);
}}});
await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():(external++,route.abort()));
const userPage=await context.newPage();await userPage.goto('http://127.0.0.1:'+server.address().port+'/user');
try{
 for(mode of ['after-action','saved-checkpoint']){
  page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+(mode==='after-action'?'/start':'/form'));const target=await getTargetInfo(context,page);
  task={id:'task-'+mode,runId:'run-'+mode,profileId:'p',profileRevision:2,profileSnapshot:structuredClone(profile),url:'http://127.0.0.1:'+server.address().port+'/start',targetId:target.targetId,browserInstance:runtime.host.startedAt,status:'filling',controller:'executor',version:1};
  store.set('run:'+task.runId,{id:task.runId,profileId:'p',profile:structuredClone(profile),tasks:[task.id],mediaManifest:[]});store.set('task:'+task.id,task);modelCalls=0;plans=0;navigationFailure=true;
  if(mode==='saved-checkpoint'){task.aiTakeover={id:'saved-original',calls:2,actions:1,history:[{type:'click',selector:'#next'}],originalVisual:{loops:1,history:[],pendingRejudge:{id:'saved-nav',status:'waiting_navigation',navigationScope:navigationScope(runtime,task)}}};store.set('task:'+task.id,task);}
  const result=await runtime.prepareWithAi(page,task,plain(profiles.buildAgentConfigFromProfile(profile)),()=>store.get('paused')===false,{readyCheck:async()=>await page.locator('#name').inputValue()===profile.fields.Name&&await page.locator('#website').inputValue()===profile.fields.Url});
  assert.equal(result.ok,true,JSON.stringify({mode,result,task}));assert.equal(await page.locator('#name').inputValue(),profile.fields.Name);assert.equal(await page.locator('#website').inputValue(),profile.fields.Url);assert.equal((await getTargetInfo(context,page)).targetId,target.targetId);assert.equal(pendingNavigationMarker(task).status,'completed');assert.equal(task.aiTakeover.calls,2);assert.equal(task.aiTakeover.actions,1);assert.equal(task.aiTakeover.originalVisual.loops,1);assert.equal(task.receipt,undefined);assert.equal(task.attemptBoundary,undefined);assert.equal(plans,mode==='after-action'?1:0);assert.equal(modelCalls,mode==='after-action'?2:0);assert.equal(userPage.isClosed(),false);
  const types=store.logs({scope:'https://cloud.fixture.invalid|navigation',taskId:task.id}).entries.map(event=>event.type);assert.ok(types.includes('original_navigation_ready'));if(mode==='after-action')assert.ok(types.includes('original_navigation_pending_rejudge'));
  results.push({mode,prepared:true,sameTarget:true,modelCalls,actions:task.aiTakeover.actions,originalCheckpointCompleted:true,deterministicCurrentProfileFill:true});await result.candidate.engine.detach();await page.close();
 }
 assert.equal(posts,0);assert.equal(external,0);console.log(JSON.stringify({ok:true,kind:'actual_isolated_navigation_native_preparation',results,userPagePreserved:!userPage.isClosed(),posts,externalRequests:external,realModelCalls:0,productionWrites:0,fullOriginalPluginAcceptance:false}));
}finally{await browser.close();store.close();await new Promise(done=>server.close(done));assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-navigation-browser-'));await rm(home,{recursive:true,force:true});}
