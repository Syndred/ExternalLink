import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../executor/src/store.mjs';
import { runPreparationTakeover } from '../executor/src/auto-takeover.mjs';
import { restrictPreparationActions } from '../core/takeover-policy.mjs';

const snapshot={url:'https://directory.example/submit',domHash:'a',fields:[{selector:'#name',type:'text',visible:true}],buttons:[{selector:'#next',text:'Next',visible:true},{selector:'#submit',text:'Submit product',type:'submit',visible:true}],widgets:[]};
test('preparation permits observed fill and forward steps, rejects final submission, hidden and arbitrary selectors',()=>{
  const actions=restrictPreparationActions([{type:'fill',selector:'#name',value:'Product'},{type:'click',selector:'#next'},{type:'click',selector:'#submit'},{type:'fill',selector:'#unknown',value:'x'},{type:'fill',selector:'#name',value:'x; arbitrary command'}],snapshot);
  assert.equal(actions.length,3);
  assert.equal(actions[1].selector,'#next');
  assert.equal(restrictPreparationActions([{type:'fill',selector:'#password',value:'secret'}],{...snapshot,fields:[{selector:'#password',type:'password',visible:true}]}).length,0);
});
test('observed free entry links and duplicated Next captions may advance but paid or final forms remain blocked',()=>{
 const page={url:'https://neeed.directory/submit',fields:[],buttons:[
  {selector:'#free',text:'Continue with Free Continue with Free',type:'link',href:'https://neeed.directory/submit?plan=free',visible:true},
  {selector:'#next',text:'Next Next',type:'button',visible:true},
  {selector:'#paid',text:'Continue with Premium for $19',type:'link',href:'https://neeed.directory/checkout',visible:true},
  {selector:'#final',text:'Next',type:'submit',visible:true}]};
 const actions=restrictPreparationActions(page.buttons.map(button=>({type:'click',selector:button.selector})),page);
 assert.deepEqual(actions.map(action=>action.selector),['#free','#next']);
});
test('file upload uses an observed hidden file input and a product media kind without opening a native picker',()=>{
 const page={url:snapshot.url,fields:[{selector:'#file',type:'file',visible:false,name:'logo'}]};
 assert.equal(restrictPreparationActions([{type:'upload',selector:'#file',mediaKind:'logo'}],page).length,1);
 assert.equal(restrictPreparationActions([{type:'fill',selector:'#file',value:'C:/private/token.json'}],page).length,0);
 assert.equal(restrictPreparationActions([{type:'upload',selector:'#file',mediaKind:'C:/private/token.json'}],page).length,0);
});
test('observed custom dropdown buttons may open their listbox without authorizing arbitrary buttons',()=>{
 const page={url:snapshot.url,widgets:[{selector:'#category',role:'button',label:'Choose Category',popup:'listbox',expanded:'false'}],buttons:[{selector:'#unknown',text:'Do something',type:'button'}]};
 assert.deepEqual(restrictPreparationActions([{type:'click',selector:'#category'},{type:'click',selector:'#unknown'}],page).map(a=>a.selector),['#category']);
});
test('read-only verification may confirm a prepared form after the AI budget is exhausted without more model calls',async()=>{
 const store=new Store(':memory:');const task={id:'t',controller:'executor',aiTakeover:{id:'old',actions:20,calls:10,history:[]}};
 const runtime={store,update(t,p,type){Object.assign(t,p);store.transition(t,type);},lease:async()=>{}};
 const result=await runPreparationTakeover(runtime,{task,observe:async()=>snapshot,ready:async()=>true,plan:async()=>{throw Error('budget must not reset');},act:async()=>{throw Error('no new actions');}});
 assert.equal(result.ok,true);assert.equal(task.aiTakeover.calls,10);assert.equal(task.aiTakeover.actions,20);store.close();
});
test('background AI caps actions, changes strategy after two stale observations and returns control to same task',async()=>{
  const store=new Store(':memory:');const task={id:'t',version:1,controller:'executor',status:'filling',url:snapshot.url};store.set('task:t',task);
  const events=[],strategies=[];let actions=0;
  const runtime={store,controllerId:'owner',update(t,patch,type){Object.assign(t,patch);events.push(type);store.transition(t,type);},lease:async()=>{}};
  const result=await runPreparationTakeover(runtime,{task,observe:async()=>snapshot,plan:async state=>{strategies.push(state.strategy);return{status:'act',actions:Array.from({length:4},()=>({type:'fill',selector:'#name',value:'Product'}))};},act:async()=>{actions++;},ready:async()=>false});
  assert.equal(actions,20);assert.equal(result.reason,'action_limit');assert.equal(task.controller,'executor');
  assert.ok(strategies.includes('alternative'));assert.equal(task.aiTakeover.actions,20);assert.equal(events[0],'ai_takeover_started');assert.equal(events.at(-1),'ai_takeover_returned');store.close();
});
test('unknown submission outcomes are verification only and never start AI preparation',async()=>{
  const store=new Store(':memory:');const task={id:'t',attemptBoundary:'already clicked'};
  await assert.rejects(runPreparationTakeover({store},{task,observe:()=>{throw Error('must not observe');}}),/先核验/);store.close();
});
test('a restarted takeover retains the original budget and cannot reset model or action limits',async()=>{
 const store=new Store(':memory:');const task={id:'t',version:1,controller:'executor',aiTakeover:{id:'original',startedAt:'before-restart',actions:19,calls:9,strategy:'alternative',history:[]}};
 const runtime={store,update(t,p,type){Object.assign(t,p);store.transition(t,type);},lease:async()=>{}};let calls=0,actions=0;
 await runPreparationTakeover(runtime,{task,observe:async()=>snapshot,ready:async()=>false,plan:async()=>{calls++;return{status:'act',actions:[{type:'fill',selector:'#name',value:'Product'},{type:'fill',selector:'#name',value:'Again'}]};},act:async()=>{actions++;}});
 assert.equal(calls,1);assert.equal(actions,1);assert.equal(task.aiTakeover.calls,10);assert.equal(task.aiTakeover.actions,20);assert.equal(task.aiTakeover.startedAt,'before-restart');store.close();
});
test('AI failure and interruption persist reason and release control without replacing the page',async()=>{
  const store=new Store(':memory:');const task={id:'t',version:1,controller:'executor',status:'filling',url:snapshot.url};
  const runtime={store,controllerId:'owner',update(t,p,type){Object.assign(t,p);store.transition(t,type);},lease:async()=>{}};
  const result=await runPreparationTakeover(runtime,{task,observe:async()=>snapshot,plan:async()=>{throw Error('model unavailable');},act:async()=>{throw Error('must not act');},ready:async()=>false});
  assert.equal(result.ok,false);assert.match(task.aiTakeover.reason,/model unavailable/);assert.equal(task.controller,'executor');assert.equal(task.aiTakeover.calls,1);store.close();
});
