import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../executor/src/store.mjs';import {workbenchScope} from '../executor/src/workbench-sync.mjs';import {enqueueLibraryMutation,enqueueProfileMutation,flushApplicationMutations,overlayApplication,resolveApplicationConflict} from '../executor/src/application-mutations.mjs';import {libraryMutation} from '../core/library-mutation.mjs';

test('workspace switch during read stops writes and cannot relabel the old snapshot as the new workspace',async()=>{
 const store=new Store(':memory:');try{store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one'});const scope=workbenchScope(store.get('pair')),snapshot={documents:{siteAnnotations:{}},revisions:{siteAnnotations:1}};store.set('applicationSnapshot',{scope,snapshot});let writes=0;
 const runtime={store,cloud:{request:async(route)=>{if(route!=='snapshot'){writes++;return;}store.set('pair',{endpoint:'https://cloud.example',workspaceId:'two'});return snapshot;}}};const result=await enqueueLibraryMutation(runtime,{operation:{type:'mark',url:'https://target.example',status:'needs_login'}});assert.match(result.error,/工作区已切换/);assert.equal(writes,0);assert.equal(store.values('appMutation:')[0].status,'pending');assert.equal(store.get('applicationSnapshot').scope,scope);
 }finally{store.close();}
});
test('workspace switch after one restore write keeps its unknown acknowledgement and does not send a following document',async()=>{
 const store=new Store(':memory:');try{const pair={endpoint:'https://cloud.example',workspaceId:'one'};store.set('pair',pair);const scope=workbenchScope(pair);let snapshot={documents:{cfgName:'Before',cfgEmail:'before@example.com'},revisions:{cfgName:1,cfgEmail:1}},writes=0;
 for(const [i,key]of ['cfgName','cfgEmail'].entries())store.set('appMutation:'+key,{id:key,scope,at:'2026-10-05T00:00:0'+i+'Z',key,baseData:snapshot.documents[key],status:'pending',operation:{id:key,at:'now',type:'recover_local',key,data:key==='cfgName'?'Recovered':'restored@example.com'}});
 const runtime={store,cloud:{async request(route,input){if(route==='snapshot')return structuredClone(snapshot);writes++;const result=libraryMutation(snapshot.documents,input.operation);snapshot.documents[result.key]=result.data;snapshot.revisions[result.key]++;store.set('pair',{...pair,workspaceId:'two'});return{ok:true};}}};const result=await flushApplicationMutations(runtime);assert.match(result.error,/工作区已切换/);assert.equal(writes,1);assert.equal(store.get('appMutation:cfgName').status,'pending');assert.equal(store.get('appMutation:cfgEmail').status,'pending');assert.equal(store.get('applicationSnapshot'),null);
 store.set('pair',pair);runtime.cloud.request=async(route,input)=>{if(route==='snapshot')return structuredClone(snapshot);writes++;const result=libraryMutation(snapshot.documents,input.operation);snapshot.documents[result.key]=result.data;snapshot.revisions[result.key]++;return{ok:true};};await flushApplicationMutations(runtime);assert.equal(writes,2);assert.equal(store.get('appMutation:cfgName').status,'confirmed');assert.equal(store.get('appMutation:cfgEmail').status,'confirmed');
 }finally{store.close();}
});
test('offline library edit persists before network access and uncertain cloud response is read back without replay',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one'});let snapshot={documents:{siteAnnotations:{}},revisions:{siteAnnotations:1}},online=false,writes=0;
 store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot});
 const runtime={store,cloud:{async request(route,input){if(!online){assert.equal(store.values('appMutation:').length,1);throw Error('offline');}if(route==='snapshot')return structuredClone(snapshot);writes++;snapshot.documents.siteAnnotations=libraryMutation(snapshot.documents,input.operation).data;snapshot.revisions.siteAnnotations++;throw Error('response lost');}}};
 const result=await enqueueLibraryMutation(runtime,{operation:{type:'mark',url:'https://directory.example/submit',status:'paid',note:'Observed fee'}});assert.equal(result.pending,1);assert.equal(overlayApplication(runtime,snapshot).documents.siteAnnotations['directory.example/submit'].status,'paid');
 online=true;await flushApplicationMutations(runtime);assert.equal(writes,1);const restored={store,cloud:runtime.cloud};const proof=await flushApplicationMutations(restored);assert.equal(proof.pending,0);assert.equal(writes,1);store.close();
});
test('conflict resolution keeps both versions and requires the exact reviewed remote revision',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example'});const scope=workbenchScope(store.get('pair'));
 let snapshot={documents:{siteAnnotations:{'site.example':{status:'paid'}}},revisions:{siteAnnotations:2}},writes=0;
 const operation={id:'local',at:'now',type:'mark',url:'https://site.example/',status:'needs_login'};
 store.set('appMutation:local',{id:'local',scope,at:'now',key:'siteAnnotations',baseData:{},operation,status:'conflict'});
 const runtime={store,cloud:{async request(route,input){if(route==='snapshot')return structuredClone(snapshot);writes++;snapshot.documents.siteAnnotations=libraryMutation(snapshot.documents,input.operation).data;snapshot.revisions.siteAnnotations++;return{ok:true};}}};
 await assert.rejects(resolveApplicationConflict(runtime,{id:'local',choice:'local',revision:1}),/版本/);assert.equal(writes,0);
 await resolveApplicationConflict(runtime,{id:'local',choice:'local',revision:2});assert.equal(writes,1);assert.equal(snapshot.documents.siteAnnotations['site.example'].status,'needs_login');
 const saved=store.get('appMutation:local');assert.equal(saved.status,'confirmed');assert.equal(saved.resolution.remoteData['site.example'].status,'paid');
 store.set('appMutation:other',{...saved,id:'other',status:'conflict',operation:{...operation,id:'other',status:'broken'}});
 await resolveApplicationConflict(runtime,{id:'other',choice:'cloud',revision:3});assert.equal(writes,1);assert.equal(store.get('appMutation:other').status,'discarded');assert.equal(overlayApplication(runtime,snapshot).documents.siteAnnotations['site.example'].status,'needs_login');store.close();
});
test('product edits survive offline restart and uncertain profile write is verified without repeating',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one'});let snapshot={documents:{siteProfiles:{p:{id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.example'},media:{logo:'old'}}}},revisions:{siteProfiles:1}},online=false,writes=0;
 store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot});const runtime={store,cloud:{async request(route,input){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'profile');writes++;const original=snapshot.documents.siteProfiles.p;snapshot.documents.siteProfiles.p={...original,...input.profile,fields:{...original.fields,...input.profile.fields},media:{...original.media,...input.profile.media},updatedAt:'cloud-time'};snapshot.revisions.siteProfiles++;throw Error('response lost');}}};
 const result=await enqueueProfileMutation(runtime,{profileId:'p',revision:1,profile:{id:'p',name:'Updated',fields:{Name:'Updated'},media:{logo:'new'}}});assert.equal(result.pending,1);assert.equal(overlayApplication(runtime,snapshot).documents.siteProfiles.p.name,'Updated');
 online=true;await flushApplicationMutations(runtime);assert.equal(writes,1);await flushApplicationMutations({store,cloud:runtime.cloud});assert.equal(writes,1);assert.equal(store.values('appMutation:')[0].status,'confirmed');store.close();
});
test('concurrent remote library edits are preserved and the local pending edit remains recoverable',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example'});store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot:{documents:{siteAnnotations:{}},revisions:{siteAnnotations:1}}});
 let writes=0;const runtime={store,cloud:{async request(route){if(route==='snapshot')return{documents:{siteAnnotations:{remote:{note:'new'}}},revisions:{siteAnnotations:2}};writes++;}}};
 const result=await enqueueLibraryMutation(runtime,{operation:{type:'mark',url:'https://directory.example/submit',status:'needs_login'}});assert.equal(writes,0);assert.equal(result.pending,1);assert.equal(store.values('appMutation:')[0].status,'conflict');store.close();
});
