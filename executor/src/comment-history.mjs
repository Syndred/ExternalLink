import {randomUUID} from 'node:crypto';
import {queue} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
const key=input=>'commentHistory:'+input.profileId+'::'+queue.normalizeDestinationKey(input.pageUrl);
export function saveCommentVersion(runtime,input){
 const url=new URL(input.pageUrl);if(!/^https?:$/.test(url.protocol)||!input.profileId)throw Error('请选择产品和普通文章网址');
 if(!Array.isArray(input.drafts)||input.drafts.length!==3||input.drafts.some(d=>typeof d.text!=='string'||d.text.length>4000))throw Error('评论候选格式不正确');
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get(key(input)),versions=saved?.scope===scope?saved.versions:[],payload={drafts:input.drafts.map(d=>({text:d.text})),tone:input.tone||'helpful',language:input.language||'auto',maxChars:Math.min(2000,Math.max(80,Number(input.maxChars)||700)),allowLink:input.allowLink===true};
 if(JSON.stringify(versions[0]?.payload)!==JSON.stringify(payload))versions.unshift({id:randomUUID(),at:new Date().toISOString(),payload});
 runtime.store.set(key(input),{scope,profileId:input.profileId,pageUrl:url.href,versions:versions.slice(0,9)});return{ok:true,versions:versions.slice(0,9)};
}
export function commentHistory(runtime,input){const saved=runtime.store.get(key(input));return{ok:true,versions:saved?.scope===workbenchScope(runtime.store.get('pair'))?saved.versions:[]};}
