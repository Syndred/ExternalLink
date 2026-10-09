import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';
import Worker from '../../cloud/worker/src/index.mjs';
import {aiCloudFixture} from './fixtures/ai-cloud.mjs';
import {Store} from '../src/store.mjs';
import {Runtime} from '../src/runtime.mjs';
import {browserLaunch} from '../src/workbench-platform.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';

const home=await mkdtemp(join(tmpdir(),'el-manual-task-page-')),profileDir=join(home,'owned-chrome'),f=aiCloudFixture();
let store,backend,web,owned,observer,ui,held,posts=0,unexpected=0;
const cloudWrites=[],errors=[],profile={id:'p',name:'原产品',fields:{Name:'原产品',Url:'https://product.fixture.invalid'}};
const cloud=createServer(async(req,res)=>{try{let body='';for await(const part of req)body+=part;const url='https://worker.fixture.invalid'+req.url;if(req.method!=='GET')cloudWrites.push(new URL(url).pathname);const response=await Worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body?{body}:{})}),f.env);res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());}catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}});
const pages=createServer((req,res)=>{if(req.method==='POST')posts++;if(req.url==='/slow'){held=res;return;}res.setHeader('Content-Type','text/html');res.end('<h1>Original task page</h1><form><input name="product"><button>Submit</button></form>');});
await new Promise(done=>cloud.listen(0,'127.0.0.1',done));await new Promise(done=>pages.listen(0,'127.0.0.1',done));
const endpoint='http://127.0.0.1:'+cloud.address().port,url='http://original.fixture.invalid:'+pages.address().port+'/original',todo='http://todo.fixture.invalid:'+pages.address().port+'/slow',closedUrl='http://closed.fixture.invalid:'+pages.address().port+'/closed';
async function start(name){const child=spawn(process.execPath,[resolve(import.meta.dirname,'../src/'+name)],{windowsHide:true,env:{...process.env,EXTERNALLINK_HOME:home,EXTERNALLINK_PORT:'0',EXTERNALLINK_WEB_PORT:'0'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',part=>errors+=part);child.stdout.resume();for(let n=0;n<150;n++){if(child.exitCode!==null)throw Error('Fixture service exited: '+errors);try{const file=JSON.parse(await readFile(join(home,name==='server.mjs'?'server.json':'workbench.json'),'utf8'));if(file.pid===child.pid)return{child,endpoint:file.endpoint};}catch{}await new Promise(done=>setTimeout(done,50));}throw Error('Fixture startup timeout');}
async function stop(service){if(service?.child.exitCode===null){const stopped=once(service.child,'exit');service.child.kill();await stopped;}}
try{
 const executable=process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':browserLaunch(process.platform,'about:blank').command;
 owned=spawn(executable,['--user-data-dir='+profileDir,'--headless=new','--no-first-run','--disable-extensions','--disable-background-networking','--no-proxy-server','--host-resolver-rules=MAP *.fixture.invalid 127.0.0.1','--remote-debugging-port=0','about:blank'],{stdio:'ignore',windowsHide:true});
 let browserEndpoint;for(let n=0;n<160;n++){if(owned.exitCode!==null)throw Error('Owned Chrome exited');try{browserEndpoint='http://127.0.0.1:'+(await readFile(join(profileDir,'DevToolsActivePort'),'utf8')).trim().split('\n')[0];break;}catch{await new Promise(done=>setTimeout(done,50));}}
 assert.ok(browserEndpoint);await writeFile(join(home,'host.json'),JSON.stringify({endpoint:browserEndpoint,startedAt:'owned-manual-task-page',chromePid:owned.pid}));
 observer=await chromium.connectOverCDP(browserEndpoint,{noDefaults:true});const context=observer.contexts()[0];
 await context.route('**/*',route=>{if(new URL(route.request().url()).hostname.endsWith('.fixture.invalid'))return route.continue();unexpected++;return route.abort();});
 const original=context.pages()[0];await original.goto(url);const targetId=(await getTargetInfo(context,original)).targetId;
 const distraction=await context.newPage();await distraction.goto(url+'?other');await distraction.bringToFront();
 for(const [key,data]of Object.entries({siteProfiles:{p:profile},sheetTableData:{entries:[{link:url},{link:todo},{link:closedUrl}]},targetFilters:{},submissionRecords:{},cfgPingIndex:false,autoFillOnVisit:false,linkMonitorSchedule:{enabled:false}}))await f.ledger.putDocument(key,data,0);
 const response=await Worker.fetch(new Request('https://worker.fixture.invalid/v2/executor/devices?workspace=default',{method:'POST',headers:{Authorization:'Bearer fixture-admin','Content-Type':'application/json'},body:'{}'}),f.env),enrollment=await response.json();assert.equal(response.status,200);
 store=new Store(join(home,'outbox.sqlite'));store.set('pair',{endpoint,workspaceId:'default',storageBackend:'d1',deviceId:enrollment.deviceId,deviceToken:enrollment.deviceToken,localToken:'fixture-local'});store.set('paused',true);store.set('executionStopped',{id:'original-stop',status:'stopped'});store.set('acceptanceBatch',{id:'retained-fixed',status:'paused',cursor:13,count:30});
 const runtime=new Runtime(store,home),snapshot=await runtime.cloud.request('snapshot'),run={id:'original-run',profileId:'p',profileRevision:snapshot.revisions.siteProfiles,profile,createdAt:new Date().toISOString(),tasks:[{id:'original-task',url,destinationKey:'original.fixture.invalid/original'},{id:'todo-task',url:todo,destinationKey:'todo.fixture.invalid/slow'},{id:'closed-task',url:closedUrl,destinationKey:'closed.fixture.invalid/closed'}]},registered=await runtime.cloud.request('runs',{run});assert.equal(registered.tasks.length,3);store.set('run:'+run.id,registered.run);
 for(const task of registered.tasks){runtime.update(task,{status:'needs_manual',siteStatus:'not_submitted',controller:'executor',profileSnapshot:profile,profileRevision:run.profileRevision,...(task.id==='todo-task'?{}:{targetId:task.id==='original-task'?targetId:'closed-target',browserInstance:'owned-manual-task-page'}),...(task.id==='original-task'?{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:'original-unknown-attempt'}:{}),reason:'Original task must remain unchanged'},'fixture_manual_task');}
 await runtime.synchronize();const before=store.values('task:');store.close();store=null;const writesBefore=cloudWrites.length;
 backend=await start('server.mjs');web=await start('workbench-server.mjs');
 for(const origin of [backend.endpoint,web.endpoint])assert.equal((await fetch(origin+'/openManualTaskPage',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const oldUi=process.argv.includes('--before-native-ui')?execFileSync('git',['show','a80c5dc:executor/web/application.js'],{encoding:'utf8'}):null;
 ui=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const page=await ui.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(oldUi&&route.request().url()===web.endpoint+'/application.js')return route.fulfill({contentType:'text/javascript',body:oldUi});return route.request().url().startsWith(web.endpoint)?route.continue():route.abort();});await page.goto(web.endpoint+'/#access=fixture-local');await page.getByRole('button',{name:'运行任务',exact:true}).click();await page.getByLabel('任务范围',{exact:true}).selectOption('all');
 async function detailFor(taskUrl){await page.locator('#content tbody tr').filter({has:page.getByText(taskUrl,{exact:true})}).getByRole('button',{name:'查看',exact:true}).click();}
 await detailFor(url);await page.getByRole('button',{name:'打开页签',exact:true}).click();await page.getByText('已显示原页面，原任务与执行状态保持',{exact:true}).waitFor();assert.equal(await original.evaluate(()=>document.hasFocus()),true);assert.equal(await distraction.evaluate(()=>document.hasFocus()),false);await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 await detailFor(closedUrl);const count=context.pages().length;await page.getByRole('button',{name:'打开页签',exact:true}).click();await page.getByText('原页签已关闭，请刷新待人工列表',{exact:true}).waitFor();assert.equal(context.pages().length,count);await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 await detailFor(todo);await page.getByRole('button',{name:'打开待办页面',exact:true}).click();await page.getByText('已打开待办页面，请核查站点状态后处理',{exact:true}).waitFor();
 for(let n=0;n<200&&!held;n++)await new Promise(done=>setTimeout(done,25));assert.ok(held);assert.equal(held.writableEnded,false,'Opening must finish before network navigation');const session=await observer.newBrowserCDPSession(),targets=await session.send('Target.getTargets');await session.detach();assert.equal(targets.targetInfos.filter(t=>t.type==='page').length,count+1);held.end('<h1>Original todo</h1>');
 let opened;for(let n=0;n<200&&!opened;n++){opened=context.pages().find(p=>p!==original&&p!==distraction);if(!opened)await new Promise(done=>setTimeout(done,25));}assert.ok(opened);await opened.waitForURL(todo);await opened.waitForLoadState('domcontentloaded');assert.equal(await opened.evaluate(()=>document.hasFocus()),true);
 store=new Store(join(home,'outbox.sqlite'),{readOnly:true});assert.deepEqual(store.values('task:'),before);assert.equal(store.get('paused'),true);assert.deepEqual(store.get('executionStopped'),{id:'original-stop',status:'stopped'});assert.deepEqual(store.get('acceptanceBatch'),{id:'retained-fixed',status:'paused',cursor:13,count:30});assert.equal(store.pendingCount(),0);assert.equal(cloudWrites.length,writesBefore);assert.equal(posts,0);assert.equal(unexpected,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,kind:'original_manual_task_page_native_services',authenticatedTwoServices:true,unauthorizedRequestsRejected:true,existingUnknownAttemptFocused:true,stoppedTaskCanView:true,closedTabNotReplaced:true,todoCreatesActiveTabWithoutWaitingForNavigation:true,originalStateUnchanged:true,newCloudWrites:0,realSubmissions:0,realModelCalls:0,originalChromeUntouched:true}));
}finally{
 store?.close();await ui?.close();await stop(web);await stop(backend);
 if(observer){const session=await observer.newBrowserCDPSession().catch(()=>null);await session?.send('Browser.close').catch(()=>{});await observer.close().catch(()=>{});}
 if(owned?.exitCode===null){const stopped=once(owned,'exit');owned.kill();await stopped;}
 held?.destroy();await new Promise(done=>cloud.close(done));await new Promise(done=>pages.close(done));
 assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-manual-task-page-'));await rm(home,{recursive:true,force:true,maxRetries:5});
}
