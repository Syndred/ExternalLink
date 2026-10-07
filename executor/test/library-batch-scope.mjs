import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {applicationMutation} from '../../core/application-mutation.mjs';
import {originalLibraryBatchScope} from '../../core/library-batch-scope.mjs';

const home=await mkdtemp(join(tmpdir(),'el-original-library-scope-'));
const documents={
 siteProfiles:{p:{id:'p',name:'Original P',fields:{Name:'Original P',Url:'https://product.example'}}},
 selectedSiteIds:['p'],activeSiteId:'p',
 sheetTableData:{entries:Array.from({length:601},(_,n)=>({link:'https://scope-'+n+'.example/form',name:'Original target '+n,category:'AI 工具目录',metrics:{dr:80}}))},
 siteAnnotations:Object.fromEntries([0,1,2].map(n=>['scope-'+n+'.example/form',{library:{groups:['free_submit']}}])),
 submissionRecords:{},cfgConcurrency:'1',unattendedPreferences:{enabled:false,hours:8,tasks:100,manualTabs:20},linkMonitorSchedule:{enabled:false},autoFillOnVisit:false
};
const revisions={siteProfiles:1,sheetTableData:1,siteAnnotations:1,selectedSiteIds:1},calls=[];
const fixed={id:'original-fixed',status:'stopped',cursor:13,count:30};
let backend,web,browser,store;
const cloud=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');let bytes='';for await(const part of req)bytes+=part;
  const body=bytes?JSON.parse(bytes):{};calls.push({route:url.pathname,method:req.method});let result;
  if(url.pathname.endsWith('/snapshot'))result={ok:true,documents,revisions};
  else if(url.pathname.endsWith('/runs')&&req.method==='GET')result={ok:true,runs:[],tasks:[]};
  else if(url.pathname.endsWith('/library')){
   const change=applicationMutation(documents,body.operation);
   if(body.revision!==(revisions[change.key]||0))throw Object.assign(Error('fixture CAS conflict'),{status:409});
   documents[change.key]=change.data;revisions[change.key]=(revisions[change.key]||0)+1;
   result={ok:true,key:change.key,revision:revisions[change.key],data:change.data};
  }else throw Object.assign(Error('fixture rejects real execution'),{status:400});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 }catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}
});
await new Promise(done=>cloud.listen(0,'127.0.0.1',done));const endpoint='http://127.0.0.1:'+cloud.address().port;
async function start(name){
 const child=spawn(process.execPath,[resolve(import.meta.dirname,'../src/'+name)],{windowsHide:true,env:{...process.env,EXTERNALLINK_HOME:home,EXTERNALLINK_PORT:'0',EXTERNALLINK_WEB_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',part=>errors+=part);child.stdout.resume();
 const service={child};if(name==='server.mjs')backend=service;else web=service;
 for(let n=0;n<100;n++){
  if(child.exitCode!==null)throw Error('fixture service exited: '+errors);
  try{const file=JSON.parse(await readFile(join(home,name==='server.mjs'?'server.json':'workbench.json'),'utf8'));if(file.pid===child.pid){service.endpoint=file.endpoint;return service;}}catch{}
  await new Promise(done=>setTimeout(done,50));
 }
 throw Error('fixture service startup exceeded observation budget');
}
async function stop(service){if(service?.child.exitCode===null){const stopped=once(service.child,'exit');service.child.kill();await stopped;}}
async function api(origin,body){const response=await fetch(origin+'/previewBatch',{method:'POST',headers:{Authorization:'Bearer fixture-local','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});return{status:response.status,data:await response.json()};}
try{
 store=new Store(join(home,'outbox.sqlite'));store.set('pair',{endpoint,workspaceId:'default',localToken:'fixture-local',deviceToken:'fixture-device',storageBackend:'d1'});store.set('paused',true);store.set('acceptanceBatch',fixed);store.close();store=null;
 backend=await start('server.mjs');web=await start('workbench-server.mjs');
 for(const origin of [backend.endpoint,web.endpoint]){
  for(const libraryScope of [{kind:'category',value:'AI 工具目录'},{kind:'group',value:'free_submit'}]){
   const expected=originalLibraryBatchScope({documents,revisions},{profileIds:['p'],[libraryScope.kind]:libraryScope.value});
   const result=await api(origin,{profileIds:['p'],libraryScope,config:{fillOnly:true}});
   assert.equal(result.status,200);assert.equal(result.data.ok,true);assert.equal(result.data.batch.count,expected.tasks.length);
   assert.deepEqual(result.data.batch.items.map(item=>[item.url,item.profileId]),expected.tasks.map(task=>[task.url,task.profileId]));
   assert.equal(result.data.batch.status,'preview');assert.equal(result.data.batch.config.fillOnly,true);
  }
  for(const libraryScope of [{kind:'category',value:'invalid'},{kind:'group',value:'invalid'},{kind:'category',value:'设计 / 作品展示'}])assert.equal((await api(origin,{profileIds:['p'],libraryScope})).status,400);
  assert.equal((await api(origin,{profileIds:['p'],urls:['https://scope-0.example/form'],libraryScope:{kind:'category',value:'AI 工具目录'}})).status,400);
 }
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const page=await browser.newPage(),errors=[],previewBodies=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname==='/previewBatch')previewBodies.push(request.postDataJSON());});
 await page.route('**/*',async route=>{if(new URL(route.request().url()).origin!==web.endpoint){await route.abort();return;}await route.continue();});
 await page.goto(web.endpoint+'/#access=fixture-local');await page.getByRole('button',{name:'外链库',exact:true}).click();
 await page.getByLabel('搜索',{exact:true}).fill('no visible original scope matches');await page.getByLabel('外链分类',{exact:true}).selectOption('AI 工具目录');
 await page.getByText('筛选到 0 个入口',{exact:false}).waitFor();
 await page.getByRole('button',{name:'从此分类开始提交',exact:true}).click();await page.getByRole('button',{name:'预览批量提交',exact:true}).click();await page.getByRole('heading',{name:'批量提交范围确认',exact:true}).waitFor();
 assert.deepEqual(previewBodies.at(-1).libraryScope,{kind:'category',value:'AI 工具目录'});assert.equal(previewBodies.at(-1).urls,undefined);
 assert.equal(await page.locator('#detail-content tbody tr').count(),50);await page.getByText('原范围第 1–50 项 / 601 项',{exact:true}).waitFor();
 const category=originalLibraryBatchScope({documents,revisions},{profileIds:['p'],category:'AI 工具目录'});
 await page.getByRole('button',{name:'下一页组合',exact:true}).click();assert.ok((await page.locator('#detail-content tbody tr').first().textContent()).includes(category.tasks[50].url));
 for(let n=0;n<11;n++)await page.getByRole('button',{name:'下一页组合',exact:true}).click();
 await page.getByText('原范围第 601–601 项 / 601 项',{exact:true}).waitFor();assert.equal(await page.locator('#detail-content tbody tr').count(),1);assert.ok((await page.locator('#detail-content tbody tr').first().textContent()).includes(category.tasks[600].url));assert.equal(await page.getByRole('button',{name:'下一页组合',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.getByLabel('外链分组',{exact:true}).selectOption('free_submit');await page.getByRole('button',{name:'从此分组开始提交',exact:true}).click();await page.getByRole('button',{name:'预览批量提交',exact:true}).click();await page.getByRole('heading',{name:'批量提交范围确认',exact:true}).waitFor();
 assert.deepEqual(previewBodies.at(-1).libraryScope,{kind:'group',value:'free_submit'});assert.equal(previewBodies.at(-1).urls,undefined);
 store=new Store(join(home,'outbox.sqlite'),{readOnly:true});const batches=store.values('workbenchBatch:');assert.equal(batches.length,6);assert.equal(batches.filter(batch=>batch.libraryScope.kind==='category').every(batch=>batch.count===601),true);
 assert.equal(store.values('task:').length,0);assert.equal(store.values('run:').length,0);assert.equal(store.pendingCount(),0);assert.equal(store.get('paused'),true);assert.deepEqual(store.get('acceptanceBatch'),fixed);assert.equal(store.get('activeWorkbenchBatch'),null);
 assert.equal(calls.some(call=>call.method==='POST'&&call.route.endsWith('/runs')),false);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,kind:'actual_services_original_library_scope_fixture',combinations:601,bothServicesCompleteCategoryAndGroupScope:true,invalidScopesBothServices400:true,actualUiIndependentCategoryAndGroup:true,displayFiltersDoNotShrinkScope:true,completeOriginalOrderPagination:true,invalidPreviewsDoNotCreateBatches:true,originalFixedBatchUnchanged:true,paused:true,pendingEvents:0,startedFixtureBatches:0,newRealSubmissions:0,externalRequests:0}));
}finally{
 store?.close();await browser?.close();await stop(web);await stop(backend);await new Promise(done=>cloud.close(done));
 const absolute=resolve(home);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&absolute.split(sep).at(-1).startsWith('el-original-library-scope-'));await rm(absolute,{recursive:true,force:true});
}
