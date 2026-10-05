import {createHash} from 'node:crypto';
import {workbenchScope} from './workbench-sync.mjs';
const partBytes=512*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export async function backupUpload(runtime,action,input,preview){
 const store=runtime.store,scope=workbenchScope(store.get('pair'));
 const info=plan=>({id:plan.id,name:plan.name,bytes:plan.bytes,partBytes,present:Array.from({length:plan.count},(_,i)=>i).filter(i=>!!store.get(`backupUploadPart:${plan.id}:${i}`)),previewId:plan.previewId,status:plan.status});
 if(action==='backupUploadStart'){
  if(!validDigest(input.sha256)||!Number.isSafeInteger(input.bytes)||input.bytes<1||Math.ceil(input.bytes/partBytes)>10000)throw Error('备份文件信息无效');
  const id=digest(scope+'\n'+input.sha256);let plan=store.get('backupUpload:'+id);
  if(plan&&(plan.scope!==scope||plan.bytes!==input.bytes||plan.sha256!==input.sha256))throw Error('原备份文件信息不匹配');
  if(!plan){plan={id,scope,sha256:input.sha256,bytes:input.bytes,count:Math.ceil(input.bytes/partBytes),name:String(input.name||'原插件备份.json').replace(/[\x00-\x1f]/g,'').slice(0,200),status:'uploading',at:new Date().toISOString()};store.set('backupUpload:'+id,plan);}
  return{ok:true,upload:info(plan)};
 }
 const plan=store.get('backupUpload:'+input.id);if(!plan||plan.scope!==scope)throw Error('当前工作区的原备份传输不存在');
 if(action==='backupUploadPart'){
  if(!Number.isInteger(input.index)||input.index<0||input.index>=plan.count||!validDigest(input.sha256)||typeof input.data!=='string'||input.data.length>Math.ceil(partBytes/3)*4)throw Error('备份分段无效');
  const bytes=Buffer.from(input.data,'base64'),expected=Math.min(partBytes,plan.bytes-input.index*partBytes);
  if(bytes.length!==expected||bytes.toString('base64')!==input.data||digest(bytes)!==input.sha256)throw Error('备份分段校验失败');
  const key=`backupUploadPart:${plan.id}:${input.index}`,old=store.get(key);if(old&&old.sha256!==input.sha256)throw Error('原备份分段内容已变化');
  if(!old)store.set(key,{id:plan.id,index:input.index,sha256:input.sha256,data:input.data});
  return{ok:true,id:plan.id,index:input.index};
 }
 if(action!=='backupUploadComplete')throw Error('备份传输动作无效');
 if(plan.previewId){const previous=store.get('backupImport:'+plan.previewId);if(previous?.scope===scope&&previous.status!=='preview')return{ok:true,preview:previous.preview};}
 const bytes=Buffer.alloc(plan.bytes);let offset=0;
 for(let i=0;i<plan.count;i++){const part=store.get(`backupUploadPart:${plan.id}:${i}`);if(!part)throw Error('备份尚有分段未上传，请重新选择原文件继续');const content=Buffer.from(part.data,'base64');if(digest(content)!==part.sha256||content.length!==Math.min(partBytes,plan.bytes-i*partBytes))throw Error('备份分段校验失败');content.copy(bytes,offset);offset+=content.length;}
 if(digest(bytes)!==plan.sha256)throw Error('完整备份校验失败，请核对原文件');
 let backup;try{backup=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('备份文件不是有效 JSON');}
 const result=await preview(backup,{id:plan.id,sha256:plan.sha256,name:plan.name,bytes:plan.bytes,previousPreviewId:plan.previewId});
 if(scope!==workbenchScope(store.get('pair')))throw Error('工作区已切换，原备份保留');
 plan.status='previewed';plan.previewId=result.preview.id;store.set('backupUpload:'+plan.id,plan);return result;
}
