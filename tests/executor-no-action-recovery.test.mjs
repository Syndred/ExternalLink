import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetryNoAction } from '../executor/src/recovery.mjs';
test('only proven non-submission actions permit one audited recovery', () => {
  const task={status:'needs_manual',siteStatus:'not_submitted',attemptBoundary:'at',reason:'verified',submitResult:{clickedSubmit:false}};
  const input={expectedAttemptBoundary:'at',expectedReason:'verified'};
  assert.equal(canRetryNoAction(task,input),true);
  assert.equal(canRetryNoAction({...task,submitResult:{clickedSubmit:true}},input),false);
  assert.equal(canRetryNoAction({...task,status:'submitted_unconfirmed'},input),false);
  assert.equal(canRetryNoAction({...task,noActionRecovery:true},input),false);
  assert.equal(canRetryNoAction({...task,networkResponses:[{status:200}]},input),false);
  assert.equal(canRetryNoAction(task,{...input,expectedAttemptBoundary:'old'}),false);
  assert.equal(canRetryNoAction({...task,submitResult:{reason:'no_submit_button'}},input),true);
  assert.equal(canRetryNoAction({...task,submitResult:null,attentionType:'wrong_form',actualSubmission:{fields:[]},fill:{filledCount:0}},input),true);
  assert.equal(canRetryNoAction({...task,submitResult:{clickedSubmit:true},attentionType:'wrong_form',actualSubmission:{fields:[{}]}},input),false);
});
test('A once-only exact 10015 fill-only refusal preserves true unknown submissions',()=>{
  const task={url:'https://10015.io/product-finder/submit',status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',reason:'fill_only',attemptBoundary:'new',noActionRecovery:true,
    submitResult:{reason:'fill_only',fillOnly:true,manual:true,networkResponses:[]},validation:{allValid:true},selectedPickers:{'#pricing':'Free','#category':'AI'}};
  const input={expectedAttemptBoundary:'new',expectedReason:'fill_only'};
  assert.equal(canRetryNoAction(task,input),true);
  for(const patch of [{guardedFillRecovery:true},{networkResponses:[{status:200}]},{receipt:{evidence:'accepted'}},{submitResult:{reason:'fill_only',clickedSubmit:true,fillOnly:true,manual:true}},{url:'https://other.test/'},{reason:'unknown'}])assert.equal(canRetryNoAction({...task,...patch},input),false);
});
