import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';

test('owned history fixture reports the failing service and drained stderr without exposing credentials',async()=>{
 const source=await readFile(new URL('../executor/test/original-local-history-recovery.mjs',import.meta.url),'utf8');
 const startSource=source.slice(source.indexOf('async function start(file)'),source.indexOf('async function stop(service)')).replaceAll('import.meta.dirname','fixtureDir');
 const child=Object.assign(new EventEmitter(),{pid:12345,exitCode:1,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter()});
 const start=vm.runInNewContext('('+startSource.trim()+')',{spawn:()=>{queueMicrotask(()=>{child.stderr.emit('data','Error: SQLITE_BUSY: database is locked\nBearer fixture-private-token\nlocalToken=isolated-history-local\n');child.emit('close',1,null);});return child;},process:{execPath:'fixture-node',env:{}},fixtureDir:'fixture-source',resolve:(...parts)=>parts.join('/'),join:(...parts)=>parts.join('/'),home:'fixture-home',backupRoot:'fixture-backups',readFile:async()=>{throw Error('Fixture has no ready file');},setTimeout});
 await assert.rejects(start('workbench-server.mjs'),error=>{
  assert.match(error.message,/workbench-server\.mjs/);assert.match(error.message,/PID 12345/);assert.match(error.message,/exited 1/);assert.match(error.message,/SQLITE_BUSY: database is locked/);assert.ok(!error.message.includes('fixture-private-token'));assert.ok(!error.message.includes('isolated-history-local'));return true;
 });
});

test('native services and UI restore saved original history and timeline without starting tasks and retain them after restart',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-local-history-recovery.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(evidence.source,'synthetic_original_facts');assert.equal(evidence.originalHistoricalCombinations,8815);assert.equal(evidence.restoredOriginalTimelineEvents,8);assert.equal(evidence.ownedFixtureTimelineWrites,1);for(const key of ['actualNativeHistorySourcePicker','noManualFileUpload','originalBatchAndLedgerExact','repeatImportDeduplicated','fullOriginalReportExported','actualUiTimelineOnlyRecovery','allOriginalEventIdsAndFieldsRetained','otherDocumentsRetained','privateBackupSaved','restartKeepsSameHistoryAndTimeline','existingTaskAndPausedBatchRetained','sourceFileBytesUnchanged'])assert.equal(evidence[key],true);for(const key of ['externalRequests','productionBusinessWrites','realModelCalls','realSubmissions'])assert.equal(evidence[key],0);
});
test('existing original record upload, full exports and resumed large-history file workflow remain available',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/run-exports.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);
});
