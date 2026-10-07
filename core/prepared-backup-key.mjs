import {backupKeys,validateApplicationBackup} from './application-backup.mjs';
import {remapProfileRecoveryKey,mergeProtectedBackupRecords} from './profile-recovery-source.mjs';
import {jsonValueEqual as same} from './json-value.mjs';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value),unsafe=new Set(['__proto__','constructor','prototype']);
export function preparedBackupPatch(base,data){
 const changes=[];
 function visit(previous,next,path){
  if(same(previous,next))return;
  if(object(previous)&&object(next)){for(const key of new Set([...Object.keys(previous),...Object.keys(next)])){if(unsafe.has(key))throw Error('备份含有不安全的字段');if(!Object.hasOwn(next,key))changes.push({path:[...path,key],remove:true});else visit(previous[key],next[key],[...path,key]);}}
  else changes.push({path,value:structuredClone(next)});
 }
 visit(base,data,[]);return changes;
}
export function validateBackupProfileMap(map){
 if(!map||typeof map!=='object'||Array.isArray(map)||Object.entries(map).some(([old,id])=>unsafe.has(old)||unsafe.has(id)||typeof id!=='string'||!/^([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})$/.test(old)||!/^([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})$/.test(id)))throw Error('备份产品对应关系无效');
}
function applyPatch(current,changes){
 let value=structuredClone(current);
 if(!Array.isArray(changes))throw Error('备份合并内容无效');
 for(const change of changes){
  if(!change||!Array.isArray(change.path)||change.path.some(key=>typeof key!=='string'||unsafe.has(key))||Object.keys(change).some(key=>!['path','value','remove'].includes(key))||change.remove!==undefined&&change.remove!==true||change.remove!==true&&!Object.hasOwn(change,'value'))throw Error('备份合并字段无效');
  if(!change.path.length){if(change.remove)throw Error('不能移除整个备份字段');value=structuredClone(change.value);continue;}
  if(!object(value))value={};let parent=value;for(const key of change.path.slice(0,-1)){if(!object(parent[key]))parent[key]={};parent=parent[key];}
  const key=change.path.at(-1);if(change.remove)delete parent[key];else parent[key]=structuredClone(change.value);
 }
 return value;
}
function keepMedia(current,data){
 for(const [id,previous]of Object.entries(current||{})){
  if(!data[id])throw Error('备份不能移除现有产品资料');const versions=new Map();for(const asset of [...(previous.mediaVersions||[]),...(data[id].mediaVersions||[])]){const existing=versions.get(asset.assetId);if(!asset.assetId||existing&&!same(existing,asset))throw Error('同一素材编号内容不一致，合并已停止');versions.set(asset.assetId,asset);}if(versions.size)data[id].mediaVersions=[...versions.values()];
 }return data;
}
function keepRows(current,data){
 const rows=structuredClone(current?.entries||[]),byKey=new Map(),exact=new Set(rows.map(row=>JSON.stringify(row)));for(let i=0;i<rows.length;i++){const key=globalThis.ExtLinkQueue.normalizeDestinationKey(rows[i].indexPage||rows[i].link||'');if(key&&!byKey.has(key))byKey.set(key,i);}
 for(const row of data.entries||[]){const text=JSON.stringify(row);if(exact.has(text))continue;exact.add(text);const key=globalThis.ExtLinkQueue.normalizeDestinationKey(row.indexPage||row.link||'');if(key&&byKey.has(key)){const i=byKey.get(key);rows[i]={...rows[i],...row};}else{if(key)byKey.set(key,rows.length);rows.push(structuredClone(row));}}
 return{...current,...data,entries:rows};
}
export function applyPreparedBackupKey(documents,operation){
 const key=operation.key;if(!backupKeys.includes(key))throw Error('备份字段未授权');const map=operation.profileIdMap||{};validateBackupProfileMap(map);
 const current=remapProfileRecoveryKey(documents[key],key,map),candidate=applyPatch(current,operation.patch);let data=candidate;
 if(candidate===undefined)throw Error('备份未包含该字段');
 if(key==='siteProfiles')data=keepMedia(current,candidate);
 if(key==='submissionRecords')data=mergeProtectedBackupRecords(current,candidate);
 if(key==='submissionTimeline'&&!same(current,candidate))data=globalThis.ExtLinkSubmissionTimeline.mergeTimelines(current,candidate);
 if(key==='sheetTableData')data=keepRows(current,candidate);
 validateApplicationBackup({format:'externallink-submission-backup',submissionRecords:{},siteProfiles:{},[key]:data});
 return data;
}
