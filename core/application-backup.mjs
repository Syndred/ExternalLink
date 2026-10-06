import './queue.js';
import './submission-timeline.js';
import './backup.js';
import {normalizeLegacyPreferences} from './application-preferences.mjs';
export const backupKeys=Object.freeze(['submissionRecords','submissionSchemaVersion','siteAnnotations','deletedSubmissionKeys','siteProfiles','activeSiteId','selectedSiteIds','urlList','submissionTimeline','timelineSchemaVersion','sheetTableData','domainBlacklist','targetFilters','domainMetricsCache','linkMonitorResults','linkMonitorSchedule','autoSubmitStandardWpComments','autoSubmitDirectoryListings','cfgEmail','cfgName','cfgCommentTemplate','cfgPingIndex','autoFillOnVisit']);
const dangerous=new Set(['__proto__','prototype','constructor']);
function validateTree(value){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(dangerous.has(key))throw Error('备份含有不安全的字段');validateTree(child);}}
export function validateApplicationBackup(raw){
 validateTree(raw);const value=normalizeLegacyPreferences(globalThis.ExtLinkBackup.validateBackup(raw));
 for(const key of ['autoSubmitStandardWpComments','autoSubmitDirectoryListings'])if(Object.hasOwn(value,key)&&typeof value[key]!=='boolean')throw Error('备份自动提交设置格式无效：'+key);
 if(Object.hasOwn(value,'cfgPingIndex')&&typeof value.cfgPingIndex!=='boolean')throw Error('备份搜索引擎通知设置格式无效');
 if(Object.hasOwn(value,'autoFillOnVisit')&&typeof value.autoFillOnVisit!=='boolean')throw Error('备份访问自动填写设置格式无效');
 for(const key of ['submissionRecords','siteProfiles','siteAnnotations','domainMetricsCache','linkMonitorResults'])if(value[key]!==undefined&&(!value[key]||typeof value[key]!=='object'||Array.isArray(value[key])))throw Error('备份字段格式无效：'+key);
 if(value.sheetTableData!=null&&(!Array.isArray(value.sheetTableData.entries)||value.sheetTableData.entries.some(r=>!r||typeof r!=='object'||Array.isArray(r))))throw Error('备份网站表格格式无效');
 if(value.urlList!==undefined&&typeof value.urlList!=='string')throw Error('备份网址列表格式无效');
 for(const id of Object.keys(value.siteProfiles))if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id))throw Error('备份产品身份无效');
 return value;
}
export function exportApplicationBackup(documents){documents=normalizeLegacyPreferences(documents);return{format:globalThis.ExtLinkBackup.FORMAT,version:Number(documents.submissionSchemaVersion||1),exportedAt:new Date().toISOString(),...Object.fromEntries(backupKeys.filter(k=>documents[k]!==undefined).map(k=>[k,structuredClone(documents[k])])),submissionRecords:structuredClone(documents.submissionRecords||{}),siteProfiles:structuredClone(documents.siteProfiles||{}),submissionTimeline:structuredClone(documents.submissionTimeline||{})};}
export function backupKeyDependencies(key){
 if(!backupKeys.includes(key))throw Error('不支持的备份字段');
 return [...new Set([key,'submissionSchemaVersion',...(['activeSiteId','selectedSiteIds'].includes(key)?['siteProfiles']:[]),...(['submissionTimeline','timelineSchemaVersion'].includes(key)?['submissionTimeline','timelineSchemaVersion']:[])])];
}
export function applicationBackupFragment(backup,key){
 if(!backupKeys.includes(key))throw Error('不支持的备份字段');
 backup=normalizeLegacyPreferences(backup);
 const fragment={format:globalThis.ExtLinkBackup.FORMAT,version:backup.version,submissionRecords:{},siteProfiles:{}};
 if(Object.hasOwn(backup,key))fragment[key]=structuredClone(backup[key]);
 if(['activeSiteId','selectedSiteIds'].includes(key))fragment.siteProfiles=Object.fromEntries(Object.keys(backup.siteProfiles||{}).map(id=>[id,{id}]));
 if(key==='submissionTimeline')fragment.timelineSchemaVersion=backup.timelineSchemaVersion;
 if(key==='timelineSchemaVersion'&&Object.hasOwn(backup,'submissionTimeline'))fragment.submissionTimeline={};
 return fragment;
}
export function mergeApplicationBackup(documents,raw){
 const backup=validateApplicationBackup(raw),merged=globalThis.ExtLinkBackup.mergeBackup(documents,backup,Math.max(Number(documents.submissionSchemaVersion||1),Number(backup.version||1)));
 // Version history is additive even when an incoming profile selects an older asset.
 for(const [id,profile]of Object.entries(merged.siteProfiles)){const assets=[...(documents.siteProfiles?.[id]?.mediaVersions||[]),...(backup.siteProfiles?.[id]?.mediaVersions||[])],byId=new Map();for(const asset of assets){if(!asset?.assetId)throw Error('备份媒体版本缺少身份');const existing=byId.get(asset.assetId);if(existing&&JSON.stringify(existing)!==JSON.stringify(asset))throw Error('同一媒体版本存在不同内容，请先核对原素材');byId.set(asset.assetId,asset);}if(assets.length)profile.mediaVersions=[...byId.values()];}
 if(backup.sheetTableData){const table=documents.sheetTableData||{entries:[]},rows=structuredClone(table.entries||[]),byKey=new Map(),exactRows=new Set(rows.map(r=>JSON.stringify(r)));rows.forEach((row,i)=>{const key=globalThis.ExtLinkQueue.normalizeDestinationKey(row.indexPage||row.link||'');if(key&&!byKey.has(key))byKey.set(key,i);});for(const row of backup.sheetTableData.entries){const serialized=JSON.stringify(row);if(exactRows.has(serialized))continue;exactRows.add(serialized);const key=globalThis.ExtLinkQueue.normalizeDestinationKey(row.indexPage||row.link||'');if(!key){if(!rows.some(existing=>JSON.stringify(existing)===JSON.stringify(row)))rows.push(row);continue;}if(byKey.has(key)){const i=byKey.get(key);rows[i]={...rows[i],...row};}else{byKey.set(key,rows.length);rows.push(row);}}merged.sheetTableData={...table,...backup.sheetTableData,entries:rows};}
 for(const key of backupKeys)if(backup[key]!==undefined&&!Object.hasOwn(merged,key)&&key!=='sheetTableData')merged[key]=['domainMetricsCache','linkMonitorResults'].includes(key)?{...(documents[key]||{}),...backup[key]}:structuredClone(backup[key]);
 return Object.fromEntries(Object.entries(merged).filter(([key])=>backupKeys.includes(key)));
}
