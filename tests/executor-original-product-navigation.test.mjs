import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import '../core/profiles.js';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {applicationModel} from '../core/application-model.mjs';
import {Store} from '../executor/src/store.mjs';
import {enqueueLibraryMutation,enqueueProfileMutation,flushApplicationMutations,overlayApplication} from '../executor/src/application-mutations.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
const P=globalThis.ExtLinkProfiles;
const profiles=()=>({z:{id:'z',name:'Zed',url:'https://zed.example',promoUrl:'https://zed.example/promote',sortIndex:0,fields:{Name:'Zed',Url:'https://zed.example'},fieldNotes:{Name:'Keep'},mediaVersions:[{assetId:'original-logo'}]},a:{id:'a',name:'Alpha',sortIndex:2,archived:true,fields:{}},b:{id:'b',name:'Beta',sortIndex:1,fields:{}}});
test('independent original promotional URL edits leave the homepage, frozen task and media history unchanged',()=>{
 const docs={siteProfiles:profiles(),submissionRecords:{original:{status:'success',profileId:'z'}}},oldConfig=P.buildAgentConfigFromProfile(docs.siteProfiles.z),frozen=structuredClone(oldConfig);
 const operation={type:'profile',profileId:'z',at:'now',profile:{id:'z',promoUrl:'https://zed.example/new?source=directory'}};
 const result=applicationMutation(docs,operation),profile=result.data.z;
 assert.equal(profile.url,'https://zed.example');assert.equal(profile.fields.Url,'https://zed.example');assert.equal(P.buildAgentConfigFromProfile(profile).targetDomain,'https://zed.example/new?source=directory');assert.equal(frozen.targetDomain,'https://zed.example/promote');assert.deepEqual(profile.mediaVersions,docs.siteProfiles.z.mediaVersions);assert.deepEqual(profile.fieldNotes,docs.siteProfiles.z.fieldNotes);assert.equal(profile.sortIndex,0);assert.equal(applicationMutationSatisfied({siteProfiles:result.data},operation),true);
 assert.equal(P.buildAgentConfigFromProfile(applicationMutation(docs,{...operation,profile:{id:'z',promoUrl:''}}).data.z).targetDomain,'https://zed.example');
 const jev={id:'JevPlay',name:'JevPlay',url:'https://jevplay.com',fields:{Url:'https://jevplay.com'},promoUrl:'https://jevplay.com/games'};assert.equal(P.buildAgentConfigFromProfile(jev).targetDomain,'https://jevplay.com');
});
test('invalid promotional URLs are client errors and cannot alter original product data',()=>{
 const docs={siteProfiles:profiles()},before=structuredClone(docs);for(const promoUrl of [123,null,'javascript:alert(1)','ftp://zed.example','https://user:password@zed.example'])assert.throws(()=>applicationMutation(docs,{type:'profile',profileId:'z',profile:{id:'z',promoUrl}}),error=>error.status===400&&/推广网址/.test(error.message));assert.deepEqual(docs,before);
});
test('the workbench uses the original persisted profile order rather than insertion or alphabetical order',()=>{
 const docs={siteProfiles:profiles()};assert.deepEqual(applicationModel({documents:docs}).products.map(p=>p.id),P.orderedProfileIds(docs.siteProfiles));assert.deepEqual(applicationModel({documents:docs}).products.map(p=>p.id),['z','b','a']);
});
test('original drag ordering is one atomic complete product update and retains archived products and all other fields',()=>{
 const docs={siteProfiles:profiles(),submissionRecords:{original:{status:'success',profileId:'z'}}},operation={id:'original-order',type:'profile_order',profileIds:['b','z','a'],at:'now'},before=structuredClone(docs),result=applicationMutation(docs,operation);
 assert.equal(result.key,'siteProfiles');assert.deepEqual(result.data,P.applyProfileOrder(docs.siteProfiles,operation.profileIds));assert.equal(applicationMutationSatisfied({siteProfiles:result.data},operation),true);assert.equal(applicationMutationSatisfied(docs,operation),false);assert.deepEqual(docs,before);assert.deepEqual(applicationModel({documents:{siteProfiles:result.data}}).products.map(p=>p.id),operation.profileIds);
 for(const profileIds of [null,[],['z','b'],['z','b','a','other'],['z','z','a'],['z','b','__proto__']])assert.throws(()=>applicationMutation(docs,{...operation,profileIds}),error=>error.status===400&&/排序/.test(error.message));
});
test('new products append after the original saved order without rewriting existing products',()=>{
 const docs={siteProfiles:profiles()},created=applicationMutation(docs,{type:'profile_create',profileId:'new',at:'now',profile:{id:'new',name:'A new product',url:'https://new.example',promoUrl:'https://new.example/offer'}});assert.equal(created.data.new.sortIndex,3);assert.deepEqual(P.orderedProfileIds(created.data),['z','b','a','new']);assert.deepEqual(created.data.z,docs.siteProfiles.z);
});
test('new products use the original next sort index while imported products without an index remain unchanged',()=>{
 const docs={siteProfiles:{...profiles(),legacy:{id:'legacy',name:'Legacy import',fields:{Name:'Legacy import'}}}},result=applicationMutation(docs,{type:'profile_create',profileId:'new',at:'now',profile:{id:'new',name:'New product',url:'https://new.example'}});assert.equal(result.data.new.sortIndex,P.nextProfileSortIndex(docs.siteProfiles));assert.deepEqual(P.orderedProfileIds(result.data),['z','b','a','new','legacy']);assert.deepEqual(result.data.legacy,docs.siteProfiles.legacy);
});
test('deleting an original product compacts saved order while preserving remaining archived products and historical receipts',()=>{
 const docs={siteProfiles:profiles(),submissionRecords:{original:{profileId:'z',status:'success'}}},result=applicationMutation(docs,{type:'profile_delete',profileId:'z',at:'now'});assert.equal(result.data.b.sortIndex,0);assert.equal(result.data.a.sortIndex,1);assert.equal(result.data.a.archived,true);assert.equal(docs.submissionRecords.original.status,'success');assert.equal(docs.siteProfiles.z.sortIndex,0);
});
test('offline product order and promotional URL survive SQLite restart and committed lost replies without replacement writes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-original-navigation-')),path=join(home,'outbox.sqlite'),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'original'};let store=new Store(path),online=false,writes=0;const snapshot={documents:{siteProfiles:profiles()},revisions:{siteProfiles:1}},runtime={store,cloud:{async request(route,input){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);writes++;const op=route==='profile'?{type:'profile',profileId:input.profileId,profile:input.profile,at:'cloud'}:input.operation,change=applicationMutation(snapshot.documents,op);snapshot.documents[change.key]=change.data;snapshot.revisions[change.key]++;throw Error('committed reply lost');}}};
 try{store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});const ordered=await enqueueLibraryMutation(runtime,{operation:{type:'profile_order',profileIds:['b','z','a']}}),edited=await enqueueProfileMutation(runtime,{profileId:'z',revision:1,profile:{id:'z',promoUrl:'https://zed.example/new'}});assert.equal(edited.pending,2);assert.deepEqual(P.orderedProfileIds(overlayApplication(runtime,snapshot).documents.siteProfiles),['b','z','a']);store.close();store=new Store(path);runtime.store=store;online=true;
 assert.equal((await flushApplicationMutations(runtime)).pending,2);assert.equal(writes,1);assert.equal((await flushApplicationMutations(runtime)).pending,1);assert.equal(writes,2);assert.equal((await flushApplicationMutations(runtime)).pending,0);assert.equal(writes,2);for(const id of [ordered.id,edited.id])assert.equal(store.get('appMutation:'+id).status,'confirmed');assert.deepEqual(P.orderedProfileIds(snapshot.documents.siteProfiles),['b','z','a']);assert.equal(snapshot.documents.siteProfiles.z.promoUrl,'https://zed.example/new');assert.equal(store.get('paused'),true);
 }finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-navigation-'));await rm(home,{recursive:true,force:true});}
});
test('a remote new product keeps an offline original order in conflict without losing the new product',async()=>{
 const store=new Store(':memory:'),pair={endpoint:'https://cloud.fixture.invalid',workspaceId:'one'},snapshot={documents:{siteProfiles:profiles()},revisions:{siteProfiles:1}};let writes=0;store.set('pair',pair);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});const remote=structuredClone(snapshot);remote.documents.siteProfiles.new={id:'new',name:'New remote',sortIndex:3};remote.revisions.siteProfiles++;
 try{const runtime={store,cloud:{async request(route){if(route==='snapshot')return structuredClone(remote);writes++;throw Error('must not write');}}},result=await enqueueLibraryMutation(runtime,{operation:{type:'profile_order',profileIds:['b','z','a']}});assert.equal(result.pending,1);assert.equal(writes,0);assert.equal(store.get('appMutation:'+result.id).status,'conflict');assert.equal(remote.documents.siteProfiles.new.name,'New remote');assert.equal(applicationMutationSatisfied(remote.documents,store.get('appMutation:'+result.id).operation),false);}finally{store.close();}
});
