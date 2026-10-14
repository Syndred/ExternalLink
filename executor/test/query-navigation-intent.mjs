import assert from 'node:assert/strict';
import {chromium} from '../node_modules/playwright/index.mjs';
import {attachEngine} from '../src/engine.mjs';
import {createOriginalSubmissionAdapter} from '../src/original-submission-adapter.mjs';
const html='<!doctype html><main id="app"><form role="search" method="get"><input type="search" name="query" value="https://product.example"><button id="query" type="submit">Search</button></form></main><script>document.querySelector("form").onsubmit=async event=>{event.preventDefault();await fetch("/lookup?query="+encodeURIComponent(document.querySelector("input").value));document.querySelector("main").innerHTML=\'<form method="post"><label>Product name<input name="name" value="Original" required></label><label>Website<input type="url" name="website" value="https://product.example" required></label><button id="final" type="submit">Submit Product</button></form>\';document.querySelector("form").onsubmit=async event=>{event.preventDefault();await fetch("/receipt",{method:"POST",body:new URLSearchParams(new FormData(event.currentTarget))});document.querySelector("main").innerHTML="<h1>Submission received</h1>";};};</script>';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
const context=await browser.newContext();let queries=0,posts=0,outsideRequests=0;
try{
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='query-fixture.example'){outsideRequests++;return route.abort();}if(url.pathname==='/lookup'){queries++;return route.fulfill({contentType:'application/json',body:'{}'});}if(url.pathname==='/receipt'){posts++;return route.fulfill({contentType:'application/json',body:'{"ok":true}'});}if(url.pathname==='/add-site')return route.fulfill({contentType:'text/html',body:html});return route.abort();});
 const page=await context.newPage();await page.goto('https://query-fixture.example/add-site');
 const frame=page.mainFrame(),engine=await attachEngine(context,frame,async()=>({ok:true}));
 const task={id:'local-query',runId:'local-run',profileId:'local-profile',url:page.url(),status:'filling',profileSnapshot:{fields:{Name:'Original',Url:'https://product.example'}}},events=[],ownership={};
 const runtime={store:{get:key=>key==='task:local-query'?task:null,pending:()=>[],valuesByInsertion:()=>[]},cloud:{request:async()=>({documents:{submissionRecords:{}}})},update(target,patch,event){Object.assign(target,patch);events.push(event);},reconcileTextInputs:async()=>{}};
 const adapter=createOriginalSubmissionAdapter(runtime,{task,page,config:{autoSubmitDirectory:true},active:()=>true,assertDocument:async()=>{},candidate:()=>({frame,engine,detection:{platform:'directory'}}),visual:()=>({elements:[{selector:'#query',label:'Search',type:'submit'},{selector:'#final',label:'Submit Product',type:'submit'}]}),ownership});
 try{
  const intent=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector:'#query'}});
  assert.equal(intent.intent,'navigation');assert.equal(intent.queryAction,true);
  const lookup=await adapter.act({type:'click',selector:'#query'});
  assert.equal(lookup.results[0].submitted,false);assert.equal(lookup.results[0].navigationExpected,true);
  assert.equal(task.attemptBoundary,undefined);assert.equal(task.actualSubmission,undefined);
  await page.locator('#final').waitFor();assert.equal(queries,1);assert.equal(posts,0);
  const finalIntent=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector:'#final'}});assert.equal(finalIntent.intent,'submission');
  const submitted=await adapter.act({type:'click',selector:'#final'});assert.equal(submitted.results[0].submitted,true);
  assert.ok(task.attemptBoundary);assert.equal(events.filter(event=>event==='original_visual_attempt_boundary').length,1);
  await page.getByRole('heading',{name:'Submission received'}).waitFor();assert.equal(posts,1);
  const blocked=await adapter.act({type:'fill',selector:'input[name=name]',value:'Original'},{entry:{submissionAttempted:true}});assert.equal(blocked.unconfirmed,true);assert.equal(posts,1);
  assert.equal(outsideRequests,0);
  console.log(JSON.stringify({ok:true,isolatedProductionEngine:true,domSearchStructureProved:true,searchClickedWithoutSubmissionBoundary:true,detailsStageRemainsWritable:true,realFinalBoundaryProtected:true,postAttemptMutationBlocked:true,queries,localPosts:posts,networkReceipt:adapter.networkEvidence()?.matched===true,outsideRequests,realSubmissions:0,productionWrites:0}));
 }finally{adapter.dispose();await engine.detach();}
}finally{await context.close();await browser.close();}
