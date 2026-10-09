import './queue.js';
import './submission-timeline.js';
import {jsonValueEqual} from './json-value.mjs';

// Match the original persisted receipt and its full timeline tuple. A newer
// publication event cannot stand in for the event belonging to this receipt.
export function existingReceiptTimelineEvent(recordKey,record){
 return globalThis.ExtLinkSubmissionTimeline.normalizeEvent({destinationKey:record.destinationKey,destinationUrl:record.destinationUrl,profileId:record.profileId,profileName:record.profileName||record.profileId,occurredAt:record.submittedAt,type:record.publicationStatus||'submitted',status:record.publicationStatus||'submitted',note:record.evidence,evidenceUrl:record.evidenceUrl,publicUrl:record.publicUrl,source:record.confirmedBy==='manual'?'manual':'agent',recordKey});
}
export function existingReceiptTimelineContains(timeline,recordKey,record){
 const T=globalThis.ExtLinkSubmissionTimeline,expected=existingReceiptTimelineEvent(recordKey,record),key=T.timelineKey(record.destinationKey,record.profileId);
 return (T.normalizeTimeline(timeline||{})[key]||[]).some(event=>event.occurredAt===expected.occurredAt&&(event.type===expected.type||expected.type==='submitted'&&event.type==='success')&&['note','evidenceUrl','publicUrl'].every(k=>String(event[k]||'').trim()===String(expected[k]||'').trim())&&(!event.recordKey||event.recordKey===recordKey));
}
export function persistedExistingReceipt(records,key){
 const Q=globalThis.ExtLinkQueue,record=records?.[key];return record?.status==='success'&&record.destinationKey&&record.profileId&&key===Q.submissionRecordKey(record.destinationKey,record.profileId)&&Q.isSubmissionSuccessful(records,record.destinationKey,record.profileId)?record:null;
}
export function repairExistingReceiptTimeline(documents,operation){
 const record=persistedExistingReceipt(documents.submissionRecords,operation.recordKey);
 if(!record||!jsonValueEqual(record,operation.expectedRecord))throw Object.assign(Error('原收件记录已变化，停止补记历史动态'),{status:409});
 return existingReceiptTimelineContains(documents.submissionTimeline,operation.recordKey,record)?documents.submissionTimeline:globalThis.ExtLinkSubmissionTimeline.append(documents.submissionTimeline||{},{...existingReceiptTimelineEvent(operation.recordKey,record),id:'receipt-repair-'+operation.id});
}
