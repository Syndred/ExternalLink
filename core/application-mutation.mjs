import {libraryMutation,libraryMutationSatisfied} from './library-mutation.mjs';
import './profiles.js';
import {jsonValueEqual} from './json-value.mjs';
const badRequest=message=>Object.assign(new Error(message),{status:400});
export function applicationMutation(documents,operation,options){
 if(operation.type==='profile_selection'){
  const available=id=>typeof id==='string'&&Object.hasOwn(documents.siteProfiles||{},id)&&!documents.siteProfiles[id].archived&&!['__proto__','constructor','prototype'].includes(id);
  const emptyCurrent=operation.value===''&&!Object.values(documents.siteProfiles||{}).some(profile=>!profile.archived);
  if(operation.key==='activeSiteId'?!available(operation.value)&&!emptyCurrent:operation.key==='selectedSiteIds'?(!Array.isArray(operation.value)||new Set(operation.value).size!==operation.value.length||operation.value.some(id=>!available(id))):true)throw badRequest('请选择现有的在用网站，选择不能重复');
  return{key:operation.key,data:structuredClone(operation.value)};
 }
 if(operation.type==='profile_order'){
  const profiles=documents.siteProfiles||{},ids=operation.profileIds;
  if(!Array.isArray(ids)||!ids.length||ids.length!==Object.keys(profiles).length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!Object.hasOwn(profiles,id)||['__proto__','constructor','prototype'].includes(id)))throw badRequest('网站排序必须包含全部现有产品且不能重复');
  return{key:'siteProfiles',data:globalThis.ExtLinkProfiles.applyProfileOrder(profiles,ids)};
 }
 if(!['profile','profile_create','profile_delete','profile_archive','profile_media'].includes(operation.type))return libraryMutation(documents,operation,options);
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(operation.profileId||'')||['constructor','prototype','__proto__'].includes(operation.profileId))throw badRequest('无效资料身份');
 const original=documents.siteProfiles?.[operation.profileId],patch=operation.profile;
 if(operation.type==='profile_delete'){
  if(!original)throw badRequest('产品资料已不存在');
  const data={...documents.siteProfiles};delete data[operation.profileId];return{key:'siteProfiles',data:globalThis.ExtLinkProfiles.applyProfileOrder(data,globalThis.ExtLinkProfiles.orderedProfileIds(data))};
 }
 if(operation.type==='profile_media'){
  if(!original||!['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4'].includes(operation.kind)||!['disable','restore'].includes(operation.action))throw badRequest('无效媒体操作');
  const media={...original.media},fields={...original.fields},mediaDisabled={...original.mediaDisabled,[operation.kind]:operation.action==='disable'};
  if(operation.action==='restore'){
   const asset=original.mediaVersions?.find(a=>a.assetId===operation.assetId&&a.kind===operation.kind);if(!asset)throw badRequest('媒体版本不属于本产品');
   if(operation.kind==='logo'){media.logo=asset.ref;fields['Cloud LOGO']=asset.ref;}else if(operation.kind==='featured'){media.featured=asset.ref;fields['Cloud Featured image']=asset.ref;}else{media.screenshots=[...(media.screenshots||[1,2,3,4].map(i=>fields['Screenshot '+i]||''))];media.screenshots[Number(operation.kind.slice(10))-1]=asset.ref;fields['Screenshot '+operation.kind.slice(10)]=asset.ref;}
  }
  return{key:'siteProfiles',data:{...documents.siteProfiles,[operation.profileId]:{...original,media,fields,mediaDisabled,updatedAt:operation.at}}};
 }
 if(operation.type==='profile_archive'){
  if(!original||typeof operation.archived!=='boolean')throw badRequest('资料身份或归档状态不匹配');
  return{key:'siteProfiles',data:{...documents.siteProfiles,[operation.profileId]:{...original,archived:operation.archived,archivedAt:operation.archived?operation.at:null,updatedAt:operation.at}}};
 }
 if(operation.type==='profile_create'&&original)throw badRequest('资料身份已存在，不能覆盖');
 if(operation.type==='profile'&&!original||patch?.id!==operation.profileId)throw badRequest('资料身份不匹配');
 if(Object.keys(patch).some(key=>!['id','name','url','promoUrl','logoUrl','logoDataUrl','fields','fieldNotes','media','mediaVersions','mediaDisabled','language','targetAudience','valueProposition','useCases','sellablePoints','avoidContent','anchorRules','blogRules'].includes(key)))throw badRequest('无效资料字段');
 if(patch.logoDataUrl!==undefined&&patch.logoDataUrl!=='')throw badRequest('新图片请通过媒体上传保存，原上传图片可清除');
 if(patch.logoUrl!==undefined&&patch.logoUrl!==''){let url;try{url=new URL(patch.logoUrl);}catch{throw badRequest('无效标志图片网址');}if(typeof patch.logoUrl!=='string'||!/^https?:$/.test(url.protocol)||url.username||url.password)throw badRequest('无效标志图片网址');}
 if(patch.mediaDisabled!==undefined&&(!patch.mediaDisabled||typeof patch.mediaDisabled!=='object'||Array.isArray(patch.mediaDisabled)||Object.entries(patch.mediaDisabled).some(([kind,value])=>!['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4'].includes(kind)||typeof value!=='boolean')))throw badRequest('无效媒体停用设置');
 if(patch.fieldNotes!==undefined&&(!patch.fieldNotes||typeof patch.fieldNotes!=='object'||Array.isArray(patch.fieldNotes)||Object.entries(patch.fieldNotes).some(([key,value])=>['__proto__','constructor','prototype'].includes(key)||typeof value!=='string'||value.length>100000)))throw badRequest('无效字段备注');
 for(const key of ['language','targetAudience','valueProposition'])if(patch[key]!==undefined&&(typeof patch[key]!=='string'||patch[key].length>10000))throw badRequest('无效资料说明');
 for(const key of ['useCases','sellablePoints','avoidContent'])if(patch[key]!==undefined&&(!Array.isArray(patch[key])||patch[key].length>100||patch[key].some(v=>typeof v!=='string'||v.length>10000)))throw badRequest('无效资料列表');
 if(patch.anchorRules!==undefined){const rules=patch.anchorRules;if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.entries(rules).some(([k,v])=>k==='allowExactMatch'?typeof v!=='boolean':!['brandKeywords','urlKeywords','naturalExpressions','keywordExpressions','avoidWords'].includes(k)||!Array.isArray(v)||v.length>100||v.some(s=>typeof s!=='string'||s.length>10000)))throw badRequest('无效推广链接规则');}
 if(patch.blogRules!==undefined){const rules=patch.blogRules;if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.entries(rules).some(([k,v])=>k==='tone'?!['helpful','professional','casual','enthusiastic'].includes(v):k==='maxLinksPerDraft'?(!Number.isSafeInteger(v)||v<0):k==='preferredAnchor'?!['natural','brand','keyword','url'].includes(v):true))throw badRequest('无效评论规则');}
 if(patch.mediaVersions!==undefined&&(!Array.isArray(patch.mediaVersions)||(original?.mediaVersions||[]).some((asset,index)=>!jsonValueEqual(asset,patch.mediaVersions[index]))))throw badRequest('历史媒体版本只能保留并追加，不能改写或删除');
 for(const [key,value]of Object.entries(patch.fields||{}))if(typeof value!=='string'||value.length>100000||/password|secret|token|api.?key/i.test(key))throw badRequest('无效或敏感资料字段');
 if(patch.name!==undefined&&(typeof patch.name!=='string'||patch.name.length>200))throw badRequest('无效产品名称');
 if(patch.url!==undefined){if(typeof patch.url!=='string')throw badRequest('无效产品网址');if(patch.url!==''){let url;try{url=new URL(patch.url);}catch{throw badRequest('无效产品网址');}if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw badRequest('无效产品网址');}}
 if(patch.promoUrl!==undefined&&patch.promoUrl!==''){let url;try{url=new URL(patch.promoUrl);}catch{throw badRequest('无效推广网址');}if(typeof patch.promoUrl!=='string'||!/^https?:$/.test(url.protocol)||url.username||url.password)throw badRequest('无效推广网址');}
 if(operation.type==='profile_create'&&!patch.name?.trim()&&!patch.url?.trim())throw badRequest('请至少填写站点名称或首页地址');
 const profile={...original,...patch,fields:{...original?.fields,...patch.fields},...(patch.fieldNotes!==undefined?{fieldNotes:{...original?.fieldNotes,...Object.fromEntries(Object.entries(patch.fieldNotes).map(([key,value])=>[key,value.trim()]).filter(([,value])=>value))}}:{}),media:{...original?.media,...patch.media},...(operation.type==='profile_create'?{sortIndex:globalThis.ExtLinkProfiles.nextProfileSortIndex(documents.siteProfiles),createdAt:operation.at,archived:false}:{}),updatedAt:operation.at};
 return{key:'siteProfiles',data:{...documents.siteProfiles,[operation.profileId]:profile}};
}
export function applicationMutationSatisfied(documents,operation){
 if(operation.type==='profile_selection')return ['activeSiteId','selectedSiteIds'].includes(operation.key)&&jsonValueEqual(documents[operation.key],operation.value);
 if(operation.type==='profile_order')return Array.isArray(operation.profileIds)&&operation.profileIds.length>0&&operation.profileIds.length===Object.keys(documents.siteProfiles||{}).length&&new Set(operation.profileIds).size===operation.profileIds.length&&operation.profileIds.every((id,index)=>documents.siteProfiles?.[id]?.sortIndex===index);
 if(!['profile','profile_create','profile_delete','profile_archive','profile_media'].includes(operation.type))return libraryMutationSatisfied(documents,operation);
 if(operation.type==='profile_delete')return !Object.hasOwn(documents.siteProfiles||{},operation.profileId);
 const actual=documents.siteProfiles?.[operation.profileId];if(!actual)return false;
 if(operation.type==='profile_archive')return actual.archived===operation.archived;
 if(operation.type==='profile_media'){
  if(operation.action==='disable')return actual.mediaDisabled?.[operation.kind]===true;
  const asset=actual.mediaVersions?.find(a=>a.assetId===operation.assetId&&a.kind===operation.kind),ref=operation.kind==='logo'?actual.fields?.['Cloud LOGO']:operation.kind==='featured'?actual.fields?.['Cloud Featured image']:actual.media?.screenshots?.[Number(operation.kind.slice(10))-1];
  return !!asset&&actual.mediaDisabled?.[operation.kind]===false&&ref===asset.ref;
 }
 return Object.entries(operation.profile).every(([key,value])=>key==='fieldNotes'?Object.entries(value||{}).every(([field,desired])=>typeof desired==='string'&&(!desired.trim()||actual.fieldNotes?.[field]===desired.trim())):key==='fields'||key==='media'||key==='mediaDisabled'?Object.entries(value||{}).every(([field,desired])=>jsonValueEqual(actual[key]?.[field],desired)):jsonValueEqual(actual[key],value));
}
