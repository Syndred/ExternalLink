import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../executor/src/store.mjs';
import {openManualTaskPage} from '../executor/src/manual-task-page.mjs';
import {originalManualTaskPage} from './helpers/original-manual-task-page.mjs';

function fixture(overrides={}){
 const store=new Store(':memory:'),task={id:'t',runId:'r',profileId:'p',url:'https://original.example/todo',targetId:'target',browserInstance:'browser',status:'needs_manual',...overrides};
 store.set('pair',{endpoint:'https://cloud.invalid',workspaceId:'original'});store.set('paused',true);store.set('task:t',task);
 const calls=[],page={isClosed:()=>false,url:()=>task.url,async bringToFront(){calls.push({kind:'focus'});}},runtime={store,host:{startedAt:'browser'},context:{pages:()=>[page],async newCDPSession(){await runtime.beforeTarget?.();return{async send(){return{targetInfo:{targetId:'target'}};},async detach(){}};}},tick(){throw Error('Unexpected execution');}};
 return{store,task,calls,runtime,input:{taskId:'t',expectedRunId:'r',expectedTargetId:task.targetId||''}};
}
test('frozen original opens existing and stopped tabs without resume; missing tab opens an ordinary URL only',async()=>{
 for(const stopped of [false,true]){const result=await originalManualTaskPage({id:'t',runId:'r',tabId:42,url:'https://original.example'},{stopped,label:stopped?'打开页签':'查看原页面'});assert.deepEqual(result.calls,[{kind:'focus',id:42,active:true}]);}
 const created=await originalManualTaskPage({id:'t',url:'https://original.example'},{label:'打开待办页面'});assert.deepEqual(created.calls[0],{kind:'create',url:'https://original.example/',active:true,windowId:73});assert.equal(created.calls.some(c=>c.kind==='message'),false);
 const closed=await originalManualTaskPage({tabId:42,url:'https://original.example'},{label:'查看原页面',closed:true});assert.equal(closed.calls[0].error,true);assert.equal(closed.calls.some(c=>c.kind==='create'),false);
});
test('native viewing preserves unknown receipt, stopped state, transferred page and all task data',async()=>{
 for(const extra of [{},{attemptBoundary:'original-attempt',status:'submitted_unconfirmed'},{receipt:{evidence:'original receipt'}},{originalGroupAdvance:{status:'transferred',targetId:'target'}}]){
  const f=fixture(extra);try{f.store.set('executionStopped',{id:'original-stop'});const before=f.store.get('task:t');const result=await openManualTaskPage(f.runtime,f.input);assert.equal(result.mode,'original');assert.deepEqual(f.calls,[{kind:'focus'}]);assert.deepEqual(f.store.get('task:t'),before);assert.equal(f.store.get('paused'),true);assert.deepEqual(f.store.get('executionStopped'),{id:'original-stop'});assert.equal(f.store.pendingCount(),0);}finally{f.store.close();}
 }
});
test('stale task, scope, browser and closed targets cannot fall back to creating a page',async()=>{
 for(const mutate of [f=>f.input.expectedRunId='changed',f=>f.input.expectedTargetId='',f=>f.runtime.host.startedAt='new',f=>f.runtime.context.pages=()=>[],f=>f.store.set('task:t',{...f.task,tabClosedAt:'closed'}),f=>f.runtime.beforeTarget=async()=>f.store.set('pair',{endpoint:'https://other.invalid'}),f=>f.runtime.beforeTarget=async()=>f.store.set('task:t',{...f.task,targetId:'changed'})]){
  const f=fixture();try{mutate(f);await assert.rejects(()=>openManualTaskPage(f.runtime,f.input));assert.deepEqual(f.calls,[]);assert.equal(f.store.pendingCount(),0);}finally{f.store.close();}
 }
});
test('invalid or protected pending URLs fail before browser connection',async()=>{
 for(const url of ['javascript:alert(1)','chrome://settings','file:///secret','not a url']){const f=fixture({targetId:null,url});try{f.runtime.context=null;f.runtime.connect=()=>{throw Error('Connection must not occur');};await assert.rejects(()=>openManualTaskPage(f.runtime,f.input),/无法打开/);}finally{f.store.close();}}
});
test('actual workbench task buttons focus or open native Chrome without changing original task or execution state',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../executor/test/original-manual-task-page.mjs',import.meta.url))],{encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024,windowsHide:true});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr+'\n'+(result.error?.message||''));
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(proof.ok,true);assert.equal(proof.originalStateUnchanged,true);assert.equal(proof.realSubmissions,0);
});
