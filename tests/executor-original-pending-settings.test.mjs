import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {overlayApplicationSettings} from '../executor/src/application-mutations.mjs';
import {applySubmissionPreferences} from '../executor/src/submission-preferences.mjs';

function fixture(){const store=new Store(':memory:'),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original'},scope=workbenchScope(pair),snapshot={documents:{cfgEmail:'old@example.com',targetFilters:{aiComments:true,aiCommentAllowLink:true},siteProfiles:{p:{id:'p',name:'Frozen product'}},submissionRecords:{original:{evidence:'Original row'}}},revisions:{cfgEmail:7,siteProfiles:8}};store.set('pair',pair);store.set('applicationSnapshot',{scope,snapshot});return{store,scope,snapshot,runtime:{store}};}
function pending(f,key,value,type='settings'){const id='pending-'+key,at='2026-10-08T01:00:00Z';f.store.set('appMutation:'+id,{id,scope:f.scope,at,key,status:'pending',operation:type==='settings'?{id,at,type,key,value}:{id,at,type,key,data:value}});}

test('pending original settings take effect without borrowing unconfirmed profiles, ledger edits or cloud revisions',()=>{
 const f=fixture();try{const before=structuredClone(f.snapshot);pending(f,'cfgEmail','new@example.com');pending(f,'siteProfiles',{p:{id:'p',name:'Unconfirmed edit'}},'recover_local');pending(f,'submissionRecords',{replaced:{}},'recover_local');const result=overlayApplicationSettings(f.runtime,f.snapshot);assert.equal(result.documents.cfgEmail,'new@example.com');assert.deepEqual(result.documents.siteProfiles,before.documents.siteProfiles);assert.deepEqual(result.documents.submissionRecords,before.documents.submissionRecords);assert.deepEqual(result.revisions,before.revisions);assert.deepEqual(f.snapshot,before);f.store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'another'});assert.deepEqual(overlayApplicationSettings(f.runtime,f.snapshot),before);}finally{f.store.close();}
});

test('locally recovered original setting documents also govern execution before their first cloud revision',()=>{
 const f=fixture();try{pending(f,'targetFilters',{aiComments:false,aiCommentAllowLink:false},'recover_local');assert.equal(overlayApplicationSettings(f.runtime,f.snapshot).documents.targetFilters.aiComments,false);assert.equal(f.snapshot.documents.targetFilters.aiComments,true);}finally{f.store.close();}
});

test('original task comment bridge checks pending disabled AI before cache or model and pending link preference before a fresh request',async()=>{
 const f=fixture();let calls=0,payload;f.runtime.batchModelRequest=async(_task,_route,input)=>{calls++;payload=input;return{ok:true,status:'ok',drafts:[{text:'Fixture draft'}]};};const task={id:'original-task'},message={action:'generateCommentDrafts',pageUrl:'https://article.fixture.invalid/post',count:1,config:{projectKey:'p',aiComments:true,aiCommentAllowLink:true}};
 try{await Runtime.prototype.bridge.call(f.runtime,task,message);assert.equal(calls,1);pending(f,'targetFilters',{aiComments:false});assert.equal((await Runtime.prototype.bridge.call(f.runtime,task,message)).status,'disabled');assert.equal(calls,1);pending(f,'targetFilters',{aiComments:true,aiCommentAllowLink:false});await Runtime.prototype.bridge.call(f.runtime,task,{...message,pageUrl:'https://article.fixture.invalid/other'});assert.equal(calls,2);assert.equal(payload.allowLink,false);assert.equal(payload.config.aiCommentAllowLink,false);}finally{f.store.close();}
});

test('pending original submission switches govern the actual execution preferences while fill-only stays enforced',()=>{
 const f=fixture();try{pending(f,'autoSubmitDirectoryListings',false);pending(f,'autoSubmitStandardWpComments',true);pending(f,'targetFilters',{aiComments:false,aiCommentAllowLink:false});const task={id:'original-task'},config=applySubmissionPreferences(f.runtime,task,f.snapshot.documents,{});assert.equal(config.autoSubmitDirectory,false);assert.equal(config.autoSubmitStandardWpComments,true);assert.equal(config.aiComments,false);assert.equal(config.aiCommentAllowLink,false);const fillOnly=applySubmissionPreferences(f.runtime,{...task,fillOnlyRun:true},f.snapshot.documents,{});assert.equal(fillOnly.autoSubmitDirectory,false);assert.equal(fillOnly.autoSubmitStandardWpComments,false);}finally{f.store.close();}
});

test('actual native page and comment studio use pending local preferences through SQLite restart, matching the frozen original configuration',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-pending-settings.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:45000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(Object.values(evidence.proof).every(Boolean),true);assert.equal(evidence.pendingSettings,3);assert.equal(evidence.fixtureModelCalls,1);assert.equal(evidence.samePendingIdsAfterSQLiteRestart,true);assert.equal(evidence.remoteDocumentsAndRevisionsUnchanged,true);for(const key of ['posts','externalRequests','realModelCalls','productionWrites'])assert.equal(evidence[key],0);
});

test('frozen pre-refactor comment engine fills the same selected text and local contact values without a model or submission',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-pending-settings-reference.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:45000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.deepEqual(evidence.values,{username:'New owner',email:'new@example.com',comment:'An explicitly selected original comment, filled without a model or submission.'});for(const key of ['posts','externalRequests','realModelCalls','productionWrites'])assert.equal(evidence[key],0);
});
