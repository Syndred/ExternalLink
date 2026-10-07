import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {Store} from '../executor/src/store.mjs';
import {originalCommentRequest} from '../executor/src/comment-cache.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const body=source.slice(source.indexOf('async function generateCommentDrafts('),source.indexOf('\nasync function ',source.indexOf('async function generateCommentDrafts(')+1));
const input={pageUrl:'https://article.example/post?original=1',count:3,config:{projectKey:'p',language:'zh',blogRules:{tone:'professional'}}};
function fixture(){const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one',deviceId:'original',storageBackend:'d1'});const runtime={store};return{runtime,store};}

test('comment TTL, refresh, capacity, exact URL, product and count match the frozen original background',async()=>{
 const f=fixture(),realNow=Date.now;let clock=1000000,originalCalls=0,nativeCalls=0;
 const context=vm.createContext({Date:{now:()=>clock},COMMENT_CACHE_TTL_MS:30*60*1000,COMMENT_CACHE_LIMIT:60,commentDraftCache:new Map(),getTargetFilters:()=>({}),callCloudAgent:async()=>({status:'ok',drafts:[{text:'Candidate '+ ++originalCalls}]})});vm.runInContext(body,context);
 const native=message=>originalCommentRequest(f.runtime,message,async()=>({ok:true,status:'ok',drafts:[{text:'Candidate '+ ++nativeCalls}],reason:'',rejected:[]}));
 const check=async message=>{context.message=message;const expected=await vm.runInContext('generateCommentDrafts(message)',context),actual=await native(message);assert.deepEqual(actual,JSON.parse(JSON.stringify(expected)));assert.equal(nativeCalls,originalCalls);};
 Date.now=()=>clock;
 try{
  await check(input);await check(input);clock+=30*60*1000-1;await check(input);clock++;await check(input);await check({...input,refresh:true});await check(input);
  await check({...input,count:1});await check({...input,pageUrl:'https://article.example/post?original=2'});await check({...input,config:{...input.config,projectKey:'q'}});
  for(let i=0;i<60;i++)await check({...input,pageUrl:'https://article.example/capacity/'+i});
  await check(input);
 }finally{Date.now=realNow;f.store.close();}
});

test('failed refresh leaves the successful cache intact, rejected generations are not cached and caller edits do not alter it',async()=>{
 const f=fixture();let calls=0,response={ok:true,status:'ok',drafts:[{text:'Original'}]};const run=refresh=>originalCommentRequest(f.runtime,{...input,refresh},async()=>{calls++;return structuredClone(response);});
 try{const original=await run(false);original.drafts[0].text='Edited';assert.equal((await run(false)).drafts[0].text,'Original');response={ok:false,status:'rejected',drafts:[]};await run(true);assert.equal((await run(false)).drafts[0].text,'Original');assert.equal(calls,2);await originalCommentRequest(f.runtime,{...input,count:1},async()=>{calls++;return response;});await originalCommentRequest(f.runtime,{...input,count:1},async()=>{calls++;return response;});assert.equal(calls,4);}finally{f.store.close();}
});

test('a disabled preference prevents cached replies and effective link and language preferences reach the model',async()=>{
 const f=fixture();let calls=0,payload;
 try{const request=async data=>{calls++;payload=data;return{ok:true,status:'ok',drafts:[{text:'Original'}]};};await originalCommentRequest(f.runtime,{...input,config:{...input.config,aiCommentAllowLink:false}},request);assert.equal(payload.allowLink,false);assert.equal(payload.language,'zh');assert.equal(payload.refresh,undefined);const disabled=await originalCommentRequest(f.runtime,{...input,config:{...input.config,aiComments:false}},request);assert.equal(disabled.status,'disabled');assert.equal(calls,1);}finally{f.store.close();}
});

test('different devices, backends and workspaces cannot reuse or save an old in-flight response',async()=>{
 for(const patch of [{deviceId:'other'},{storageBackend:'neon'},{workspaceId:'other'}]){const f=fixture();try{await assert.rejects(originalCommentRequest(f.runtime,input,async()=>{f.store.set('pair',{...f.store.get('pair'),...patch});return{ok:true,status:'ok',drafts:[{text:'Old response'}]};}),/设备|工作区/);let calls=0;const value=await originalCommentRequest(f.runtime,input,async()=>{calls++;return{ok:true,status:'ok',drafts:[{text:'New response'}]};});assert.equal(value.drafts[0].text,'New response');assert.equal(calls,1);}finally{f.store.close();}}
});

test('the original task bridge reserves model budget only on a miss and carries refresh and language to the provider',async()=>{
 const f=fixture();let calls=0;f.runtime.batchModelRequest=async(task,route,payload)=>{calls++;assert.equal(task.id,'original');assert.equal(route,'ai/comment');assert.equal(payload.language,'zh');return{ok:true,status:'ok',drafts:[{text:'Candidate '+calls}]};};
 try{const task={id:'original'},message={action:'generateCommentDrafts',...input};await Runtime.prototype.bridge.call(f.runtime,task,message);assert.equal((await Runtime.prototype.bridge.call(f.runtime,task,message)).cached,true);await Runtime.prototype.bridge.call(f.runtime,task,{...message,refresh:true});assert.equal(calls,2);}finally{f.store.close();}
});
