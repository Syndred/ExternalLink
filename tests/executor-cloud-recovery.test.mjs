import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../executor/src/runtime.mjs';
import {Store} from '../executor/src/store.mjs';

test('successful authenticated read clears a recovered transport error without resuming tasks or acknowledging pending events', async () => {
  const store=new Store(':memory:');
  store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one',deviceToken:'test'});
  store.set('paused',true);
  const runtime=new Runtime(store,'.'),originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{throw Object.assign(new Error('fetch failed'),{cause:{code:'ECONNRESET'}});};
    await assert.rejects(runtime.cloud.request('workspace/journal-documents'),error=>error.cloudNetwork);
    assert.match(runtime.status().cloudError,/ECONNRESET/);
    await runtime.synchronize();
    assert.match(runtime.status().cloudError,/ECONNRESET/,'an empty outbox cannot prove the cloud recovered');
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,documents:{siteProfiles:{}},revisions:{siteProfiles:2}})});
    const before=store.pendingCount();
    await runtime.cloud.request('workspace/journal-documents');
    assert.equal(runtime.status().cloudError,'');
    assert.equal(store.get('paused'),true);
    assert.equal(store.pendingCount(),before);
    runtime.cloudError='云端回执回读不一致';
    await runtime.cloud.request('workspace/journal-documents');
    assert.equal(runtime.status().cloudError,'云端回执回读不一致','a successful GET cannot clear a business validation failure');
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test('a paused idle executor rechecks a transient network failure and never resumes submissions',async()=>{
  const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.test',workspaceId:'one'});store.set('paused',true);
  const runtime=new Runtime(store,'.');runtime.hydrated=true;runtime.cloudError='云端连接失败 (ECONNRESET)';runtime.lastCloudNetworkFailure=runtime.cloudError;
  const routes=[];
  Object.defineProperty(runtime,'cloud',{value:{request:async route=>{routes.push(route);runtime.cloudError='';runtime.lastCloudNetworkFailure=null;return{ok:true};}}});
  try {runtime.tick();if(runtime.job)await runtime.job;assert.deepEqual(routes,['workspace/journal-documents']);assert.equal(runtime.status().cloudError,'');assert.equal(store.get('paused'),true);}
  finally{store.close();}
});
