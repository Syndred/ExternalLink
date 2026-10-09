import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {originalLibraryAction} from './helpers/original-library-catalog.mjs';
import {applicationMutation} from '../core/application-mutation.mjs';

test('pin preserves the original supplied URL spelling for a new queue entry',async()=>{
 for(const url of ['https://new.example','https://NEW.example:443','https://new.example/a%2fb','https://new.example?x=1']){
  const before={urlList:'https://existing.example/form|forum',siteAnnotations:{keep:{note:'Keep'}},deletedSubmissionKeys:['keep'],submissionRecords:{keep:{evidence:'Keep'}}};
  const expected=await originalLibraryAction(before,'pin',{url}),change=applicationMutation(before,{type:'pin',url,id:'pin-fixture',at:'2026-10-09T00:00:00Z'});
  assert.deepEqual({...before,[change.key]:change.data},expected.documents,url);
 }
});

test('actual library pin control changes the original queue and survives offline restart without changing preferences',{timeout:45000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-pin-control.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
 for(const key of ['ok','existingDuplicatesMatchOriginal','newEntryMatchesOriginal','originalQueueOrderVisible','offlineRestartAndLostReply','preferencesAndReceiptsKept'])assert.equal(proof[key],true);
 assert.equal(proof.realSubmissions,0);
});
