import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
for(const options of [[],['--receipt'],['--iframe','--article'],['--receipt','--iframe','--article']])test('original UI comment trimming precedes true field limit and exact field saving '+options.join(' '),{timeout:30000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-single-page-comment-fields.mjs','--padded',...options],{cwd,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(proof.rawValueReadback,true);assert.equal(proof.sqliteReopenPreservesActual,true);assert.equal(proof.failedFieldCheckpointSurvivesSqliteReopen,true);assert.equal(proof.posts,0);
});
test('candidate UI preserves raw draft and copy while filling original trimmed comment',{timeout:30000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-comment-candidate-actions.mjs','--padded'],{cwd,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(proof.actualEngineReadback,true);assert.equal(proof.controlledClipboardTextsMatched,true);assert.equal(proof.actualUiReloadKeepsEdits,true);assert.equal(proof.posts,0);
});
