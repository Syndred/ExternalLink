import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1Store} from '../../../cloud/worker/src/d1-store.mjs';
export function aiCloudFixture(){
 const sqlite=new DatabaseSync(':memory:');for(const name of ['0001_d1_storage.sql','0002_d1_executor.sql'])sqlite.exec(readFileSync(new URL('../../../cloud/worker/migrations/'+name,import.meta.url),'utf8'));
 const db={prepare(sql){let args=[];return{bind(...values){args=values;return this;},first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const statement=sqlite.prepare(sql);return statement.columns().length?{results:statement.all(...args),meta:{changes:0}}:{results:[],meta:{changes:statement.run(...args).changes}};}};},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const statement of statements)out.push(await statement.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const objects=new Map(),bucket={head:async key=>objects.has(key)?{customMetadata:objects.get(key).meta?.customMetadata}:null,put:async(key,value,meta)=>objects.set(key,{bytes:new Uint8Array(value),meta}),get:async key=>{const object=objects.get(key);return object?{arrayBuffer:async()=>object.bytes.slice().buffer,httpMetadata:object.meta?.httpMetadata}:null;}};
 const env={LEDGER_DB:db,MEDIA_BUCKET:bucket,APP_ACCESS_TOKEN:'fixture-admin',ALLOWED_WORKSPACE_ID:'default',DEEPSEEK_API_KEY:'fixture-key',DEEPSEEK_BASE_URL:'https://provider.fixture.invalid'};
 const state={modelCalls:0,pageReads:0,status:200,requests:[],hold:null,modelResult:null};
 const fetch=async(url,options)=>{
  const target=new URL(typeof url==='string'?url:url.url);
  if(target.hostname==='provider.fixture.invalid'){
   state.modelCalls++;const count=state.modelCalls,content=JSON.parse(options.body).messages[1].content,input=JSON.parse(Array.isArray(content)?content.find(part=>part.type==='text').text:content);state.requests.push(input);await state.hold;
   if(state.status!==200)return Response.json({error:{message:state.status===402?'Insufficient Balance':'rate limit exceeded'}},{status:state.status});
   const result=state.modelResult??(input.page?{drafts:[{text:'Advice '+count},{text:'Suggestion '+count},{text:'Question '+count}]}:{fields:{Name:'Original product',Url:'https://product.fixture.invalid',Title:'Generated title '+count},valueProposition:'Original value'});
   return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  }
  if(['article.fixture.invalid','product.fixture.invalid'].includes(target.hostname)){state.pageReads++;return new Response('<html><title>Original article</title><script>hidden script</script><p>'+'Useful original article. '.repeat(30)+'</p></html>');}
  throw Error('Unexpected fixture network target '+target.origin);
 };
 return{sqlite,env,ledger:new D1Store(db,bucket,'default'),state,fetch};
}
