import './profiles.js';
import './queue.js';
import './submission-timeline.js';
import './backup.js';

const stableId=id=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id);
export function mergeProtectedBackupRecords(current,candidate){
 const records=globalThis.ExtLinkBackup.mergeRecords(current,candidate),queue=globalThis.ExtLinkQueue;
 for(const [id,record]of Object.entries(current||{}))if(record?.taskId){
  const merged=queue.mergePublicationFields(record,candidate?.[id]||{});
  if(!Object.hasOwn(record,'publicationStatus')&&merged.publicationStatus===queue.inferPublicationStatus(record))delete merged.publicationStatus;
  for(const field of ['publicUrl','evidenceUrl'])if(!Object.hasOwn(record,field)&&!merged[field])delete merged[field];
  records[id]=merged;
 }
 return records;
}
export function remapProfileReferences(row,idMap){
 const remap=id=>idMap[id]||id;
 for(const key of ['projects','submitProjects','submittedProjects'])if(Array.isArray(row[key])){const next=[...new Set(row[key].map(remap))];if(JSON.stringify(next)!==JSON.stringify(row[key])){const sourceKey={projects:'sourceProjects',submitProjects:'sourceSubmitProjects',submittedProjects:'sourceSubmittedProjects'}[key];row[sourceKey]??=structuredClone(row[key]);row[key]=next;}}
 if(row.profileId&&remap(row.profileId)!==row.profileId){row.sourceProfileId??=row.profileId;row.profileId=remap(row.profileId);}
 if(Array.isArray(row.library?.profileIds)){const previous=row.library.profileIds,next=[...new Set(previous.map(remap))];if(JSON.stringify(next)!==JSON.stringify(previous)){row.library.sourceProfileIds??=structuredClone(previous);row.library.profileIds=next;}}
}
export function remapProfileRecords(source,idMap){
 const records={},queue=globalThis.ExtLinkQueue;
 for(const [storedKey,record]of Object.entries(source||{})){
  if(!record||typeof record!=='object'){records[storedKey]=record;continue;}
  const separator=storedKey.lastIndexOf('::'),profileId=record.profileId||(separator<0?'':storedKey.slice(separator+2)),destinationKey=record.destinationKey||queue.normalizeDestinationKey(record.destinationUrl||(separator<0?'':storedKey.slice(0,separator)));
  if(!idMap[profileId]||idMap[profileId]===profileId){Object.assign(records,globalThis.ExtLinkBackup.mergeRecords(records,{[storedKey]:structuredClone(record)}));continue;}
  if(!profileId||!destinationKey){records[storedKey]=structuredClone(record);continue;}
  const next=queue.remapSubmissionRecords({original:{...record,profileId,destinationKey}},idMap);
  Object.assign(records,globalThis.ExtLinkBackup.mergeRecords(records,next));
 }
 return records;
}
export function remapProfileRecoveryKey(value,key,idMap){
 const data=structuredClone(value);if(data===undefined||!Object.keys(idMap).length)return data;
 const remap=id=>idMap[id]||id;
 if(key==='activeSiteId')return remap(data);
 if(key==='selectedSiteIds')return [...new Set(data.map(remap))];
 if(key==='submissionRecords')return remapProfileRecords(data,idMap);
 if(key==='siteProfiles'){
  const projects=Object.fromEntries([...new Set(Object.entries(idMap).filter(([old,stable])=>data[old]||data[stable]).map(([,stable])=>stable))].map(id=>[id,{}])),seeded=globalThis.ExtLinkProfiles.stabilizeTableProfiles(projects,data).profiles;
  for(const [id,profile]of Object.entries(seeded)){const versions=new Map();for(const old of [id,...Object.keys(idMap).filter(old=>idMap[old]===id)])for(const asset of data[old]?.mediaVersions||[]){const previous=versions.get(asset.assetId);if(!asset.assetId||previous&&JSON.stringify(previous)!==JSON.stringify(asset))throw Error('同一素材编号内容不一致，合并已停止');versions.set(asset.assetId,asset);}if(versions.size)profile.mediaVersions=[...versions.values()];}return seeded;
 }
 if(key==='sheetTableData'){for(const row of data.entries||[])remapProfileReferences(row,idMap);if(data.submissionRecords)data.submissionRecords=remapProfileRecords(data.submissionRecords,idMap);}
 if(key==='siteAnnotations')for(const row of Object.values(data))if(row&&typeof row==='object')remapProfileReferences(row,idMap);
 if(key==='linkMonitorResults'){const result={};for(const [old,row]of Object.entries(data)){const separator=old.lastIndexOf('::'),next=separator<0?old:old.slice(0,separator+2)+remap(old.slice(separator+2));if(Object.hasOwn(result,next)&&JSON.stringify(result[next])!==JSON.stringify(row))throw Error('旧产品监测引用内容不同，请先核对来源');result[next]=row;}return result;}
 return data;
}
export function prepareProfileRecoverySource(original){
 const documents=structuredClone(original),table=documents.sheetTableData||{},projects=table.projects||{};
 if(!projects||typeof projects!=='object'||Array.isArray(projects)||Object.entries(projects).some(([id,fields])=>!stableId(id)||!fields||typeof fields!=='object'||Array.isArray(fields)))throw Error('恢复来源的表格产品资料格式无效');
 const seeded=globalThis.ExtLinkProfiles.stabilizeTableProfiles(projects,documents.siteProfiles||{}),remap=id=>seeded.idRemap[id]||id;
 const changed=seeded.changed||Object.keys(seeded.idRemap).length;
 const active=remap(documents.activeSiteId||''),activeSiteId=active&&seeded.profiles[active]?active:Object.keys(seeded.profiles)[0]||'',selectedSiteIds=[...new Set((documents.selectedSiteIds||[]).map(remap).filter(id=>seeded.profiles[id]))];
 if(!changed)return Object.keys(seeded.profiles).length?{...documents,activeSiteId,selectedSiteIds}:documents;
 // The source file remains immutable. Prepared identities follow the original table
 // seeding rule; every original receipt field and source row stays recoverable.
 for(const [id,profile]of Object.entries(seeded.profiles)){
  const versions=new Map();
  for(const originalId of [id,...Object.keys(seeded.idRemap).filter(old=>remap(old)===id)])for(const asset of documents.siteProfiles?.[originalId]?.mediaVersions||[]){
   if(!asset?.assetId)throw Error('恢复素材版本缺少编号');
   const previous=versions.get(asset.assetId);if(previous&&JSON.stringify(previous)!==JSON.stringify(asset))throw Error('同一素材编号内容不一致，恢复已停止');
   versions.set(asset.assetId,asset);
  }
  if(versions.size)profile.mediaVersions=[...versions.values()];
 }
 documents.siteProfiles=seeded.profiles;
 documents.activeSiteId=activeSiteId;documents.selectedSiteIds=selectedSiteIds;
 const sourceTable=structuredClone(table),annotations=documents.siteAnnotations||{};
 const mapFields=row=>remapProfileReferences(row,seeded.idRemap);
 for(const row of table.entries||[])mapFields(row);
 if(table.submissionRecords)table.submissionRecords=remapProfileRecords(table.submissionRecords,seeded.idRemap);
 for(const annotation of Object.values(annotations))if(annotation&&typeof annotation==='object'){
  mapFields(annotation);
 }
 const queue=globalThis.ExtLinkQueue,combined={...(documents.submissionRecords||{})};
 for(const [key,record]of Object.entries(table.submissionRecords||{}))combined[key]=combined[key]?queue.mergePublicationFields(combined[key],record):record;
 const records=remapProfileRecords(combined,seeded.idRemap);
 documents.submissionRecords=queue.migrateSubmissionRecords({records,annotations,tableData:table}).records;
 documents.submissionSchemaVersion=queue.SUBMISSION_SCHEMA_VERSION;
 const timeline=globalThis.ExtLinkSubmissionTimeline;
 documents.submissionTimeline=timeline.migrateLegacy({timeline:documents.submissionTimeline||{},submissionRecords:documents.submissionRecords,tableData:sourceTable,profileIdMap:seeded.idRemap}).timeline;
 documents.timelineSchemaVersion=Math.max(Number(documents.timelineSchemaVersion||1),timeline.SCHEMA_VERSION);
 if(documents.linkMonitorResults){const results={};for(const [key,result]of Object.entries(documents.linkMonitorResults)){const separator=key.lastIndexOf('::'),profile=separator<0?'':key.slice(separator+2),next=separator<0?key:key.slice(0,separator+2)+remap(profile);if(Object.hasOwn(results,next)&&JSON.stringify(results[next])!==JSON.stringify(result))throw Error('旧产品的监测记录对应同一入口但内容不同，请先核对来源');results[next]=result;}documents.linkMonitorResults=results;}
 return documents;
}
export function profileRecoveryDependencyKeys(original,prepared){
 if(JSON.stringify(Object.keys(original.siteProfiles||{}).sort())===JSON.stringify(Object.keys(prepared.siteProfiles||{}).sort()))return[];
 return ['siteProfiles','activeSiteId','selectedSiteIds','sheetTableData','submissionRecords','submissionTimeline','siteAnnotations','linkMonitorResults'].filter(key=>Object.hasOwn(prepared,key));
}
