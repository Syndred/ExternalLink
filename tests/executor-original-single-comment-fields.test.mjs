import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

for(const receipt of [false,true])for(const form of ['standard','sparse','article'])for(const iframe of [false,true])test('actual single-page '+(receipt?'existing receipt':'new task')+' '+form+' '+(iframe?'iframe':'main')+' comment field limits and exact readback',{timeout:35000},()=>{
 const args=['executor/test/original-single-page-comment-fields.mjs',...(receipt?['--receipt']:[]),...(form==='standard'?['--standard']:form==='article'?['--article']:[]),...(iframe?['--iframe']:[])];
 if(process.env.EL_SINGLE_COMMENT_EVIDENCE)args.push('--evidence-dir',process.env.EL_SINGLE_COMMENT_EVIDENCE);
 const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['ok','actualUi','actualRuntimeControl','originalCompleteFieldLimitGuardCompared','overflowRejectedBeforeRegistrationLeaseOrFieldMutation','rawValueReadback','unrelatedMatchingFieldCannotCertifyComment','sqliteReopenPreservesActual','failedFieldCheckpointWithAndWithoutDecoy','failedFieldCheckpointSurvivesSqliteReopen','oldReceiptTaskAndDocumentsKept','originalChromeUntouched'])assert.equal(proof[key],true,key);
 assert.equal(proof.receiptMode,receipt);assert.equal(proof.articleMode,form==='article');assert.equal(proof.iframe,iframe);assert.equal(proof.longRawCommentChars,24002);assert.equal(proof.registrations,receipt?0:1);assert.equal(proof.posts+proof.models+proof.productionWrites,0);assert.equal(proof.overallMigrationComplete,false);
});
