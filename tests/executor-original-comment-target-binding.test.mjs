import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {fillCommentDraft} from '../executor/src/workbench-features.mjs';

for(const [label,sourceTarget,taskTarget,expected]of [
 ['another same-URL tab','source-tab','original-tab',/评论网页与原任务页面不一致/],
 ['missing original target','source-tab',undefined,/评论网页与原任务页面不一致/],
 ['matching original target','original-tab','original-tab',/fixture original page lookup/],
 ['legacy draft without a selected tab',undefined,'original-tab',/fixture original page lookup/],
])test('comment fill target ownership: '+label,async()=>{
 const store=new Store(':memory:');store.set('paused',true);
 const task={id:'original',profileId:'p',...(taskTarget?{targetId:taskTarget}:{}),url:'https://article.fixture.invalid/same',status:'pending'};store.set('task:original',task);
 let lookedUp=0,leased=0,cloudReads=0;
 const runtime={store,context:{},findPage:async()=>{lookedUp++;throw Error('fixture original page lookup');},lease:async()=>{leased++;},cloud:{request:async()=>{cloudReads++;throw Error('unexpected cloud request');}}};
 try{await assert.rejects(fillCommentDraft(runtime,{taskId:task.id,profileId:'p',pageUrl:task.url,targetId:sourceTarget,text:'Original raw comment'}),expected);assert.equal(lookedUp,label.startsWith('another')||label.startsWith('missing')?0:1);assert.equal(leased+cloudReads,0);assert.deepEqual(store.get('task:original'),task);assert.equal(store.pendingCount(),0);}finally{store.close();}
});
