import './profiles.js';
import './queue.js';
import './submission-timeline.js';
import './backup.js';

const stableId=id=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)&&!['constructor','prototype','__proto__'].includes(id);
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
 const mapFields=row=>{
  for(const key of ['projects','submitProjects','submittedProjects'])if(Array.isArray(row[key])){const next=[...new Set(row[key].map(remap))];if(JSON.stringify(next)!==JSON.stringify(row[key])){const sourceKey={projects:'sourceProjects',submitProjects:'sourceSubmitProjects',submittedProjects:'sourceSubmittedProjects'}[key];row[sourceKey]??=structuredClone(row[key]);row[key]=next;}}
  if(row.profileId&&remap(row.profileId)!==row.profileId){row.sourceProfileId??=row.profileId;row.profileId=remap(row.profileId);}
 };
 for(const row of table.entries||[])mapFields(row);
 if(table.submissionRecords)table.submissionRecords=globalThis.ExtLinkQueue.remapSubmissionRecords(table.submissionRecords,seeded.idRemap);
 for(const annotation of Object.values(annotations))if(annotation&&typeof annotation==='object'){
  mapFields(annotation);
  if(Array.isArray(annotation.library?.profileIds)){const previous=annotation.library.profileIds,next=[...new Set(previous.map(remap))];if(JSON.stringify(next)!==JSON.stringify(previous)){annotation.library.sourceProfileIds??=structuredClone(previous);annotation.library.profileIds=next;}}
 }
 const queue=globalThis.ExtLinkQueue,combined={...(documents.submissionRecords||{})};
 for(const [key,record]of Object.entries(table.submissionRecords||{}))combined[key]=combined[key]?queue.mergePublicationFields(combined[key],record):record;
 const records={};for(const record of Object.values(combined)){
  if(!record||typeof record!=='object')continue;
  const next=queue.remapSubmissionRecords({original:record},seeded.idRemap);
  Object.assign(records,globalThis.ExtLinkBackup.mergeRecords(records,next));
 }
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
