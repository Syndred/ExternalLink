import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {AgentBrowserAdapter} from '../executor/src/agent-browser-adapter.mjs';
import {profiles,plain} from '../executor/src/shared.mjs';
import {materializeTaskMedia,materializeTaskUpload} from '../executor/src/task-media.mjs';
import {imageFormatFixtures} from '../executor/test/image-format-fixtures.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(profile){
 const home=await mkdtemp(join(tmpdir(),'el-embedded-task-')),store=new Store(':memory:'),task={id:'original-task',runId:'original-run',profileId:profile.id,profileSnapshot:structuredClone(profile),status:'filling',version:1,controller:'executor'};
 store.set('task:'+task.id,task);store.set('paused',true);store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});const events=[],runtime={home,store,update(t,patch,type){Object.assign(t,patch);store.set('task:'+t.id,t);events.push(type);},bridge:async()=>{throw Error('Unconfigured media bridge');}};
 return{home,store,task,runtime,events,config:plain(profiles.buildAgentConfigFromProfile(profile)),async close(){store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-embedded-task-'));await rm(home,{recursive:true,force:true});}};
}
const originalProfile=image=>({id:'p',name:'Original product',url:'https://product.example',logoUrl:'https://product.example/public-logo.svg',logoDataUrl:image.dataUrl,fields:{Name:'Original product',Url:'https://product.example',LOGO:'https://product.example/public-logo.svg'}});

test('native upload uses the original embedded logo bytes MIME and checksum offline, and clearing current data does not replace an old task image',async()=>{
 for(const image of imageFormatFixtures){const f=await fixture(originalProfile(image)),originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Offline: no remote substitution');};try{
  const before=structuredClone(f.task.profileSnapshot),file=await materializeTaskMedia(f.runtime,f.task,f.config,'logo');assert.deepEqual(await readFile(file),image.bytes);assert.equal(f.task.usedMedia[0].mime,image.mime);assert.equal(f.task.usedMedia[0].source,'embedded');assert.equal(f.task.usedMedia[0].sha256,sha(image.bytes));assert.ok(file.endsWith(image.name.slice(image.name.lastIndexOf('.'))));
  f.store.set('applicationSnapshot',{snapshot:{documents:{siteProfiles:{p:{...before,logoDataUrl:'',logoUrl:'',fields:{...before.fields,LOGO:''}}}}}});await materializeTaskMedia(f.runtime,f.task,f.config,'logo');assert.deepEqual(await readFile(file),image.bytes);assert.deepEqual(f.task.profileSnapshot,before);assert.equal(f.task.attemptBoundary,undefined);assert.equal(f.task.status,'filling');assert.equal(f.store.get('acceptanceBatch').cursor,13);
 }finally{globalThis.fetch=originalFetch;await f.close();}}
});

test('an explicit remote-media bridge request fetches its original URL rather than returning the embedded logo',async()=>{
 const f=await fixture(originalProfile(imageFormatFixtures[0])),originalFetch=globalThis.fetch,remote=imageFormatFixtures[1];let requests=0;globalThis.fetch=async url=>{requests++;assert.equal(String(url),f.config.logoUrl);return new Response(remote.bytes,{headers:{'Content-Type':remote.mime}});};try{
  const result=await Runtime.prototype.bridge.call(f.runtime,f.task,{action:'fetchSubmissionMedia',url:f.config.logoUrl});assert.equal(result.ok,true);assert.equal(result.dataUrl,remote.dataUrl);assert.equal(requests,1);assert.equal(f.task.usedMedia[0].ref,f.config.logoUrl);assert.equal(f.task.usedMedia[0].sha256,sha(remote.bytes));assert.deepEqual(f.task.profileSnapshot,originalProfile(imageFormatFixtures[0]));
 }finally{globalThis.fetch=originalFetch;await f.close();}
});

test('selected cloud logos override old embedded images, disabled media stays disabled, and screenshot alias keeps the original first slot',async()=>{
 const image=imageFormatFixtures[0],profile={...originalProfile(imageFormatFixtures[1]),fields:{Name:'Original product','Cloud LOGO':'cloud-media://selected'},media:{screenshots:['cloud-media://selected']}},f=await fixture(profile);let reads=0;f.store.set('run:'+f.task.runId,{id:f.task.runId,profileId:'p',profile, tasks:[f.task.id],mediaManifest:[{asset_id:'selected',sha256:sha(image.bytes)}]});f.runtime.bridge=async()=>{reads++;return{dataUrl:image.dataUrl};};try{
  assert.equal(f.config.logoDataUrl,'');const file=await materializeTaskMedia(f.runtime,f.task,f.config,'logo');assert.deepEqual(await readFile(file),image.bytes);assert.equal(reads,1);await materializeTaskMedia(f.runtime,f.task,f.config,'screenshot');assert.equal(f.task.usedMedia.find(item=>item.kind==='screenshot1').ref,'cloud-media://selected');
  const before=structuredClone(f.task.usedMedia);for(const kind of ['logo','featured','screenshot1'])await assert.rejects(materializeTaskMedia(f.runtime,f.task,{...f.config,mediaDisabled:{[kind]:true}},kind),/停用/);assert.deepEqual(f.task.usedMedia,before);assert.equal(reads,2);
 }finally{await f.close();}
});

test('changed or malformed embedded data cannot replace the frozen image or record a successful materialization',async()=>{
 const f=await fixture(originalProfile(imageFormatFixtures[0]));try{
  await assert.rejects(materializeTaskMedia(f.runtime,f.task,{...f.config,logoDataUrl:imageFormatFixtures[1].dataUrl},'logo'),/原任务冻结/);const invalid='data:image/png;base64,'+imageFormatFixtures[0].bytes.toString('base64');f.task.profileSnapshot={...f.task.profileSnapshot,logoDataUrl:invalid};await assert.rejects(materializeTaskMedia(f.runtime,f.task,{...f.config,logoDataUrl:invalid},'logo'),/格式与声明/);await assert.rejects(materializeTaskMedia(f.runtime,f.task,f.config,'other'),/类别无效/);assert.equal(f.events.length,0);assert.equal(f.task.usedMedia,undefined);assert.equal(f.task.attemptBoundary,undefined);
 }finally{await f.close();}
});

test('native upload records the transformed file separately from the immutable original bytes and refuses a failed normalizer',async()=>{
 const original=imageFormatFixtures[0],converted=imageFormatFixtures[1],f=await fixture(originalProfile(original));let fail=false;const engine={async call(message){assert.equal(message.action,'normalizeNativeMediaUpload');assert.equal(message.selector,'#logo');assert.equal(message.dataUrl,original.dataUrl);return fail?{ok:false,error:'原图片上传控件已变化'}:{ok:true,dataUrl:converted.dataUrl};}};try{
  const file=await materializeTaskUpload(f.runtime,f.task,f.config,'logo',engine,'#logo');assert.deepEqual(await readFile(file),converted.bytes);assert.equal(f.task.usedMedia[0].sha256,sha(original.bytes));assert.equal(f.task.usedMedia[0].mime,original.mime);assert.equal(f.task.usedMedia[0].uploadSha256,sha(converted.bytes));assert.equal(f.task.usedMedia[0].uploadMime,converted.mime);assert.equal(f.task.usedMedia[0].transformed,true);const prepared=f.events.filter(event=>event==='media_upload_prepared').length;fail=true;await assert.rejects(materializeTaskUpload(f.runtime,f.task,f.config,'logo',engine,'#logo'),/控件已变化/);assert.equal(f.events.filter(event=>event==='media_upload_prepared').length,prepared);assert.equal(f.task.attemptBoundary,undefined);assert.equal(f.store.get('paused'),true);
 }finally{await f.close();}
});

test('the native CLI rechecks the original target after asynchronous image conversion and never uploads into a changed tab',async()=>{
 let checks=0,commands=0;const adapter={async assertTarget(){checks++;if(checks===2)throw Error('接管原页身份变化');},async upload(kind,selector){assert.equal(kind,'logo');assert.equal(selector,'#logo');return 'original-file.png';},async command(){commands++;}};await assert.rejects(AgentBrowserAdapter.prototype.act.call(adapter,{type:'upload',selector:'#logo',mediaKind:'logo'}),/原页身份变化/);assert.equal(checks,2);assert.equal(commands,0);
});
