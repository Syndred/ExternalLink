import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';import {manualWatchMessage,checkManualWatches} from '../executor/src/manual-watch.mjs';
test('manual observation requires the prepared original task, token and frame baseline, and preserves an unknown click across network failure',async()=>{
 const store=new Store(':memory:'),frame={url:()=> 'https://target.example/form'},page={url:()=>frame.url(),frames:()=>[frame],mainFrame:()=>frame};
 const task={id:'original',profileId:'p',url:frame.url(),targetId:'tab',browserInstance:'host',status:'pending',profileSnapshot:{fields:{Name:'Product',Url:'https://product.example'}}};
 const runtime={store,findPage:async()=>page,cloud:{request:async()=>({documents:{submissionRecords:{}}}),flush:async()=>{throw Error('lost response');}},lease:async()=>{},update(t,patch,type){Object.assign(t,patch);store.transition(t,type);}};
 const input={taskId:task.id,targetId:task.targetId,pageUrl:page.url(),frameUrl:frame.url(),documentId:1};
 try{
  store.set('paused',true);store.set('task:original',task);assert.equal((await manualWatchMessage(runtime,{...input,action:'manualSubmissionWatchRequest'})).ok,false);
  task.preparedAt=new Date().toISOString();store.set('task:original',task);const issued=await manualWatchMessage(runtime,{...input,action:'manualSubmissionWatchRequest'});assert.equal(issued.ok,true);const token=issued.watch.token;
  assert.equal((await manualWatchMessage(runtime,{...input,action:'manualSubmissionClicked',token})).ok,false);assert.equal(store.get('task:original').attemptBoundary,undefined);
  await manualWatchMessage(runtime,{...input,action:'manualSubmissionWatchReady',token,baseline:{evidence:'Existing confirmation'}});
  assert.equal((await manualWatchMessage(runtime,{...input,action:'manualSubmissionClicked',token:'wrong'})).ok,false);
  assert.equal((await manualWatchMessage(runtime,{...input,action:'manualSubmissionClicked',token})).ok,true);const original=store.get('task:original');assert.ok(original.attemptBoundary);assert.equal(original.receipt,undefined);assert.equal(store.pendingCount(),1);assert.equal(store.get('manualWatch:original').syncError,'lost response');
  assert.equal((await manualWatchMessage(runtime,{...input,action:'manualSubmissionClicked',token})).ok,false);assert.equal(store.get('task:original').attemptBoundary,original.attemptBoundary);
  runtime.findPage=async()=>{throw Error('original tab closed');};await checkManualWatches(runtime);assert.equal(store.get('task:original').receipt,undefined);assert.equal(store.get('manualWatch:original').error,'original tab closed');
 }finally{store.close();}
});
