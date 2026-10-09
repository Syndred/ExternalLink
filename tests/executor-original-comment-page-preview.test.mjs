import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('actual comment UI matches original short and blocked page previews, target identity and SQLite persistence',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-comment-page-preview.mjs'],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
 for(const key of ['ok','completeOriginalGenerationHandlerExecuted','actualUiAndNativePagePreview','actualRuntimeControlDispatch','shortTitlePreviewWithoutModel','blockedSnapshotUsesActualArticle','longSnapshotGeneratesOriginalThree','rejectedPageModelTitleFallback','explicitDuplicateTargetPreserved','selectedSourceRejectsOtherTaskBeforeFill','selectedSourceMatchesOneOfTwoOriginalTasks','actualCommentFieldAndSqliteTaskReadback','unrelatedMatchingFieldCannotCertifyComment','ambiguousDuplicateRejected','sqliteReopenAndUiReload','sameUrlReloadRejectsOldModel','deviceSwitchRejectsLocalPreview','deviceSwitchDuringDocumentReadRejected','emptyPagePreviewDoesNotCreateLoadableDraft','disabledPreferenceStopsGeneration','originalBusinessUnchanged','originalChromeUntouched'])assert.equal(proof[key],true,key);
 assert.deepEqual(proof.cases.map(row=>[row.kind,row.originalAndCurrentCandidates,row.controlledModels]),[['short',1,0],['blocked',1,1],['long',3,1]]);
 assert.equal(proof.productionWrites+proof.realSubmissions+proof.realModelCalls,0);
 assert.equal(proof.overallMigrationComplete,false);
});
