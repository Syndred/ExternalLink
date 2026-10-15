import test from 'node:test';
import assert from 'node:assert/strict';
import {stageReceiptBoundary} from '../executor/src/stage-receipt-recovery.mjs';
const evidence={matched:true,evidence:'Exact visible original receipt',publicationStatus:'pending_moderation'};
const fixture=()=>{
 const task={url:'https://qwenai.site/en/submit',targetId:'original-target',browserInstance:'original-browser',profileSnapshot:{id:'OldPhotoLive',fields:{Name:'OldPhotoLive AI',Url:'https://oldphotoliveai.com'}},actualSubmission:{fields:[{name:'name',value:'OldPhotoLive AI'}]}};
 task.attemptHistory=[{kind:'original_stage_advanced',url:task.url,targetId:task.targetId,browserInstance:task.browserInstance,profileSnapshot:structuredClone(task.profileSnapshot),actualSubmission:structuredClone(task.actualSubmission),attemptBoundary:'2026-10-15T02:10:00.000Z',baselineEvidence:'',submitResult:{stageAdvanced:true,submitted:false,clickedSubmit:true},networkResponses:[{url:'https://qwenai.site/api/tools/submit',status:200,signals:{ok:'true'}}]}];return task;
};
test('only exact original acknowledged POST plus visible receipt recovers its boundary without altering history',()=>{
 const task=fixture(),before=structuredClone(task);
 assert.equal(stageReceiptBoundary(task,evidence).attemptBoundary,task.attemptHistory[0].attemptBoundary);
 assert.deepEqual(task,before);
});
test('missing acknowledgement, identity drift, changed actual fields and nonreceipt never recover a boundary',()=>{
 for(const mutate of [t=>t.receipt={},t=>t.attemptBoundary='existing',t=>t.targetId='other',t=>t.browserInstance='other',t=>t.actualSubmission.fields[0].value='Other product',t=>t.profileSnapshot.fields.Name='Other',t=>t.url='https://other.invalid/en/submit',t=>t.attemptHistory[0].submitResult.clickedSubmit=false,t=>t.attemptHistory[0].networkResponses[0].status=400,t=>t.attemptHistory[0].networkResponses[0].signals={},t=>t.attemptHistory[0].networkResponses[0].url='https://other.invalid/api/tools/submit',t=>t.attemptHistory.push({kind:'later_step'})]){
  const task=fixture();mutate(task);assert.equal(stageReceiptBoundary(task,evidence),null);
 }
 assert.equal(stageReceiptBoundary(fixture(),{...evidence,matched:false}),null);
 assert.equal(stageReceiptBoundary(fixture(),{...evidence,publicationStatus:'submitted'}),null);
 const oldReceipt=fixture();oldReceipt.attemptHistory[0].baselineEvidence=evidence.evidence;
 assert.equal(stageReceiptBoundary(oldReceipt,evidence),null);
});
