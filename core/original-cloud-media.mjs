import './profiles.js';

// The original PostgreSQL catalogue orders by file_name, whereas R2 pages
// order by object key. Sort only after all pages have been collected.
export function sortOriginalMediaCatalogue(assets){
 return assets.sort((a,b)=>{const left=String(a.file_name||a.asset_id||''),right=String(b.file_name||b.asset_id||'');return left<right?-1:left>right?1:0;});
}

// The original fillFormUntilReady prefers the current product's cloud logo
// and ordered screenshots. Freeze that default once at run registration;
// explicit selected versions and disabled slots continue to belong to the user.
export function originalCloudMediaDefaults(profile,assets=[]){
 const P=globalThis.ExtLinkProfiles,config=P.buildAgentConfigFromProfile(profile),id=P.canonicalProfileId(profile.id||config.projectKey||config.brandName);
 if(!id)return{};
 const own=assets.filter(asset=>asset?.asset_id&&P.canonicalProfileId(asset.profile_id)===id&&/^image\//i.test(asset.content_type||'')),defaults={};
 if(!config.mediaDisabled?.logo&&!String(config.logoUrl||'').startsWith('cloud-media://')){const logo=own.find(asset=>asset.media_kind==='logo');if(logo)defaults.logo='cloud-media://'+logo.asset_id;}
 if(!(config.screenshots||[]).some(ref=>String(ref).startsWith('cloud-media://'))){
  const screenshots=own.filter(asset=>asset.media_kind==='screenshot'||/^screenshot[1-4]$/.test(asset.media_kind||'')).map(asset=>({...asset,index:Number(asset.media_index??asset.media_kind.match(/([1-4])$/)?.[1]??0)})).sort((a,b)=>a.index-b.index);
  if(screenshots.length)defaults.screenshots=screenshots.map((asset,index)=>config.mediaDisabled?.['screenshot'+(index+1)]?'':'cloud-media://'+asset.asset_id);
 }
 return defaults;
}

export function applyOriginalCloudMediaDefaults(config,defaults={}){
 const result={...config,projectFields:{...config.projectFields}};
 if(defaults.logo&&!config.mediaDisabled?.logo&&!String(config.logoUrl||'').startsWith('cloud-media://'))Object.assign(result,{logoUrl:defaults.logo,projectFields:{...result.projectFields,'Cloud LOGO':defaults.logo}});
 if(defaults.screenshots&&!(config.screenshots||[]).some(ref=>String(ref).startsWith('cloud-media://')))result.screenshots=defaults.screenshots.map((ref,index)=>config.mediaDisabled?.['screenshot'+(index+1)]?'':ref);
 return result;
}

// Original lookup failure must not prevent public/embedded media from filling.
// Only this optional catalogue read falls back; explicit selected-version
// validation and frozen attachment checks must still reject invalid images.
export async function resolveOriginalCloudMediaDefaults(profile,list,{timeoutMs=4000}={}){
 let timer,timedOut=false;
 try{
  const assets=await Promise.race([Promise.resolve().then(list),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(Error('云端媒体清单超时'));},timeoutMs);})]);
  return{originalMediaDefaults:originalCloudMediaDefaults(profile,sortOriginalMediaCatalogue([...assets]))};
 }catch{
  return{originalMediaDefaults:{},originalMediaLookupWarning:timedOut?'云端媒体清单超过4秒，保留原资料图片':'云端媒体清单暂不可用，保留原资料图片'};
 }finally{clearTimeout(timer);}
}

// Old native runs already froze a product-owned catalogue. Recover defaults
// only from that immutable catalogue; never read today's assets for an old run.
export function frozenOriginalMediaDefaults(run){
 if(!run?.profile)return{};
 if(Object.hasOwn(run,'originalMediaDefaults'))return run.originalMediaDefaults||{};
 const assets=(run.mediaManifest||[]).filter(asset=>/^[a-f0-9]{64}$/.test(asset.sha256||'')&&(/^image\//i.test(asset.content_type||'')||/\.(png|jpe?g|webp|gif|svg)$/i.test(asset.file_name||''))).map(asset=>({...asset,profile_id:run.profileId,content_type:asset.content_type||'image/'+asset.file_name.split('.').at(-1)}));
 return originalCloudMediaDefaults(run.profile,assets);
}

export async function listOriginalD1Media(bucket,workspace){
 if(!bucket?.list)return[];
 const prefix=`workspaces/${workspace}/media/`,assets=[],seen=new Set();let cursor;
 do{const page=await bucket.list({prefix,limit:200,cursor,include:['customMetadata','httpMetadata']});
  for(const object of page.objects||[])assets.push({asset_id:object.key.slice(prefix.length),file_name:object.customMetadata?.fileName||object.key.slice(prefix.length),profile_id:object.customMetadata?.profileId||'',media_kind:object.customMetadata?.kind||'',content_type:object.httpMetadata?.contentType||'',media_index:object.customMetadata?.mediaIndex});
  cursor=page.truncated?page.cursor:undefined;if(cursor&&seen.has(cursor))throw Error('云端媒体分页游标重复');if(cursor)seen.add(cursor);
 }while(cursor);
 return sortOriginalMediaCatalogue(assets);
}
