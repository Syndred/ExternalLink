import {taskMediaReferences} from '../../../core/task-media-selection.mjs';
import {validateImageBytes} from '../../../core/media-assets.mjs';
import {mediaObjectKey} from './worker-core.mjs';import {sha256} from './d1-store.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
export async function freezeD1TaskMedia(bucket,workspace,profile,taskProfileId=profile.id){
 const manifest=[];
 for(const {ref,kind}of taskMediaReferences(profile)){
  const assetId=ref.slice(14),key=mediaObjectKey(workspace,assetId),head=await bucket.head(key);
  if(!head)fail('选定素材不存在，请恢复原素材后重新预览');
  if(head.customMetadata?.profileId&&head.customMetadata.profileId!==taskProfileId)fail('选定素材不属于当前任务产品',403);
  let checksum=head.customMetadata?.sha256||'';
  // Original R2 migration retained image bytes and HTTP metadata, but some
  // legacy objects have no custom metadata. Freeze those exact selected bytes
  // without changing the original object or inventing a catalogue owner.
  if(!checksum){
   const object=await bucket.get(key);if(!object)fail('选定素材不存在',404);
   if(object.customMetadata?.profileId&&object.customMetadata.profileId!==taskProfileId)fail('选定素材不属于当前任务产品',403);
   const bytes=new Uint8Array(await object.arrayBuffer());validateImageBytes(bytes,object.httpMetadata?.contentType?.split(';')[0]);checksum=await sha256(bytes);
  }
  if(!/^[a-f0-9]{64}$/.test(checksum))fail('选定素材的原版本校验无效');
  manifest.push({asset_id:assetId,media_kind:kind.startsWith('screenshot')?'screenshot':kind,
   media_index:kind.startsWith('screenshot')?Number(kind.slice(10)):null,sha256:checksum,file_name:head.customMetadata?.fileName||assetId});
 }
 return manifest;
}
