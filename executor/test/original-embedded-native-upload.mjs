import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {Runtime} from '../src/runtime.mjs';
import {Store} from '../src/store.mjs';
import {profiles,plain} from '../src/shared.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {imageFormatFixtures} from './image-format-fixtures.mjs';

// Fresh isolated Chrome and SQLite only. Model replies are fixtures; no external registrations or posts.
let posts=0,externalRequests=0,fixturePlanCalls=0,fixtureJudgeCalls=0,fixtureVisionCalls=0,screenshotArtifacts=0;
const kinds=process.argv.includes('--inline-kinds')?['featured','screenshot1','screenshot2','screenshot3','screenshot4']:['logo'];let currentKind='logo';
const form=png=>'<form method="POST"><label>Product '+currentKind+(png?' PNG only. Maximum dimensions 8px x 8px. Ratio 2:1.':'')+'<input id="logo" name="'+currentKind+'" type="file" accept="'+(png?'image/png':'image/gif,image/svg+xml')+'" required></label><button type="submit">Submit product</button></form>';
const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/iframe')?'<iframe src="/frame'+(req.url.includes('png')?'-png':'')+'" title="Original product form"></iframe>':form(req.url.includes('png')));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const portServer=http.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const home=await mkdtemp(join(tmpdir(),'el-original-embedded-upload-')),browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions','--remote-debugging-port='+port]}),context=await browser.newContext(),store=new Store(':memory:'),runtime=new Runtime(store,home),cases=[];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 store.set('pair',{endpoint:'https://isolated.fixture.invalid',workspaceId:'isolated'});store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});store.set('task:unknown',{id:'unknown',status:'submitted_unconfirmed',attemptBoundary:'original-unknown-boundary'});
 runtime.context=context;runtime.host={endpoint:'http://127.0.0.1:'+port,startedAt:'isolated-embedded-'+Date.now()};runtime.preparePublicPage=async()=>{};runtime.lease=async()=>{};
 runtime.synchronize=async()=>{for(const event of store.pending()){assert.ok(event.state.profileSnapshot);assert.equal(event.state.attemptBoundary,undefined);assert.equal(event.state.receipt,undefined);store.ack(event.id);}};
 const artifacts=new Map();Object.defineProperty(runtime,'cloud',{value:{flush:async()=>runtime.synchronize(),async request(route,input){
  if(route==='artifact'){const ref='isolated-screenshot-'+(++screenshotArtifacts);artifacts.set(ref,input.dataUrl);return{ref};}
  if(route==='artifact-read'){assert.ok(artifacts.has(input.ref));return{dataUrl:artifacts.get(input.ref)};}
  if(route==='ai/judge'){fixtureJudgeCalls++;return{status:'incomplete',reason:'Fixture preparation only; no site receipt'};}
  if(route==='ai/vision-plan'){fixtureVisionCalls++;assert.ok(input.screenshot.startsWith('data:image/png;base64,'));throw Object.assign(Error('Fixture visual service unavailable; original DOM fallback'),{status:503});}
  assert.equal(route,'plan');assert.equal(input.mode,'prepare_takeover');assert.equal(input.fillOnly,true);fixturePlanCalls++;const field=input.snapshot.fields.find(field=>field.type==='file');assert.ok(field,'Actual engine must observe the original file control');return{status:'act',actions:[{type:'upload',selector:field.selector,mediaKind:currentKind}]};}}});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():(externalRequests++,route.abort()));
 for(const kind of kinds)for(const [index,image]of imageFormatFixtures.entries())for(const mode of ['main','iframe','main-png','iframe-png']){
  currentKind=kind;
  const inFrame=mode.startsWith('iframe'),png=mode.endsWith('-png'),page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/'+mode);const frame=inFrame?page.frames().find(frame=>frame.url().includes('/frame')):page.mainFrame();assert.ok(frame);await frame.locator('#logo').waitFor();const target=await getTargetInfo(context,page),profile={id:'p',name:'Original embedded product',url:'https://product.example',logoUrl:'https://product.example/old-public-logo.png',logoDataUrl:image.dataUrl,fields:{Name:'Original embedded product',Url:'https://product.example',LOGO:'https://product.example/old-public-logo.png'}},task={id:'embedded-'+index+'-'+mode,runId:'run-'+index+'-'+mode,profileId:'p',profileSnapshot:structuredClone(profile),profileRevision:1,status:'filling',controller:'executor',version:1,targetId:target.targetId,browserInstance:runtime.host.startedAt,url:page.url()};
  task.id+='-'+kind;task.runId+='-'+kind;
  if(kind!=='logo'){
   profile.logoDataUrl=imageFormatFixtures.find(other=>other.dataUrl!==image.dataUrl).dataUrl;
   for(let slot=1;slot<=4;slot++)profile.fields['Screenshot '+slot]=imageFormatFixtures[slot%2].dataUrl;
   profile.fields[kind==='featured'?'Featured image':'Screenshot '+kind.slice(10)]=image.dataUrl;
   task.profileSnapshot=structuredClone(profile);
  }
  store.set('task:'+task.id,task);store.set('run:'+task.runId,{id:task.runId,profileId:'p',profile,tasks:[task.id],mediaManifest:[]});const originalProfile=structuredClone(profile),readFile=()=>frame.locator('#logo').evaluate(async input=>input.files[0]?{mime:input.files[0].type,bytes:[...new Uint8Array(await input.files[0].arrayBuffer())]}:null);
  const prepare=async()=>{const result=await runtime.prepareWithAi(page,task,plain(profiles.buildAgentConfigFromProfile(task.profileSnapshot)),()=>true,{normalFillDone:true,readyCheck:async()=>Boolean(await readFile())});assert.equal(result.ok,true,JSON.stringify(result));await result.candidate?.engine.detach();};
  await prepare();let uploaded=await readFile();assert.equal(uploaded.mime,png?'image/png':image.mime);if(!png)assert.deepEqual(Buffer.from(uploaded.bytes),image.bytes);else{assert.deepEqual(uploaded.bytes.slice(0,8),[137,80,78,71,13,10,26,10]);const dimensions=await frame.locator('#logo').evaluate(async input=>{const bitmap=await createImageBitmap(input.files[0]),result={width:bitmap.width,height:bitmap.height};bitmap.close();return result;});assert.ok(dimensions.width<=8&&dimensions.height<=8);if(image.mime==='image/svg+xml')assert.deepEqual(dimensions,{width:8,height:4});}assert.equal(task.usedMedia[0].sha256,sha(image.bytes));assert.equal(task.usedMedia[0].uploadSha256,sha(Buffer.from(uploaded.bytes)));assert.equal(task.usedMedia[0].transformed,png);assert.equal(task.usedMedia[0].source,'embedded');assert.equal(task.controller,'executor');assert.equal(task.attemptBoundary,undefined);assert.equal(task.receipt,undefined);const firstUpload=Buffer.from(uploaded.bytes);
  store.set('applicationSnapshot',{snapshot:{documents:{siteProfiles:{p:{...profile,logoDataUrl:'',logoUrl:'',fields:{LOGO:''}}}}}});await frame.locator('#logo').setInputFiles([]);await prepare();uploaded=await readFile();assert.deepEqual(Buffer.from(uploaded.bytes),firstUpload);assert.deepEqual(task.profileSnapshot,originalProfile);assert.deepEqual(store.get('run:'+task.runId).profile,originalProfile);assert.equal(task.targetId,target.targetId);cases.push({kind,mode,originalMime:image.mime,uploadMime:uploaded.mime,sha256:sha(Buffer.from(uploaded.bytes)),sameTarget:true,oldEmbeddedTaskFrozen:true,uploadActions:task.aiTakeover.actions});await page.close();
 }
 for(const task of store.values('task:').filter(task=>task.id.startsWith('embedded-')))for(const event of task.agentVisualHistory){assert.equal(event.visualAgent,false);assert.ok(event.visualFallbackReason.includes('Fixture visual service unavailable'));assert.equal(sha(await readFile(event.localScreenshot)),sha(Buffer.from(artifacts.get(event.artifactRef).split(',')[1],'base64')));}
 assert.equal(posts,0);assert.equal(externalRequests,0);assert.equal(fixturePlanCalls,16*kinds.length);assert.equal(fixtureVisionCalls,16*kinds.length);assert.equal(fixtureJudgeCalls,32*kinds.length);assert.equal(screenshotArtifacts,16*kinds.length);assert.equal(store.get('paused'),true);assert.equal(store.get('acceptanceBatch').cursor,13);assert.equal(store.get('task:unknown').attemptBoundary,'original-unknown-boundary');
 console.log(JSON.stringify({ok:true,kind:'isolated_original_embedded_native_upload',actualNativeMainFrameAndIframePaths:true,cases,fixturePlanCalls,fixtureJudgeCalls,fixtureVisionCalls,screenshotArtifacts,realModelCalls:0,posts,externalRequests,productionWrites:0,originalUnknownTaskAndPausedFixedBudgetPreserved:true}));
}finally{store.close();await browser.close();await new Promise(resolve=>server.close(resolve));assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-embedded-upload-'));await rm(home,{recursive:true,force:true});}
