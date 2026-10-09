import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('actual library group controls match complete original panel in eight states and save, reopen and recover the same offline SQLite plan',{timeout:60000},()=>{
 const result=spawnSync(process.execPath,['executor/test/library-state.mjs','--groups'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:55000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
 for(const key of ['ok','completeOriginalPanelAndModulesExecuted','actualGroupAddRemoveSaveReopen','sqliteReopenAndCloudRecoveryVerified','originalReceiptsPreserved','paused'])assert.equal(proof[key],true);
 assert.equal(proof.groupCases,8);assert.deepEqual(proof.offlinePlanTypes,['mark','set_deleted']);assert.equal(proof.realSubmissions,0);assert.equal(proof.productionWrites,0);
});
