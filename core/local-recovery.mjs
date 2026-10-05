import {backupKeys,validateApplicationBackup} from './application-backup.mjs';
import {normalizeLegacyPreferences} from './application-preferences.mjs';
const objectKeys=new Set(['targetFilters','linkMonitorSchedule']);
const arrayKeys=new Set(['selectedSiteIds','deletedSubmissionKeys','domainBlacklist']);
const stringKeys=new Set(['activeSiteId','cfgEmail','cfgName','cfgCommentTemplate']);
function validateValue(key,value){
 if(objectKeys.has(key)&&(!value||typeof value!=='object'||Array.isArray(value)))throw Error('恢复资料格式无效：'+key);
 if(arrayKeys.has(key)&&(!Array.isArray(value)||value.some(item=>typeof item!=='string')))throw Error('恢复资料格式无效：'+key);
 if(stringKeys.has(key)&&typeof value!=='string')throw Error('恢复资料格式无效：'+key);
 if(key.startsWith('autoSubmit')&&typeof value!=='boolean')throw Error('恢复资料格式无效：'+key);
 if(key.endsWith('SchemaVersion')&&(!Number.isSafeInteger(Number(value))||Number(value)<1))throw Error('恢复资料版本无效：'+key);
}

export function localRecoveryDocuments(raw){
 const value=normalizeLegacyPreferences(raw?.documents||raw?.snapshot?.documents||raw||{});
 if(!value||typeof value!=='object'||!Object.keys(value.siteProfiles||{}).length)throw Error('恢复来源没有产品资料，不能恢复');
 const picked=Object.fromEntries(backupKeys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
 validateApplicationBackup({format:'externallink-submission-backup',submissionRecords:{},...picked});for(const [key,value]of Object.entries(picked))validateValue(key,value);return structuredClone(picked);
}
export function recoveryDocument(documents,key,raw){
 if(!backupKeys.includes(key))throw Error('恢复字段未授权');
 validateValue(key,raw);
 validateApplicationBackup({format:'externallink-submission-backup',submissionRecords:{},siteProfiles:{},[key]:raw});
 let data=structuredClone(raw);if(data===undefined)throw Error('恢复资料缺失');
 if(key==='submissionRecords'){
  data=structuredClone(documents.submissionRecords||{});for(const [id,incoming]of Object.entries(raw)){const previous=data[id];if(previous?.taskId||previous?.status==='success')continue;data[id]={...previous,...incoming};}
 }else if(key==='submissionTimeline'&&JSON.stringify(documents.submissionTimeline)!==JSON.stringify(data))data=globalThis.ExtLinkSubmissionTimeline.mergeTimelines(documents.submissionTimeline||{},data);
 else if(key==='submissionSchemaVersion'||key==='timelineSchemaVersion')data=Math.max(Number(documents[key]||1),Number(data||1));
 else if(key==='siteProfiles'){
  for(const [id,profile]of Object.entries(data)){const history=new Map();for(const asset of [...(documents.siteProfiles?.[id]?.mediaVersions||[]),...(profile.mediaVersions||[])]){if(!asset?.assetId)throw Error('恢复素材版本缺少编号');const existing=history.get(asset.assetId);if(existing&&JSON.stringify(existing)!==JSON.stringify(asset))throw Error('同一素材编号内容不一致，恢复已停止');history.set(asset.assetId,asset);}if(history.size)profile.mediaVersions=[...history.values()];}
 }
 return data;
}
