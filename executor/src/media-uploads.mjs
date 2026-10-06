import {randomUUID,createHash} from 'node:crypto';
import {decodeImageAsset} from '../../core/media-assets.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {overlayApplication,flushApplicationMutations} from './application-mutations.mjs';
export function pendingMediaUploads(runtime){const scope=workbenchScope(runtime.store.get('pair'));return runtime.store.valuesByInsertion('mediaUpload:').filter(item=>item.scope===scope&&!['confirmed','retained'].includes(item.status));}
export async function enqueueMediaUpload(runtime,input){
 const saved=runtime.store.get('applicationSnapshot'),scope=workbenchScope(runtime.store.get('pair'));
 if(saved?.scope!==scope)throw Error('请先读取当前工作区');
 const profile=overlayApplication(runtime,saved.snapshot).documents.siteProfiles?.[input.profileId];
 if(!profile||profile.archived||!['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4'].includes(input.kind))throw Error('无效产品或媒体类型');
 const bytes=decodeImageAsset(input.dataUrl),sha256=createHash('sha256').update(bytes).digest('hex'),assetId='asset-'+randomUUID();
 const item={assetId,scope,profileId:input.profileId,kind:input.kind,mime:input.dataUrl.slice(5,input.dataUrl.indexOf(';')),dataUrl:input.dataUrl,sha256,fileName:String(input.fileName||'image').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100),at:new Date().toISOString(),status:'pending'};
 runtime.store.set('mediaUpload:'+assetId,item);
 return{ok:true,assetId,persisted:true,...await flushMediaUploads(runtime)};
}
export function flushMediaUploads(runtime){if(runtime.mediaUploadFlush)return runtime.mediaUploadFlush;runtime.mediaUploadFlush=performFlush(runtime).finally(()=>{runtime.mediaUploadFlush=null;});return runtime.mediaUploadFlush;}
async function performFlush(runtime){
 for(const item of pendingMediaUploads(runtime)){
  try{
   let asset;try{asset=(await runtime.cloud.request('media-assets/'+item.assetId)).asset;}catch(error){if(error.status!==404)throw error;}
   if(!asset){runtime.store.set('mediaUpload:'+item.assetId,{...item,status:'uploading'});await runtime.cloud.request('media-upload',item);asset=(await runtime.cloud.request('media-assets/'+item.assetId)).asset;}
   if(asset?.sha256!==item.sha256||asset.profileId!==item.profileId||asset.kind!==item.kind||asset.mime!==item.mime)throw Error('媒体独立回读不一致');
   const mutationId='media-'+item.assetId;
   if(!runtime.store.get('appMutation:'+mutationId)){
    const snapshot=overlayApplication(runtime,runtime.store.get('applicationSnapshot').snapshot),p=snapshot.documents.siteProfiles?.[item.profileId];if(!p||p.archived)throw Error('产品已归档，媒体保留待处理');
    const media={...p.media},fields={},ref='cloud-media://'+item.assetId;
    if(item.kind==='logo'){media.logo=ref;fields['Cloud LOGO']=ref;}else if(item.kind==='featured'){media.featured=ref;fields['Cloud Featured image']=ref;}else{media.screenshots=[...(p.media?.screenshots||[1,2,3,4].map(i=>p.fields?.['Screenshot '+i]||''))];media.screenshots[Number(item.kind.slice(10))-1]=ref;fields['Screenshot '+item.kind.slice(10)]=ref;}
    const profile={id:item.profileId,media,fields,mediaDisabled:{...p.mediaDisabled,[item.kind]:false},mediaVersions:[...(p.mediaVersions||[]),{assetId:item.assetId,ref,kind:item.kind,sha256:item.sha256,mime:item.mime,fileName:item.fileName,at:item.at}]};
    const operation={type:'profile',profileId:item.profileId,profile,id:mutationId,at:item.at};
    runtime.store.set('appMutation:'+mutationId,{id:mutationId,scope:item.scope,at:item.at,operation,key:'siteProfiles',baseData:snapshot.documents.siteProfiles,status:'pending'});
   }
   await flushApplicationMutations(runtime);
   const mutationStatus=runtime.store.get('appMutation:'+mutationId)?.status,confirmed=mutationStatus==='confirmed',retained=mutationStatus==='discarded';runtime.store.set('mediaUpload:'+item.assetId,{...item,status:confirmed?'confirmed':retained?'retained':'reference_pending',error:'',...(confirmed||retained?{dataUrl:undefined}:{}),confirmedAt:confirmed?new Date().toISOString():null});
  }catch(error){runtime.store.set('mediaUpload:'+item.assetId,{...runtime.store.get('mediaUpload:'+item.assetId),error:error.message});break;}
 }
 return{pending:pendingMediaUploads(runtime).length,error:pendingMediaUploads(runtime).find(item=>item.error)?.error||''};
}
