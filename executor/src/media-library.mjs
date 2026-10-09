import {profileMediaReferences} from '../../core/media-assets.mjs';
export async function mediaLibrary(runtime,{catalogueOnly=false}={}){
 const assets=[],seen=new Set();let cursor='';do{const page=await runtime.cloud.request('workspace/media'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(!Array.isArray(page.assets))throw Error('云端媒体目录格式无法识别');assets.push(...page.assets);cursor=page.next||'';if(cursor&&seen.has(cursor))throw Error('云端媒体分页游标重复');if(cursor)seen.add(cursor);}while(cursor);
 if(catalogueOnly===true)return{ok:true,at:new Date().toISOString(),assets};
 const snapshot=await runtime.cloud.request('snapshot'),references=Object.values(snapshot.documents.siteProfiles||{}).flatMap(p=>profileMediaReferences(p).map(r=>({...r,profileId:p.id,profileName:p.name||p.fields?.Name||p.id}))),ids=new Set(assets.map(a=>a.asset_id));
 return{ok:true,at:new Date().toISOString(),assets,references,missing:references.filter(r=>!ids.has(r.ref.slice(14)))};
}
