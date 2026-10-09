import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applicationMutation} from '../core/application-mutation.mjs';
test('browser-page platform metadata cannot inject additional URL-list entries or rewrite a saved original type',()=>{
 const documents={urlList:'https://existing.example/post|article'};
 for(const type of ['pin','add_browser_url'])for(const platformType of ['wp_comment\nhttps://injected.example|directory','forum|directory','',42]){
  assert.throws(()=>applicationMutation(documents,{id:'test',at:'now',type,url:'https://new.example/post',platformType}),error=>error.status===400);
 }
 const existing=applicationMutation(documents,{id:'test',at:'now',type:'pin',url:'https://existing.example/post',platformType:'wp_comment'});assert.equal(existing.data,documents.urlList);
 const legacy=applicationMutation(documents,{id:'test',at:'now',type:'pin',url:'https://new.example/post'});assert.equal(legacy.data,'https://new.example/post|directory\n'+documents.urlList);
});
test('actual browser additions retain seven frozen-original detected page types and the existing interactive engine',{timeout:65000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-browser-add-platform.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(evidence.actualUiWordpressAddition,true);assert.equal(evidence.actualUiExistingPositionAndMarks,true);assert.deepEqual(evidence.results.map(row=>row.platform),['wp_comment','profile','forum','directory','submission','article','unknown']);for(const row of evidence.results)for(const key of ['urlListMatchesFrozenOriginal','existingInteractiveEngineKept','fieldsUnchanged'])assert.equal(row[key],true);for(const key of ['posts','externalRequests','realModelCalls','productionWrites','realSubmissions'])assert.equal(evidence[key],0);
});
