import test from 'node:test';
import assert from 'node:assert/strict';
import {Cloud} from '../executor/src/cloud.mjs';
import {libraryTransfer} from '../cloud/worker/src/library-transfer.mjs';
const bucket=()=>{const objects=new Map();return{objects,async get(key){const bytes=objects.get(key);return bytes?{arrayBuffer:async()=>bytes.slice().buffer}:null;},async head(key){return objects.has(key)?{}:null;},async put(key,value){objects.set(key,new Uint8Array(value).slice());}};};
for(const backend of ['neon','d1'])test(`${backend} large transfer recovers a lost part reply with original Unicode payload and without retransmitting verified bytes`,async()=>{
 const oldFetch=globalThis.fetch,storage=bucket(),routes=[];let lost=true,partWrites=0;
 const body={operation:{type:'backup_merge',id:'original-transfer',at:'now',key:'siteProfiles',backup:{siteProfiles:{original:{id:'original',fields:{Description:'原字段😀'.repeat(110000)}}}}},revision:17};
 globalThis.fetch=async(url,options)=>{
  const target=new URL(url),route=target.pathname.split('/executor/')[1];routes.push(route);
  assert.equal(target.pathname.startsWith(backend==='d1'?'/v2/':'/v1/'),true);
  assert.equal(options.headers.Authorization,'Bearer fixture-device');
  const result=await libraryTransfer(storage,'original-workspace','original-device',route.slice('library-transfer/'.length),JSON.parse(options.body));
  if(route.endsWith('/part')){partWrites++;if(lost){lost=false;throw Error('reply lost after durable part');}}
  return Response.json(result);
 };
 try{
  const config={endpoint:'https://fixture.invalid',workspaceId:'original-workspace',deviceId:'original-device',deviceToken:'fixture-device',storageBackend:backend};
  await assert.rejects(new Cloud(config).request('library',body),/连接失败/);
  const recovered=await new Cloud(config).request('library',body);assert.deepEqual(recovered.payload,body);assert.equal(recovered.route,'library');
  const parts=Math.ceil(Buffer.byteLength(JSON.stringify(body))/(512*1024));assert.equal(partWrites,parts);assert.ok(!routes.includes('library'));assert.equal(storage.objects.size,parts+1);
 }finally{globalThis.fetch=oldFetch;}
});
for(const changed of ['storageBackend','deviceId'])test(`large transfer stops after ${changed} changes even when workspace and token remain the same`,async()=>{
 const oldFetch=globalThis.fetch,storage=bucket(),routes=[],config={endpoint:'https://fixture.invalid',workspaceId:'one',deviceId:'original-device',deviceToken:'fixture-token',storageBackend:'neon'};
 globalThis.fetch=async(url,options)=>{const route=new URL(url).pathname.split('/executor/')[1];routes.push(route);const result=await libraryTransfer(storage,'one','original-device','start',JSON.parse(options.body));config[changed]=changed==='storageBackend'?'d1':'new-device';return Response.json(result);};
 try{
  const body={operation:{id:'original-operation',data:'原资料'.repeat(400000)},revision:19};await assert.rejects(new Cloud(config).request('library',body),/后端已切换/);
  assert.deepEqual(routes,['library-transfer/start']);assert.equal(storage.objects.size,1);
 }finally{globalThis.fetch=oldFetch;}
});
