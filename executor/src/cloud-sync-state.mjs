import {createHash} from 'node:crypto';
import {backupKeys} from '../../core/application-backup.mjs';
export const cloudDocumentKeys=Object.freeze([...new Set([...backupKeys,'linkMonitorEnabled','linkMonitorMinutes'])]);
export const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const cloudDigest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function normalizeCloudRevisions(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('云端修订号响应不完整，暂无法确认同步状态');
 return Object.fromEntries(Object.entries(value).filter(([key,revision])=>cloudDocumentKeys.includes(key)&&Number.isInteger(Number(revision))&&Number(revision)>=0).map(([key,revision])=>[key,Number(revision)]));
}
export function cloudSnapshot(pair,value){
 if(!value||!value.documents||typeof value.documents!=='object'||Array.isArray(value.documents)||value.workspaceId!==undefined&&value.workspaceId!==(pair.workspaceId||'default')||pair.deviceId&&value.deviceId!==undefined&&value.deviceId!==pair.deviceId)throw Error('云端设备、工作区或资料响应不完整，原资料保留');
 return{documents:Object.fromEntries(cloudDocumentKeys.filter(key=>Object.hasOwn(value.documents,key)).map(key=>[key,value.documents[key]])),revisions:normalizeCloudRevisions(value.revisions)};
}
export function cacheCloudSnapshot(runtime,remote){
 const pair=runtime.store.get('pair'),scope=String(pair?.endpoint||'')+'|'+String(pair?.workspaceId||'default'),fresh=cloudSnapshot(pair,remote),saved=runtime.store.get('applicationSnapshot'),old=saved?.scope===scope?saved.snapshot:{documents:{},revisions:{}};
 const snapshot={documents:{...old.documents,...fresh.documents},revisions:{...old.revisions,...fresh.revisions}};runtime.store.set('applicationSnapshot',{scope,snapshot,remoteSnapshot:fresh,at:new Date().toISOString()});return snapshot;
}
