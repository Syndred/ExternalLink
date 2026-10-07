import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export async function materializeTaskMedia(runtime,task,config,kind) {
  const index=Number(kind.replace('screenshot',''))||1;
  const ref=kind==='logo'?config.logoUrl:kind==='featured'?config.featuredImage:config.screenshots?.[index-1];
  if(!ref)throw Error('该产品缺少已配置的 '+kind+' 素材');
  const frozen=task.acceptanceId?runtime.store.get('acceptance:'+task.acceptanceId):null;
  const asset=frozen?.combinations.find(c=>c.profileId===task.profileId)?.mediaManifest.find(a=>a.kind===kind&&a.ref===ref&&a.ok);
  if(asset){
    const bytes=await readFile(asset.file);
    if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('冻结媒体校验失败，禁止替换版本');
    const folder=join(runtime.home,'task-media');await mkdir(folder,{recursive:true});
    const file=join(folder,asset.sha256+'.'+(asset.mime==='image/jpeg'?'jpg':asset.mime==='image/svg+xml'?'svg':asset.mime.split('/')[1].replace(/[^a-z0-9]/gi,'')));
    await writeFile(file,bytes);
    runtime.update(task,{usedMedia:[...(task.usedMedia||[]).filter(m=>m.kind!==kind),{kind,ref,sha256:asset.sha256,bytes:bytes.length,mime:asset.mime,at:new Date().toISOString(),source:'frozen_backup'}]},'media_materialized');
    return file;
  }
  let bytes,mime;
  if(ref.startsWith('cloud-media://')){
    const original=runtime.store.get('run:'+task.runId)?.mediaManifest?.find(asset=>asset.asset_id===ref.slice(14));
    if(!original?.sha256)throw Error('素材不在原任务的冻结清单中');
    const media=await runtime.bridge(task,{action:'fetchCloudSubmissionMedia',ref});
    const match=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(media.dataUrl||'');
    if(!match)throw Error('冻结媒体返回无效');mime=match[1];bytes=Buffer.from(match[2],'base64');
    if(createHash('sha256').update(bytes).digest('hex')!==original.sha256)throw Error('冻结媒体校验失败，禁止替换版本');
  }else{
    const url=new URL(ref);
    if(url.protocol!=='https:'||url.username||url.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname))throw Error('素材地址不是公开 HTTPS 图片');
    const response=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});
    mime=response.headers.get('content-type')?.split(';')[0]||'';
    if(!response.ok||!mime.startsWith('image/')||Number(response.headers.get('content-length'))>6*1024*1024)throw Error('素材响应无效或过大');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>6*1024*1024)throw Error('素材超过 6 MB');chunks.push(chunk);}
    bytes=Buffer.concat(chunks);
  }
  if(!bytes.length||bytes.length>6*1024*1024)throw Error('素材为空或超过 6 MB');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const folder=join(runtime.home,'task-media');await mkdir(folder,{recursive:true});
  const file=join(folder,sha256+'.'+(mime==='image/jpeg'?'jpg':mime==='image/svg+xml'?'svg':mime.split('/')[1].replace(/[^a-z0-9]/gi,'')));
  await writeFile(file,bytes);
  runtime.update(task,{usedMedia:[...(task.usedMedia||[]).filter(m=>m.kind!==kind),{kind,ref,sha256,bytes:bytes.length,mime,at:new Date().toISOString()}]},'media_materialized');
  return file;
}
