import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {originalTaskMediaEvidence} from './task-media-evidence.mjs';
import {decodeImageAsset} from '../../core/media-assets.mjs';
import {profiles} from './shared.mjs';

export async function materializeTaskMedia(runtime,task,config,kind,{useEmbeddedLogo=true}={}) {
  if(kind==='screenshot')kind='screenshot1';
  if(!/^(?:logo|featured|screenshot[1-9]\d*)$/.test(kind))throw Error('素材类别无效');
  if(config.mediaDisabled?.[kind])throw Error('该产品已停用 '+kind+' 素材');
  const index=Number(kind.replace('screenshot',''))||1;
  if(!Number.isSafeInteger(index))throw Error('素材类别无效');
  const embedded=kind==='logo'&&useEmbeddedLogo?config.logoDataUrl:'';
  if(embedded&&task.profileSnapshot&&profiles.buildAgentConfigFromProfile(task.profileSnapshot).logoDataUrl!==embedded)throw Error('内置图片不属于原任务冻结的产品资料');
  const ref=embedded||(kind==='logo'?config.logoUrl:kind==='featured'?config.featuredImage:config.screenshots?.[index-1]);
  if(!ref)throw Error('该产品缺少已配置的 '+kind+' 素材');
  const inline=String(ref).startsWith('data:');
  if(inline&&task.profileSnapshot){
    const original=profiles.buildAgentConfigFromProfile(task.profileSnapshot),expected=kind==='logo'?(embedded?original.logoDataUrl:original.logoUrl):kind==='featured'?original.featuredImage:original.screenshots?.[index-1];
    if(expected!==ref)throw Error('内置图片不属于原任务冻结的产品资料');
  }
  const frozen=task.acceptanceId?runtime.store.get('acceptance:'+task.acceptanceId):null;
  const asset=frozen?.combinations.find(c=>c.profileId===task.profileId)?.mediaManifest.find(a=>a.kind===kind&&a.ref===ref&&a.ok);
  if(asset&&!ref.startsWith('cloud-media://')){
    const bytes=await readFile(asset.file);
    if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('冻结媒体校验失败，禁止替换版本');
    const folder=join(runtime.home,'task-media');await mkdir(folder,{recursive:true});
    const file=join(folder,asset.sha256+'.'+(asset.mime==='image/jpeg'?'jpg':asset.mime==='image/svg+xml'?'svg':asset.mime.split('/')[1].replace(/[^a-z0-9]/gi,'')));
    await writeFile(file,bytes);
    runtime.update(task,{usedMedia:[...(task.usedMedia||[]).filter(m=>m.kind!==kind),{kind,ref,sha256:asset.sha256,bytes:bytes.length,mime:asset.mime,at:new Date().toISOString(),source:'frozen_backup'}]},'media_materialized');
    return file;
  }
  let bytes,mime,originalEvidence;
  if(inline){
    bytes=Buffer.from(decodeImageAsset(ref));mime=ref.slice(5,ref.indexOf(';'));
  }else if(ref.startsWith('cloud-media://')){
    const original=runtime.store.get('run:'+task.runId)?.mediaManifest?.find(asset=>asset.asset_id===ref.slice(14));
    originalEvidence=await originalTaskMediaEvidence(runtime,task,ref);
    const expected=original?.sha256||originalEvidence?.sha256;
    if(!expected)throw Error('素材不在原任务的冻结清单中');
    const media=originalEvidence||await runtime.bridge(task,{action:'fetchCloudSubmissionMedia',ref});
    const match=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(media.dataUrl||'');
    if(!match)throw Error('冻结媒体返回无效');mime=match[1];bytes=Buffer.from(match[2],'base64');
    if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('冻结媒体校验失败，禁止替换版本');
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
  runtime.update(task,{usedMedia:[...(task.usedMedia||[]).filter(m=>m.kind!==kind),{kind,ref,sha256,bytes:bytes.length,mime,at:new Date().toISOString(),...(inline?{source:'embedded'}:originalEvidence?{source:originalEvidence.source,sourceScopeSha256:originalEvidence.sourceScopeSha256,recoveredOriginalChecksum:originalEvidence.recoveredOriginalChecksum}:{})}]},'media_materialized');
  return file;
}

// Keep the original frozen checksum distinct from the file transformed for a
// particular site's format, dimensions or crop. The shared original mapper
// owns those transformations for both ordinary fill and native upload actions.
export async function materializeTaskUpload(runtime,task,config,kind,engine,selector){
  const file=await materializeTaskMedia(runtime,task,config,kind),canonicalKind=kind==='screenshot'?'screenshot1':kind,original=task.usedMedia.find(item=>item.kind===canonicalKind),bytes=await readFile(file);
  if(createHash('sha256').update(bytes).digest('hex')!==original.sha256)throw Error('原图片落地后校验失败，禁止替换版本');
  const result=await engine.call({action:'normalizeNativeMediaUpload',selector,dataUrl:'data:'+original.mime+';base64,'+bytes.toString('base64')});
  if(!result?.ok)throw Error(result?.error||'原图片转换失败');
  const output=Buffer.from(decodeImageAsset(result.dataUrl)),mime=result.dataUrl.slice(5,result.dataUrl.indexOf(';')),sha256=createHash('sha256').update(output).digest('hex'),extension=mime==='image/jpeg'?'jpg':mime==='image/svg+xml'?'svg':mime.split('/')[1],uploadFile=join(runtime.home,'task-media',sha256+'.'+extension);
  await writeFile(uploadFile,output);
  runtime.update(task,{usedMedia:task.usedMedia.map(item=>item.kind===canonicalKind?{...item,uploadSha256:sha256,uploadMime:mime,uploadBytes:output.length,transformed:sha256!==original.sha256||mime!==original.mime}:item)},'media_upload_prepared');
  return uploadFile;
}
