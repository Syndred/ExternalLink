import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationModel} from '../core/application-model.mjs';
import {queue,priorProductSuccess,selectScope} from '../executor/src/shared.mjs';
import {autoVisitTarget} from '../executor/src/browser-assistant.mjs';
const url='https://receipt.example/submit',key='receipt.example/submit::p';
const source={status:'success',profileId:'p',destinationUrl:url,destinationKey:'receipt.example/submit',confirmedBy:'agent',evidence:'Concrete original site receipt',submittedAt:'2026-09-20T00:00:00Z',publicationStatus:'pending_moderation'};
const variants=[source,{...source,confirmedBy:'legacy_import'}, {...source,evidence:''},{...source,evidence:'Table.xlsx submitted seed'},{...source,confirmedBy:'manual',evidence:'Legacy siteAnnotations.submittedProjects'}];
test('queue prior receipt checks retain original evidence requirements and host-product deduplication',()=>{
 for(const record of variants){const records={[key]:record},before=structuredClone(records),expected=queue.isSubmissionSuccessful(records,'receipt.example/submit','p');assert.equal(priorProductSuccess(records,'p',url),expected,JSON.stringify({confirmedBy:record.confirmedBy,evidence:record.evidence}));assert.equal(priorProductSuccess(records,'p','https://receipt.example/another-submit'),expected);assert.equal(priorProductSuccess(records,'q',url),false);assert.equal(priorProductSuccess(records,'p','https://another.example/submit'),false);assert.deepEqual(records,before);const snapshot={documents:{urlList:url,siteProfiles:{p:{id:'p',fields:{Name:'原产品',Url:'https://product.example'}}},submissionRecords:records}},result=selectScope(snapshot,null,'p');assert.equal(result.tasks.length,expected?0:1);assert.equal(autoVisitTarget(snapshot,'p',url)===null,expected);}
});
test('overview receipt labels agree with original catalog evidence without discarding legacy activity',()=>{
 for(const record of variants){const snapshot={documents:{urlList:url,siteProfiles:{p:{id:'p'}},submissionRecords:{[key]:record}}},before=structuredClone(snapshot),model=applicationModel(snapshot),expected=queue.isSubmissionSuccessful(snapshot.documents.submissionRecords,'receipt.example/submit','p');assert.equal(model.library[0].progress.hasSubmitted,expected);assert.equal(model.activity.length,1);assert.equal(model.activity[0].records.length,1);assert.equal(model.activity[0].submission==='received',expected);assert.deepEqual(snapshot,before);}
});
