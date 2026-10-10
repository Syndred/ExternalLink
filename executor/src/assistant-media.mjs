import {createHash} from 'node:crypto';
import {mediaLibrary} from './media-library.mjs';

// Field-only manual uploads need the selected product's media, without creating
// a submission task. The caller fences the product, connection and document.
export async function assistantMedia(runtime,message,config,assertCurrent){
 await assertCurrent();const ref=message.action==='fetchCloudSubmissionMedia'?message.ref:message.url;
 const allowed=[['logo',config.logoUrl],['featured',config.featuredImage],...(config.screenshots||[]).map((value,index)=>['screenshot'+(index+1),value])].filter(([kind,value])=>value&&!config.mediaDisabled?.[kind]);
 if(!allowed.some(([,value])=>value===ref))throw Error('素材不属于当前产品资料');
 const pair=runtime.store.get('pair');let url,headers={},asset;
 if(message.action==='fetchCloudSubmissionMedia'){
  if(!/^cloud-media:\/\/[a-zA-Z0-9._-]+$/.test(ref))throw Error('云端图片编号无效');const id=ref.slice(14),catalogue=await mediaLibrary(runtime,{catalogueOnly:true});await assertCurrent();asset=catalogue.assets.find(row=>row.asset_id===id);if(!asset)throw Error('当前云端图片不存在');
  const normalized=value=>String(value||'').trim().toLowerCase();if(asset.profile_id&&normalized(asset.profile_id)!==normalized(config.projectKey))throw Error('图片不属于当前产品');
  url=new URL((pair.storageBackend==='d1'?'/v2/executor/':'/v1/executor/')+'workspace/media/'+id,pair.endpoint);url.searchParams.set('workspace',pair.workspaceId);headers.Authorization='Bearer '+pair.deviceToken;
 }else{url=new URL(ref);if(!['http:','https:'].includes(url.protocol))throw Error('远程图片网址无效');}
 const response=await fetch(url,{headers,credentials:'omit',signal:AbortSignal.timeout(30000)});await assertCurrent();if(!response.ok)throw Error('图片读取失败 HTTP '+response.status);
 const limit=12*1024*1024;if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('图片超过12MB');}
 const mime=(response.headers.get('content-type')||asset?.mime||'').split(';')[0].trim().toLowerCase();if(!/^image\/(?:png|jpeg|webp|gif|svg\+xml|avif)$/.test(mime)){await response.body?.cancel();throw Error('素材不是支持的图片');}
 const bytes=Buffer.from(await response.arrayBuffer());await assertCurrent();if(!bytes.length||bytes.length>limit)throw Error('图片大小无效');const sha256=createHash('sha256').update(bytes).digest('hex');if(asset?.sha256&&asset.sha256!==sha256)throw Error('云端图片字节已变化');
 return{ok:true,dataUrl:'data:'+mime+';base64,'+bytes.toString('base64'),sha256};
}
