import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {originalManualTaskPage} from './helpers/original-manual-task-page.mjs';

const source=process.env.MANUAL_CARD_BEFORE==='1'?execFileSync('git',['show','07cc817:executor/web/application.js'],{encoding:'utf8'}):readFileSync(new URL('../executor/web/application.js',import.meta.url),'utf8');
const start=source.indexOf('function appendManualControls('),body=source.slice(start,source.indexOf('\nasync function showBatchLog',start));
function nativeCard(task,{stopped=false,failOpen=false}={}){
 const calls=[],controls=[],checks=[],panel={append(...items){controls.push(...items);},replaceChildren(...items){controls.splice(0,controls.length,...items);}},context=vm.createContext({URL,task,panel,data:{executionStopped:stopped,manualSkipRequests:[]},
  el:(tag,attrs,children)=>({tag,...attrs,children}),button:(label,handler,primary)=>({label,handler,primary}),checkControl:(label,value,change)=>{const check={label,value,change};checks.push(check);return check;},
  request:async(route,input)=>{calls.push({route,...input});if(route==='/openManualTaskPage'&&failOpen)throw Error('原页签已关闭');return{ok:true};},detail:{close(){calls.push({closed:true});}},load:async()=>{}});
 vm.runInContext(body+'\nappendManualControls(panel,task)',context);
 return{calls,controls,checks};
}
const base={id:'t',runId:'r',profileId:'p',targetId:'target',status:'needs_manual',url:'https://www.producthunt.com/posts/new'};
const readyReason='Product Hunt 必填 100%，等待确认 Create draft';
test('native manual card matches original creation, confirmation, stopped and no-tab branches',async()=>{
 for(const scenario of [{name:'ready',ready:true},{name:'ready stopped',ready:true,stopped:true},{name:'ready without tab',ready:true,noTab:true},{name:'ordinary',ready:false},{name:'ordinary stopped',ready:false,stopped:true},{name:'unknown receipt',ready:false,attempt:true},{name:'non Product Hunt',ready:false,ordinary:true}]){
  const original=await originalManualTaskPage({tabId:scenario.noTab?null:7,parkedReason:scenario.ready?readyReason:'等待人工处理'},{stopped:scenario.stopped});
  const task={...base,...(scenario.noTab?{targetId:null}:{}),...(scenario.attempt?{attemptBoundary:'original-attempt',status:'submitted_unconfirmed'}:{}),...(scenario.ordinary?{url:'https://other.example/'}:{}),productHunt:{readyToCreate:scenario.ready||scenario.attempt}};
  const current=nativeCard(task,{stopped:scenario.stopped}),labels=current.controls.map(c=>c.label).filter(Boolean);
  assert.equal(labels.includes('人工确认成功'),original.labels.includes('确认成功'),scenario.name);
  assert.equal(labels.includes('确认创建 Product Hunt 草稿'),original.labels.includes('确认创建 Product Hunt 草稿'),scenario.name);
  assert.equal(current.calls.length,0);
 }
});
test('creation and ordinary continuation focus the original page before dispatch, with unchanged task identity',async()=>{
 for(const ready of [false,true]){
  const task={...base,productHunt:{readyToCreate:ready}},f=nativeCard(task),button=f.controls.find(c=>c.label===(ready?'确认创建 Product Hunt 草稿':'人工继续原任务'));button.handler();f.checks[0].change(true);
  await f.controls.find(c=>c.label===(ready?'确认创建 Product Hunt 草稿':'确认继续原任务')).handler();
  assert.deepEqual(f.calls.map(c=>c.route||'close'),['/openManualTaskPage','/manualSubmit','close']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{route:'/openManualTaskPage',taskId:'t',expectedRunId:'r',expectedTargetId:'target'});
  assert.equal(f.calls[1].confirmProductHuntCreate,ready);assert.equal(f.calls[1].ordinaryPermissionsAuthorized,true);
 }
});
test('closed page cannot continue and unchecked consent cannot focus the page',async()=>{
 const f=nativeCard(base,{failOpen:true});f.controls.find(c=>c.label==='人工继续原任务').handler();f.checks[0].change(true);await assert.rejects(f.controls.find(c=>c.label==='确认继续原任务').handler(),/原页签已关闭/);assert.deepEqual(f.calls.map(c=>c.route),['/openManualTaskPage']);
 const unchecked=nativeCard(base);unchecked.controls.find(c=>c.label==='人工继续原任务').handler();await unchecked.controls.find(c=>c.label==='确认继续原任务').handler();assert.equal(unchecked.calls.some(c=>c.route==='/openManualTaskPage'),false);assert.equal(unchecked.calls[0].ordinaryPermissionsAuthorized,false);
});
test('pending manual receipt synchronization remains accessible despite stale creation metadata',()=>{
 const f=nativeCard({...base,productHunt:{readyToCreate:true},receipt:{confirmedBy:'manual'},manualConfirmation:{status:'pending_sync'}});assert.equal(f.controls.some(c=>c.label==='继续同步人工确认'),true);assert.equal(f.controls.some(c=>c.label==='确认创建 Product Hunt 草稿'),false);
});
