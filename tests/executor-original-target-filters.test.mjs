import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {pendingSubmissionQueue} from '../core/submission-queue.mjs';
import {selectScope,queue} from '../executor/src/shared.mjs';
import {previewWorkbenchBatch} from '../executor/src/workbench-features.mjs';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueLibraryMutation,flushApplicationMutations,pendingApplication,overlayApplication} from '../executor/src/application-mutations.mjs';
import {applicationData} from '../executor/src/application-data.mjs';
const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const oldNormalize=vm.runInNewContext('('+source.slice(source.indexOf('function normalizeTargetFilters('),source.indexOf('async function getTargetFilters('))+')');
const plain=value=>JSON.parse(JSON.stringify(value));
const op=(key,value)=>({type:'settings',key,value,id:'original-settings',at:'2026-10-06T00:00:00Z'});
test('saved filter values match the original normalization for legacy strings, clamps and literal booleans',()=>{
 for(const input of [{},{minDomainAgeMonths:'9999',minOpportunityScore:'999'},{minDomainAgeMonths:'-20',minOpportunityScore:'-5'},{minDomainAgeMonths:'invalid',minOpportunityScore:'invalid'},{blacklistEnabled:false,requireKnownDomainAge:'false',aiComments:false,showManualFillIcons:false},{minDomainAgeMonths:'5.5',minOpportunityScore:'22.5',aiCommentAllowLink:false}]){
  assert.deepEqual(applicationMutation({},op('targetFilters',input)).data,plain(oldNormalize(input)));
 }
});
test('partial filter edits retain original assistant preferences and added DR/DA gates without mutating the raw snapshot',()=>{
 const raw={targetFilters:{aiComments:false,aiCommentAllowLink:false,showManualFillIcons:false,minDomainAgeMonths:'15',minDr:70,minDa:50}},before=structuredClone(raw),change=applicationMutation(raw,op('targetFilters',{minOpportunityScore:'30'}));
 assert.deepEqual(change.data,{...plain(oldNormalize({...raw.targetFilters,minOpportunityScore:'30'})),minDr:70,minDa:50});assert.deepEqual(raw,before);
 assert.equal(applicationMutationSatisfied({...raw,targetFilters:change.data},op('targetFilters',{minOpportunityScore:'30'})),true);
 assert.equal(applicationMutationSatisfied(raw,op('targetFilters',{minOpportunityScore:'30'})),false);
 assert.throws(()=>applicationMutation(raw,op('targetFilters',{unknown:true})),/筛选/);
});
test('blacklist incremental operations reproduce the original update, including normalized removal and wildcard additions',async()=>{
 const originalUpdate=source.slice(source.indexOf('async function updateDomainBlacklist('),source.indexOf('\n}',source.indexOf('async function updateDomainBlacklist('))+2);
 for(const patch of [{add:['*.WWW.Blocked.Example','https://Other.Example/path','other.example']},{remove:['https://www.blocked.example/path']},{replace:true,add:['*.Example.com','WWW.Example.com','','*.']},{add:[],remove:[]}]){
  let saved={domainBlacklist:['.blocked.example','Keep.Example']};
  const fn=vm.runInNewContext('('+originalUpdate+')',{self:{ExtLinkQueue:queue},chrome:{storage:{local:{get:async()=>saved,set:async value=>{saved=value;}}}}});
  const expected=plain((await fn(patch)).domainBlacklist),actual=applicationMutation({domainBlacklist:['.blocked.example','Keep.Example']},op('domainBlacklist',patch));assert.deepEqual(actual.data,expected);
 }
});
test('blacklist replacement accepts original arrays and migrated text, preserving rules and unrelated evidence',()=>{
 const docs={domainBlacklist:['keep.example'],submissionRecords:{receipt:{status:'success',evidence:'Original receipt'}}},input=['*.WWW.Blocked.Example','https://OTHER.example/path','other.example',''];
 const expected=['.blocked.example','other.example'];for(const value of [input,input.join('\n')]){const change=applicationMutation(docs,op('domainBlacklist',value));assert.deepEqual(change.data,expected);assert.equal(applicationMutationSatisfied({...docs,domainBlacklist:change.data},op('domainBlacklist',value)),true);}
 assert.deepEqual(docs.domainBlacklist,['keep.example']);assert.equal(docs.submissionRecords.receipt.evidence,'Original receipt');assert.throws(()=>applicationMutation(docs,op('domainBlacklist',{add:['ok.example'],unknown:true})),/黑名单/);
});
const fixtureSnapshot=()=>({documents:{siteProfiles:{p:{id:'p',name:'Original product'}},selectedSiteIds:['p'],sheetTableData:{entries:[{link:'https://old.example/form',metrics:{dr:90,da:90}},{link:'https://young.example/form',metrics:{dr:90,da:90}},{link:'https://unknown.example/form',metrics:{dr:90,da:90}}]},targetFilters:{minDomainAgeMonths:'10000',requireKnownDomainAge:'false'},domainMetricsCache:{'old.example':{ageMonths:650},'young.example':{ageMonths:500}},submissionRecords:{}},revisions:{siteProfiles:1,targetFilters:1}});
test('settings presentation normalizes legacy filters while raw cloud documents and revisions remain unchanged',async()=>{
 const store=new Store(':memory:'),snapshot=fixtureSnapshot(),original=structuredClone(snapshot),pair={endpoint:'https://fixture.invalid',workspaceId:'presentation'};store.set('pair',pair);store.set('paused',true);
 try{const runtime={store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0}),cloud:{request:async()=>structuredClone(snapshot)}},data=await applicationData(runtime,{refresh:true});assert.equal(data.settings.targetFilters.minDomainAgeMonths,600);assert.equal(data.settings.targetFilters.requireKnownDomainAge,false);assert.equal(data.settings.targetFilters.aiComments,true);assert.deepEqual(store.get('applicationSnapshot').snapshot,original);assert.deepEqual(snapshot,original);}finally{store.close();}
});
test('original month clamping and literal unknown-age switch govern both actual queue and VM batch preview',async()=>{
 const snapshot=fixtureSnapshot(),store=new Store(':memory:');try{
  const expected=['https://old.example/form','https://unknown.example/form'];assert.deepEqual(plain(selectScope(snapshot,null,'p').tasks.map(t=>t.url)),expected);assert.deepEqual(pendingSubmissionQueue(snapshot).groups.map(g=>g.domain).sort(),['old.example','unknown.example']);
  const runtime={store,cloud:{request:async route=>route==='snapshot'?structuredClone(snapshot):{runs:[],tasks:[]}}};store.set('paused',true);const {batch}=await previewWorkbenchBatch(runtime,{profileIds:['p'],urls:snapshot.documents.sheetTableData.entries.map(row=>row.link)});assert.deepEqual(batch.items.map(item=>item.status),['ready','excluded','ready']);assert.match(batch.items[1].reason,/年龄/);assert.equal(store.get('paused'),true);assert.equal(snapshot.documents.targetFilters.minDomainAgeMonths,'10000');
 }finally{store.close();}
});
test('normalized blacklist and added DR/DA constraints affect execution rather than only the settings display',()=>{
 const snapshot=fixtureSnapshot();snapshot.documents.targetFilters={blacklistEnabled:true,minDr:'90',minDa:'95'};snapshot.documents.domainBlacklist=['*.old.example'];const scope=selectScope(snapshot,null,'p');assert.equal(scope.tasks.length,0);assert.match(scope.exclusions[0].reason,/黑名单/);assert.match(scope.exclusions[1].reason,/DA/);
 snapshot.documents.targetFilters={blacklistEnabled:false,minDomainAgeMonths:-5};assert.equal(selectScope(snapshot,null,'p').tasks.length,3);
});
test('offline partial settings and blacklist survive SQLite reopen and lost replies without replacement IDs or repeated writes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-original-filters-')),path=join(home,'outbox.sqlite');let store=new Store(path);const pair={endpoint:'https://fixture.invalid',workspaceId:'original-filter'},scope=workbenchScope(pair),snapshot=fixtureSnapshot();snapshot.documents.targetFilters={aiComments:false,minDr:50};snapshot.documents.domainBlacklist=['original.example'];snapshot.revisions.domainBlacklist=1;let online=false;const writes=[];
 let runtime={store,cloud:{async request(route,input){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);writes.push(input.operation.id);const change=applicationMutation(snapshot.documents,input.operation);snapshot.documents[change.key]=change.data;snapshot.revisions[change.key]++;throw Error('committed reply lost');}}};store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope,snapshot});
 try{
  await enqueueLibraryMutation(runtime,{operation:{type:'settings',key:'targetFilters',value:{minOpportunityScore:'25'}}});await enqueueLibraryMutation(runtime,{operation:{type:'settings',key:'domainBlacklist',value:{add:['*.new.example']}}});const ids=pendingApplication(runtime).map(item=>item.id),overlaid=overlayApplication(runtime,snapshot);assert.equal(overlaid.documents.targetFilters.aiComments,false);assert.deepEqual(overlaid.documents.domainBlacklist,['.new.example','original.example']);
  store.close();store=new Store(path);runtime.store=store;online=true;for(let i=0;i<4;i++)await flushApplicationMutations(runtime);assert.deepEqual(writes,ids);assert.equal(pendingApplication(runtime).length,0);assert.equal(snapshot.documents.targetFilters.aiComments,false);assert.equal(snapshot.documents.targetFilters.minDr,50);assert.equal(snapshot.documents.targetFilters.minOpportunityScore,25);assert.deepEqual(snapshot.documents.domainBlacklist,['.new.example','original.example']);assert.equal(store.get('paused'),true);
 }finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep));await rm(home,{recursive:true,force:true});}
});
