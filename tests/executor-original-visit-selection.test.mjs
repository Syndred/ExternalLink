import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueLibraryMutation,overlayVisitPreferences,visitPreferenceDocuments} from '../executor/src/application-mutations.mjs';
import {autoVisitTarget,assistantState} from '../executor/src/browser-assistant.mjs';
import {sidepanelOpened} from '../executor/src/single-page.mjs';

function fixture(){
 const store=new Store(':memory:'),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'visit-selection'},snapshot={documents:{siteProfiles:{p:{id:'p',name:'Original P',fields:{Name:'Original P',Url:'https://p.fixture.invalid'}},q:{id:'q',name:'Original Q',fields:{Name:'Original Q',Url:'https://q.fixture.invalid'}}},selectedSiteIds:['p'],activeSiteId:'p',autoFillOnVisit:true,sheetTableData:{entries:[]},submissionRecords:{}},revisions:{siteProfiles:2,activeSiteId:1,selectedSiteIds:1}};
 store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot:structuredClone(snapshot)});
 const runtime={store,cloud:{async request(route){if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'library');throw Error('Fixture cloud writes unavailable');}}};return{store,pair,snapshot,runtime};
}
test('saved local batch and current-product choices affect visit matching without borrowing pending product payload or revisions',async()=>{
 const f=fixture(),before=structuredClone(f.snapshot);try{
  await enqueueLibraryMutation(f.runtime,{operation:{type:'profile',profileId:'p',profile:{id:'p',fields:{Name:'Unconfirmed local payload'}}}});
  await enqueueLibraryMutation(f.runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:['q']}});
  let local=overlayVisitPreferences(f.runtime,f.snapshot);assert.equal(autoVisitTarget(local,'p','https://betalist.com/submit'),null);assert.ok(autoVisitTarget(local,'q','https://betalist.com/submit'));assert.deepEqual(local.documents.siteProfiles,f.snapshot.documents.siteProfiles);assert.deepEqual(local.revisions,f.snapshot.revisions);
  await enqueueLibraryMutation(f.runtime,{operation:{type:'profile_selection',key:'activeSiteId',value:'q'}});await enqueueLibraryMutation(f.runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:[]}});
  local=overlayVisitPreferences(f.runtime,f.snapshot);assert.ok(autoVisitTarget(local,'q','https://betalist.com/submit'));assert.equal(autoVisitTarget(local,'p','https://betalist.com/submit'),null);assert.equal(local.documents.activeSiteId,'q');assert.deepEqual(local.documents.selectedSiteIds,[]);
  assert.deepEqual(f.snapshot,before);assert.equal(f.store.values('task:').length,0);assert.equal(f.store.values('run:').length,0);
 }finally{f.store.close();}
});
test('legacy assistant state follows the saved local active product and exposes the same current visit selection',async()=>{
 const f=fixture();try{
  sidepanelOpened(f.runtime,{});await enqueueLibraryMutation(f.runtime,{operation:{type:'profile_selection',key:'activeSiteId',value:'q'}});await enqueueLibraryMutation(f.runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:[]}});
  const state=assistantState(f.runtime);assert.equal(state.settings.profileId,'q');assert.equal(state.settings.enabled,true);assert.deepEqual(state.selectedProfileIds,['q']);assert.equal(f.snapshot.documents.activeSiteId,'p');
 }finally{f.store.close();}
});
test('selection guards reuse raw product and media references and ignore preferences from another workspace',async()=>{
 const f=fixture();try{
  f.snapshot.documents.siteProfiles.p.logoDataUrl='data:image/png;base64,'+'A'.repeat(500000);
  const before=structuredClone(f.snapshot);await enqueueLibraryMutation(f.runtime,{operation:{type:'profile_selection',key:'selectedSiteIds',value:['q']}});
  const local=visitPreferenceDocuments(f.runtime,f.snapshot.documents);assert.equal(local.siteProfiles,f.snapshot.documents.siteProfiles);assert.equal(local.siteProfiles.p.logoDataUrl,f.snapshot.documents.siteProfiles.p.logoDataUrl);assert.deepEqual(local.selectedSiteIds,['q']);assert.deepEqual(f.snapshot,before);
  f.store.set('pair',{...f.pair,workspaceId:'other'});assert.equal(visitPreferenceDocuments(f.runtime,f.snapshot.documents),f.snapshot.documents);assert.deepEqual(overlayVisitPreferences(f.runtime,f.snapshot),f.snapshot);
 }finally{f.store.close();}
});

test('current native panel supplies the original empty-batch fallback and never overrides explicit selected products',()=>{
 const f=fixture();try{
  sidepanelOpened(f.runtime,{profileId:'q',targetId:'selected-page'});
  assert.deepEqual(assistantState(f.runtime).selectedProfileIds,['p']);
  const cached=f.store.get('applicationSnapshot');cached.snapshot.documents.selectedSiteIds=[];f.store.set('applicationSnapshot',cached);
  const state=assistantState(f.runtime);assert.equal(state.settings.profileId,'q');assert.deepEqual(state.selectedProfileIds,['q']);
  assert.equal(f.store.get('applicationSnapshot').snapshot.documents.activeSiteId,'p');assert.equal(f.store.values('appMutation:').length,0);
 }finally{f.store.close();}
});
