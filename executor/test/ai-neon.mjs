// Actual Worker and Neon HTTP driver against an isolated PostgreSQL engine.
// Uses the same ignored PGlite dependency as timeline-neon.mjs; no live service.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../test-output/timeline-pg/node_modules/@electric-sql/pglite/dist/index.js';
import Worker from '../../cloud/worker/src/index.mjs';

const db=new PGlite(),realFetch=globalThis.fetch;
const env={APP_ACCESS_TOKEN:'fixture-admin',ALLOWED_WORKSPACE_ID:'one',DATABASE_URL:'postgresql://fixture:fixture@fixture.neon.invalid/fixture',DEEPSEEK_API_KEY:'fixture-provider',DEEPSEEK_BASE_URL:'https://provider.fixture.invalid'};
let modelStatus=200,modelCalls=0,pageReads=0,queries=0;
const modelRequests=[];
const raw=value=>value==null?null:typeof value==='object'?JSON.stringify(value):String(value);
async function query({query,params}){queries++;const result=await db.query(query,params);return{fields:result.fields,rows:result.rows.map(row=>result.fields.map(field=>raw(row[field.name]))),rowCount:result.rows.length};}
globalThis.fetch=async(url,options={})=>{
 const target=new URL(typeof url==='string'?url:url.url);
 if(target.hostname==='api.neon.invalid'){
  const body=JSON.parse(options.body),result=body.queries?{results:await db.transaction(async tx=>{const saved=db.query.bind(db);db.query=tx.query.bind(tx);try{const out=[];for(const q of body.queries)out.push(await query(q));return out;}finally{db.query=saved;}})}:await query(body);
  return Response.json(result);
 }
 if(target.hostname==='provider.fixture.invalid'){
  modelCalls++;const request=JSON.parse(options.body),input=JSON.parse(request.messages[1].content);modelRequests.push(input);
  if(modelStatus!==200)return Response.json({error:{message:modelStatus===402?'Insufficient Balance':'rate limit exceeded'}},{status:modelStatus});
  const result=input.page?{drafts:[{text:'Original article advice'},{text:'A distinct practical suggestion'},{text:'A relevant follow-up question'}]}:{fields:{Name:'Original product',Url:'https://product.fixture.invalid',Title:'Generated title'},valueProposition:'Original value'};
  return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
 }
 if(['product.fixture.invalid','article.fixture.invalid'].includes(target.hostname)){pageReads++;return new Response('<html><title>Original page</title><script>secret script</script><p>'+ 'Original useful content. '.repeat(30)+'</p></html>',{headers:{'Content-Type':'text/html'}});}
 throw Error('Unexpected fixture network target '+target.origin);
};
const call=async(route,token,body,workspace='one',method=body?'POST':'GET')=>{const response=await Worker.fetch(new Request('https://worker.fixture.invalid/v1/executor/'+route+'?workspace='+workspace,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}),env);return{status:response.status,data:await response.json()};};
try{
 await db.exec(await readFile(new URL('../../cloud/worker/schema.sql',import.meta.url),'utf8'));await db.exec("INSERT INTO externallink_workspaces(workspace_id) VALUES('one')");
 const enrolled=await call('devices','fixture-admin',{});assert.equal(enrolled.status,200,JSON.stringify(enrolled.data));const token=enrolled.data.deviceToken;
 await db.query("INSERT INTO externallink_workspace_documents(workspace_id,document_key,data) VALUES('one','submissionRecords',$1::jsonb)",[JSON.stringify({original:{status:'success',evidence:'Original receipt'}})]);
 const protectedState=async()=>JSON.stringify((await db.query('SELECT document_key,revision,data FROM externallink_workspace_documents ORDER BY document_key')).rows),before=await protectedState();
 const profile={id:'original',fields:{Name:'Original',Url:'https://product.fixture.invalid'}};
 const extracted=await call('ai/extract-site',token,{url:profile.fields.Url,language:'zh'});assert.equal(extracted.status,200);assert.equal(extracted.data.profile.fields.Title,'Generated title');assert.equal(extracted.data.source.title,'Original page');
 const generated=await call('ai/generate-site',token,{profile,language:'zh'});assert.equal(generated.status,200);assert.equal(generated.data.profile.fields.Url,profile.fields.Url);
 const comment=await call('ai/comment',token,{pageUrl:'https://article.fixture.invalid/post',count:3,language:'zh',allowLink:false,config:{brandName:'Original',targetDomain:profile.fields.Url},tone:'professional'});assert.equal(comment.status,200);assert.equal(comment.data.drafts.length,3);assert.equal(modelRequests.at(-1).page.title,'Original page');assert.ok(!modelRequests.at(-1).page.text.includes('secret script'));assert.equal(modelRequests.at(-1).allowLink,false);assert.equal(modelRequests.at(-1).language,'zh');
 const reads=pageReads;assert.equal((await call('ai/comment',token,{pageUrl:'https://article.fixture.invalid/post',pageText:'Supplied original article',count:1})).data.drafts.length,1);assert.equal(pageReads,reads);
 assert.equal((await call('ai/domain-metrics',token,{domains:[]})).status,200);
 for(const status of [402,429]){modelStatus=status;const failed=await call('ai/generate-site',token,{profile});assert.equal(failed.status,503);assert.equal(failed.data.code,status===402?'AI_PROVIDER_BALANCE_EXHAUSTED':'AI_PROVIDER_UNAVAILABLE');assert.equal(failed.data.retryable,status!==402);}modelStatus=200;
 const count=modelCalls;
 assert.equal((await call('ai/comment','wrong',{pageText:'No model call'})).status,401);assert.equal((await call('ai/comment',token,{pageText:'No model call'},'other')).status,403);assert.equal((await call('ai/comment','fixture-admin',{pageText:'No model call'})).status,401);
 assert.equal((await call('ai/generate-site',token,undefined,'one','GET')).status,404);assert.equal((await call('ai/admin-state',token,{})).status,404);assert.equal(modelCalls,count);
 assert.equal((await call('revoke','fixture-admin',{deviceId:enrolled.data.deviceId})).status,200);assert.equal((await call('ai/comment',token,{pageText:'No model call'})).status,401);assert.equal(modelCalls,count);
 assert.equal(await protectedState(),before);for(const table of ['externallink_executor_runs','externallink_executor_tasks','externallink_executor_events'])assert.equal((await db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
 console.log(JSON.stringify({ok:true,kind:'actual_worker_neon_http_driver_isolated_postgresql_ai',modelCalls,pageReads,queries,allFourAiRoutes:true,articleFallbackAndExplicitText:true,providerErrors503Classified:true,wrongWorkspaceAndRevokedDeviceRejected:true,originalDocumentsAndRevisionsUnchanged:true,newRuntimeRuns:0,newRealSubmissions:0,productionNeonRequests:0,realProviderRequests:0}));
}finally{globalThis.fetch=realFetch;await db.close();}
