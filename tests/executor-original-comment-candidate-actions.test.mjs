import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('actual candidate card buttons copy exact controlled text, fill only the original task and preserve edits after SQLite reopen',{timeout:45000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-comment-candidate-actions.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:40000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
 for(const key of ['ok','threeActualUiCandidatesFilled','actualEngineReadback','sameOriginalTaskKept','editedDraftsMatchFrozenOriginal','controlledClipboardTextsMatched','controlledClipboardFailureKeepsDraft','lateAttemptBoundaryRejected','sqliteReopenKeepsDraftsAndSelectedText','actualUiReloadKeepsEdits','originalBusinessUnchanged','originalChromeUntouched'])assert.equal(proof[key],true,key);
 for(const key of ['posts','realSubmissions','realModelCalls','productionWrites'])assert.equal(proof[key],0,key);assert.equal(proof.realOsClipboardTested,false);
});
