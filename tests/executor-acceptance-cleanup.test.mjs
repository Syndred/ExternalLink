import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../executor/src/store.mjs';import {closeAcceptanceTask} from '../executor/src/acceptance-cleanup.mjs';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('fixed blocker cleanup persists recovery evidence before closing only registered task pages',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-cleanup-')),screenshot=join(home,'page.png');await writeFile(screenshot,'fixture evidence');const store=new Store(':memory:');
 store.set('acceptance:fixed',{combinations:[{identity:'site::p',existingTaskId:'t'}]});const task={id:'t',url:'https://site.example/submit',acceptanceId:'fixed',targetId:'owned',browserInstance:'browser',status:'needs_manual',attentionType:'human_verification',screenshot};store.set('task:t',task);
 const closed=[];const page=id=>({isClosed:()=>false,url:()=>id==='owned'?'https://site.example/submit':'https://other.example',async close(){assert.ok(store.get('task:t').recoveryCheckpoint.screenshotSha256);closed.push(id);}});const owned=page('owned'),other=page('other');
 const runtime={store,host:{startedAt:'browser'},findPage:async()=>owned,update(t,p){Object.assign(t,p);store.set('task:'+t.id,t);},context:{pages:()=>[owned,other],async newCDPSession(p){return{send:async()=>({targetInfo:{targetId:p===owned?'owned':'other'}}),detach:async()=>{}};}}};
 try{await closeAcceptanceTask(runtime,task);assert.deepEqual(closed,['owned']);assert.equal(task.recoveryCheckpoint.stage,'human_verification');assert.ok(task.tabClosedAt);}finally{store.close();await rm(home,{recursive:true,force:true});}
});
test('unknown submission retains its original page even when cleanup is requested',async()=>{
 await closeAcceptanceTask({findPage(){throw Error('must not close');}},{acceptanceId:'fixed',targetId:'t',attemptBoundary:'sent',status:'submitted_unconfirmed'});
});
