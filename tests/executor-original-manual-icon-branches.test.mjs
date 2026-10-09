import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('actual manual select, embedded image, unknown field and article comment buttons match the complete original click handler', {timeout:45000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-manual-icon-branches.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
 assert.equal(proof.ok,true);assert.equal(proof.completeOriginalHandlerExecuted,true);
 assert.equal(proof.originalHelperDependenciesStubbed,true);
 assert.deepEqual(proof.results.map(item=>item.kind),['select','file','unmapped','comment']);
 assert.match(proof.results[1].exactUploadedSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(proof.negative.map(item=>item.kind),['no_matching_option','missing_image','missing_profile']);
 assert.ok(proof.negative.every(item=>item.completeOriginalHandlerResultMatched));
 for(const name of ['posts','externalRequests','productionWrites','realModelCalls'])assert.equal(proof[name],0);
 assert.equal(proof.controlledCommentRequests,1);assert.equal(proof.receiptsPreserved,true);assert.equal(proof.paused,true);
});
