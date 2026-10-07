import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueProfileMutation,enqueueLibraryMutation,flushApplicationMutations} from '../executor/src/application-mutations.mjs';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {applyPreparedBackupKey} from '../core/prepared-backup-key.mjs';
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(key=>[key,reorder(value[key])])):value;
test('original product edits with reordered jsonb rules and media versions confirm after a lost reply without another write',async()=>{
 const store=new Store(':memory:');try{
  const pair={endpoint:'https://fixture.invalid',workspaceId:'one',storageBackend:'neon'},asset={assetId:'old',kind:'logo',ref:'cloud-media://old',sha256:'old-hash'};
  let snapshot={documents:{siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original'},mediaVersions:[asset],originalExtra:{retain:true}}}},revisions:{siteProfiles:1}},writes=0;
  store.set('pair',pair);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});
  const runtime={store,cloud:{async request(route,input){if(route==='snapshot')return reorder(snapshot);writes++;const operation={type:'profile',profileId:input.profileId,profile:input.profile,at:'server-time'};snapshot.documents.siteProfiles=reorder(applicationMutation(snapshot.documents,operation).data);snapshot.revisions.siteProfiles++;throw Error('lost after durable jsonb write');}}};
  const profile={id:'p',anchorRules:{brandKeywords:['Original'],allowExactMatch:false},blogRules:{tone:'helpful',maxLinksPerDraft:0,preferredAnchor:'brand'},mediaVersions:[reorder(asset)],fieldNotes:{Name:'原备注'}};
  await enqueueProfileMutation(runtime,{profileId:'p',profile,revision:1});assert.equal(writes,1);await flushApplicationMutations(runtime);assert.equal(writes,1);assert.equal(store.values('appMutation:')[0].status,'confirmed');assert.equal(snapshot.documents.siteProfiles.p.originalExtra.retain,true);
  assert.equal(applicationMutationSatisfied(snapshot.documents,{type:'profile',profileId:'p',profile:{id:'p',mediaVersions:[{...asset,sha256:'changed'}]}}),false);
  assert.throws(()=>applicationMutation(snapshot.documents,{type:'profile',profileId:'p',profile:{id:'p',mediaVersions:[{...asset,sha256:'changed'}]}}),/历史媒体/);
 }finally{store.close();}
});
test('field learning and answer-free form memory with reordered jsonb objects survive unknown replies without duplicate writes',async()=>{
 for(const type of ['form_learning','form_knowledge']){
  const store=new Store(':memory:');try{
   const pair={endpoint:'https://fixture.invalid',workspaceId:'one'},base={siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.fixture.invalid'}}},siteAnnotations:{}};let snapshot={documents:base,revisions:{siteProfiles:1,siteAnnotations:1}},writes=0;
   store.set('pair',pair);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});
   const runtime={store,cloud:{async request(route,input){if(route==='snapshot')return reorder(snapshot);writes++;const change=applicationMutation(snapshot.documents,input.operation);snapshot.documents[change.key]=reorder(change.data);snapshot.revisions[change.key]++;throw Error('lost write reply');}}};
   const operation={type,url:'https://directory.fixture.invalid/form',profileId:'p',identity:{name:'Original',url:'https://product.fixture.invalid'},mappings:{discord:{profileKey:'Discord',value:'https://discord.gg/original',label:'Discord',hint:'community'}},schema:{url:'https://directory.fixture.invalid/form',forms:[{method:'post'}],fields:[{name:'discord',label:'Discord',type:'text'}]}};
   await enqueueLibraryMutation(runtime,{operation});assert.equal(writes,1);await flushApplicationMutations(runtime);assert.equal(writes,1);assert.equal(store.values('appMutation:')[0].status,'confirmed');
   if(type==='form_knowledge')assert.equal(snapshot.documents.siteAnnotations['directory.fixture.invalid/form'].formKnowledge.mappings.discord.value,undefined);
  }finally{store.close();}
 }
});
test('original backup media treats reordered object keys as the same immutable version but rejects changed bytes and reordered history',()=>{
 const asset={assetId:'old',kind:'logo',ref:'cloud-media://old',sha256:'hash'},other={assetId:'next',kind:'logo',ref:'cloud-media://next',sha256:'next-hash'},documents={siteProfiles:{p:{id:'p',mediaVersions:[asset,other]}}};
 const operation={type:'backup_prepared_key',key:'siteProfiles',patch:[{path:['p','mediaVersions'],value:[reorder(asset),reorder(other)]}]};
 assert.deepEqual(applyPreparedBackupKey(documents,operation).p.mediaVersions,documents.siteProfiles.p.mediaVersions);
 assert.throws(()=>applyPreparedBackupKey(documents,{...operation,patch:[{path:['p','mediaVersions'],value:[{...asset,sha256:'different'}]}]}),/素材编号/);
 assert.throws(()=>applicationMutation(documents,{type:'profile',profileId:'p',profile:{id:'p',mediaVersions:[other,asset]}}),/历史媒体/);
});
