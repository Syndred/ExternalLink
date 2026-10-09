import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {Runtime} from '../src/runtime.mjs';
import {Store} from '../src/store.mjs';
import {workbenchScope} from '../src/workbench-sync.mjs';
import {saveAssistantSettings,stopBrowserAssistant} from '../src/browser-assistant.mjs';
import {originalManualIconClick} from '../../tests/helpers/original-manual-icon-lifecycle.mjs';

const logoDataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
let posts=0,comments=0,externalRequests=0;
const server=http.createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(req.url==='/article'?'<title>Article with comments</title><article>'+('A detailed guide to directory submissions, useful feedback, software features, publication evidence and product research. '.repeat(10))+'</article><form id="commentform" method="POST" action="/comment"><h2>Leave a comment</h2><label>Name<input name="author" id="author"></label><label>Email<input name="email" id="email" type="email"></label><label>Website<input name="url" id="url" type="url"></label><label>Comment<textarea id="comment" name="comment"></textarea></label><button type="submit">Post comment</button></form>':'<title>Submit product</title><h1>Submit a product</h1><form method="POST"><label>Product name<input name="product_name"></label><label>Website<input name="website" type="url"></label><label>Pricing type<select name="pricing_type" style="width:200px;height:30px"><option value="">Choose pricing</option><option value="free">Free</option><option value="paid">Paid</option></select></label><label>Logo<input name="logo" type="file"></label><label>Unmapped extra<input name="unmapped_extra" value="Keep existing input"></label><button type="submit">Submit product</button></form>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']}),context=await browser.newContext(),store=new Store(':memory:'),runtime=new Runtime(store,'unused-manual-branch-fixture');
try{
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('http://127.0.0.1:')||url.startsWith('data:'))return route.continue();externalRequests++;return route.abort();});
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'manual-branches'});store.set('paused',true);
 const snapshot={documents:{siteProfiles:{p:{id:'p',name:'First Product',fields:{Name:'First Product',Url:'https://first.example','PRICING TYPE':'Free',LOGO:'(uploaded logo)'},logoDataUrl}},siteAnnotations:{},submissionRecords:{kept:{status:'success',evidence:'original receipt'}},autoFillOnVisit:false,targetFilters:{showManualFillIcons:true}},revisions:{siteProfiles:2}};
 store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot});runtime.context=context;runtime.host={startedAt:'fixture-browser'};
 Object.defineProperty(runtime,'cloud',{value:{async request(route,input){if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'ai/comment');assert.equal(input.config.projectKey,'p');assert.ok(input.pageText.length>=120);comments++;return{ok:true,status:'ok',drafts:[{text:'Controlled original comment',angle:'Advice',anchorText:'',placement:'body'}]};}}});
 const page=await context.newPage();page.setDefaultTimeout(7000);const base='http://127.0.0.1:'+server.address().port;await page.goto(base+'/directory');await saveAssistantSettings(runtime,{enabled:true,autoFillOnVisit:false,profileId:'p'});
 await page.waitForFunction(()=>document.querySelectorAll('.extlink-manual-icon').length===5,null,{timeout:7000}).catch(async error=>{throw Error(JSON.stringify({error:runtime.browserAssistantError,icons:await page.locator('.extlink-manual-icon').count(),frames:runtime.browserAssistantFrames?.size})+' '+error.message);});
 const results=[];
 for(const[kind,name,value]of [['select','pricing_type','free'],['file','logo',logoDataUrl],['unmapped','unmapped_extra',''],['comment','comment','Controlled original comment']]){
  if(kind==='comment'){await page.goto(base+'/article');await saveAssistantSettings(runtime,{enabled:true,autoFillOnVisit:false,profileId:'p'});await page.waitForFunction(()=>document.querySelectorAll('.extlink-manual-icon').length===4,null,{timeout:7000});}
  const reference=await originalManualIconClick(kind,value);
  await page.locator('[name='+name+']').evaluate(field=>{const rect=field.getBoundingClientRect();const icon=Array.from(document.querySelectorAll('.extlink-manual-icon')).find(icon=>Math.abs(parseFloat(icon.style.top)-(window.scrollY+rect.top+4))<1&&Math.abs(parseFloat(icon.style.left)-(window.scrollX+rect.right-24))<1);assertIcon(icon);function assertIcon(icon){if(!icon)throw Error('No icon for '+field.name);}icon.setAttribute('data-fixture-role',field.name);});
  await page.locator('[data-fixture-role='+name+']').click();
  await page.waitForFunction(([name,state])=>document.querySelector('[data-fixture-role='+name+']').dataset.state===state,[name,reference.state],{timeout:7000}).catch(async error=>{throw Error(kind+': '+JSON.stringify(await page.locator('[data-fixture-role='+name+']').evaluate(icon=>({state:icon.dataset.state,title:icon.title})))+' '+error.message);});
  const actual=await page.locator('[name='+name+']').evaluate(field=>{const icon=document.querySelector('[data-fixture-role='+field.name+']');return{value:field.type==='file'?'':field.value,state:icon.dataset.state,title:icon.title};});
  assert.equal(actual.value,reference.value,kind);assert.equal(actual.title,reference.title,kind);
  if(kind==='file'){const bytes=Buffer.from(await page.locator('[name=logo]').evaluate(async field=>Array.from(new Uint8Array(await field.files[0].arrayBuffer()))));assert.deepEqual(bytes,Buffer.from(logoDataUrl.split(',')[1],'base64'));results.push({kind,exactUploadedSha256:createHash('sha256').update(bytes).digest('hex')});}else results.push({kind,completeOriginalHandlerResultMatched:true});
 }
 await page.goto(base+'/directory');await saveAssistantSettings(runtime,{enabled:true,autoFillOnVisit:false,profileId:'p'});await page.waitForFunction(()=>document.querySelectorAll('.extlink-manual-icon').length===5,null,{timeout:7000});
 const negative=[];
 for(const[kind,name,options]of [['select','pricing_type',{}],['file','logo',{fileOk:false}],['unmapped','unmapped_extra',{missingConfig:true}]]){
  if(kind==='select')await page.locator('[name=pricing_type]').evaluate(field=>{for(const option of Array.from(field.options))if(option.value)option.remove();});
  if(kind==='file'){snapshot.documents.siteProfiles.p.logoDataUrl='';snapshot.documents.siteProfiles.p.fields.LOGO='';store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot});}
  if(options.missingConfig){delete snapshot.documents.siteProfiles.p;store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot});}
  const reference=await originalManualIconClick(kind,'',options);
  await page.locator('[name='+name+']').evaluate(field=>{const rect=field.getBoundingClientRect();const icon=Array.from(document.querySelectorAll('.extlink-manual-icon')).find(icon=>Math.abs(parseFloat(icon.style.top)-(window.scrollY+rect.top+4))<1&&Math.abs(parseFloat(icon.style.left)-(window.scrollX+rect.right-24))<1);if(!icon)throw Error('Missing negative fixture icon');icon.setAttribute('data-fixture-role',field.name);});
  await page.locator('[data-fixture-role='+name+']').click();await page.waitForFunction(name=>document.querySelector('[data-fixture-role='+name+']').dataset.state==='empty',name,{timeout:7000});
  const actual=await page.locator('[name='+name+']').evaluate(field=>{const icon=document.querySelector('[data-fixture-role='+field.name+']');return{value:field.type==='file'?'':field.value,state:icon.dataset.state,title:icon.title};});
  assert.deepEqual(actual,{value:reference.value,state:reference.state,title:reference.title});
  if(kind==='file')assert.equal(await page.locator('[name=logo]').evaluate(field=>field.files.length),0);
  negative.push({kind:options.missingConfig?'missing_profile':kind==='file'?'missing_image':'no_matching_option',completeOriginalHandlerResultMatched:true});
 }
 assert.equal(comments,1);assert.equal(posts,0);assert.equal(externalRequests,0);assert.equal(store.get('paused'),true);assert.equal(store.values('task:').length,0);assert.deepEqual(store.get('applicationSnapshot').snapshot.documents.submissionRecords,snapshot.documents.submissionRecords);
 console.log(JSON.stringify({ok:true,kind:'isolated_actual_manual_icon_branch_evidence',results,negative,completeOriginalHandlerExecuted:true,originalHelperDependenciesStubbed:true,controlledCommentRequests:comments,realModelCalls:0,posts,externalRequests,productionWrites:0,receiptsPreserved:true,paused:true}));
}finally{await stopBrowserAssistant(runtime);store.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
