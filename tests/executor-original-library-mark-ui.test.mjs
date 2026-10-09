import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('all original destination condition controls save and reload their exact marks without changing receipts or the paused range',()=>{
 const result=spawnSync(process.execPath,['executor/test/library-actions.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.passed,true);assert.equal(evidence.originalMarkUiCases,18);assert.equal(evidence.originalRecordsAndPausedBatchPreserved,true);assert.equal(evidence.newRealSubmissions,0);
});
