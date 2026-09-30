import './queue.js';import './library-classifier.js';import './executor-contract.js';
const host=value=>globalThis.ExtLinkQueue.extractDomain(value||'').toLowerCase();
export function applicationModel(snapshot,tasks=[]){
 const documents=snapshot.documents||{},products=Object.entries(documents.siteProfiles||{}).map(([id,profile])=>({...profile,id}));
 const inventory=globalThis.ExtLinkExecutorContract.inventory({documents},null);
 const records=Object.entries(documents.submissionRecords||{}).map(([key,record])=>({...record,key,profileId:record.profileId||key.slice(key.lastIndexOf('::')+2),host:host(record.destinationUrl||record.destinationKey||key.split('::')[0])}));
 const combinations=new Map();
 const cell=(site,profileId)=>{const identity=site+'::'+profileId;if(!combinations.has(identity))combinations.set(identity,{identity,site,profileId,execution:'not_started',submission:'not_submitted',review:'unknown',reply:'unknown',publication:'unknown',sync:'unknown',taskIds:[],records:[]});return combinations.get(identity);};
 for(const record of records){const target=cell(record.host,record.profileId);target.records.push(record);
  if(record.status==='success'){target.submission='received';target.review=record.publicationStatus==='pending_moderation'?'pending':record.publicationStatus==='published'?'approved':'unknown';target.publication=record.publicationStatus==='published'?'published':'unknown';target.sync='confirmed';}
 }
 for(const task of tasks){const target=cell(host(task.url),task.profileId);target.taskIds.push(task.id);target.execution=task.status;target.reason=task.reason||'';
  if(task.receipt?.evidence){target.submission='received';if(task.receipt.publicationStatus==='pending_moderation')target.review='pending';target.sync=task.cloudVerified?'confirmed':'pending';}
  else if(task.attemptBoundary&&target.submission!=='received')target.submission='sent_unconfirmed';
  target.sync=task.syncStatus||target.sync;
 }
 const library=inventory.candidates.map(row=>({...row,site:host(row.url),annotation:globalThis.ExtLinkQueue.findDestinationAnnotation(documents.siteAnnotations||{},row.destinationKey,host(row.url))||{}}));
 return{products,library,total:inventory.total,sources:inventory.sources,combinations:[...combinations.values()]};
}
export const taskSummary=task=>Object.fromEntries(['id','url','profileId','runId','status','siteStatus','reason','attentionType','attemptBoundary','receipt','cloudVerified','syncStatus','pendingEvents','acceptanceId','reviewStatus','controller','artifactRef','screenshot','updatedAt'].filter(key=>task[key]!==undefined).map(key=>[key,task[key]]));
