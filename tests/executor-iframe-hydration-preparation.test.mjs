import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('a same-document iframe that exposes fields after its first detection gets deterministic preparation',()=>{
 const result=spawnSync(process.execPath,['tests/helpers/iframe-hydration-preparation.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout.trim());assert.equal(proof.observedFields,7);assert.equal(proof.detectCalls,2);assert.equal(proof.smartFillCalls,1);assert.equal(proof.missingNormalPreparation,false);assert.equal(proof.qualityCorrectlyRejectsContactOnly,true);assert.equal(proof.externalRequests,0);assert.equal(proof.browserOperations,0);assert.equal(proof.productionWrites,0);
});

test('normalFillDone from another frame does not skip an empty iframe',()=>{
 const result=spawnSync(process.execPath,['tests/helpers/iframe-hydration-preparation.mjs','prior-empty'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout.trim());assert.equal(proof.smartFillCalls,1);assert.equal(proof.missingNormalPreparation,false);assert.equal(proof.observation.normalPreparationRequested,true);
});

for(const [mode,requested,verified,finalAttempt]of [['prior-complete',false,true,false],['still-unrecognized',false,false,false],['final-attempt',false,false,true]])test(`${mode} preserves its form and submission safeguards during observation`,()=>{
 const result=spawnSync(process.execPath,['tests/helpers/iframe-hydration-preparation.mjs',mode],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout.trim());assert.equal(proof.smartFillCalls,0);assert.equal(proof.observation.normalPreparationRequested,requested);assert.equal(proof.observation.verifiedPriorPreparation,verified);assert.equal(proof.observation.finalAttempt,finalAttempt);if(finalAttempt)assert.equal(proof.attemptBoundary,'keep-original-final');
});

for(const [mode,fills,alreadyPrepared]of [['repeat-same',1,true],['repeat-new-document',2,false]])test(`${mode} scopes deterministic preparation to the original document`,()=>{
 const result=spawnSync(process.execPath,['tests/helpers/iframe-hydration-preparation.mjs',mode],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout.trim());assert.equal(proof.smartFillCalls,fills);assert.equal(proof.observation.alreadyPrepared,alreadyPrepared);
});
