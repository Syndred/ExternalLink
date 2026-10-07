import {isDeepStrictEqual} from 'node:util';
import {automationLedger,queue,plain} from './shared.mjs';

// bd916b2 completeTaskFromJudge. Models may suggest success; the original
// ledger and a new signal relative to the original baseline authorize it.
const shortText=(value,limit)=>{const text=String(value||'').replace(/\s+/g,' ').trim();return text.length>limit?text.slice(0,limit-1)+'…':text;};
export function originalJudgeSuccessDecision(task,entry={},judge={}){
 const baselineEvidence=shortText(entry.submissionEvidenceBaseline||'',2000).toLowerCase(),baselineUrl=String(entry.submissionUrlBaseline||''),resultUrl=String(judge.evidenceUrl||judge.publicUrl||''),resultMoved=Boolean(resultUrl&&baselineUrl&&resultUrl!==baselineUrl);
 const evidenceSignals=(Array.isArray(judge.evidenceSignals)?judge.evidenceSignals:[]).filter(signal=>!baselineEvidence||resultMoved||shortText(signal?.text||'',2000).toLowerCase()!==baselineEvidence);
 const evidence=baselineEvidence&&!resultMoved&&shortText(judge.evidence||'',2000).toLowerCase()===baselineEvidence?'':judge.evidence||'';
 const proof=plain(automationLedger.validateSuccessProof({confirmedBy:'agent',evidence,source:judge.source||'judge',actionObserved:judge.actionObserved===true||entry.submissionAttempted===true,evidenceSignals,networkEvidence:judge.networkEvidence||null,publicationStatus:judge.publicationStatus,publicUrl:judge.publicUrl||'',destinationUrl:task.url||'',evidenceUrl:judge.evidenceUrl||''}));
 if(!proof.ok)return{proof,terminal:entry.submissionAttempted===true||judge.source==='deterministic_submit',unconfirmed:entry.submissionAttempted===true||judge.source==='deterministic_submit'};
 return{proof,terminal:true,receipt:{evidence:proof.evidence,evidenceType:proof.evidenceType,evidenceUrl:proof.evidenceUrl||judge.evidenceUrl||'',publicUrl:judge.publicUrl||task.publicUrl||'',publicationStatus:queue.inferPublicationStatus({evidence:proof.evidence,publicUrl:judge.publicUrl||task.publicUrl||'',evidenceUrl:judge.evidenceUrl||'',publicationStatus:judge.publicationStatus}),confirmedBy:'agent',successProof:{source:judge.source||'judge',actionObserved:judge.actionObserved===true||entry.submissionAttempted===true,evidenceSignals:judge.evidenceSignals||[],networkEvidence:judge.networkEvidence||null}}};
}
export function originalSubmitSuccessDecision(task,result){
 const entry={submissionAttempted:!!task.attemptBoundary,submissionEvidenceBaseline:task.baselineEvidence||'',submissionUrlBaseline:task.submissionUrlBaseline||task.url};
 return originalJudgeSuccessDecision(task,entry,{evidence:result.evidence||'',publicationStatus:result.publicationStatus||'submitted',publicUrl:result.publicUrl||'',evidenceUrl:result.evidenceUrl||'',source:'deterministic_submit',actionObserved:result.clickedSubmit===true||result.submitted===true||result.clickedCreateDraft===true,evidenceSignals:result.evidenceSignals||[{type:result.publicationStatus==='published'?'public_listing':'visible_confirmation',text:result.evidence||'',url:result.evidenceUrl||result.publicUrl||task.url||'',matched:Boolean(result.evidence)}],networkEvidence:result.networkEvidence||null});
}
export function nativeSuccessRecord(task){
 const receipt=task.receipt;
 const record=plain(queue.buildSuccessRecord({destinationUrl:task.url,destinationKey:task.destinationKey,profileId:task.profileId,submittedAt:task.attemptBoundary||receipt.receivedAt,evidence:receipt.evidence,evidenceUrl:receipt.evidenceUrl||receipt.url,publicUrl:receipt.publicUrl||'',publicationStatus:receipt.publicationStatus||'submitted',confirmedBy:receipt.confirmedBy||task.confirmedBy||'agent'}));
 return{...record,taskId:task.id,runId:task.runId,actualSubmission:task.actualSubmission,reviewStatus:task.reviewStatus,artifactRef:task.artifactRef||'',executor:'windows-playwright',...(receipt.evidenceType?{evidenceType:receipt.evidenceType}:{}),...(receipt.successProof?{successProof:plain(receipt.successProof)}:{})};
}
export function nativeReceiptReadbackMatches(read,record){
 if(!read||read.taskId!==record.taskId||read.evidence!==record.evidence||!isDeepStrictEqual(read.actualSubmission,record.actualSubmission))return false;
 // Original receipts without these fields retain their existing recovery rule.
 // New proof-bearing receipts cannot silently acknowledge an older truncated
 // cloud record or another public result with the same visible text.
 return !record.successProof||['publicUrl','evidenceUrl','publicationStatus','confirmedBy','evidenceType','successProof'].every(key=>isDeepStrictEqual(read[key],record[key]));
}
