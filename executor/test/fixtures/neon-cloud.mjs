// Actual Neon HTTP driver and SQL, backed by the existing isolated PG fixture.
import {PGlite} from '../../test-output/timeline-pg/node_modules/@electric-sql/pglite/dist/index.js';
import {readFile} from 'node:fs/promises';
export async function neonCloudFixture(){
 const db=new PGlite();await db.exec(await readFile(new URL('../../../cloud/worker/schema.sql',import.meta.url),'utf8'));
 await db.exec("INSERT INTO externallink_workspaces(workspace_id) VALUES('one'),('other')");
 const objects=new Map(),state={queries:0,transactions:0,beforeTransaction:null,failSql:null,puts:0};
 const bucket={
  async put(key,value,options={}){if(options.onlyIf?.etagDoesNotMatch==='*'&&objects.has(key))return null;const bytes=new Uint8Array(value);objects.set(key,{bytes:bytes.slice(),options:structuredClone(options)});state.puts++;return{key};},
  async head(key){const object=objects.get(key);return object?{key,size:object.bytes.length,customMetadata:object.options.customMetadata,httpMetadata:object.options.httpMetadata}:null;},
  async get(key){const object=objects.get(key);return object?{key,size:object.bytes.length,body:object.bytes.slice(),customMetadata:object.options.customMetadata,httpMetadata:object.options.httpMetadata,arrayBuffer:async()=>object.bytes.slice().buffer,text:async()=>new TextDecoder().decode(object.bytes),writeHttpMetadata(headers){for(const [key,value]of Object.entries(object.options.httpMetadata||{}))if(key==='contentType')headers.set('Content-Type',value);}}:null;},
  async list({prefix=''}){return{objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key,size:objects.get(key).bytes.length,customMetadata:objects.get(key).options.customMetadata,httpMetadata:objects.get(key).options.httpMetadata})),truncated:false};}
 };
 const env={APP_ACCESS_TOKEN:'fixture-admin',ALLOWED_WORKSPACE_ID:'one',DATABASE_URL:'postgresql://fixture:fixture@fixture.neon.invalid/fixture',MEDIA_BUCKET:bucket};
 const raw=(value,field)=>value==null?null:[114,3802].includes(field.dataTypeID)||typeof value==='object'?JSON.stringify(value):String(value);
 const query=async(engine,{query,params})=>{
  state.queries++;
  if(state.failSql?.test(query)){state.failSql=null;throw Object.assign(Error('injected SQL write failure'),{code:'XX000'});}
  const result=await engine.query(query,params);return{fields:result.fields,rows:result.rows.map(row=>result.fields.map(field=>raw(row[field.name],field))),rowCount:result.rows.length};
 };
 const fetch=async(url,options={})=>{
  const target=new URL(url instanceof URL?url:typeof url==='string'?url:url.url);if(target.hostname!=='api.neon.invalid')throw Error('Unexpected fixture network '+target.origin);
  try{
   const body=JSON.parse(options.body);
   if(!body.queries)return Response.json(await query(db,body));
   state.transactions++;await state.beforeTransaction?.();
   const results=await db.transaction(async tx=>{const out=[];for(const q of body.queries)out.push(await query(tx,q));return out;});
   return Response.json({results});
  }catch(error){return Response.json({message:error.message,code:error.code||'XX000',severity:'ERROR'},{status:400});}
 };
 const seed=async(key,data,workspace='one')=>db.query('INSERT INTO externallink_workspace_documents(workspace_id,document_key,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(workspace_id,document_key) DO UPDATE SET data=excluded.data,revision=externallink_workspace_documents.revision+1',[workspace,key,JSON.stringify(data)]);
 const snapshot=async(workspace='one')=>{const result=await db.query('SELECT document_key,data,revision FROM externallink_workspace_documents WHERE workspace_id=$1 ORDER BY document_key',[workspace]);return{documents:Object.fromEntries(result.rows.map(row=>[row.document_key,row.data])),revisions:Object.fromEntries(result.rows.map(row=>[row.document_key,Number(row.revision)]))};};
 return{db,env,state,objects,fetch,seed,snapshot,close:()=>db.close()};
}
