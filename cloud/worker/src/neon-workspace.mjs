import {readJournal} from './submission-journal.mjs';
import {putDeviceMedia} from './device-media.mjs';
import {mediaObjectKey,artifactObjectKey} from './worker-core.mjs';
import {sha256} from './d1-store.mjs';
import {decodeImageAsset,validateMediaSize} from '../../../core/media-assets.mjs';
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9._-]+$/.test(id);
const assetKind=row=>row.media_kind==='screenshot'?'screenshot'+row.media_index:row.media_kind;
async function assetRow(sql,workspace,assetId){
 if(!validId(assetId))fail('无效媒体身份',400);
 const rows=await sql`select * from externallink_media_assets where workspace_id=${workspace} and asset_id=${assetId}`;
 if(!rows[0])fail('媒体尚不存在',404);return rows[0];
}
export async function verifiedNeonMediaBytes(bucket,workspace,row){
 if(row.object_key!==mediaObjectKey(workspace,row.asset_id))fail('媒体对象范围不匹配',403);
 const object=await bucket.get(row.object_key);if(!object)fail('媒体对象不存在',404);
 const bytes=new Uint8Array(await object.arrayBuffer());
 if(bytes.length!==Number(row.byte_length)||await sha256(bytes)!==row.sha256)fail('媒体内容校验失败');
 return bytes;
}
export async function readNeonDeviceMedia(sql,bucket,workspace,assetId){
 const row=await assetRow(sql,workspace,assetId);await verifiedNeonMediaBytes(bucket,workspace,row);
 return{assetId:row.asset_id,profileId:row.profile_id,kind:assetKind(row),sha256:row.sha256,mime:row.content_type,fileName:row.file_name};
}
export async function putNeonDeviceMedia(sql,bucket,workspace,input){
 const rows=await sql`select data from externallink_workspace_documents where workspace_id=${workspace} and document_key='siteProfiles'`;
 const profiles=rows[0]?.data;
 if(!profiles?.[input.profileId]||profiles[input.profileId].archived||!['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4'].includes(input.kind))fail('无效产品或媒体范围',403);
 if(!/^asset-[a-f0-9-]{36}$/.test(input.assetId||''))fail('无效媒体身份',400);
 const bytes=validateMediaSize(decodeImageAsset(input.dataUrl),input.kind),mime=input.dataUrl.slice(5,input.dataUrl.indexOf(';'));
 if(mime!==input.mime||await sha256(bytes)!==input.sha256)fail('媒体 SHA 校验或格式不匹配',400);
 const existing=await sql`select * from externallink_media_assets where workspace_id=${workspace} and asset_id=${input.assetId}`;
 if(!existing.length){
  const asset=await putDeviceMedia(bucket,workspace,input,profiles),kind=input.kind.startsWith('screenshot')?'screenshot':input.kind,index=kind==='screenshot'?Number(input.kind.slice(10)):null;
  // An R2 version survives a failed SQL insert. A retry adopts the same bytes;
  // it cannot overwrite either an old catalog row or another product's upload.
  await sql`insert into externallink_media_assets(workspace_id,asset_id,profile_id,media_kind,media_index,object_key,file_name,content_type,byte_length,sha256)
    values(${workspace},${input.assetId},${input.profileId},${kind},${index},${mediaObjectKey(workspace,input.assetId)},${asset.fileName},${mime},${bytes.length},${input.sha256}) on conflict do nothing`;
 }
 const asset=await readNeonDeviceMedia(sql,bucket,workspace,input.assetId);
 if(asset.profileId!==input.profileId||asset.kind!==input.kind||asset.sha256!==input.sha256||asset.mime!==mime)fail('媒体身份已存在且范围不同');
 return asset;
}
export async function neonWorkspaceRead(sql,bucket,workspace,target,query){
 if(target==='submission-tasks')return Response.json(await readJournal(sql,workspace,query));
 if(target==='media'){
  const assets=await sql`select asset_id,profile_id,media_kind,media_index,file_name,content_type,byte_length,sha256,created_at,updated_at
    from externallink_media_assets where workspace_id=${workspace} order by file_name`;
  return Response.json({ok:true,assets});
 }
 const media=target.match(/^media\/([a-zA-Z0-9._-]+)$/);
 if(media){
  const row=await assetRow(sql,workspace,media[1]),bytes=await verifiedNeonMediaBytes(bucket,workspace,row);
  return new Response(bytes,{headers:{'Content-Type':row.content_type,'Content-Length':String(bytes.length),
   'Content-Disposition':'inline; filename="'+row.file_name.replace(/[^a-zA-Z0-9._-]/g,'_')+'"; filename*=UTF-8\'\''+encodeURIComponent(row.file_name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase()),'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}});
 }
 const artifact=target.match(/^automation\/artifacts\/([a-zA-Z0-9._-]+)$/);
 if(artifact){
  const object=await bucket.get(artifactObjectKey(workspace,artifact[1]));if(!object)fail('证据附件不存在',404);
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(object.customMetadata?.sha256&&await sha256(bytes)!==object.customMetadata.sha256)fail('证据附件校验失败');
  return new Response(bytes,{headers:{'Content-Type':object.httpMetadata?.contentType||'image/png','Content-Length':String(bytes.length),'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'}});
 }
 fail('工作台接口未授权',403);
}
