import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {quickOpenLibrary} from '../src/quick-open.mjs';
import {overlayApplication} from '../src/application-mutations.mjs';
import {originalLibraryBatchQueue,originalLibraryQuickOpen} from '../../tests/helpers/original-library-catalog.mjs';

const home=await mkdtemp(join(tmpdir(),'el-original-navigation-'));
const documents={siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.fixture.invalid'}}},selectedSiteIds:['p'],activeSiteId:'p',urlList:'https://saved.fixture.invalid/submit',sheetTableData:{entries:[]},submissionRecords:{},domainBlacklist:[],targetFilters:{},autoFillOnVisit:false,unattendedPreferences:{enabled:false},linkMonitorSchedule:{enabled:false}};
const revisions={siteProfiles:1,sheetTableData:1,domainBlacklist:1},fixed={status:'paused',cursor:13,count:30},calls=[];
let backend,web,browser,store,targetGets=0,posts=0,externalRequests=0;
const cloud=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;for await(const chunk of req){};
 calls.push({path,method:req.method});
 if(path.startsWith('/target-')){if(req.method==='POST')posts++;else targetGets++;res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Owned fixture destination</h1>');}
 else if(req.method==='GET'&&path.endsWith('/snapshot')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,documents,revisions}));}
 else if(req.method==='GET'&&path.endsWith('/runs')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,tasks:[],runs:[]}));}
 else {res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'Fixture writes unavailable'}));}
});
await new Promise(done=>cloud.listen(0,'127.0.0.1',done));const endpoint='http://127.0.0.1:'+cloud.address().port,urls=[endpoint+'/target-first',endpoint+'/target-second'],added=endpoint+'/target-new';
documents.sheetTableData.entries=urls.map((link,n)=>({link,note:'AI tool directory',metrics:{dr:n?70:95,da:n?60:90}}));const remoteBefore=JSON.stringify({documents,revisions});
async function start(name){
 const child=spawn(process.execPath,[resolve(import.meta.dirname,'../src/'+name)],{windowsHide:true,env:{...process.env,EXTERNALLINK_HOME:home,EXTERNALLINK_PORT:'0',EXTERNALLINK_WEB_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',part=>errors+=part);child.stdout.resume();const service={child};if(name==='server.mjs')backend=service;else web=service;
 for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error('Fixture service exited: '+errors);try{const file=JSON.parse(await readFile(join(home,name==='server.mjs'?'server.json':'workbench.json'),'utf8'));if(file.pid===child.pid){service.endpoint=file.endpoint;return service;}}catch{}await new Promise(done=>setTimeout(done,50));}throw Error('Fixture service startup exceeded observation budget');
}
async function stop(service){if(service?.child.exitCode===null){const stopped=once(service.child,'exit');service.child.kill();await stopped;}}
async function api(origin,route,body={}){const response=await fetch(origin+route,{method:'POST',headers:{Authorization:'Bearer fixture-local','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)}),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true);return result;}
try{
 store=new Store(join(home,'outbox.sqlite'));store.set('pair',{endpoint,workspaceId:'default',localToken:'fixture-local',deviceToken:'fixture-device',storageBackend:'d1'});store.set('paused',true);store.set('acceptanceBatch',fixed);store.close();store=null;
 backend=await start('server.mjs');web=await start('workbench-server.mjs');const original=await originalLibraryBatchQueue({documents,revisions});assert.ok(original.groups.length>100);
 for(const origin of [backend.endpoint,web.endpoint]){const actual=await api(origin,'/getSubmissionQueue',{category:'',group:''});assert.equal(actual.total,original.groups.length);assert.deepEqual(actual.tasks.map(group=>group.key),original.groups.map(group=>group.key));const scoped=await api(origin,'/getSubmissionQueue',{category:'AI 工具目录'});assert.equal(scoped.total,2);}
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const page=await browser.newPage(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{if(new URL(route.request().url()).origin!==web.endpoint){externalRequests++;await route.abort();return;}await route.continue();});
 await page.goto(web.endpoint+'/#access=fixture-local');await page.getByRole('button',{name:'外链库',exact:true}).click();await page.getByRole('button',{name:'单站投稿队列',exact:true}).click();
 await page.getByText('第 1 / '+original.groups.length+' 站',{exact:false}).waitFor();await page.getByRole('button',{name:'下一站',exact:true}).click();await page.getByText('第 2 / '+original.groups.length+' 站',{exact:false}).waitFor();await page.getByRole('button',{name:'上一站',exact:true}).click();await page.getByText('第 1 / '+original.groups.length+' 站',{exact:false}).waitFor();
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.getByRole('button',{name:'设置与备份',exact:true}).click();await page.getByLabel('域名黑名单（每行一个）',{exact:true}).fill('127.0.0.1');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('设置已存本机，等待同步',{exact:false}).waitFor();
 await page.getByRole('button',{name:'外链库',exact:true}).click();await page.getByRole('button',{name:'单站投稿队列',exact:true}).click();await page.getByText('Original：域名黑名单。可浏览核对。',{exact:true}).waitFor();
 const created=await api(web.endpoint,'/libraryMutation',{operation:{type:'create',url:added,fields:{note:'AI tool directory'}}});assert.ok(created.pending);const actual=await api(backend.endpoint,'/getSubmissionQueue',{category:''});assert.ok(actual.tasks.some(group=>group.url===added));assert.equal(actual.total,original.groups.length+1);
 store=new Store(join(home,'outbox.sqlite'));const runtime={store,context:await browser.newContext(),cloud:{async request(route){assert.equal(route,'snapshot');return{documents:structuredClone(documents),revisions:structuredClone(revisions)};}}};
 await runtime.context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==endpoint||!url.pathname.startsWith('/target-')){externalRequests++;await route.abort();return;}await route.continue();});
 const expected=await originalLibraryQuickOpen(overlayApplication(runtime,{documents,revisions}),{urls:[added],batchSize:1}),opened=await quickOpenLibrary(runtime,{urls:[added],batchSize:1});await runtime.quickOpenJob;
 assert.deepEqual(store.get('quickOpenJob:'+opened.job.id).items.map(item=>item.url),expected);assert.equal(store.get('quickOpenJob:'+opened.job.id).status,'completed');assert.equal(runtime.context.pages().length,1);assert.equal(runtime.context.pages()[0].url(),added);assert.equal(targetGets,1);
 assert.equal(store.values('task:').length,0);assert.equal(store.values('run:').length,0);assert.equal(store.get('paused'),true);assert.deepEqual(store.get('acceptanceBatch'),fixed);assert.equal(JSON.stringify({documents,revisions}),remoteBefore);assert.equal(calls.some(call=>call.method==='POST'&&call.path.endsWith('/runs')),false);assert.deepEqual(errors,[]);assert.equal(posts,0);assert.equal(externalRequests,0);
 console.log(JSON.stringify({ok:true,kind:'actual_services_original_navigation_and_pending_quick_open_fixture',completeOriginalRangeBothServices:true,originalDestinations:original.groups.length,scopedCategoryBothServices:true,actualUiNextAndPrevious:true,actualUiPendingBlacklistExplanation:true,pendingNewTargetVisible:true,actualChromeOpenedPendingTarget:true,ownedTargetGetRequests:targetGets,remoteDocumentsAndRevisionsUnchanged:true,originalFixedBatchUnchanged:true,registeredTasks:0,posts,externalRequests,productionWrites:0,realModelCalls:0,realSubmissions:0}));
}finally{
 store?.close();await browser?.close();await stop(web);await stop(backend);await new Promise(done=>cloud.close(done));const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-original-navigation-'));await rm(absolute,{recursive:true,force:true});
}
