import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';

const home=await mkdtemp(join(tmpdir(),'el-pending-batch-settings-'));
const urls=['https://first.fixture.invalid/form','https://second.fixture.invalid/form'];
const documents={siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.fixture.invalid'}}},selectedSiteIds:['p'],activeSiteId:'p',sheetTableData:{entries:urls.map(link=>({link,note:'AI tool directory',metrics:{dr:80,da:70}}))},submissionRecords:{},cfgConcurrency:'1',domainBlacklist:[],targetFilters:{},autoFillOnVisit:false,unattendedPreferences:{enabled:false},linkMonitorSchedule:{enabled:false}};
const revisions={siteProfiles:2,cfgConcurrency:1,domainBlacklist:1},remoteBefore=JSON.stringify({documents,revisions});
const fixed={id:'original-fixed',status:'paused',cursor:13,count:30},calls=[];
let backend,web,browser,store;
const cloud=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  for await(const chunk of req){};
  calls.push({path,method:req.method});
  if(req.method==='GET'&&path.endsWith('/snapshot')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,documents,revisions}));}
  else if(req.method==='GET'&&path.endsWith('/runs')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,tasks:[],runs:[]}));}
  else {res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'Fixture writes unavailable'}));}
 }catch(error){res.writeHead(500);res.end(JSON.stringify({ok:false,error:error.message}));}
});
await new Promise(done=>cloud.listen(0,'127.0.0.1',done));
const endpoint='http://127.0.0.1:'+cloud.address().port;
async function start(name){
 const child=spawn(process.execPath,[resolve(import.meta.dirname,'../src/'+name)],{windowsHide:true,env:{...process.env,EXTERNALLINK_HOME:home,EXTERNALLINK_PORT:'0',EXTERNALLINK_WEB_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',part=>errors+=part);child.stdout.resume();
 const service={child};if(name==='server.mjs')backend=service;else web=service;
 for(let n=0;n<100;n++){
  if(child.exitCode!==null)throw Error('Fixture service exited: '+errors);
  try{const file=JSON.parse(await readFile(join(home,name==='server.mjs'?'server.json':'workbench.json'),'utf8'));if(file.pid===child.pid){service.endpoint=file.endpoint;return service;}}catch{}
  await new Promise(done=>setTimeout(done,50));
 }
 throw Error('Fixture service startup exceeded observation budget');
}
async function stop(service){if(service?.child.exitCode===null){const stopped=once(service.child,'exit');service.child.kill();await stopped;}}
async function api(origin,route,body){
 const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer fixture-local','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true,JSON.stringify(result));return result;
}
try{
 store=new Store(join(home,'outbox.sqlite'));store.set('pair',{endpoint,workspaceId:'default',localToken:'fixture-local',deviceToken:'fixture-device',storageBackend:'d1'});store.set('paused',true);store.set('acceptanceBatch',fixed);store.close();store=null;
 backend=await start('server.mjs');web=await start('workbench-server.mjs');
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const page=await browser.newPage(),errors=[],previewResponses=[];page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));page.on('response',async response=>{if(new URL(response.url()).pathname==='/previewBatch')previewResponses.push(await response.json());});
 await page.route('**/*',async route=>{if(new URL(route.request().url()).origin!==web.endpoint){await route.abort();throw Error('Unexpected fixture browser external request');}await route.continue();});
 await page.goto(web.endpoint+'/#access=fixture-local');await page.getByRole('button',{name:'设置与备份',exact:true}).click();
 await page.getByLabel('同时处理的外链目标数',{exact:true}).fill('4');await page.getByLabel('域名黑名单（每行一个）',{exact:true}).fill('first.fixture.invalid');
 await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('设置已存本机，等待同步',{exact:false}).waitFor();
 await page.getByRole('button',{name:'外链库',exact:true}).click();for(const url of urls)await page.getByLabel('选择 '+url,{exact:true}).check();
 await page.getByRole('button',{name:'批量提交',exact:true}).click();await page.getByRole('button',{name:'预览批量提交',exact:true}).click();await page.getByRole('heading',{name:'批量提交范围确认',exact:true}).waitFor();
 await page.getByText('按已保存的自动提交设置执行 · 并发 4',{exact:true}).waitFor();await page.getByText('2 个组合 · 可安排 1 个 · 排除 1 个',{exact:false}).waitFor();
 assert.equal(previewResponses.length,1);const uiBatch=previewResponses[0].batch;assert.equal(uiBatch.config.concurrency,4);assert.deepEqual(uiBatch.items.map(item=>item.status),['excluded','ready']);
 for(const origin of [backend.endpoint,web.endpoint]){const {batch}=await api(origin,'/previewBatch',{profileIds:['p'],urls});assert.equal(batch.config.concurrency,4);assert.deepEqual(batch.items.map(item=>item.status),['excluded','ready']);}
 const identities=uiBatch.items.map(item=>[item.taskId,item.runId]);await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.getByRole('button',{name:'设置与备份',exact:true}).click();
 await page.getByLabel('域名黑名单（每行一个）',{exact:true}).fill('first.fixture.invalid\nsecond.fixture.invalid');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('设置已存本机，等待同步',{exact:false}).waitFor();
 const result=await api(web.endpoint,'/startBatch',{batchId:uiBatch.id,ordinaryPermissionsAuthorized:true});assert.deepEqual(result.batch.items.map(item=>item.status),['excluded','excluded']);assert.deepEqual(result.batch.items.map(item=>[item.taskId,item.runId]),identities);assert.deepEqual(result.batch.config,uiBatch.config);
 store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.equal(store.values('task:').length,0);assert.equal(store.values('run:').length,0);assert.deepEqual(store.get('acceptanceBatch'),fixed);
 const pending=store.values('appMutation:').filter(item=>!['confirmed','discarded'].includes(item.status));assert.ok(pending.some(item=>item.key==='cfgConcurrency'));assert.equal(pending.filter(item=>item.key==='domainBlacklist').length,2);
 assert.equal(calls.some(call=>call.method==='POST'&&call.path.endsWith('/runs')),false);assert.equal(JSON.stringify({documents,revisions}),remoteBefore);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,kind:'actual_services_pending_batch_settings_fixture',actualUiSavedPendingSettings:true,actualUiPreviewConcurrency:4,bothServicesReadPendingGates:true,afterPreviewPendingBlacklistBlocksRegistration:true,frozenTaskAndRunIdsUnchanged:true,frozenConfigUnchanged:true,originalFixedBatchUnchanged:true,remoteDocumentsAndRevisionsUnchanged:true,pendingEdits:pending.length,registeredTasks:0,realSubmissions:0,realModelCalls:0,productionWrites:0,externalRequests:0}));
}finally{
 store?.close();await browser?.close();await stop(web);await stop(backend);await new Promise(done=>cloud.close(done));
 const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-pending-batch-settings-'));await rm(absolute,{recursive:true,force:true});
}
