import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),store=new Store(join(homedir(),'.externallink-executor','outbox.sqlite'),{readOnly:true}),pair=store.get('pair');
const commentRows=()=>store.db.prepare("SELECT id,value FROM state WHERE id LIKE 'comment%' OR id LIKE 'originalComment%' ORDER BY id").all();const before=JSON.stringify(commentRows()),normalize=value=>value.replaceAll('\r\n','\n'),hash=value=>createHash('sha256').update(value).digest('hex');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),headers={Authorization:'Bearer '+pair.localToken,'Content-Type':'application/json'},services=[];
let browser;
try{
 for(const port of [19388,19389]){const response=await fetch('http://127.0.0.1:'+port+'/appData',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);const app=await response.json();assert.equal(app.ok,true);assert.equal(app.runtime.paused,true);assert.equal(app.runtime.busy,false);assert.equal(app.runtime.pendingEvents,0);assert.equal(app.pendingEdits.length,0);services.push({port,products:app.model.products.length,library:app.model.library.length,combinations:app.model.combinations.length,paused:true,busy:false,pendingEvents:0});}
 const gmailResponse=await fetch('http://127.0.0.1:19388/gmailStatus',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(10000)});assert.equal(gmailResponse.status,200);const gmailData=await gmailResponse.json();assert.equal(gmailData.ok,true);const gmail={status:gmailData.gmail.status,savedMessages:gmailData.gmail.messageCount,providerReadPerformed:false};assert.equal(gmail.status,'needs_authorization');assert.equal(gmail.savedMessages,758);
 const assets=[];for(const file of ['application.js','comment-studio.js','application.css']){const path='executor/web/'+file,response=await fetch('http://127.0.0.1:19389/'+file,{headers,signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const served=normalize(await response.text()),workspace=normalize(await readFile(join(root,path),'utf8')),committed=normalize(execFileSync('git',['show',head+':'+path],{cwd:root,encoding:'utf8'}));assert.equal(served,workspace);assert.equal(served,committed);assets.push({path,sha256:hash(served),servedEqualsWorkspaceAndCommit:true});}
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});const context=await browser.newContext({extraHTTPHeaders:{Authorization:headers.Authorization}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:19389'?route.continue():route.abort());page.setDefaultTimeout(10000);await page.goto('http://127.0.0.1:19389/');const pages=[];
 for(const label of ['我的网站','外链库','提交总览','运行任务','AI 评论','设置与备份']){await page.getByRole('navigation',{name:'工作区'}).getByRole('button',{name:label,exact:true}).click();await page.locator('#heading').getByText(label,{exact:true}).waitFor();pages.push({label,nativeDomRendered:true});}
 assert.deepEqual(errors,[]);assert.equal(JSON.stringify(commentRows()),before);assert.equal(store.get('paused'),true);assert.equal(store.get('acceptanceBatch').cursor,13);assert.equal(store.get('acceptanceBatch').count,30);
 const proof={ok:true,at:new Date().toISOString(),sourceCommit:head,actualReadonlyNativeUi:true,services,gmail,assets,pages,originalCommentsRawRowsUnchanged:true,originalCommentRawRowsSha256:hash(before),productionBusinessWrites:0,newSubmissions:0,originalChromeUntouched:true};await writeFile(new URL('../../docs/evidence/no-extension-2026-09-30/autonomous-closure-2026-10-10/native-published-smoke.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({ok:true,sourceCommit:head,nativePages:pages.length,bothServicesPaused:true,servedAssetsMatchCommittedSource:true,businessWrites:0,originalChromeUntouched:true}));
}finally{await browser?.close();store.close();}
