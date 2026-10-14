import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {attachEngine} from '../executor/src/engine.mjs';
import {profiles,plain} from '../executor/src/shared.mjs';
import {previewWorkbenchBatch,startWorkbenchBatch,nextWorkbenchTask} from '../executor/src/workbench-features.mjs';

async function fixture({revision=2,missingSnapshot=false,prepared=false}={}){
 const old={id:'photo',name:'OldPhoto',fields:{Name:'OldPhoto',Url:'https://photo.fixture.invalid/',Pricing:'Free: one photo per day','PRICING TYPE':'Freemium','Credits System':'One free photo per day','Short Discription(100-150 words)':'OldPhoto offers one free photo per day.'}},current={...old,fields:{...old.fields,Pricing:'Paid: $1.99 per photo','PRICING TYPE':'Paid','Credits System':'One paid processing job per credit','Short Discription(100-150 words)':'OldPhoto processes each photo for $1.99 upfront.'}};
 const task={id:'legacy-task',runId:'legacy-run',profileId:'photo',profileRevision:revision,url:'https://directory.fixture.invalid/submit',destinationKey:'directory.fixture.invalid/submit',status:'pending',version:1,...(!missingSnapshot?{profileSnapshot:structuredClone(old)}:{}),...(prepared?{targetId:'saved-page',fillOnlyPrepared:true,actualSubmission:{fields:[{label:'Pricing',value:'Free'}]}}:{})};
 const run={id:task.runId,profileId:'photo',profileRevision:2,profile:structuredClone(old),createdAt:'2026-09-30T00:00:00Z',tasks:[task.id],mediaManifest:[]},store=new Store(':memory:'),events=[];
 store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'default'});store.set('paused',true);
 const runtime=new Runtime(store,'isolated-profile-refresh');runtime.tick=()=>{};
 const snapshot={documents:{siteProfiles:{photo:current},sheetTableData:{entries:[{link:task.url}]},submissionRecords:{},siteAnnotations:{}},revisions:{siteProfiles:17}};
 const cloud={async request(route,input){
  if(route==='snapshot')return structuredClone(snapshot);
  if(route==='runs?view=inventory')return{runs:[structuredClone(run)],tasks:[structuredClone(task)]};
  if(route==='runs?runId='+task.runId)return{runs:[structuredClone(run)],tasks:[structuredClone(task)]};
  if(route==='lease')return{version:input.version};
  throw Error('Unexpected isolated cloud route '+route);
 },async flush(value){for(const event of value.pending()){events.push(event);value.ack(event.id);}}};
 Object.defineProperty(runtime,'cloud',{value:cloud});
 const {batch}=await previewWorkbenchBatch(runtime,{profileIds:['photo'],urls:[task.url],config:{fillOnly:true}});
 assert.equal(batch.items[0].existingTask,true);assert.equal(batch.items[0].profile.fields.Pricing,current.fields.Pricing);
 await startWorkbenchBatch(runtime,{batchId:batch.id,ordinaryPermissionsAuthorized:true});
 return{runtime,store,batch,task,run,old,current,events};
}

for(const missingSnapshot of [false,true])test(`reused unsubmitted task binds current batch pricing and revision with snapshot ${missingSnapshot?'missing':'present'}`,async()=>{
 const f=await fixture({missingSnapshot});try{
  const originalRun=f.store.get('run:'+f.run.id),task=await nextWorkbenchTask(f.runtime);
  assert.equal(task.profileSnapshot.fields.Pricing,'Paid: $1.99 per photo');assert.equal(task.profileSnapshot.fields['PRICING TYPE'],'Paid');assert.equal(task.profileRevision,17);
  assert.deepEqual(f.store.get('run:'+f.run.id),originalRun);assert.equal(task.profileRefreshHistory.at(-1).profileRevision,2);assert.equal(task.profileRefreshHistory.at(-1).profileSnapshot.fields.Pricing,'Free: one photo per day');
 }finally{f.store.close();}
});

for(const mode of ['same-revision-different-content','newer-source','prepared-page'])test(`reuse preserves and excludes ${mode} before releasing old values`,async()=>{
 const f=await fixture({revision:mode==='same-revision-different-content'?17:mode==='newer-source'?18:2,prepared:mode==='prepared-page'});try{
  const before=f.store.get('task:'+f.task.id),next=await nextWorkbenchTask(f.runtime);assert.equal(next,null);assert.deepEqual(f.store.get('task:'+f.task.id),before);
  const item=f.store.get('workbenchBatch:'+f.batch.id).items[0];assert.equal(item.status,'excluded');assert.match(item.reason,/资料|快照|修订/);
 }finally{f.store.close();}
});

for(const mode of ['receipt','attemptBoundary'])test(`late ${mode} keeps submitted pricing history intact`,async()=>{
 const f=await fixture();try{
  const task=f.store.get('task:'+f.task.id);task[mode]=mode==='receipt'?{evidence:'Retained fixture receipt'}:'retained-fixture-boundary';f.store.set('task:'+task.id,task);const before=f.store.get('task:'+task.id);
  assert.equal(await nextWorkbenchTask(f.runtime),null);assert.deepEqual(f.store.get('task:'+task.id),before);assert.equal(before.profileSnapshot.fields.Pricing,'Free: one photo per day');
 }finally{f.store.close();}
});

for(const mode of ['receipt','attemptBoundary','unknown-status'])test(`profile refresh itself rejects ${mode} arriving during a future lease implementation`,async()=>{
 const f=await fixture();try{
  f.runtime.lease=async task=>{if(mode==='unknown-status'){task.status='submitted_unconfirmed';task.siteStatus='sent_unconfirmed';}else task[mode]=mode==='receipt'?{evidence:'Late fixture receipt'}:'late-fixture-boundary';f.store.set('task:'+task.id,task);};
  assert.equal(await nextWorkbenchTask(f.runtime),null);const retained=f.store.get('task:'+f.task.id);assert.equal(retained.profileSnapshot.fields.Pricing,'Free: one photo per day');assert.equal(retained.profileRevision,2);assert.equal(retained.profileRefreshHistory,undefined);
  if(mode==='unknown-status')assert.equal(retained.status,'submitted_unconfirmed');else assert.ok(retained[mode]);assert.equal(f.store.get('run:'+f.run.id).profile.fields.Pricing,'Free: one photo per day');
 }finally{f.store.close();}
});

test('the shared native mapper fills refreshed paid pricing in an isolated form without submission',async()=>{
 const f=await fixture();let browser;try{
  const task=await nextWorkbenchTask(f.runtime);browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext();let external=0,posts=0;
  await context.route('**/*',route=>{
   if(route.request().url()!==task.url){external++;return route.abort();}if(route.request().method()!=='GET'){posts++;return route.abort();}
   return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Submit a photo tool</title><form><label>Product name<input name="name"></label><label>Website<input name="url" type="url"></label><label>Description<textarea name="description"></textarea></label><label>Pricing type<select name="pricing_type"><option value="">Choose pricing</option><option>Free</option><option>Freemium</option><option>Paid</option></select></label><button type="submit">Submit tool</button></form>'});
  });
  const page=await context.newPage();await page.goto(task.url);const engine=await attachEngine(context,page.mainFrame());
  try{const config=plain(profiles.buildAgentConfigFromProfile(task.profileSnapshot,{fillOnly:true}));assert.equal(config.pricing,'Paid: $1.99 per photo');const result=await engine.call({action:'smartFill',config});assert.equal(result.error,undefined);assert.equal(await page.locator('[name=description]').inputValue(),'OldPhoto processes each photo for $1.99 upfront.');assert.equal(await page.locator('[name=pricing_type]').inputValue(),'Paid');}
  finally{await engine.detach();}
  assert.equal(posts,0);assert.equal(external,0);assert.equal(task.attemptBoundary,undefined);assert.equal(task.receipt,undefined);
 }finally{await browser?.close();f.store.close();}
});
