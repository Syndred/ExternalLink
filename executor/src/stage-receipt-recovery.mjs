import {isDeepStrictEqual} from 'node:util';

// Read-only recovery of a POST boundary incorrectly archived as a form step.
// It is usable only after the original page's exact visible receipt matches.
export function stageReceiptBoundary(task,evidence){
 if(task?.receipt||task?.attemptBoundary||!evidence?.matched||!evidence.evidence||evidence.publicationStatus!=='pending_moderation')return null;
 let url;try{url=new URL(task.url);}catch{return null;}
 if(url.hostname!=='qwenai.site'||url.pathname!=='/en/submit')return null;
 const history=task.attemptHistory?.at(-1);
 if(history?.kind!=='original_stage_advanced'||history.baselineEvidence===evidence.evidence||history.targetId!==task.targetId||history.browserInstance!==task.browserInstance||history.url!==task.url||!Number.isFinite(Date.parse(history.attemptBoundary))||!isDeepStrictEqual(history.profileSnapshot,task.profileSnapshot)||!isDeepStrictEqual(history.actualSubmission,task.actualSubmission)||!history.actualSubmission?.fields?.length||history.submitResult?.stageAdvanced!==true||history.submitResult?.submitted!==false||history.submitResult?.clickedSubmit!==true)return null;
 const acknowledged=(history.networkResponses||[]).some(r=>{try{const u=new URL(r.url);return u.origin===url.origin&&u.pathname==='/api/tools/submit'&&r.status>=200&&r.status<300&&String(r.signals?.ok)==='true';}catch{return false;}});
 return acknowledged?{attemptBoundary:history.attemptBoundary,baselineEvidence:history.baselineEvidence||'',history}:null;
}
