import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('actual generation UI matches the complete original candidate limit, saves three candidates and reloads them from SQLite',{timeout:60000},()=>{
 const result=spawnSync(process.execPath,['executor/test/comment-drafts.mjs'],{encoding:'utf8',timeout:55000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
 for(const key of ['passed','completeOriginalGenerationHandlerExecuted','overDeliveryAndBlankCandidatesMatchOriginal','threeGeneratedCandidatesSavedAndReloaded','genericFiveCandidateApiPreserved','sqliteReopenKeepsGeneratedCandidateLimit','firstFailedGenerationIsNotALoadableDraft','oneCandidateFallback','inFlightEditsRetainedInHistory','productAndArticleChangesDiscardOldResults','navigationDisposesOldStudio','failurePreservesDraftAndRetry','originalReceiptAndPausedBatchPreserved','originalChromeUntouched'])assert.equal(proof[key],true,key);
 assert.equal(proof.productionWrites+proof.realModelCalls+proof.newRealSubmissions,0);
});
