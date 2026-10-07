import test from 'node:test';
import assert from 'node:assert/strict';
import Worker from '../cloud/worker/src/index.mjs';
import {aiCloudFixture} from '../executor/test/fixtures/ai-cloud.mjs';
async function setup(run){const f=aiCloudFixture(),realFetch=globalThis.fetch;globalThis.fetch=f.fetch;const call=async(route,token,body,workspace='default')=>{const response=await Worker.fetch(new Request('https://worker.fixture.invalid/v2/executor/'+route+'?workspace='+workspace,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),f.env);return{status:response.status,data:await response.json()};};try{const token=(await call('devices','fixture-admin',{})).data.deviceToken;await run(f,call,token);}finally{globalThis.fetch=realFetch;f.sqlite.close();}}
test('authenticated D1 extraction, generation and article fallback use the original service without changing business documents',()=>setup(async(f,call,token)=>{
 await f.ledger.putDocument('submissionRecords',{original:{evidence:'Original receipt',status:'success'}},0);const before=await f.ledger.document('submissionRecords');
 const extracted=await call('ai/extract-site',token,{url:'https://product.fixture.invalid',language:'zh'});assert.equal(extracted.status,200);assert.equal(extracted.data.source.title,'Original article');assert.equal(extracted.data.profile.fields.Title,'Generated title 1');
 assert.equal((await call('ai/generate-site',token,{profile:{fields:{Url:'https://product.fixture.invalid'}},language:'zh'})).status,200);
 const comment=await call('ai/comment',token,{pageUrl:'https://article.fixture.invalid/post',count:3,language:'zh',allowLink:false});assert.equal(comment.status,200);assert.equal(comment.data.drafts.length,3);assert.equal(f.state.requests.at(-1).allowLink,false);assert.ok(!f.state.requests.at(-1).page.text.includes('hidden script'));
 const reads=f.state.pageReads;assert.equal((await call('ai/comment',token,{pageText:'Original supplied text',count:1})).data.drafts.length,1);assert.equal(f.state.pageReads,reads);assert.equal((await call('ai/domain-metrics',token,{domains:[]})).status,200);
 assert.deepEqual(await f.ledger.document('submissionRecords'),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_runs').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM executor_events').get().n,0);
}));
test('device AI reports the original balance and transient provider errors as classified 503 responses',()=>setup(async(f,call,token)=>{
 for(const status of [402,429]){f.state.status=status;for(const route of ['generate-site','comment']){const result=await call('ai/'+route,token,{profile:{fields:{}},pageText:'Original text'});assert.equal(result.status,503);assert.equal(result.data.code,status===402?'AI_PROVIDER_BALANCE_EXHAUSTED':'AI_PROVIDER_UNAVAILABLE');assert.equal(result.data.retryable,status!==402);}}
}));
test('wrong workspace, admin token and revoked devices cannot invoke the model or read article pages',()=>setup(async(f,call,token)=>{
 const payload={pageUrl:'https://article.fixture.invalid/post'};assert.equal((await call('ai/comment','wrong',payload)).status,401);assert.equal((await call('ai/comment','fixture-admin',payload)).status,401);assert.equal((await call('ai/comment',token,payload,'other')).status,403);
 const device=f.sqlite.prepare('SELECT id FROM executor_devices').get().id;assert.equal((await call('revoke','fixture-admin',{deviceId:device})).status,200);assert.equal((await call('ai/comment',token,payload)).status,401);assert.equal(f.state.modelCalls,0);assert.equal(f.state.pageReads,0);
}));
