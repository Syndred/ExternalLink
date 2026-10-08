import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('native services and UI restore saved original history and timeline without starting tasks and retain them after restart',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-local-history-recovery.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(evidence.source,'synthetic_original_facts');assert.equal(evidence.originalHistoricalCombinations,8815);assert.equal(evidence.restoredOriginalTimelineEvents,8);assert.equal(evidence.ownedFixtureTimelineWrites,1);for(const key of ['actualNativeHistorySourcePicker','noManualFileUpload','originalBatchAndLedgerExact','repeatImportDeduplicated','fullOriginalReportExported','actualUiTimelineOnlyRecovery','allOriginalEventIdsAndFieldsRetained','otherDocumentsRetained','privateBackupSaved','restartKeepsSameHistoryAndTimeline','existingTaskAndPausedBatchRetained','sourceFileBytesUnchanged'])assert.equal(evidence[key],true);for(const key of ['externalRequests','productionBusinessWrites','realModelCalls','realSubmissions'])assert.equal(evidence[key],0);
});
test('existing original record upload, full exports and resumed large-history file workflow remain available',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/run-exports.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);
});
