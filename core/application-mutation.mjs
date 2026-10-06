import {libraryMutation,libraryMutationSatisfied} from './library-mutation.mjs';
const badRequest=message=>Object.assign(new Error(message),{status:400});
export function applicationMutation(documents,operation,options){
 if(!['profile','profile_create','profile_delete','profile_archive','profile_media'].includes(operation.type))return libraryMutation(documents,operation,options);
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(operation.profileId||'')||['constructor','prototype','__proto__'].includes(operation.profileId))throw badRequest('无效资料身份');
 const original=documents.siteProfiles?.[operation.profileId],patch=operation.profile;
 if(operation.type==='profile_delete'){
  if(!original)throw badRequest('产品资料已不存在');
  const data={...documents.siteProfiles};delete data[operation.profileId];return{key:'siteProfiles',data};
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
 if(Object.keys(patch).some(key=>!['id','name','url','fields','fieldNotes','media','mediaVersions','mediaDisabled','language','targetAudience','valueProposition','useCases','sellablePoints','avoidContent','anchorRules','blogRules'].includes(key)))throw badRequest('无效资料字段');
 if(patch.fieldNotes!==undefined&&(!patch.fieldNotes||typeof patch.fieldNotes!=='object'||Array.isArray(patch.fieldNotes)||Object.entries(patch.fieldNotes).some(([key,value])=>['__proto__','constructor','prototype'].includes(key)||typeof value!=='string'||value.length>100000)))throw badRequest('无效字段备注');
 for(const key of ['language','targetAudience','valueProposition'])if(patch[key]!==undefined&&(typeof patch[key]!=='string'||patch[key].length>10000))throw badRequest('无效资料说明');
 for(const key of ['useCases','sellablePoints','avoidContent'])if(patch[key]!==undefined&&(!Array.isArray(patch[key])||patch[key].length>100||patch[key].some(v=>typeof v!=='string'||v.length>10000)))throw badRequest('无效资料列表');
 if(patch.anchorRules!==undefined){const rules=patch.anchorRules;if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.entries(rules).some(([k,v])=>k==='allowExactMatch'?typeof v!=='boolean':!['brandKeywords','urlKeywords','naturalExpressions','keywordExpressions','avoidWords'].includes(k)||!Array.isArray(v)||v.length>100||v.some(s=>typeof s!=='string'||s.length>10000)))throw badRequest('无效推广链接规则');}
 if(patch.blogRules!==undefined){const rules=patch.blogRules;if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.entries(rules).some(([k,v])=>k==='tone'?!['helpful','professional','casual','enthusiastic'].includes(v):k==='maxLinksPerDraft'?(!Number.isSafeInteger(v)||v<0):k==='preferredAnchor'?!['natural','brand','keyword','url'].includes(v):true))throw badRequest('无效评论规则');}
 if(patch.mediaVersions!==undefined&&(!Array.isArray(patch.mediaVersions)||(original?.mediaVersions||[]).some((asset,index)=>JSON.stringify(asset)!==JSON.stringify(patch.mediaVersions[index]))))throw badRequest('历史媒体版本只能保留并追加，不能改写或删除');
 for(const [key,value]of Object.entries(patch.fields||{}))if(typeof value!=='string'||value.length>100000||/password|secret|token|api.?key/i.test(key))throw badRequest('无效或敏感资料字段');
 if(patch.name!==undefined&&(typeof patch.name!=='string'||!patch.name.trim()||patch.name.length>200))throw badRequest('无效产品名称');
 if(patch.url!==undefined){let url;try{url=new URL(patch.url);}catch{throw badRequest('无效产品网址');}if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw badRequest('无效产品网址');}
 if(operation.type==='profile_create'&&(!patch.name||!patch.url))throw badRequest('新增产品需要名称和网址');
 const profile={...original,...patch,fields:{...original?.fields,...patch.fields},...(patch.fieldNotes!==undefined?{fieldNotes:{...original?.fieldNotes,...Object.fromEntries(Object.entries(patch.fieldNotes).map(([key,value])=>[key,value.trim()]).filter(([,value])=>value))}}:{}),media:{...original?.media,...patch.media},...(operation.type==='profile_create'?{createdAt:operation.at,archived:false}:{}),updatedAt:operation.at};
 return{key:'siteProfiles',data:{...documents.siteProfiles,[operation.profileId]:profile}};
}
export function applicationMutationSatisfied(documents,operation){
 if(!['profile','profile_create','profile_delete','profile_archive','profile_media'].includes(operation.type))return libraryMutationSatisfied(documents,operation);
 if(operation.type==='profile_delete')return !Object.hasOwn(documents.siteProfiles||{},operation.profileId);
 const actual=documents.siteProfiles?.[operation.profileId];if(!actual)return false;
 if(operation.type==='profile_archive')return actual.archived===operation.archived;
 if(operation.type==='profile_media'){
  if(operation.action==='disable')return actual.mediaDisabled?.[operation.kind]===true;
  const asset=actual.mediaVersions?.find(a=>a.assetId===operation.assetId&&a.kind===operation.kind),ref=operation.kind==='logo'?actual.fields?.['Cloud LOGO']:operation.kind==='featured'?actual.fields?.['Cloud Featured image']:actual.media?.screenshots?.[Number(operation.kind.slice(10))-1];
  return !!asset&&actual.mediaDisabled?.[operation.kind]===false&&ref===asset.ref;
 }
 return Object.entries(operation.profile).every(([key,value])=>key==='fieldNotes'?Object.entries(value||{}).every(([field,desired])=>typeof desired==='string'&&(!desired.trim()||actual.fieldNotes?.[field]===desired.trim())):key==='fields'||key==='media'||key==='mediaDisabled'?Object.entries(value||{}).every(([field,desired])=>JSON.stringify(actual[key]?.[field])===JSON.stringify(desired)):JSON.stringify(actual[key])===JSON.stringify(value));
}
