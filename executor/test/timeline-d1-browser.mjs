import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {connectionIdentity} from '../src/workbench-connections.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';
import {D1Store} from '../../cloud/worker/src/d1-store.mjs';
import {d1Executor} from '../../cloud/worker/src/d1-executor.mjs';

const home=await mkdtemp(join(tmpdir(),'el-timeline-browser-')),sqlite=new DatabaseSync(':memory:');
for(const file of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../../cloud/worker/migrations/'+file,import.meta.url),'utf8'));
const db={prepare(sql){let args=[];return{bind(...values){args=values;return this;},first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const stmt=sqlite.prepare(sql);return stmt.columns().length?{results:stmt.all(...args),meta:{changes:0}}:{results:[],meta:{changes:stmt.run(...args).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
const objects=new Map(),bucket={head:async key=>objects.has(key)?{customMetadata:objects.get(key).meta?.customMetadata}:null,put:async(key,value,meta)=>objects.set(key,{bytes:new Uint8Array(value),meta}),get:async key=>{const object=objects.get(key);return object?{arrayBuffer:async()=>object.bytes.slice().buffer,httpMetadata:object.meta?.httpMetadata}:null;}};
const env={LEDGER_DB:db,MEDIA_BUCKET:bucket,APP_ACCESS_TOKEN:'fixture-admin'},calls=[];
let backend,web,browser,store,blockedToken=null,loseNextEdit=false;
const cloud=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1'),body=[];for await(const chunk of req)body.push(chunk);
  calls.push({method:req.method,path:url.pathname,workspace:url.searchParams.get('workspace')||'default'});
  if(req.headers.authorization==='Bearer '+blockedToken){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'fixture credential unavailable'}));return;}
  const response=await d1Executor(new Request('https://fixture.example'+url.pathname+url.search,{method:req.method,headers:{Authorization:req.headers.authorization||'','Content-Type':'application/json'},...(req.method==='POST'?{body:Buffer.concat(body)}:{})}),env,url.searchParams.get('workspace')||'default');
  if(loseNextEdit&&url.pathname.endsWith('/library')&&response.status===200){loseNextEdit=false;blockedToken=req.headers.authorization.slice(7);res.destroy();return;}res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}
});
await new Promise(done=>cloud.listen(0,'127.0.0.1',done));const endpoint='http://127.0.0.1:'+cloud.address().port;
const cloudCall=async(workspace,route,token,body)=>{const r=await fetch(endpoint+'/v2/executor/'+route+'?workspace='+workspace,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
async function start(name){
 const child=spawn(process.execPath,[resolve(import.meta.dirname,'../src/'+name)],{windowsHide:true,env:{...process.env,EXTERNALLINK_HOME:home,EXTERNALLINK_PORT:'0',EXTERNALLINK_WEB_PORT:'0'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',part=>errors+=part);child.stdout.resume();const service={child};if(name==='server.mjs')backend=service;else web=service;
 for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error('fixture service exited: '+errors);try{const file=JSON.parse(await readFile(join(home,name==='server.mjs'?'server.json':'workbench.json'),'utf8'));if(file.pid===child.pid){service.endpoint=file.endpoint;return service;}}catch{}await new Promise(done=>setTimeout(done,50));}throw Error('fixture service startup exceeded observation budget');
}
async function stop(service){if(service?.child.exitCode===null){const stopped=once(service.child,'exit');service.child.kill();await stopped;}}
const local=async(origin,path,body,id)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer fixture-local','Content-Type':'application/json',...(id?{'X-Workbench-Connection':id}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};

const oldEvent={id:'old-event',profileId:'p',profileName:'原产品',destinationKey:'target.example/form',destinationUrl:'https://target.example/form',type:'note',status:'note',note:'原导入笔记',occurredAt:'2026-10-07T00:00:00.000Z',source:'migration'};
const docs={siteProfiles:{p:{id:'p',name:'原产品',fields:{Name:'原产品',Url:'https://product.example'}},q:{id:'q',name:'新产品',fields:{Name:'新产品',Url:'https://new-product.example'}}},activeSiteId:'p',selectedSiteIds:['p'],urlList:'https://target.example/form',siteAnnotations:{},submissionTimeline:{'target.example/form::p':[oldEvent]},submissionRecords:{'old-receipt.example::p':{status:'success',profileId:'p',destinationKey:'old-receipt.example',destinationUrl:'https://old-receipt.example',evidence:'保留原收件'}},linkMonitorSchedule:{enabled:false,minutes:1440}};
const business=s=>JSON.stringify([s.valuesByInsertion('task:'),s.get('acceptanceBatch'),s.get('workbenchBatch:original'),s.pending(),s.logs({scope:workbenchScope(s.get('pair'))})]);
try{
 const ledger=new D1Store(db,bucket,'default');for(const [key,data]of Object.entries(docs))await ledger.putDocument(key,data,0);
 const enrollment=await cloudCall('default','devices','fixture-admin',{}),pair={endpoint,storageBackend:'d1',...enrollment.data,localToken:'fixture-local'},scope=workbenchScope(pair);
 const registered=await cloudCall('default','runs',pair.deviceToken,{run:{id:'original-run',profileId:'p',profileRevision:1,createdAt:'2026-10-07T00:00:00Z',mode:'single_page_preparation',authorization:'fill_only',feeLimit:0,tasks:[{id:'original-task',url:'https://target.example/form',destinationKey:'target.example/form'}]}});assert.equal(registered.status,200);
 store=new Store(join(home,'outbox.sqlite'));store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope,snapshot:(await cloudCall('default','snapshot',pair.deviceToken)).data});store.set('run:original-run',registered.data.run);store.set('task:original-task',{...registered.data.tasks[0],status:'submitted_unconfirmed',attemptBoundary:'original-boundary',reason:'原结果未知',profileSnapshot:docs.siteProfiles.p});store.set('acceptanceBatch',{id:'original-fixed',status:'paused',cursor:13,count:30});store.set('workbenchBatch:original',{id:'original',status:'paused',cursor:13,usedTasks:13,usedAiActions:4,config:{fillOnly:true,concurrency:3},items:[{taskId:'original-task',identity:'target.example/form::p'}]});const protectedBefore=business(store);store.close();store=null;
 backend=await start('server.mjs');web=await start('workbench-server.mjs');
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext(),page=await context.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));let external=0;
 await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==web.endpoint){external++;await route.abort();return;}await route.continue();});
 await page.goto(web.endpoint+'/#access=fixture-local');await page.getByRole('button',{name:'外链库',exact:true}).click();await page.getByRole('button',{name:'时间线',exact:true}).first().click();await page.getByRole('button',{name:'编辑动态',exact:true}).click();
 assert.equal(await page.getByLabel('动态所属产品',{exact:true}).isEnabled(),true);assert.ok((await page.getByLabel('动态所属产品',{exact:true}).locator('option').allTextContents()).includes('外链站通用动态'));
 await page.getByLabel('动态所属产品',{exact:true}).selectOption('q');await page.getByLabel('动态类型',{exact:true}).selectOption('published');await page.getByLabel('动态说明',{exact:true}).fill('人工确认已上线');await page.getByLabel('公开外链网址',{exact:true}).fill('https://target.example/post');loseNextEdit=true;
 await page.getByRole('button',{name:'保存动态',exact:true}).click();await page.getByText('动态已存本机，等待同步',{exact:true}).waitFor();
 store=new Store(join(home,'outbox.sqlite'),{readOnly:true});const pending=store.values('appMutation:').find(item=>item.operation.type==='timeline');assert.ok(pending.writeAttemptedAt);assert.equal(pending.status,'pending');assert.equal(pending.operation.eventId,'old-event');assert.equal(pending.relatedBaseRevisions.submissionRecords,1);assert.equal(business(store),protectedBefore);store.close();store=null;
 let snap=(await ledger.document('submissionTimeline')).data;assert.equal(snap['target.example/form::p'],undefined);assert.equal(snap['target.example/form::q'][0].id,'old-event');assert.equal((await ledger.document('submissionRecords')).data['target.example/form::q'].publicationStatus,'published');
 const writesBefore=calls.filter(call=>call.method==='POST'&&call.path.endsWith('/library')).length;blockedToken=null;const upload=await local(web.endpoint,'/cloudSyncPush',{});assert.equal(upload.status,200,JSON.stringify(upload.data));assert.equal(calls.filter(call=>call.method==='POST'&&call.path.endsWith('/library')).length,writesBefore,'lost reply must be verified without another edit');store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.equal(store.get('appMutation:'+pending.id).status,'confirmed');assert.equal(business(store),protectedBefore);store.close();store=null;
 await page.locator('#close-detail').click();await page.reload();await page.getByRole('button',{name:'外链库',exact:true}).click();await page.getByRole('button',{name:'时间线',exact:true}).first().click();await page.getByRole('button',{name:'添加跟进动态',exact:true}).click();assert.equal(await page.getByLabel('动态所属产品',{exact:true}).inputValue(),'__destination__');await page.getByLabel('动态类型',{exact:true}).selectOption('published');await page.getByLabel('动态说明',{exact:true}).fill('外链站通用说明，公开网址可稍后补充');await page.getByRole('button',{name:'保存动态',exact:true}).click();await page.getByText('动态已保存并回读云端',{exact:true}).waitFor();
 const records=(await ledger.document('submissionRecords')).data;assert.equal(records['target.example/form::__destination__'],undefined);assert.ok((await ledger.document('submissionTimeline')).data['target.example/form::__destination__']);
await page.locator('#close-detail').click();await page.reload();await page.getByRole('button',{name:'外链库',exact:true}).click();await page.getByRole('button',{name:'时间线',exact:true}).first().click();page.once('dialog',dialog=>dialog.accept());const removedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/libraryMutation');await page.getByRole('button',{name:'删除动态',exact:true}).last().click();const removed=await(await removedResponse).json();assert.equal(removed.pending,0);
 assert.deepEqual((await ledger.document('submissionRecords')).data,records);snap=(await ledger.document('submissionTimeline')).data;assert.equal(Object.values(snap).flat().some(event=>event.id==='old-event'),false);assert.deepEqual(pageErrors,[]);assert.equal(external,0);
 store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.equal(business(store),protectedBefore);assert.equal(store.values('appMutation:').filter(item=>item.operation.type==='timeline'&&item.status!=='confirmed').length,0);assert.equal(store.get('workbenchJournalPending')?.length||0,0);store.close();store=null;assert.equal(sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM executor_events').get().n,0);
 console.log(JSON.stringify({ok:true,kind:'authenticated_d1_actual_services_and_chrome_original_timeline',migratedEventEditable:true,originalProductMove:true,commonDestinationEvent:true,publishedUrlOptionalLikeOriginal:true,actualLostEditReplyRecoveredWithoutReplay:true,atomicLinkedLedgerReadback:true,removeRetainsOriginalReceipts:true,originalUnknownTaskAndFrozenBudgetUnchanged:true,cloudTimelineEdits:2,cloudTimelineAdds:1,newRuntimeRuns:0,cloudEvents:0,externalRequests:external,newRealSubmissions:0}));
}finally{
 store?.close();await browser?.close();await stop(web);await stop(backend);await new Promise(done=>cloud.close(done));sqlite.close();const target=resolve(home);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.split(sep).at(-1).startsWith('el-timeline-browser-'));await rm(target,{recursive:true,force:true});
}
