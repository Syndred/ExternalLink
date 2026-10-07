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

const home=await mkdtemp(join(tmpdir(),'el-cloud-connections-')),sqlite=new DatabaseSync(':memory:');
for(const file of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../../cloud/worker/migrations/'+file,import.meta.url),'utf8'));
const db={prepare(sql){let args=[];return{bind(...values){args=values;return this;},first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const stmt=sqlite.prepare(sql);return stmt.columns().length?{results:stmt.all(...args),meta:{changes:0}}:{results:[],meta:{changes:stmt.run(...args).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
const objects=new Map(),bucket={head:async key=>objects.has(key)?{customMetadata:objects.get(key).meta?.customMetadata}:null,put:async(key,value,meta)=>objects.set(key,{bytes:new Uint8Array(value),meta}),get:async key=>{const object=objects.get(key);return object?{arrayBuffer:async()=>object.bytes.slice().buffer,httpMetadata:object.meta?.httpMetadata}:null;}};
const env={LEDGER_DB:db,MEDIA_BUCKET:bucket,APP_ACCESS_TOKEN:'fixture-admin'},calls=[];
let backend,web,browser,store,blockedToken=null;
const cloud=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1'),body=[];for await(const chunk of req)body.push(chunk);
  calls.push({method:req.method,path:url.pathname,workspace:url.searchParams.get('workspace')||'default'});
  if(req.headers.authorization==='Bearer '+blockedToken){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'fixture credential unavailable'}));return;}
  const response=await d1Executor(new Request('https://fixture.example'+url.pathname+url.search,{method:req.method,headers:{Authorization:req.headers.authorization||'','Content-Type':'application/json'},...(req.method==='POST'?{body:Buffer.concat(body)}:{})}),env,url.searchParams.get('workspace')||'default');
  res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());
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
const docs=name=>({siteProfiles:{p:{id:'p',name,fields:{Name:name,Url:'https://product.example','Business mail':'owner@example.com'}}},activeSiteId:'p',selectedSiteIds:['p'],urlList:'https://target.example/form',siteAnnotations:{'target.example/form':{library:{favorite:true,groups:['high_quality']}}},submissionTimeline:{},submissionRecords:{},linkMonitorSchedule:{enabled:false,minutes:1440}});
try{
 for(const workspace of ['default','second']){const ledger=new D1Store(db,bucket,workspace);for(const [key,data]of Object.entries(docs(workspace==='default'?'原产品':'新工作区产品')))await ledger.putDocument(key,data,0);}
 const enroll=async workspace=>{const r=await cloudCall(workspace,'devices','fixture-admin',{});assert.equal(r.status,200);return{endpoint,storageBackend:'d1',...r.data};};
 const a=await enroll('default'),b=await enroll('default'),c=await enroll('second');
 const registered=await cloudCall('default','runs',a.deviceToken,{run:{id:'original-run',profileId:'p',profileRevision:1,createdAt:'2026-10-07T00:00:00Z',mode:'single_page_preparation',authorization:'fill_only',feeLimit:0,tasks:[{id:'original-task',url:'https://target.example/form',destinationKey:'target.example/form'}]}});assert.equal(registered.status,200,JSON.stringify(registered.data));
 assert.equal((await cloudCall('default','tasks/original-task',b.deviceToken)).status,403,'other device must not own the original task');
 const pair={...a,localToken:'fixture-local'},fixed={id:'original-fixed',status:'paused',cursor:13,count:30,attempts:{original:{taskId:'original-task'}}},originalTask={...registered.data.tasks[0],status:'submitted_unconfirmed',attemptBoundary:'original-boundary',reason:'原结果未知',profileSnapshot:docs('原冻结产品').siteProfiles.p};
 store=new Store(join(home,'outbox.sqlite'));store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:(await cloudCall('default','snapshot',a.deviceToken)).data,at:'original-time'});store.set('run:original-run',registered.data.run);store.set('task:original-task',originalTask);store.set('acceptanceBatch',fixed);
 for(let n=0;n<52;n++)store.set('task:history-'+n,{id:'history-'+n,runId:'original-run',profileId:'p',url:'https://old.example/'+n,status:'finished',cloudVerified:true,receipt:{evidence:'原历史-'+n},createdAt:'2026-09-30T00:00:00Z'});
 const expectedTasks=store.valuesByInsertion('task:');store.close();store=null;backend=await start('server.mjs');web=await start('workbench-server.mjs');
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext(),page=await context.newPage(),oldPage=await context.newPage(),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==web.endpoint){await route.abort();return;}await route.continue();});
 for(const p of [page,oldPage])await p.goto(web.endpoint+'/#access=fixture-local');
 await page.getByRole('button',{name:'外链库',exact:true}).click();await page.getByLabel('外链分组',{exact:true}).selectOption('high_quality');await page.getByLabel('搜索',{exact:true}).fill('old temporary search');
 await page.getByRole('button',{name:'设置与备份',exact:true}).click();await page.getByLabel('默认联系人姓名',{exact:true}).fill('Unsaved previous workspace contact');page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'云端连接与保存的记录',exact:true}).click();await page.getByRole('heading',{name:'云端连接与保存的记录',exact:true}).waitFor();
 const upload=async cfg=>{await page.getByLabel('更新连接使用的设备登记文件').setInputFiles({name:'device.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(cfg))});await page.getByRole('button',{name:'核验所选连接',exact:true}).click();};
 const rotated={...a,deviceToken:'eld_fixture_rotated'};sqlite.prepare('UPDATE executor_devices SET token_hash=? WHERE workspace=? AND id=?').run(createHash('sha256').update(rotated.deviceToken).digest('hex'),'default',a.deviceId);
 await upload(rotated);await page.getByRole('heading',{name:'核对凭据更新',exact:true}).waitFor();await page.getByRole('button',{name:'确认更新云端连接',exact:true}).click();await page.getByRole('heading',{name:'云端连接已更新',exact:true}).waitFor();
 const currentA=connectionIdentity(rotated);assert.equal((await local(web.endpoint,'/connection')).data.connectionId,currentA);
 assert.equal(await page.getByLabel('默认联系人姓名',{exact:true}).inputValue(),'');
 store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.deepEqual(store.valuesByInsertion('task:'),expectedTasks);assert.deepEqual(store.get('acceptanceBatch'),fixed);assert.equal(store.get('pair').deviceToken,rotated.deviceToken);store.close();store=null;
 let loseCommitReply=true,lostPreviewId;
 await page.route('**/commitConnection',async route=>{if(!loseCommitReply){await route.continue();return;}loseCommitReply=false;lostPreviewId=route.request().postDataJSON().previewId;const response=await route.fetch();assert.equal(response.status(),200);await response.json();await route.abort('failed');});
 await page.getByRole('button',{name:'查看当前连接与保存的记录',exact:true}).click();await upload(b);await page.getByRole('heading',{name:'核对云端连接切换',exact:true}).waitFor();await page.getByRole('button',{name:'确认切换并保留原记录',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('Failed to fetch'));
 await page.getByRole('button',{name:'确认切换并保留原记录',exact:true}).click();await page.getByRole('heading',{name:'云端连接已更新',exact:true}).waitFor();
 assert.ok(lostPreviewId);store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.equal(store.db.prepare('SELECT count(*) n FROM connection_commits').get().n,2);store.close();store=null;
 assert.equal((await local(backend.endpoint,'/appData',{})).data.tasks.length,0);assert.equal((await cloudCall('default','tasks/original-task',b.deviceToken)).status,403);
 for(const origin of [backend.endpoint,web.endpoint]){const stale=await local(origin,'/libraryMutation',{operation:{type:'settings',key:'cfgName',value:'stale page change'}},currentA);assert.equal(stale.status,409);assert.match(stale.data.error,/旧请求未写入新工作区/);}
 // Verify the actual old page's existing request identity when it refreshes.
 const staleResponse=oldPage.waitForResponse(r=>new URL(r.url()).pathname==='/appData');await oldPage.getByRole('button',{name:'刷新云端',exact:true}).click();assert.equal((await staleResponse).status(),409);
 await page.getByRole('button',{name:'查看当前连接与保存的记录',exact:true}).click();await upload(c);await page.getByRole('button',{name:'确认切换并保留原记录',exact:true}).click();await page.getByRole('heading',{name:'云端连接已更新',exact:true}).waitFor();
 await page.getByRole('button',{name:'查看当前连接与保存的记录',exact:true}).click();const oldSaved=page.locator('#detail-content .notice').filter({hasText:a.deviceId});await oldSaved.getByRole('button',{name:'查看保存的记录',exact:true}).click();await page.getByRole('heading',{name:'原连接保存的记录',exact:true}).waitFor();assert.equal(await page.locator('#detail-content tbody tr').count(),50);assert.ok((await page.locator('#detail-content tbody tr').first().textContent()).includes('original-task'));await page.getByRole('button',{name:'下一页保存记录',exact:true}).click();await page.locator('#detail-content tbody').getByText('history-49',{exact:true}).waitFor();assert.equal(await page.locator('#detail-content tbody tr').count(),3);
 blockedToken=rotated.deviceToken;await page.getByRole('button',{name:'返回云端连接',exact:true}).click();await page.locator('#detail-content .notice').filter({hasText:a.deviceId}).getByRole('button',{name:'核验并切回此连接',exact:true}).click();await page.getByText('fixture credential unavailable',{exact:true}).waitFor();
 await page.locator('#detail-content .notice').filter({hasText:a.deviceId}).getByRole('button',{name:'查看保存的记录',exact:true}).click();await page.getByRole('heading',{name:'原连接保存的记录',exact:true}).waitFor();assert.equal(await page.locator('#detail-content tbody tr').count(),50);blockedToken=null;
 await page.getByRole('button',{name:'返回云端连接',exact:true}).click();await page.locator('#detail-content .notice').filter({hasText:a.deviceId}).getByRole('button',{name:'核验并切回此连接',exact:true}).click();await page.getByRole('button',{name:'确认切换并保留原记录',exact:true}).click();await page.getByRole('heading',{name:'云端连接已更新',exact:true}).waitFor();
 await new Promise(done=>setTimeout(done,2300));store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.deepEqual(store.valuesByInsertion('task:'),expectedTasks);assert.deepEqual(store.get('acceptanceBatch'),fixed);assert.equal(store.get('pair').deviceToken,rotated.deviceToken);assert.equal(store.get('paused'),true);assert.equal(store.get('connectionExecutionHold').connectionId,currentA);assert.equal(store.pendingCount(),0);assert.equal(store.db.prepare('SELECT count(*) n FROM connection_profiles').get().n,3);
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.getByRole('button',{name:'外链库',exact:true}).click();assert.equal(await page.getByLabel('外链分组',{exact:true}).inputValue(),'');assert.equal(await page.getByLabel('搜索',{exact:true}).inputValue(),'');
 assert.equal(sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM executor_events').get().n,0);assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/runs')).length,1);assert.deepEqual(pageErrors,[]);
 console.log(JSON.stringify({ok:true,kind:'authenticated_d1_actual_services_and_chrome_connection_fixture',credentialRotationRetainsOriginalState:true,sameWorkspaceDifferentDeviceIsolation:true,differentWorkspaceIsolation:true,bothServicesRejectStalePage409:true,actualOldPageRefresh409:true,cookieSessionSurvivesSwitch:true,actualLostCommitReplyRetryOriginalReceipt:true,previousDraftAndDisplayFiltersCleared:true,readOnlyHistoryTasks:53,historyPages:2,historyAvailableWithRevokedCredentials:true,restoreOriginalTasksAndFrozenBatch:true,automaticExecutionAfterRestore:false,originalUnknownAttemptPreserved:true,postEnrollmentFixtureRuns:1,newRuntimeRuns:0,cloudEvents:0,externalRequests:0,newRealSubmissions:0}));
}finally{
 store?.close();await browser?.close();await stop(web);await stop(backend);await new Promise(done=>cloud.close(done));sqlite.close();const target=resolve(home);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&target.split(sep).at(-1).startsWith('el-cloud-connections-'));await rm(target,{recursive:true,force:true});
}
