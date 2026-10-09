import {randomUUID,createHash} from 'node:crypto';
import {queue} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {copyCommentDraft} from './comment-history.mjs';

const snapshotKey=payload=>[payload?.text||'',payload?.tone||'',...(payload?.drafts||[]).map(draft=>draft?.text||'')].join('\u0001');
function owner(runtime,input){
 const url=new URL(input.pageUrl);if(!/^https?:$/.test(url.protocol)||typeof input.profileId!=='string'||!input.profileId)throw Error('请选择产品和普通文章网址');
 const scope=workbenchScope(runtime.store.get('pair')),article=queue.normalizeDestinationKey(url.href);
 return {scope,profileId:input.profileId,pageUrl:url.href,key:'originalCommentState:'+createHash('sha256').update(scope).digest('hex')+':'+input.profileId+'::'+article,legacyKey:'commentHistory:'+input.profileId+'::'+article};
}
function payload(value){
 if(!value||!Array.isArray(value.drafts)||value.drafts.length>5||value.drafts.some(d=>!d||typeof d.text!=='string')||value.text!==undefined&&typeof value.text!=='string')throw Error('评论候选格式不正确');
 if(value.selected!==undefined&&(!Number.isInteger(value.selected)||value.selected< -1||value.selected>=value.drafts.length))throw Error('评论候选选择无效');
 return {...value,drafts:value.drafts.map(copyCommentDraft),text:value.text||'',selected:Number.isInteger(value.selected)?value.selected:-1,tone:value.tone||'helpful'};
}
function state(runtime,identity){
 const saved=runtime.store.get(identity.key);if(saved){if(saved.schema!==1||saved.scope!==identity.scope)throw Error('原评论历史状态无效');return structuredClone(saved);}
 const legacy=runtime.store.get(identity.legacyKey),validLegacy=legacy?.scope===identity.scope?legacy:null;
 return {schema:1,scope:identity.scope,profileId:identity.profileId,pageUrl:identity.pageUrl,active:null,versions:(validLegacy?.versions||[]).slice(0,8).map(v=>structuredClone(v)),legacyArchive:validLegacy?structuredClone(validLegacy):null};
}
export function originalCommentState(runtime,input){const identity=owner(runtime,input);return {ok:true,...state(runtime,identity)};}
export function captureOriginalCommentState(runtime,input){
 const identity=owner(runtime,input),next=state(runtime,identity),current=payload(input.current);
 if(input.label!==undefined&&!['切换候选前','恢复前','重新生成前','上一版'].includes(input.label))throw Error('评论快照来源无效');
 next.active=current;
 if(input.capture!==false&&(current.text.trim()||current.drafts.length)&&snapshotKey(next.versions[0]?.payload)!==snapshotKey(current))next.versions=[{id:randomUUID(),at:new Date().toISOString(),label:input.label||'上一版',payload:current},...next.versions].slice(0,8);
 runtime.store.set(identity.key,next);return {ok:true,...next};
}
export function restoreOriginalCommentState(runtime,input){
 const identity=owner(runtime,input),next=state(runtime,identity);
 if(typeof input.versionId!=='string'||!input.versionId)throw Error('请选择原历史快照');
 const target=next.versions.find(v=>v.id===input.versionId);if(!target)throw Error('历史快照已变化，请重新载入');
 const current=payload(input.current),restored=payload(target.payload);
 if((current.text.trim()||current.drafts.length)&&snapshotKey(current)!==snapshotKey(restored))next.versions=[{id:randomUUID(),at:new Date().toISOString(),label:'恢复前',payload:current},...next.versions.filter(v=>v.id!==target.id)].slice(0,8);
 // The original keeps raw text first, then the selected candidate as fallback.
 next.active={...restored,text:restored.text||restored.drafts[restored.selected]?.text||'',tone:target.payload.tone||current.tone};
 runtime.store.set(identity.key,next);return {ok:true,...next};
}
