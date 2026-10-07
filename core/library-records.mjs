import './queue.js';
import './submission-timeline.js';
const queue=globalThis.ExtLinkQueue;
const displayHostDestinations=new Set(['startupstash.com','startupcollections.com','aisuperhub.io','launchpedia.co','tipseason.com','library.phygital.plus','aisotools.com']);
export function canonicalLibraryDestination(value){
 const normalized=queue.normalizeDestinationKey(value),domain=String(queue.extractDomain(value)||'').toLowerCase();
 return displayHostDestinations.has(domain)?domain:normalized;
}
// The original catalog normalizes a display copy before migrating legacy events.
// These derived rows never replace the original receipt document or its revision.
export function libraryRecords(documents){
 const seeded={...(documents.submissionRecords||{})};
 for(const [key,record]of Object.entries(documents.sheetTableData?.submissionRecords||{}))seeded[key]=seeded[key]?queue.mergePublicationFields(seeded[key],record):record;
 return queue.migrateSubmissionRecords({records:queue.remapSubmissionRecords(seeded,{}),annotations:documents.siteAnnotations||{},tableData:documents.sheetTableData||{}}).records;
}
const originalTime=value=>Date.parse(value||'')||0;
export function libraryDestinationFacts({records,groupedTimeline,products,destination,monitorResults={},tasks=[]}){
 const key=canonicalLibraryDestination(destination),recordRows=Object.entries(records).filter(([,r])=>r&&canonicalLibraryDestination(r.destinationKey||r.destinationUrl||'')===key).sort(([,a],[,b])=>originalTime(b.submittedAt||b.updatedAt)-originalTime(a.submittedAt||a.updatedAt));
 const destinations=Object.values(groupedTimeline).filter(d=>canonicalLibraryDestination(d.destinationKey||'')===key);
 const events=destinations.flatMap(d=>d.profiles||[]).flatMap(p=>p.events||[]).sort((a,b)=>originalTime(b.occurredAt)-originalTime(a.occurredAt));
 const monitorValues=recordRows.map(([recordKey])=>monitorResults[recordKey]?.status).filter(Boolean),monitorStatus=['missing','unreachable','live'].find(status=>monitorValues.includes(status))||'';
 const localTasks=tasks.filter(task=>canonicalLibraryDestination(task.url||'')===key);
 const profileStatuses=products.map(profile=>{
  const recordKey=queue.submissionRecordKey(key,profile.id),profileRows=recordRows.filter(([,r])=>String(r.profileId||'').trim()===String(profile.id||'').trim()),record=profileRows[0]?.[1],displayRecords={...records};
  for(const [storedKey,storedRecord]of profileRows){if(!displayRecords[recordKey])displayRecords[recordKey]=storedRecord;if(storedKey===recordKey)break;}
  const profileEvents=events.filter(e=>String(e.profileId||'').trim()===String(profile.id||'').trim());
  const receiptTask=localTasks.filter(task=>task.profileId===profile.id&&task.receipt?.evidence).sort((a,b)=>originalTime(b.updatedAt)-originalTime(a.updatedAt))[0];
  return{profileId:profile.id,profileName:profile.name||profile.id,success:queue.isSubmissionSuccessful(records,key,profile.id)||queue.isSubmissionSuccessful(displayRecords,key,profile.id)||!!receiptTask,submittedAt:record?.submittedAt||receiptTask?.receipt?.submittedAt||receiptTask?.updatedAt||'',publicationStatus:record?.publicationStatus||receiptTask?.receipt?.publicationStatus||'',latestEvent:profileEvents[0]||null,eventCount:profileEvents.length};
 });
 return{key,events,latestEvent:events[0]||null,profileStatuses,monitorStatus,localTasks};
}
