import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {originalCommentRestoration} from './helpers/original-comment-restore.mjs';
test('frozen original comment input and history restore preserve edited candidates and update their character counts',()=>{
 const original=[{text:'Original',angle:'提问',anchorText:'Brand',placement:'末尾',chars:8}],result=originalCommentRestoration(original,{0:'Edited 中文🙂'});
 assert.equal(result.edited.drafts[0].chars,'Edited 中文🙂'.length);assert.deepEqual(result.restoredDrafts,original);assert.deepEqual(result.history[0].drafts,result.edited.drafts);
});
test('actual latest-comment restoration preserves unsaved and in-flight edits, failures and original ownership through SQLite reopen',{timeout:45000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-comment-restore.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:40000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['ok','latestRestoresSavedCandidate','unsavedEditsMatchFrozenOriginal','editedCharacterCountsPreserved','inFlightEditsBackedUp','failedBackupDoesNotReplaceDraft','productSwitchRejectsOldResult','sqliteReopenKeepsVersions','originalBusinessUnchanged'])assert.equal(proof[key],true);assert.equal(proof.realSubmissions,0);assert.equal(proof.realModelCalls,0);
});
