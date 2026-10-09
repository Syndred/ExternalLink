import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('single-page interface follows the confirmed original queue page and profile without selecting another user page',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-single-page-receipt-ui.mjs'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['actualApplicationServed','receiptFailureShown','nextOriginalPageSelected','originalProfileRetained','userPageNotSelected','missingNextPageRetainsSelection','visitRequestMatchesNewSelection','completedQueueShown','closedPanelStopsPolling','gateFailureShown','gateNextPageSelected','gateEmptyQueueKeepsManualFill'])assert.equal(proof[key],true);assert.equal(proof.realSubmissions,0);
});
