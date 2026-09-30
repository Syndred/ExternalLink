globalThis.self=globalThis;await import('../core/profiles.js');
import test from 'node:test';import assert from 'node:assert/strict';import {applicationModel,taskSummary} from '../core/application-model.mjs';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {Store} from '../executor/src/store.mjs';import {applicationData} from '../executor/src/application-data.mjs';import {workbenchScope} from '../executor/src/workbench-sync.mjs';
test('an application without a verified mailbox cannot display unowned legacy associations as received replies',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example'});store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot:{documents:{siteProfiles:{p:{name:'P'}},submissionRecords:{'directory.example::p':{profileId:'p',destinationUrl:'https://directory.example',status:'success'}}},revisions:{}}});
 store.set('gmailAssociation:legacy',{status:'associated',identity:'directory.example::p'});const runtime={store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0})};const data=await applicationData(runtime);assert.equal(data.model.combinations[0].reply,'unknown');store.close();
});
test('archived products cannot enter new execution scope',()=>{
 assert.throws(()=>globalThis.ExtLinkExecutorContract.selectScope({documents:{siteProfiles:{p:{archived:true}},urlList:'https://directory.example'}},null,'p'),/归档/);
});
test('media disable and version restore preserve old assets and stop fallback to retired fields',()=>{
 const profile={id:'p',fields:{'Cloud LOGO':'cloud-media://new',LOGO:'https://old.example/logo.png'},media:{logo:'cloud-media://new'},mediaVersions:[{assetId:'old',ref:'cloud-media://old',kind:'logo',sha256:'old-hash'},{assetId:'new',ref:'cloud-media://new',kind:'logo',sha256:'new-hash'}]};
 const disabled=applicationMutation({siteProfiles:{p:profile}},{type:'profile_media',profileId:'p',kind:'logo',action:'disable',at:'now'}).data.p;
 assert.equal(globalThis.ExtLinkProfiles.buildAgentConfigFromProfile(disabled,{}).logoUrl,'');assert.equal(disabled.mediaVersions.length,2);
 const restored=applicationMutation({siteProfiles:{p:disabled}},{type:'profile_media',profileId:'p',kind:'logo',action:'restore',assetId:'old',at:'later'}).data.p;
 assert.equal(globalThis.ExtLinkProfiles.buildAgentConfigFromProfile(restored,{}).logoUrl,'cloud-media://old');assert.equal(restored.mediaVersions.length,2);assert.equal(profile.media.logo,'cloud-media://new');
 assert.deepEqual(globalThis.ExtLinkProfiles.buildAgentConfigFromProfile({fields:{'Screenshot 3':'cloud-media://retired'},mediaDisabled:{screenshot3:true}},{}).screenshots,[]);
 assert.throws(()=>applicationMutation({siteProfiles:{p:profile}},{type:'profile',profileId:'p',profile:{id:'p',mediaVersions:[]},at:'now'}),/历史媒体/);
 assert.throws(()=>applicationMutation({siteProfiles:{p:profile}},{type:'profile',profileId:'p',profile:{id:'p',mediaVersions:[{...profile.mediaVersions[0],sha256:'changed'},profile.mediaVersions[1]]},at:'now'}),/历史媒体/);
});
test('create and archive products preserve historical records and reject reused identities',()=>{
 const docs={siteProfiles:{p:{id:'p',name:'Original'}},submissionRecords:{history:{profileId:'p',evidence:'Received'}}};
 const create={type:'profile_create',profileId:'new',profile:{id:'new',name:'New product',url:'https://new.example',fields:{Name:'New product',Url:'https://new.example'}},at:'2026-09-30'};
 const created=applicationMutation(docs,create);assert.equal(created.data.new.name,'New product');assert.equal(applicationMutationSatisfied({siteProfiles:created.data},create),true);
 assert.throws(()=>applicationMutation({siteProfiles:created.data},create),/存在/);
 const archived=applicationMutation(docs,{type:'profile_archive',profileId:'p',archived:true,at:'2026-09-30'});assert.equal(archived.data.p.archived,true);assert.equal(docs.siteProfiles.p.archived,undefined);assert.equal(docs.submissionRecords.history.evidence,'Received');
 assert.equal(applicationMutation({siteProfiles:archived.data},{type:'profile_archive',profileId:'p',archived:false,at:'later'}).data.p.archived,false);
 assert.throws(()=>applicationMutation(docs,{...create,profile:{...create.profile,url:'javascript:alert(1)'}}),/网址/);
});
test('matrix uses host and product identity and keeps receipt, review, publication and sync independent',()=>{
 const snapshot={documents:{siteProfiles:{p:{name:'P'},q:{name:'Q'}},urlList:'https://www.directory.example/submit\nhttps://directory.example/add',submissionRecords:{'directory.example/submit::p':{profileId:'p',status:'success',publicationStatus:'pending_moderation'}}}};
 const model=applicationModel(snapshot,[{id:'t',url:'https://directory.example/add',profileId:'p',status:'finished',receipt:{evidence:'Received',publicationStatus:'pending_moderation'},cloudVerified:true,syncStatus:'confirmed'},
 {id:'unknown',url:'https://directory.example/submit',profileId:'q',status:'submitted_unconfirmed',attemptBoundary:'sent',syncStatus:'pending'}]);
 assert.equal(model.products.length,2);assert.equal(model.combinations.length,2);const received=model.combinations.find(c=>c.profileId==='p');assert.equal(received.review,'pending');assert.equal(received.publication,'unknown');assert.equal(received.reply,'unknown');assert.equal(received.submission,'received');
 assert.equal(model.combinations.find(c=>c.profileId==='q').submission,'sent_unconfirmed');
});
test('task list omits detailed inputs, history and any incidental credentials',()=>{
 assert.deepEqual(taskSummary({id:'t',status:'pending',localToken:'private',profileSnapshot:{},actualSubmission:{},history:[]}),{id:'t',status:'pending'});
});
