import {Buffer} from 'node:buffer';
import {sha256} from './d1-store.mjs';
const partBytes=512*1024;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
export async function libraryTransfer(bucket,workspace,deviceId,action,input){
 if(!validDigest(input.id))fail('备份传输身份无效');
 const root=`${workspace}/d1/transfers/${deviceId}/${input.id}/`,manifestKey=root+'manifest.json';
 const read=async()=>{const object=await bucket.get(manifestKey);if(!object)fail('原设备的备份传输不存在',404);return JSON.parse(new TextDecoder().decode(await object.arrayBuffer()));};
 if(action==='start'){
  if(!['library','profile'].includes(input.route)||!Number.isSafeInteger(input.bytes)||input.bytes<1||!Array.isArray(input.parts)||!input.parts.length||input.parts.length>10000||input.parts.some((p,i)=>!validDigest(p?.sha256)||!Number.isInteger(p.bytes)||p.bytes<1||p.bytes>partBytes||(i<input.parts.length-1&&p.bytes!==partBytes))||input.parts.reduce((n,p)=>n+p.bytes,0)!==input.bytes)fail('备份分段清单无效');
  const manifest={id:input.id,route:input.route,bytes:input.bytes,parts:input.parts},bytes=encode(manifest),existing=await bucket.get(manifestKey);
  if(existing){if(await sha256(await existing.arrayBuffer())!==await sha256(bytes))fail('原备份传输清单已变化',409);}else await bucket.put(manifestKey,bytes,{httpMetadata:{contentType:'application/json'}});
 }
 const manifest=await read();
 if(action==='part'){
  const part=manifest.parts[input.index];if(!Number.isInteger(input.index)||!part||typeof input.data!=='string'||input.data.length>Math.ceil(partBytes/3)*4)fail('备份分段无效');
  const bytes=Buffer.from(input.data,'base64');if(bytes.length!==part.bytes||bytes.toString('base64')!==input.data||await sha256(bytes)!==part.sha256)fail('备份分段校验失败');
  const key=root+'parts/'+part.sha256;if(!await bucket.head(key))await bucket.put(key,bytes,{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:part.sha256}});
  return{ok:true,id:input.id,index:input.index};
 }
 if(action==='commit'){
  const bytes=new Uint8Array(manifest.bytes);let offset=0;
  for(const part of manifest.parts){const object=await bucket.get(root+'parts/'+part.sha256);if(!object)fail('备份尚有分段未上传',409);const content=await object.arrayBuffer();if(content.byteLength!==part.bytes||await sha256(content)!==part.sha256)fail('备份分段校验失败',503);bytes.set(new Uint8Array(content),offset);offset+=part.bytes;}
  if(await sha256(bytes)!==manifest.id)fail('完整备份校验失败',503);
  let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('备份内容不是有效 JSON');}
  return{route:manifest.route,payload};
 }
 if(!['start','status'].includes(action))fail('备份传输动作无效');
 const present=[];for(let i=0;i<manifest.parts.length;i++)if(await bucket.head(root+'parts/'+manifest.parts[i].sha256))present.push(i);
 return{ok:true,id:manifest.id,bytes:manifest.bytes,present};
}
