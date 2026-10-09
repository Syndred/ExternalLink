import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native Product Hunt launch, same-task resume, panel and auto-visit preserve original no-progress boundaries',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-product-hunt-no-progress.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));
 assert.equal(evidence.ok,true);assert.equal(evidence.rows.length,6);assert.ok(evidence.rows.slice(0,4).every(row=>row.stepRequests===1));assert.ok(evidence.rows.slice(4).every(row=>row.stepRequests===3&&row.visualCalls===1&&row.actualFinalReadinessCheck&&row.priorConsentDidNotCreate));assert.equal(evidence.originalCheckpointHistory,12);assert.equal(evidence.profileRunTargetAndUnknownBoundaryKept,true);assert.equal(evidence.actualVisualReadinessPreservedWithoutAnotherStepOrCreate,true);
 for(const key of ['posts','externalRequests','modelCalls','productionWrites'])assert.equal(evidence[key],0);
});
