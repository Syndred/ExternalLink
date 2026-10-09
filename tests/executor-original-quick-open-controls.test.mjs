import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('actual quick-open UI toggles the original filtered selection and retains options across dialogs and batches',{timeout:45000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-quick-open-controls.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:40000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['ok','filteredToggleMatchesFrozenOriginal','hiddenSelectionsRetained','originalDefaults','originalIntervalStep','dialogOptionsRetained','optionsSurviveCompletion','removeOpenedFalseRetainsSelection','removeOpenedTrueRemovesSelection','sourceDocumentsUnchanged'])assert.equal(proof[key],true);assert.equal(proof.realSiteTabsOpened,0);assert.equal(proof.realSubmissions,0);assert.equal(proof.realModelCalls,0);
});
