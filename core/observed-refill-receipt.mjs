import './queue.js';
import './automation-ledger.js';
import './submission-timeline.js';
import {jsonValueEqual} from './json-value.mjs';
import {existingReceiptTimelineEvent,existingReceiptTimelineContains,persistedExistingReceipt} from './existing-receipt.mjs';
export const observedRefillReceiptKeys=['submissionRecords','submissionSchemaVersion','submissionTimeline','timelineSchemaVersion','siteAnnotations'];
const normal=value=>String(value||'').replace(/\s+/g,' ').trim();
const fail=message=>{throw Object.assign(Error(message),{status:409});};
export function observedRefillRecord(operation){
 const Q=globalThis.ExtLinkQueue,{observation:o,receipt:r}=operation;
 if(!o||!r||!operation.id||!o.token||!o.refillId||o.actionObserved!==true||r.matched!==true||!Number.isFinite(Date.parse(o.clickedAt))||!Number.isFinite(Date.parse(o.observedAt))||Date.parse(o.observedAt)<Date.parse(o.clickedAt)||!operation.profileId)fail('缺少原网页点击及新回执证明');
 let destination,current,original;try{destination=new URL(operation.destinationUrl);current=new URL(o.currentPageUrl);original=new URL(o.pageUrl);const evidence=new URL(o.evidenceUrl);if(!/^https?:$/.test(evidence.protocol)||evidence.username||evidence.password)throw Error();}catch{fail('原网页回执地址无效');}
 if([destination,current,original].some(url=>!/^https?:$/.test(url.protocol)||url.username||url.password)||current.origin!==original.origin&&!/^(?:[^.]+\.)*typeform\.com$|^formsubmit\.co$/.test(current.hostname.replace(/^www\./,'')))fail('回执已离开原提交网页');
 if(!normal(r.evidence)||normal(r.evidence)===normal(o.baseline))fail('未出现不同于原页面基线的新回执');
 const proof=globalThis.ExtLinkAutomationLedger.validateSuccessProof({confirmedBy:'agent',source:'deterministic_submit',actionObserved:true,evidence:r.evidence,evidenceSignals:r.evidenceSignals?.length?r.evidenceSignals:[{type:'visible_confirmation',text:normal(r.evidence),url:o.evidenceUrl,matched:true}],publicationStatus:r.publicationStatus||'submitted',publicUrl:r.publicUrl||'',destinationUrl:operation.destinationUrl,evidenceUrl:o.evidenceUrl});
 if(!proof.ok||normal(proof.evidence)===normal(o.baseline))fail(proof.reason||'回执证据仍是原页面提示');
 const destinationKey=Q.normalizeDestinationKey(operation.destinationUrl),recordKey=Q.submissionRecordKey(destinationKey,operation.profileId),expected=operation.expectedRecords?.[recordKey]||null;
 const source=persistedExistingReceipt({[operation.previousRecordKey]:operation.previousRecord},operation.previousRecordKey);
 if(!source||source.profileId!==operation.profileId||Q.extractDomain(source.destinationUrl||source.destinationKey)!==Q.extractDomain(operation.destinationUrl)||!jsonValueEqual(operation.expectedRecords?.[operation.previousRecordKey],source))fail('原已收件记录身份不一致');
 if(expected?.status==='success'&&String(expected.publicUrl||'')===String(r.publicUrl||'')&&String(expected.evidence||'')===String(proof.evidence||'')&&String(expected.publicationStatus||'submitted')===String(r.publicationStatus||'submitted'))return{recordKey,record:expected};
 const record=Q.buildSuccessRecord({destinationKey,destinationUrl:operation.destinationUrl,profileId:operation.profileId,profileName:operation.profileName||operation.profileId,submittedAt:o.observedAt,confirmedBy:'agent',evidence:proof.evidence,publicUrl:r.publicUrl||'',evidenceUrl:proof.evidenceUrl||o.evidenceUrl,publicationStatus:r.publicationStatus||'submitted'});
 return{recordKey,record:{...record,evidenceType:proof.evidenceType,runId:'',taskId:''}};
}
export function observedRefillReceiptSatisfied(documents,operation){
 try{const {recordKey,record}=observedRefillRecord(operation);return jsonValueEqual(documents.submissionRecords?.[recordKey],record)&&existingReceiptTimelineContains(documents.submissionTimeline,recordKey,record)&&documents.submissionSchemaVersion===globalThis.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION&&documents.timelineSchemaVersion===globalThis.ExtLinkSubmissionTimeline.SCHEMA_VERSION&&!globalThis.ExtLinkQueue.verifiedSubmissionSiteAnnotationUpdates(documents.submissionRecords,documents.siteAnnotations).addedKeys.length;}catch{return false;}
}
export function observedRefillReceiptMutation(documents,operation){
 const {recordKey,record}=observedRefillRecord(operation);
 if(!observedRefillReceiptSatisfied(documents,operation)){
  if(!Object.hasOwn(operation.expectedRecords||{},recordKey)||Object.keys(operation.expectedRecords||{}).some(key=>![recordKey,operation.previousRecordKey].includes(key)))fail('原台账范围不完整');
  for(const [key,expected]of Object.entries(operation.expectedRecords))if(!jsonValueEqual(documents.submissionRecords?.[key]||null,expected))fail('原收件记录已变化，保留本次新证据待核验');
 }
 const timeline=existingReceiptTimelineContains(documents.submissionTimeline,recordKey,record)?documents.submissionTimeline:globalThis.ExtLinkSubmissionTimeline.append(documents.submissionTimeline||{},{...existingReceiptTimelineEvent(recordKey,record),id:'refill-receipt-'+operation.id});
 const records=jsonValueEqual(documents.submissionRecords?.[recordKey],record)?documents.submissionRecords:{...documents.submissionRecords,[recordKey]:record};
 const markers=globalThis.ExtLinkQueue.verifiedSubmissionSiteAnnotationUpdates(records,documents.siteAnnotations,globalThis.ExtLinkQueue.normalizeDestinationKey,operation.at);
 return{key:'submissionRecords',data:records,updates:{submissionRecords:records,submissionSchemaVersion:globalThis.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION,submissionTimeline:timeline,timelineSchemaVersion:globalThis.ExtLinkSubmissionTimeline.SCHEMA_VERSION,siteAnnotations:markers.annotations},revisionKeys:observedRefillReceiptKeys,record};
}
