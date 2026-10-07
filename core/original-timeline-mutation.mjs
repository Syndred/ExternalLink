import './queue.js';
import './submission-timeline.js';
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
export const timelineDocumentKeys=['submissionTimeline','timelineSchemaVersion','submissionRecords','submissionSchemaVersion'];
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const timelineValueEqual=(left,right)=>JSON.stringify(stable(left))===JSON.stringify(stable(right));
function recordsEqual(actual,desired,event){
 const key=globalThis.ExtLinkQueue.submissionRecordKey(event.destinationKey,event.profileId),record=actual?.[key];
 if(record&&!Object.hasOwn(record,'updatedAt')&&record.submittedAt===event.occurredAt){desired=structuredClone(desired);if(desired[key])delete desired[key].updatedAt;}
 return timelineValueEqual(actual,desired);
}

// Keep the original applyTimelinePublicationUpgrade evidence and rank rules.
export function timelinePublicationUpgrade(records,event){
 const Q=globalThis.ExtLinkQueue,profileId=String(event.profileId||'').trim();
 if(!profileId||profileId==='__destination__'||!['submitted','pending_moderation','published'].includes(event.type))return{records,updatedRecord:null};
 if(event.type==='submitted'){
  const note=String(event.note||'').replace(/\s+/g,' ').trim(),generic=/^(?:已提交|提交成功|submitted|success|人工记录[:：]?submitted)$/i.test(note);
  if((!note||generic)&&!event.evidenceUrl&&!event.publicUrl)return{records,updatedRecord:null};
 }
 const key=Q.submissionRecordKey(event.destinationKey,profileId),existing=records[key];
 const updatedRecord=existing?Q.applyPublicationUpgrade(existing,event.type,{updatedAt:event.occurredAt,evidence:event.note||existing.evidence||'人工记录状态变化',evidenceUrl:event.evidenceUrl||existing.evidenceUrl||'',publicUrl:event.publicUrl||existing.publicUrl||''}):Q.buildSuccessRecord({destinationKey:event.destinationKey,destinationUrl:event.destinationUrl,profileId,profileName:event.profileName||profileId,submittedAt:event.occurredAt,confirmedBy:'manual',evidence:event.note||`人工记录：${event.type}`,evidenceUrl:event.evidenceUrl||'',publicUrl:event.publicUrl||'',publicationStatus:event.type});
 return{records:{...records,[key]:updatedRecord},updatedRecord};
}
export function originalTimelineMutation(documents,operation){
 const T=globalThis.ExtLinkSubmissionTimeline,events=documents.submissionTimeline||{},previous=Object.values(T.normalizeTimeline(events)).flat().find(event=>event.id===operation.eventId);
 if(!['add','update','remove'].includes(operation.action))fail('时间线操作无效');
 if(operation.action!=='add'&&!previous)fail('时间线动态不存在');
 let result;
 if(operation.action==='remove')result=T.removeEvent(events,operation.eventId);
 else{
  const patch=operation.action==='add'?operation.event:operation.patch;
  const allowed=['id','destinationKey','destinationUrl','profileId','profileName','type','status','publicationStatus','occurredAt','note','evidenceUrl','publicUrl','source','confirmedBy'];
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!allowed.includes(key)||key==='id'&&operation.action!=='add')||Object.values(patch).some(value=>typeof value!=='string'||value.length>10000))fail('时间线修改无效');
  if(Object.hasOwn(patch,'profileId')&&!patch.profileId.trim())fail('请选择要记录的网站项目');
  const manual={...patch,source:patch.source||'manual',confirmedBy:operation.action==='add'&&patch.source==='agent'?patch.confirmedBy||'agent':'manual'};
  if(operation.action==='add'){
   const event=T.normalizeEvent(manual),existing=Object.values(T.normalizeTimeline(events)).flat().find(value=>value.id===event.id);
   if(existing&&!timelineValueEqual(existing,event))throw Object.assign(new Error('进度事件编号已存在但内容不同'),{status:409});
   result=T.appendWithResult(events,event);
  }else result=T.updateEvent(events,operation.eventId,manual);
 }
 const updates={submissionTimeline:result.timeline,timelineSchemaVersion:T.SCHEMA_VERSION};
 // The monitor already verifies and upgrades the original receipt separately;
 // its progress message must not replace that retained receipt evidence.
 const monitorEvent=operation.action==='add'&&result.event.source==='agent'&&result.event.confirmedBy==='link_check';
 const upgraded=operation.action==='remove'||monitorEvent?{updatedRecord:null}:timelinePublicationUpgrade(documents.submissionRecords||{},result.event);
 if(upgraded.updatedRecord){updates.submissionRecords=operation.action==='add'&&result.added===false&&recordsEqual(documents.submissionRecords,upgraded.records,result.event)?documents.submissionRecords:upgraded.records;updates.submissionSchemaVersion=globalThis.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION;}
 return{key:'submissionTimeline',data:result.timeline,updates,revisionKeys:operation.action==='remove'?timelineDocumentKeys.slice(0,2):timelineDocumentKeys,event:result.event,record:upgraded.updatedRecord};
}
export function originalTimelineSatisfied(documents,operation){
 const T=globalThis.ExtLinkSubmissionTimeline,event=Object.values(T.normalizeTimeline(documents.submissionTimeline||{})).flat().find(value=>value.id===(operation.eventId||operation.event?.id));
 if(operation.action==='remove')return!event&&documents.timelineSchemaVersion===T.SCHEMA_VERSION;
 if(!event)return false;
 try{const change=originalTimelineMutation(documents,operation);return Object.entries(change.updates).every(([key,data])=>{
  if(key==='submissionRecords'&&change.record)return recordsEqual(documents[key],data,event);
  return timelineValueEqual(documents[key],data);
 });}catch{return false;}
}
