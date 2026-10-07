import test from 'node:test';
import assert from 'node:assert/strict';
import {originalAutoFillSourceCases} from '../executor/test/original-auto-fill-source-flow.mjs';
test('the original automatic visit keeps manual captcha blocked and incomplete pages in fill-only mode without an automatic next tab',async()=>{
 const evidence=await originalAutoFillSourceCases();assert.equal(evidence.ok,true);assert.equal(evidence.results.length,8);assert.ok(evidence.results.find(row=>row.mode==='incomplete-required-fields').originalIncompleteFillReportedNotReady);assert.ok(evidence.results.find(row=>row.mode==='semantic-model-review').semanticUncertaintyDidNotClassifyDestination);for(const row of evidence.results){assert.equal(row.originalAutomaticQueueAdvances,0);assert.equal(row.originalNewTabs,0);assert.equal(row.originalFinalSubmitCalls,0);}assert.equal(evidence.realSubmissions,0);
});
