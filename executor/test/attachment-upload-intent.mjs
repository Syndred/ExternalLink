import assert from 'node:assert/strict';
import {chromium} from '../node_modules/playwright/index.mjs';
import {attachEngine} from '../src/engine.mjs';
import {createOriginalSubmissionAdapter} from '../src/original-submission-adapter.mjs';
const fixture='<form id="listing" method="post"><label>Product name<input name="name" value="Original" required></label><button id="final" type="submit">Submit Product</button></form><div role="dialog" aria-label="File uploads"><form id="attachment"><input id="file" type="file" hidden><p>1 file selected</p><button id="upload" type="submit">Upload 1 file</button></form></div><script>window.uploaded=false;document.querySelector("#attachment").onsubmit=async event=>{event.preventDefault();const body=new FormData();body.append("file",document.querySelector("#file").files[0]);await fetch("/upload",{method:"POST",body});window.uploaded=true;document.querySelector("[role=dialog]").remove();};document.querySelector("#listing").onsubmit=event=>{event.preventDefault();window.submitted=true;};</script>';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
const context=await browser.newContext();let uploadPosts=0,outsideRequests=0,releaseUpload;const held=new Promise(resolve=>releaseUpload=resolve);
try{
 await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.hostname!=='upload-fixture.example'){outsideRequests++;return route.abort();}if(url.pathname==='/upload'){uploadPosts++;await held;return route.fulfill({contentType:'application/json',body:'{"ok":true}'});}return route.fulfill({contentType:'text/html',body:fixture});});
 const page=await context.newPage();await page.goto('https://upload-fixture.example/submit');await page.locator('#file').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('local image fixture')});
 const frame=page.mainFrame(),engine=await attachEngine(context,frame,async()=>({ok:true}));
 const task={id:'local-upload',runId:'r',profileId:'p',url:page.url(),targetId:'isolated',browserInstance:'isolated',status:'filling',profileSnapshot:{fields:{Name:'Original',Url:'https://product.example'}}},events=[];
 const runtime={store:{get:key=>key==='task:local-upload'?task:null,pending:()=>[],valuesByInsertion:()=>[]},cloud:{request:async()=>({documents:{submissionRecords:{}}})},update(target,patch,event){Object.assign(target,patch);events.push(event);},reconcileTextInputs:async()=>{}};
 const adapter=createOriginalSubmissionAdapter(runtime,{task,page,config:{autoSubmitDirectory:true},active:()=>true,assertDocument:async()=>{},candidate:()=>({frame,engine,detection:{platform:'directory'}}),visual:()=>({elements:[{selector:'#upload',label:'Upload 1 file',type:'submit'},{selector:'#final',label:'Submit Product',type:'submit'}]}),ownership:{}});
 try{
  const intent=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector:'#upload'}});assert.equal(intent.intent,'attachment');assert.equal(intent.attachmentFiles[0].name,'logo.png');
  const uploaded=await adapter.act({type:'click',selector:'#upload'});assert.equal(uploaded.results[0].submitted,false);assert.equal(task.attemptBoundary,undefined);assert.equal(task.status,'filling');
  assert.equal(task.attachmentActionHistory[0].status,'clicked');
  await page.locator('#file').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('local image fixture')});
  const again=await adapter.act({type:'click',selector:'#upload'});assert.equal(again.attachmentActionGuard,true);assert.equal(task.attemptBoundary,undefined);
  releaseUpload();await page.waitForFunction(()=>window.uploaded===true);assert.equal(uploadPosts,1);
  const removed=await adapter.act({type:'click',selector:'#upload'});assert.equal(removed.attachmentActionGuard,true);assert.equal(task.attemptBoundary,undefined);
  await adapter.act({type:'fill',selector:'input[name=name]',value:'Original'});assert.equal(task.attemptBoundary,undefined);
  const final=await adapter.act({type:'click',selector:'#final'});assert.equal(final.results[0].submitted,true);assert.ok(task.attemptBoundary);
  assert.equal(events.filter(event=>event==='original_visual_attempt_boundary').length,1);assert.equal(uploadPosts,1);assert.equal(outsideRequests,0);
  console.log(JSON.stringify({ok:true,isolatedProductionEngine:true,productionAdapter:true,fixtureStore:'memory mock',nativeFilesProveAttachmentIntent:true,uploadUsesSeparateActionHistory:true,uncertainUploadNotRepeated:true,reselectedFileDoesNotReupload:true,removedDialogNotReclicked:true,formRemainsWritableBeforeFinal:true,realFinalBoundaryProtected:true,localUploadPosts:uploadPosts,outsideRequests,realSubmissions:0,productionWrites:0}));
 }finally{adapter.dispose();await engine.detach();}
}finally{releaseUpload();await context.close();await browser.close();}
