import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {browserLaunch} from '../src/workbench-platform.mjs';
import {Store} from '../src/store.mjs';
import {Runtime} from '../src/runtime.mjs';
import {quickOpenLibrary} from '../src/quick-open.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {checkBrowserAssistant,stopBrowserAssistant} from '../src/browser-assistant.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';
import {originalLibraryQuickOpen,originalAutoVisitRequest} from '../../tests/helpers/original-library-catalog.mjs';

// A fresh, owned native Chrome is necessary: chromium.launch/newContext apply
// focus emulation even in headed mode. No existing Chrome profile is touched.
const home=await mkdtemp(join(tmpdir(),'el-original-background-')),profile=join(home,'owned-profile');
const executable=process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':browserLaunch(process.platform,'about:blank').command;
const child=spawn(executable,['--user-data-dir='+profile,'--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--remote-debugging-port=0','about:blank'],{stdio:'ignore',windowsHide:true});
const store=new Store(join(home,'outbox.sqlite')),runtime=new Runtime(store,home),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original-background'},scope=workbenchScope(pair);
const product={id:'p',name:'Original Product',fields:{Name:'Original Product',Url:'https://original-product.example','Business mail':'owner@example.com','Long description (250-500 words)':'An original product for verifying automatic filling on the user selected page.'}};
const urls=['https://background-one.fixture.invalid/submit','https://background-two.fixture.invalid/submit','https://background-three.fixture.invalid/submit'];
const snapshot={documents:{siteProfiles:{p:product},activeSiteId:'p',selectedSiteIds:['p'],submissionRecords:{},sheetTableData:{entries:urls.map(link=>({link,indexPage:link}))},autoFillOnVisit:true},revisions:{siteProfiles:1,sheetTableData:1,autoFillOnVisit:1}};
const form='<!doctype html><h1>Submit your product</h1><form><label>Product name<input id="name" name="productName" required></label><label>Website<input id="website" name="website" type="url" required></label><label>Email<input id="email" name="email" type="email" required></label><label>Description<textarea name="description" id="description" required></textarea></label><button type="submit">Submit product</button></form>';
const runs=new Map(),remoteTasks=new Map(),results=[];let serial=Promise.resolve(),registrations=0,posts=0,external=0,onSnapshot,control,context;
store.set('pair',pair);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});store.set('applicationSnapshot',{scope,snapshot:structuredClone(snapshot)});store.set('browserAssistantSettings',{scope,enabled:true,autoFillOnVisit:true,profileId:'p'});
Object.defineProperty(runtime,'cloud',{value:{async request(route,input){
 if(route==='snapshot'){await onSnapshot?.(control);return structuredClone(snapshot);}
 if(route==='runs?view=inventory')return{runs:[...runs.values()],tasks:[...remoteTasks.values()]};
 if(route.startsWith('runs?runId=')){const id=decodeURIComponent(route.split('=')[1]);return{runs:runs.has(id)?[structuredClone(runs.get(id))]:[],tasks:[...remoteTasks.values()].filter(t=>t.runId===id)};}
 if(route.startsWith('tasks/'))return{task:structuredClone(remoteTasks.get(route.slice(6)))};
 if(route==='runs'){registrations++;assert.equal(input.run.authorization,'fill_only');const run={...input.run,profile:structuredClone(product)},task={...input.run.tasks[0],runId:run.id,profileId:'p',status:'needs_manual',version:1,attentionType:'fill_only'};runs.set(run.id,run);remoteTasks.set(task.id,task);return{ok:true,run,tasks:[task]};}
 throw Error('Unexpected fixture cloud route '+route);
}}});
runtime.lease=async()=>{};runtime.synchronize=async()=>{for(const event of store.pending()){remoteTasks.set(event.taskId,event.state);store.ack(event.id);}};runtime.tick=()=>{throw Error('Background opening must not submit');};
runtime.dispatchControl=(action,input)=>{const next=serial.then(async()=>{control={action,input};try{return await runtime.withControl(()=>runtime.control(action,input));}finally{control=null;}});serial=next.catch(()=>{});return next;};
async function scan(){await serial;const result=await checkBrowserAssistant(runtime);assert.notEqual(result?.reason,'assistant_busy');await serial;}
async function settle(){await new Promise(done=>setTimeout(done,750));await serial;}
async function sourceRequest(page){const session=await context.newCDPSession(page);try{const tree=await session.send('Page.getFrameTree'),world=await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'ExternalLinkExecutor',grantUniveralAccess:false}),reply=await session.send('Runtime.evaluate',{expression:'__externalLinkServices.request({action:"requestAutoFill"})',contextId:world.executionContextId,awaitPromise:true,returnByValue:true});assert.equal(reply.exceptionDetails,undefined);return reply.result.value;}finally{await session.detach();}}
const visibility=page=>page.evaluate(()=>({focused:document.hasFocus(),visible:document.visibilityState==='visible'}));
try{
 let endpoint;for(let n=0;n<160;n++){if(child.exitCode!==null)throw Error('Owned native Chrome exited');try{endpoint='http://127.0.0.1:'+(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n')[0];break;}catch{await new Promise(done=>setTimeout(done,50));}}
 assert.ok(endpoint);await writeFile(join(home,'host.json'),JSON.stringify({endpoint,startedAt:'owned-background-chrome',chromePid:child.pid}));await runtime.connect();context=runtime.context;
 await context.route('**/*',async route=>{if(!new URL(route.request().url()).hostname.endsWith('.fixture.invalid')){external++;await route.abort();return;}if(route.request().method()==='POST')posts++;await route.fulfill({contentType:'text/html',body:form});});
 const foreground=context.pages()[0];await foreground.goto('https://foreground.fixture.invalid/');await foreground.bringToFront();
 // Before any quick-open call, verify that the actual Runtime.connect does
 // not falsify the focus of an ordinary background target.
 const browserSession=await runtime.browser.newBrowserCDPSession();
 const [controlPage]=await Promise.all([context.waitForEvent('page',{timeout:10000}),browserSession.send('Target.createTarget',{url:'about:blank',background:true})]);await controlPage.goto('https://control.fixture.invalid/');
 assert.deepEqual(await visibility(controlPage),{focused:false,visible:false},'Native attachment must retain real background visibility and focus');await controlPage.close();
 const original=await originalLibraryQuickOpen(snapshot,{urls:urls.slice(0,2),batchSize:2,intervalMs:100},{details:true});assert.deepEqual(original.opened,urls.slice(0,2).map(url=>({url,active:false})));
 const opened=await quickOpenLibrary(runtime,{urls:urls.slice(0,2),batchSize:2,intervalMs:100});await runtime.quickOpenJob;
 const job=store.get('quickOpenJob:'+opened.job.id);assert.equal(job.status,'completed');assert.ok(job.items.every(item=>item.status==='opened'));
 const [a,b]=urls.slice(0,2).map(url=>context.pages().find(page=>page.url()===url));assert.ok(a&&b);
 assert.deepEqual(await visibility(foreground),{focused:true,visible:true},'Quick-open must leave the original foreground tab active');for(const page of [a,b])assert.deepEqual(await visibility(page),{focused:false,visible:false},'Quick-open must leave the original foreground tab active');
 const originalInactive=await originalAutoVisitRequest(snapshot,{url:urls[0],activeTabId:8});assert.equal(originalInactive.fills.length,0);
 await scan();await settle();assert.equal(registrations,0);for(const page of [a,b])assert.equal(await page.locator('#name').inputValue(),'');
 assert.equal((await sourceRequest(a)).requested,false);await settle();assert.equal(registrations,0);
 results.push({mode:'background-batch-with-auto-fill-enabled',frozenTabsActiveFalse:true,foregroundRetained:true,noRegistrationOrFill:true,backgroundContentRequestIgnored:true});
 const originalActive=await originalAutoVisitRequest(snapshot,{url:urls[0],activeTabId:9});assert.equal(originalActive.fills.length,1);
 await a.bringToFront();await scan();await settle();assert.equal(await a.locator('#name').inputValue(),product.fields.Name);assert.equal(await b.locator('#name').inputValue(),'');assert.equal(registrations,1);
 results.push({mode:'activate-one-background-page',originalActiveVisitMatches:true,selectedPageFilledOnly:true});
 // An active source message is debounced. Switching before its timer fires
 // must cancel without registering a task, and revisiting must recover.
 await b.bringToFront();assert.equal((await sourceRequest(b)).requested,true);await foreground.bringToFront();await settle();assert.equal(await b.locator('#name').inputValue(),'');assert.equal(registrations,1);assert.equal(store.values('assistantFill:').find(f=>f.url===b.url()).status,'cancelled');
 await b.bringToFront();await scan();await settle();assert.equal(await b.locator('#name').inputValue(),product.fields.Name);assert.equal(registrations,2);
 results.push({mode:'switch-before-delayed-fill-and-return',cancelledBeforeRegistration:true,originalCancelledRecordRecovered:true});
 await foreground.bringToFront();await quickOpenLibrary(runtime,{urls:[urls[2]],batchSize:1});await runtime.quickOpenJob;const c=context.pages().find(page=>page.url()===urls[2]);await scan();await settle();assert.equal(registrations,2);
 await c.bringToFront();let switched=false;onSnapshot=async action=>{if(action?.action!=='fillAssistantTask'||action.input.url!==c.url())return;onSnapshot=null;switched=true;await foreground.bringToFront();};assert.equal((await sourceRequest(c)).requested,true);await settle();assert.equal(switched,true);assert.equal(registrations,2);assert.equal(await c.locator('#name').inputValue(),'');assert.equal(store.values('assistantFill:').find(f=>f.url===c.url()).status,'cancelled');
 results.push({mode:'switch-during-cloud-confirmation',stoppedBeforeRegistration:true});
 // Explicit native page selection remains an intentional fill context even
 // while its target is physically in the background.
 const cInfo=await getTargetInfo(context,c);await runtime.dispatchControl('sidepanelOpened',{profileId:'p',targetId:cInfo.targetId});await scan();await settle();assert.equal(await c.locator('#name').inputValue(),product.fields.Name);assert.equal(registrations,3);assert.deepEqual(await visibility(c),{focused:false,visible:false});
 results.push({mode:'explicit-native-panel-background-selection',intentionalSelectedPageFills:true});
 assert.equal(posts,0);assert.equal(external,0);assert.deepEqual(store.get('acceptanceBatch'),{status:'paused',cursor:13,count:30});assert.equal(store.get('paused'),true);
 for(const task of store.values('task:')){assert.equal(task.attemptBoundary,undefined);assert.equal(task.receipt,undefined);assert.equal(store.get('run:'+task.runId).authorization,'fill_only');}
 console.log(JSON.stringify({ok:true,kind:'original_background_quick_open_native_chrome',realRuntimeConnection:true,results,registrations,posts,externalRequests:external,productionWrites:0,realModelCalls:0,originalChromeUntouched:true}));await browserSession.detach();
}finally{
 await stopBrowserAssistant(runtime).catch(()=>{});await serial.catch(()=>{});
 if(runtime.browser){const session=await runtime.browser.newBrowserCDPSession().catch(()=>null);await session?.send('Browser.close').catch(()=>{});await runtime.browser?.close().catch(()=>{});}
 if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}store.close();
 assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-background-'));await rm(home,{recursive:true,force:true,maxRetries:5});
}
