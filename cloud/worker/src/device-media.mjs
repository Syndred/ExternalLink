import {decodeImageAsset} from '../../../core/media-assets.mjs';
import {sha256} from './d1-store.mjs';import {mediaObjectKey} from './worker-core.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
function key(workspace,id){if(!/^asset-[a-f0-9-]{36}$/.test(id||''))fail('无效媒体身份',400);return mediaObjectKey(workspace,id);}
export async function readDeviceMedia(bucket,workspace,assetId){
 const object=await bucket.get(key(workspace,assetId));if(!object)fail('媒体尚不存在',404);
 const metadata=object.customMetadata||{},checksum=await sha256(new Uint8Array(await object.arrayBuffer()));
 if(checksum!==metadata.sha256)fail('媒体内容校验失败');
 return{assetId,profileId:metadata.profileId,kind:metadata.kind,sha256:checksum,mime:object.httpMetadata?.contentType,fileName:metadata.fileName};
}
export async function putDeviceMedia(bucket,workspace,input,profiles){
 if(!profiles?.[input.profileId]||profiles[input.profileId].archived||!['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4'].includes(input.kind))fail('无效产品或媒体范围',403);
 const bytes=decodeImageAsset(input.dataUrl),mime=input.dataUrl.slice(5,input.dataUrl.indexOf(';'));
 if(mime!==input.mime||await sha256(bytes)!==input.sha256)fail('媒体 SHA 校验或格式不匹配',400);
 const objectKey=key(workspace,input.assetId);
 // R2 conditional write prevents even concurrent requests from overwriting a version.
 await bucket.put(objectKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:mime},customMetadata:{profileId:input.profileId,kind:input.kind,sha256:input.sha256,fileName:String(input.fileName||'image').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100)}});
 const asset=await readDeviceMedia(bucket,workspace,input.assetId);
 if(asset.sha256!==input.sha256||asset.profileId!==input.profileId||asset.kind!==input.kind||asset.mime!==mime)fail('媒体身份已存在且范围不同');return asset;
}
