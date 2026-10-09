import {randomUUID} from 'node:crypto';
import {queue} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
const originalSnapshotKey=payload=>[payload?.text||'',payload?.tone||'',...(payload?.drafts||[]).map(draft=>draft?.text||'')].join('\u0001');
const key=input=>'commentHistory:'+input.profileId+'::'+queue.normalizeDestinationKey(input.pageUrl);
export function copyCommentDraft(draft){
 if(!draft||typeof draft!=='object')return null;
 return{text:String(draft.text||''),angle:String(draft.angle||''),anchorText:String(draft.anchorText||''),placement:String(draft.placement||''),...(Number.isFinite(Number(draft.chars))?{chars:Number(draft.chars)}:{})};
}
export function saveCommentVersion(runtime,input){
 const url=new URL(input.pageUrl);if(!/^https?:$/.test(url.protocol)||!input.profileId)throw Error('请选择产品和普通文章网址');
 if(!Array.isArray(input.drafts)||input.drafts.length>5||input.drafts.some(d=>!d||typeof d.text!=='string')||!input.drafts.length&&(typeof input.text!=='string'||!input.text.trim())||input.text!==undefined&&typeof input.text!=='string')throw Error('评论候选格式不正确');
 if(input.selected!==undefined&&(!Number.isInteger(input.selected)||input.selected<0||input.selected>=input.drafts.length))throw Error('评论候选选择无效');
 if(input.label!==undefined&&!['切换候选前','恢复前','重新生成前'].includes(input.label))throw Error('评论快照来源无效');
 const scope=workbenchScope(runtime.store.get('pair')),saved=runtime.store.get(key(input)),versions=saved?.scope===scope?saved.versions:[],payload={drafts:input.drafts.map(copyCommentDraft),tone:input.tone||'helpful',language:input.language||'auto',maxChars:Math.min(2000,Math.max(80,Number(input.maxChars)||700)),allowLink:input.allowLink===true};
 if(input.text!==undefined)payload.text=input.text;
 if(input.selected!==undefined)payload.selected=input.selected;
 if(input.captureBeforeSwitch===true&&versions.length&&originalSnapshotKey(versions[0].payload)===originalSnapshotKey(payload))return{ok:true,versions:versions.slice(0,9)};
 if(JSON.stringify(versions[0]?.payload)!==JSON.stringify(payload))versions.unshift({id:randomUUID(),at:new Date().toISOString(),...(input.label?{label:input.label}:{}),payload});
 runtime.store.set(key(input),{scope,profileId:input.profileId,pageUrl:url.href,versions:versions.slice(0,9)});return{ok:true,versions:versions.slice(0,9)};
}
export function commentHistory(runtime,input){const saved=runtime.store.get(key(input));return{ok:true,versions:saved?.scope===workbenchScope(runtime.store.get('pair'))?saved.versions:[]};}
