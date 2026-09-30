import './queue.js';
import './library-classifier.js';
import './executor-contract.js';
import './submission-timeline.js';
import './opportunity-score.js';
import './library-groups.js';
const host=value=>globalThis.ExtLinkQueue.extractDomain(value||'').toLowerCase();
const stamp=value=>{const time=globalThis.ExtLinkSubmissionTimeline.parseTime(value);return Number.isFinite(time)?time:0;};
const taskActive=task=>!!(task.attemptBoundary||task.receipt||Object.keys(task.actualPreparation||{}).length||Object.keys(task.actualSubmission||{}).length||task.targetId||task.preparedAt||task.hasActivity||['opening','filling','submitting','finished','submitted_unconfirmed'].includes(task.status)||task.status==='needs_manual'&&task.reason);
export function applicationModel(snapshot,tasks=[]){
 const documents=snapshot.documents||{},products=Object.entries(documents.siteProfiles||{}).map(([id,profile])=>({...profile,id}));
 const inventory=globalThis.ExtLinkExecutorContract.inventory({documents},null);
 const timeline=globalThis.ExtLinkSubmissionTimeline;
 const migrated=timeline.migrateLegacy({timeline:documents.submissionTimeline||{},submissionRecords:documents.submissionRecords||{},tableData:documents.sheetTableData||{}}).timeline;
 const allEvents=Object.values(timeline.normalizeTimeline(migrated)).flat();
 const records=Object.entries(documents.submissionRecords||{}).map(([key,record])=>({...record,key,profileId:record.profileId||key.slice(key.lastIndexOf('::')+2),host:host(record.destinationUrl||record.destinationKey||key.split('::')[0])}));
 const combinations=new Map();
 const cell=(site,profileId)=>{const identity=site+'::'+profileId;if(!combinations.has(identity))combinations.set(identity,{identity,site,profileId,execution:'not_started',submission:'not_submitted',review:'unknown',reply:'unknown',publication:'unknown',sync:'unknown',taskIds:[],records:[],events:[],hasActivity:false,lastActivityAt:''});return combinations.get(identity);};
 const touch=(target,time)=>{if(stamp(time)>stamp(target.lastActivityAt))target.lastActivityAt=time;target.hasActivity=true;};
 for(const record of records){const target=cell(record.host,record.profileId);target.records.push(record);target.url=record.destinationUrl||target.url;touch(target,record.updatedAt||record.submittedAt||record.time);
  if(record.status==='success'){target.submission='received';target.review=record.publicationStatus==='pending_moderation'?'pending':record.publicationStatus==='published'?'approved':'unknown';target.publication=record.publicationStatus==='published'?'published':'unknown';target.sync='confirmed';}
 }
 for(const event of allEvents){const target=cell(host(event.destinationUrl||event.destinationKey),event.profileId);target.events.push(event);target.url=event.destinationUrl||target.url;touch(target,event.occurredAt);}
 for(const task of [...tasks].sort((a,b)=>stamp(a.updatedAt)-stamp(b.updatedAt))){const target=cell(host(task.url),task.profileId);target.taskIds.push(task.id);target.url=task.url;target.execution=task.status;target.reason=task.reason||'';
  if(taskActive(task))touch(target,task.updatedAt||task.preparedAt||task.createdAt);
  if(task.receipt?.evidence){target.submission='received';if(task.receipt.publicationStatus==='pending_moderation')target.review='pending';if(task.receipt.publicationStatus==='published'){target.review='approved';target.publication='published';}target.sync=task.cloudVerified?'confirmed':'pending';}
  else if(task.attemptBoundary&&target.submission!=='received')target.submission='sent_unconfirmed';
  target.sync=task.syncStatus||target.sync;
 }
 for(const target of combinations.values()){
  target.events.sort((a,b)=>stamp(b.occurredAt)-stamp(a.occurredAt));target.latestEvent=target.events[0]||null;
  // Manual progress explains review/publication, without creating a site receipt.
  const progressEvent=target.events.find(e=>['submitted','pending_moderation','published','rejected','needs_follow_up','needs_manual','link_missing','link_submit'].includes(e.publicationStatus||e.type));
  target.progress=progressEvent?.publicationStatus||progressEvent?.type||'';
  if(target.progress==='published'){target.publication='published';target.review='approved';}
  if(target.progress==='pending_moderation')target.review='pending';
  if(target.progress==='rejected')target.review='rejected';
 }
 const library=inventory.candidates.map(row=>{
  const site=host(row.url),annotation=globalThis.ExtLinkQueue.findDestinationAnnotation(documents.siteAnnotations||{},row.destinationKey,site)||{};
  const related=[...combinations.values()].filter(c=>c.site===site),monitorValues=records.filter(r=>r.host===site).map(r=>documents.linkMonitorResults?.[r.key]?.status).filter(Boolean);
  const monitorStatus=['missing','unreachable','live'].find(s=>monitorValues.includes(s))||'';
  const quality=globalThis.ExtLinkOpportunityScore.scoreOpportunity({metrics:{...row.row,...row.row?.metrics,...documents.domainMetricsCache?.[site]},annotation,monitorStatus});
  const classification=globalThis.ExtLinkLibraryClassifier.describe({entry:row.row||{},url:row.url,domain:site,metrics:quality.metrics});
  const events=related.flatMap(c=>c.events).sort((a,b)=>stamp(b.occurredAt)-stamp(a.occurredAt));
  const profileStatuses=related.map(c=>({profileId:c.profileId,success:c.submission==='received',latestEvent:c.latestEvent,publicationStatus:c.progress||c.publication,submittedAt:c.records.find(r=>r.status==='success')?.submittedAt}));
  const item={...row,site,...classification,annotation,quality,metrics:quality.metrics,monitorStatus,events,profileStatuses,preferences:globalThis.ExtLinkLibraryClassifier.libraryPreferences(annotation),pinned:annotation.library?.pinned===true,time:row.row?.time||row.row?.addedAt||'',lastActivityAt:related.reduce((time,c)=>stamp(c.lastActivityAt)>stamp(time)?c.lastActivityAt:time,'')};
  item.groups=globalThis.ExtLinkLibraryGroups.GROUPS.filter(([id])=>globalThis.ExtLinkLibraryGroups.matches(item,id)).map(([id])=>id);
  item.progress=timeline.deriveLibraryProgress(item);return item;
 });
 return{products,library,total:inventory.total,sources:inventory.sources,combinations:[...combinations.values()],activity:[...combinations.values()].filter(c=>c.hasActivity).sort((a,b)=>stamp(b.lastActivityAt)-stamp(a.lastActivityAt))};
}
export const taskSummary=task=>({...Object.fromEntries(['id','url','profileId','runId','status','siteStatus','reason','attentionType','attemptBoundary','receipt','cloudVerified','syncStatus','pendingEvents','acceptanceId','reviewStatus','controller','artifactRef','screenshot','updatedAt','createdAt','preparedAt'].filter(key=>task[key]!==undefined).map(key=>[key,task[key]])),...(taskActive(task)?{hasActivity:true}:{})});
