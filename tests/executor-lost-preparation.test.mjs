import test from 'node:test';import assert from 'node:assert/strict';
import {canRestoreLostPreparation} from '../executor/src/lost-preparation.mjs';
const scout={url:'https://toolscout.ai/submit',status:'needs_manual',siteStatus:'not_submitted',targetId:'old',browserInstance:'old-host',attemptBoundary:null,logoutRecovery:true,
 attemptHistory:[{kind:'verified_non_submission_action',submitResult:{reason:'no_submit_button'},actualSubmission:{fields:[]}},{kind:'verified_logout_only',networkResponses:[{url:'https://toolscout.ai/auth/logout',status:302}]}],
 stageHistory:[{stage:1},{stage:5}],attentionType:'human_verification_page_unavailable'};
const cap={url:'https://www.futuretools.io/submit-a-tool',status:'needs_manual',siteStatus:'rejected',targetId:'old',browserInstance:'old-host',attemptBoundary:'at',reason:'Please complete the captcha before submitting',
 attentionType:'human_verification',submitResult:{submitted:false,validationFailed:true,networkResponses:[]},networkResponses:[]};
const input={expectedTargetId:'old',expectedAttemptBoundary:null};
test('Only proven ToolScout preparation or an explicit FutureTools CAPTCHA rejection can restore a lost page',()=>{assert.equal(canRestoreLostPreparation(scout,input,'new-host'),true);assert.equal(canRestoreLostPreparation(cap,{...input,expectedAttemptBoundary:'at'},'new-host'),true);});
test('Unknown results, HTTP500, accepted tasks, stale identities and repeated restoration cannot clear an attempt',()=>{for(const p of [{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed'},{networkResponses:[{status:500}]},{receipt:{evidence:'received'}},{reason:'new empty form'},{lostPreparationRecoveries:[{targetId:'old'}]}])assert.equal(canRestoreLostPreparation({...cap,...p},{...input,expectedAttemptBoundary:'at'},'new-host'),false);assert.equal(canRestoreLostPreparation(scout,input,'old-host'),false);assert.equal(canRestoreLostPreparation(scout,{...input,expectedTargetId:'other'},'new-host'),false);});
