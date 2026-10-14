import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {attachEngine} from '../executor/src/engine.mjs';
import {createOriginalSubmissionAdapter} from '../executor/src/original-submission-adapter.mjs';
import {Store} from '../executor/src/store.mjs';

const normalizedSource=path=>readFileSync(new URL(path,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const extractPreparation=source=>source.match(/  function preparationClickIntent\([\s\S]*?(?=\n  function )/)[0];
test('standalone and extension preparation intent keep identical DOM proof rules',()=>{
 assert.equal(extractPreparation(normalizedSource('../core/form-engine.js')),extractPreparation(normalizedSource('../extension/content.js')));
});

test('native cookie dismiss and linked combobox actions are preparation, while submit and unlinked controls are protected',async()=>{
 let browser;try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext();let external=0,posts=0;
  const url='https://preparation.fixture.invalid/submit';await context.route('**/*',route=>{
   if(route.request().url()!==url){external++;return route.abort();}if(route.request().method()!=='GET'){posts++;return route.abort();}
   return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Submit AI Tool</title>
    <div id="cookies" role="dialog" aria-label="Cookie notice"><p>This cookie notice can be dismissed.</p><button id="close" aria-label="dismiss cookie notice" onclick="document.querySelector('#cookies').hidden=true">×</button><button type="submit" id="explicit-submit">Dismiss cookie notice</button><button type="button" id="accept">Accept cookies</button></div>
    <form id="product" method="post"><input name="name" value="Fixture Product"><input name="url" value="https://product.fixture.invalid/">
    <button type="button" id="category" role="combobox" aria-haspopup="listbox" aria-controls="categories" aria-expanded="false" onclick="document.querySelector('#categories').hidden=false;this.setAttribute('aria-expanded','true')">Category</button>
    <div id="categories" role="listbox" hidden><div id="option" role="option" tabindex="0" onclick="document.querySelector('#category').textContent='Generative AI';document.querySelector('#category').setAttribute('aria-expanded','false');document.querySelector('#categories').hidden=true">Generative AI</div></div>
    <button id="default-submit" role="combobox" aria-haspopup="listbox" aria-controls="uncontrolled" aria-expanded="false">Choose Category</button><button type="submit" id="final">Submit Tool</button>
    <button type="button" id="unexpected" role="combobox" aria-haspopup="listbox" aria-controls="unexpected-list" aria-expanded="false" onclick="this.form.requestSubmit()">Category</button><div id="unexpected-list" role="listbox" hidden></div>
    </form><div role="listbox" id="uncontrolled"><div role="option" id="unlinked" tabindex="0">Photography</div></div>
    <div role="menu"><div id="menu-final" role="menuitem" tabindex="0">Submit Tool</div></div>
    <div role="dialog" aria-label="Login"><button id="other-close" type="button">Close</button></div>
    <div role="dialog" aria-label="Cookie notice"><p>By closing this notice, you accept the cookie policy.</p><button type="button" id="legal-close">Dismiss cookie notice</button></div>
    <button type="button" id="duplicate-a" role="combobox" aria-haspopup="listbox" aria-controls="duplicate" aria-expanded="true">Category</button>
    <button type="button" id="duplicate-b" role="combobox" aria-haspopup="listbox" aria-controls="duplicate" aria-expanded="true">Category</button>
    <div id="duplicate" role="listbox"><div id="duplicate-option" role="option" tabindex="0">Generative AI</div></div>
    <script>window.nativeSubmits=0;document.querySelector('#product').addEventListener('submit',e=>{window.nativeSubmits++;e.preventDefault()})</script>`});
  });
  const page=await context.newPage();await page.goto(url);const engine=await attachEngine(context,page.mainFrame());
  try{
   await engine.call({action:'getPageSnapshot'});
   for(const selector of ['#explicit-submit','#default-submit','#final','#unlinked','#menu-final','#other-close','#accept','#legal-close','#duplicate-a','#duplicate-b','#duplicate-option']){
    const intent=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector}});assert.notEqual(intent.intent,'preparation',selector);
   }
   for(const [selector,kind]of [['#close','cookie_dismiss'],['#category','combobox_toggle'],['#option','combobox_option']]){
    const intent=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector}});assert.equal(intent.intent,'preparation',selector);assert.equal(intent.preparationKind,kind);
    const result=await engine.call({action:'executeActionPlan',actions:[{type:'click',selector,preparationProof:{signature:intent.preparationSignature,kind,documentTimeOrigin:intent.documentTimeOrigin}}]});assert.equal(result.ok,true);assert.equal(result.results[0].submitted,false);assert.equal(result.results[0].navigationExpected,false);
   }
   assert.equal(await page.locator('#category').textContent(),'Generative AI');assert.equal(await page.evaluate(()=>window.nativeSubmits),0);
   const unexpected=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector:'#unexpected'}});assert.equal(unexpected.intent,'preparation');
   const result=await engine.call({action:'executeActionPlan',actions:[{type:'click',selector:'#unexpected',preparationProof:{signature:unexpected.preparationSignature,kind:unexpected.preparationKind,documentTimeOrigin:unexpected.documentTimeOrigin}}]});
   assert.equal(result.results[0].submitted,true);assert.equal(result.results[0].preparationUnexpectedSubmission,true);assert.equal(await page.evaluate(()=>window.nativeSubmits),1);
  }finally{await engine.detach();}
  assert.equal(posts,0);assert.equal(external,0);
 }finally{await browser?.close();}
});

test('preparation proof rejects a changed document or a control changed to submit before clicking',async()=>{
 let browser;try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext();let external=0,posts=0;
  const url='https://preparation.fixture.invalid/drift';await context.route('**/*',route=>{
   if(route.request().url()!==url){external++;return route.abort();}if(route.request().method()!=='GET'){posts++;return route.abort();}
   return route.fulfill({contentType:'text/html',body:`<!doctype html><form><fieldset><legend id="context">Category</legend><button type="button" id="category" role="combobox" aria-haspopup="listbox" aria-controls="list" aria-expanded="false" onclick="window.clicked++">Category</button><div id="list" role="listbox" hidden></div></fieldset></form><script>window.clicked=0</script>`});
  });
  const page=await context.newPage();await page.goto(url);const engine=await attachEngine(context,page.mainFrame());
  try{
   const intent=await engine.call({action:'inspectModelClickIntent',clickAction:{type:'click',selector:'#category'}});assert.equal(intent.intent,'preparation');
   const proof={signature:intent.preparationSignature,kind:intent.preparationKind,documentTimeOrigin:intent.documentTimeOrigin};
   let result=await engine.call({action:'executeActionPlan',actions:[{type:'click',selector:'#category',preparationProof:{...proof,documentTimeOrigin:proof.documentTimeOrigin+1}}]});
   assert.equal(result.ok,false);assert.equal(result.results[0].needs_manual,true);assert.equal(await page.evaluate(()=>window.clicked),0);
   const session=await context.newCDPSession(page);try{
    await session.send('Runtime.evaluate',{contextId:engine.documentId,expression:"document.querySelector('#category').scrollIntoView=function(){this.type='submit';}"});
   }finally{await session.detach();}
   result=await engine.call({action:'executeActionPlan',actions:[{type:'click',selector:'#category',preparationProof:proof}]});
   assert.equal(result.ok,false);assert.equal(result.results[0].needs_manual,true);assert.equal(await page.evaluate(()=>window.clicked),0);assert.equal(posts,0);assert.equal(external,0);
   await page.locator('#category').evaluate(element=>{element.type='button';});
   const paymentSession=await context.newCDPSession(page);try{
    await paymentSession.send('Runtime.evaluate',{contextId:engine.documentId,expression:"document.querySelector('#category').scrollIntoView=function(){document.querySelector('#context').textContent='Pay to submit this listing';}"});
   }finally{await paymentSession.detach();}
   result=await engine.call({action:'executeActionPlan',actions:[{type:'click',selector:'#category',preparationProof:proof}]});
   assert.equal(result.ok,false);assert.equal(result.results[0].humanGate,'payment');assert.equal(await page.evaluate(()=>window.clicked),0);assert.equal(posts,0);assert.equal(external,0);
  }finally{await engine.detach();}
 }finally{await browser?.close();}
});

function fixture({fails=false,unknown=false,unexpectedSubmit=false,task:existingTask,store:existingStore}={}){
 const task={id:'t',runId:'r',profileId:'p',url:'https://form.fixture.invalid/submit',targetId:'target',browserInstance:'browser',status:'filling',profileSnapshot:{fields:{Name:'Original',Url:'https://product.fixture.invalid'}}},events=[],writes=[],pending=[];let clicks=0,final=false;
 const frame={url:()=>task.url,locator:()=>({evaluateAll:async()=>[]})},page={on(){},off(){},url:()=>task.url,mainFrame:()=>frame};
 const preparation={ok:true,intent:'preparation',preparationAction:true,preparationKind:'cookie_dismiss',preparationSignature:'{"kind":"cookie_dismiss","selector":"#close"}',preparationSelector:'#close',preparationEvidence:{kind:'cookie_dismiss',tag:'button',type:'button',dialog:'cookies',formOwner:false},documentTimeOrigin:123};
 if(existingTask)Object.assign(task,structuredClone(existingTask));
 if(existingStore)existingStore.set('task:'+task.id,task);
 const engine={call:async message=>{
  if(message.action==='inspectModelClickIntent')return final?{ok:true,intent:'submission',label:'Submit Product'}:unknown?{ok:true,intent:'unknown',label:'Close'}:preparation;
  if(message.action==='collectFormValidation')return{validationFailed:false};if(message.action==='getFilledFieldsReport')return{fields:[{label:'Product name',value:'Original',type:'text'}],allValid:true};if(message.action==='classifySubmitEvidence')return{matched:false};
  if(message.action==='executeActionPlan'){assert.equal(existingStore?existingStore.pendingCount():pending.length,0);clicks++;if(fails)throw Error('Response unavailable');return{ok:true,results:[{ok:true,clicked:true,submitted:final||unknown||unexpectedSubmit,preparationUnexpectedSubmission:unexpectedSubmit}]};}throw Error(message.action);
 }};
 const runtime={store:existingStore||{get:key=>key==='task:t'?task:null,pending:()=>pending,valuesByInsertion:()=>[]},cloud:{request:async()=>({documents:{submissionRecords:{}}}),flush:async()=>{if(existingStore){for(const event of existingStore.pending())existingStore.ack(event.id);}else pending.length=0;}},update(t,patch,event){Object.assign(t,patch);events.push(event);writes.push(structuredClone(patch));if(existingStore)existingStore.transition(t,event);else pending.push({id:String(events.length),taskId:task.id});},reconcileTextInputs:async()=>{}};
 const adapter=createOriginalSubmissionAdapter(runtime,{task,page,config:{autoSubmitDirectory:true},active:()=>true,assertDocument:async()=>{},candidate:()=>({frame,engine,detection:{platform:'directory'}}),visual:()=>({elements:[{selector:'#close',label:'Close',type:'button'},{selector:'#final',label:'Submit Product',type:'submit'}]}),ownership:{}});
 return{task,events,writes,adapter,preparation,clicks:()=>clicks,final:()=>{final=true;}};
}

for(const fails of [false,true])test(`proved preparation persists ${fails?'uncertain':'clicked'} state without a final boundary and cannot replay`,async()=>{
 const f=fixture({fails});try{
  if(fails)await assert.rejects(f.adapter.act({type:'click',selector:'#close'}),/Response unavailable/);else await f.adapter.act({type:'click',selector:'#close'});
  assert.equal(f.task.attemptBoundary,undefined);assert.equal(f.task.preparationActionHistory[0].status,fails?'started':'clicked');assert.equal(f.writes[0].preparationActionHistory[0].status,'started');
  const duplicate=await f.adapter.act({type:'click',selector:'#close'});assert.equal(duplicate.preparationActionGuard,true);assert.equal(f.clicks(),1);
 }finally{f.adapter.dispose();}
});

test('unknown click and final submit still own a final submission boundary',async()=>{
 const unknown=fixture({unknown:true});try{await unknown.adapter.act({type:'click',selector:'#close'});assert.ok(unknown.task.attemptBoundary);assert.equal(unknown.task.preparationActionHistory,undefined);}finally{unknown.adapter.dispose();}
 const f=fixture();try{await f.adapter.act({type:'click',selector:'#close'});f.final();await f.adapter.act({type:'click',selector:'#final'});assert.ok(f.task.attemptBoundary);assert.equal(f.clicks(),2);}finally{f.adapter.dispose();}
});

test('an unexpected form submit from a preparation handler becomes protected unknown evidence',async()=>{
 const f=fixture({unexpectedSubmit:true});try{await f.adapter.act({type:'click',selector:'#close'});assert.ok(f.task.attemptBoundary);assert.equal(f.task.attemptBoundary,f.task.preparationActionHistory[0].at);assert.equal(f.task.siteStatus,'sent_unconfirmed');assert.ok(f.events.includes('original_preparation_unexpected_submission'));}finally{f.adapter.dispose();}
});

test('a persisted unknown boundary cannot be reclassified by a fresh adapter invocation',async()=>{
 const f=fixture();f.task.attemptBoundary='keep-historical-unknown';try{const result=await f.adapter.act({type:'click',selector:'#close'});assert.equal(result.unconfirmed,true);assert.equal(f.clicks(),0);assert.equal(f.task.attemptBoundary,'keep-historical-unknown');assert.equal(f.task.preparationActionHistory,undefined);}finally{f.adapter.dispose();}
});

test('a persisted receipt cannot be modified or clicked by a fresh adapter invocation',async()=>{
 const f=fixture();f.task.receipt={evidence:'Submission received',receivedAt:'2026-10-14T00:00:00Z'};try{
  for(const type of ['click','fill','select','check','upload']){const result=await f.adapter.act({type,selector:'#close',value:'Original'});assert.equal(result.unconfirmed,true);}
  assert.equal(f.clicks(),0);assert.equal(f.task.preparationActionHistory,undefined);assert.equal(f.events.length,0);
 }finally{f.adapter.dispose();}
});

test('a persisted uncertain preparation cannot replay after a fresh invocation or a changed preparation signature',async()=>{
 const f=fixture({fails:true});try{
  await assert.rejects(f.adapter.act({type:'click',selector:'#close'}),/Response unavailable/);
  const g=fixture({task:f.task});try{
   g.preparation.preparationSignature='changed-visible-name';const result=await g.adapter.act({type:'click',selector:'#close'});
   assert.equal(result.preparationActionGuard,true);assert.equal(g.clicks(),0);assert.equal(g.task.preparationActionHistory.length,1);assert.equal(g.task.attemptBoundary,undefined);
  }finally{g.adapter.dispose();}
  const h=fixture({task:f.task,unknown:true});try{
   const result=await h.adapter.act({type:'click',selector:'#close'});assert.equal(result.preparationActionGuard,true);assert.equal(h.clicks(),0);assert.equal(h.task.attemptBoundary,undefined);
  }finally{h.adapter.dispose();}
 }finally{f.adapter.dispose();}
});

test('a genuine final control replacing a preparation selector keeps the submission boundary',async()=>{
 const f=fixture();try{
  await f.adapter.act({type:'click',selector:'#close'});f.final();await f.adapter.act({type:'click',selector:'#close'});
  assert.ok(f.task.attemptBoundary);assert.equal(f.clicks(),2);assert.equal(f.events.filter(event=>event==='original_visual_attempt_boundary').length,1);
 }finally{f.adapter.dispose();}
});

test('SQLite close and reopen preserve a started preparation and reject replay without changing old records',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'el-preparation-intent-')),file=join(directory,'outbox.sqlite');let store;
 try{
  store=new Store(file);const f=fixture({fails:true,store});try{await assert.rejects(f.adapter.act({type:'click',selector:'#close'}),/Response unavailable/);}finally{f.adapter.dispose();}
  const saved=store.get('task:t');assert.equal(saved.preparationActionHistory[0].status,'started');assert.equal(store.pendingCount(),0);store.close();store=null;
  store=new Store(file);const g=fixture({task:store.get('task:t'),store});try{
   const result=await g.adapter.act({type:'click',selector:'#close'});assert.equal(result.preparationActionGuard,true);assert.equal(g.clicks(),0);assert.deepEqual(store.get('task:t'),saved);assert.equal(store.pendingCount(),0);
  }finally{g.adapter.dispose();}
 }finally{
  store?.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&directory.includes('el-preparation-intent-'));rmSync(directory,{recursive:true,force:true});
 }
});
