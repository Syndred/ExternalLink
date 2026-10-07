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

test('original form planning, visual planning, judging and field validation use authenticated device routes and original handlers',()=>setup(async(f,call,token)=>{
 await f.ledger.putDocument('siteProfiles',{p:{fields:{Name:'Frozen original',Url:'https://product.fixture.invalid'}}},0);
 await f.ledger.putDocument('siteAnnotations',{original:{note:'Keep manual mark',library:{favorite:true,groups:['original']}}},0);
 await f.ledger.putDocument('submissionRecords',{original:{status:'success',evidence:'Keep original receipt'}},0);
 const before=await f.ledger.revisions(),documents=await Promise.all(['siteProfiles','siteAnnotations','submissionRecords'].map(key=>f.ledger.document(key)));
 const payload={task:{projectKey:'p'},snapshot:{url:'https://directory.fixture.invalid',fields:[{selector:'#original'}]},config:{projectKey:'p',brandName:'Frozen original'},fillOnly:true};
 f.state.modelResult={status:'act',reason:'Original field meaning',actions:[{type:'fill',selector:'#original',value:'Frozen original'},{type:'submit'}]};
 const plan=await call('ai/plan',token,payload);assert.equal(plan.status,200);assert.deepEqual(plan.data.actions,[{type:'fill',selector:'#original',value:'Frozen original'}]);assert.equal(f.state.requests.at(-1).config.brandName,'Frozen original');
 f.state.modelResult={status:'act',stage:'original-custom-widget',actions:[{type:'click',selector:'#original'},{type:'fill',selector:'#original',value:'Late value'},{type:'fill',selector:'#unknown',value:'No'}]};
 const visual=await call('ai/vision-plan',token,{...payload,screenshot:'data:image/png;base64,aW1hZ2U=',elements:[{selector:'#original',label:'Choose category'}],viewport:{width:800,height:600}});assert.equal(visual.status,200);assert.equal(visual.data.actions.length,1);assert.equal(visual.data.actions[0].selector,'#original');assert.equal(f.state.requests.at(-1).config.projectKey,'p');
 f.state.modelResult={status:'incomplete',reason:'No visible receipt'};const judge=await call('ai/judge',token,{snapshot:payload.snapshot});assert.equal(judge.status,200);assert.equal(judge.data.status,'incomplete');
 f.state.modelResult={status:'revise',submitReady:false,fields:[{selector:'#original',value:'Correct original value',reason:'word limit'}],issues:['Required field incomplete']};
 const validation=await call('ai/validate-fill',token,{...payload,filledFields:[{selector:'#original',value:'Too long',constraints:{maxLength:22}}]});assert.equal(validation.status,200);assert.equal(validation.data.submitReady,false);assert.equal(validation.data.fields[0].value,'Correct original value');assert.equal(f.state.requests.at(-1).filledFields[0].constraints.maxLength,22);
 const calls=f.state.modelCalls;assert.equal((await call('ai/plan',token,{...payload,mode:'prepare_takeover'})).status,403);assert.equal(f.state.modelCalls,calls,'general fill planning cannot bypass the leased task takeover endpoint');
 assert.deepEqual(await f.ledger.revisions(),before);assert.deepEqual(await Promise.all(['siteProfiles','siteAnnotations','submissionRecords'].map(key=>f.ledger.document(key))),documents);for(const table of ['executor_runs','executor_events','executor_controls'])assert.equal(f.sqlite.prepare('SELECT count(*) n FROM '+table).get().n,0);assert.equal(f.state.pageReads,0);
}));

test('all restored form AI routes reject wrong scopes and revoked devices before models, and preserve provider error classification',()=>setup(async(f,call,token)=>{
 const payload={snapshot:{},config:{},screenshot:'data:image/png;base64,aW1hZ2U=',elements:[],viewport:{width:800,height:600}};
 for(const route of ['plan','vision-plan','judge','validate-fill']){for(const denied of ['wrong','fixture-admin'])assert.equal((await call('ai/'+route,denied,payload)).status,401);assert.equal((await call('ai/'+route,token,payload,'other')).status,403);}assert.equal(f.state.modelCalls,0);
 for(const status of [402,429]){f.state.status=status;for(const route of ['plan','vision-plan','judge','validate-fill']){const result=await call('ai/'+route,token,payload);assert.equal(result.status,503);assert.equal(result.data.code,status===402?'AI_PROVIDER_BALANCE_EXHAUSTED':'AI_PROVIDER_UNAVAILABLE');assert.equal(result.data.retryable,status!==402);}}
 const calls=f.state.modelCalls,device=f.sqlite.prepare('SELECT id FROM executor_devices').get().id;await call('revoke','fixture-admin',{deviceId:device});for(const route of ['plan','vision-plan','judge','validate-fill'])assert.equal((await call('ai/'+route,token,payload)).status,401);assert.equal(f.state.modelCalls,calls);assert.equal(f.state.pageReads,0);
}));
