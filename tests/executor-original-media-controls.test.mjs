import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {applicationMutation,applicationMutationSatisfied} from '../core/application-mutation.mjs';
import {enqueueLibraryMutation,flushApplicationMutations,overlayApplication,pendingApplication} from '../executor/src/application-mutations.mjs';
import {enqueueMediaUpload} from '../executor/src/media-uploads.mjs';
import {putDeviceMedia,readDeviceMedia} from '../cloud/worker/src/device-media.mjs';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {imageFormatFixtures} from '../executor/test/image-format-fixtures.mjs';
const P=globalThis.ExtLinkProfiles,embedded=imageFormatFixtures[0].dataUrl;
const kinds=['logo','featured','screenshot1','screenshot2','screenshot3','screenshot4'];
test('offline edits with equal timestamps retain original clear-before-disable order',()=>{
 const store=new Store(':memory:'),pair={endpoint:'https://fixture.invalid',workspaceId:'original'},scope=workbenchScope(pair);try{store.set('pair',pair);for(const id of ['ffffffff','11111111'])store.set('appMutation:'+id,{id,scope,status:'pending',at:'2026-10-06T00:00:00Z'});assert.deepEqual(pendingApplication({store}).map(item=>item.id),['ffffffff','11111111']);}finally{store.close();}
});
function original(){return{id:'p',name:'Original',url:'https://product.example',logoUrl:'https://product.example/logo.png',logoDataUrl:embedded,fields:{LOGO:'https://product.example/logo.png','Cloud LOGO':'cloud-media://logo','Featured image':'https://product.example/cover.png','Cloud Featured image':'cloud-media://featured',...Object.fromEntries([1,2,3,4].map(i=>['Screenshot '+i,'cloud-media://shot'+i]))},media:{logo:'cloud-media://logo',featured:'cloud-media://featured',screenshots:[1,2,3,4].map(i=>'cloud-media://shot'+i)},mediaVersions:kinds.map(kind=>({assetId:kind,kind,ref:'cloud-media://'+kind,sha256:'old-'+kind}))};}
test('original clear changes only the embedded logo after save and independent public URL editing is confirmed',()=>{
 const profile=original(),before=structuredClone(profile),operation={type:'profile',profileId:'p',profile:{id:'p',logoDataUrl:''},at:'now'};
 const cleared=applicationMutation({siteProfiles:{p:profile}},operation).data.p;
 assert.equal(cleared.logoDataUrl,'');assert.equal(cleared.logoUrl,before.logoUrl);assert.deepEqual(cleared.fields,before.fields);assert.deepEqual(cleared.mediaVersions,before.mediaVersions);assert.deepEqual(profile,before);assert.ok(applicationMutationSatisfied({siteProfiles:{p:cleared}},operation));
 const edited=applicationMutation({siteProfiles:{p:cleared}},{...operation,profile:{id:'p',logoUrl:'https://new.example/logo.svg'}}).data.p;assert.equal(edited.logoUrl,'https://new.example/logo.svg');
 for(const logoUrl of ['javascript:alert(1)','https://user:pass@example.com/a.png',7])assert.throws(()=>applicationMutation({siteProfiles:{p:profile}},{...operation,profile:{id:'p',logoUrl}}),e=>e.status===400);
 for(const mediaDisabled of [{logo:'false'},{constructor:true},[],null])assert.throws(()=>applicationMutation({siteProfiles:{p:profile}},{...operation,profile:{id:'p',mediaDisabled}}),e=>e.status===400);
 const markerProfile={id:'p',logoDataUrl:embedded,fields:{LOGO:'(uploaded logo)','Featured image':'(uploaded logo)'}},markerCleared=applicationMutation({siteProfiles:{p:markerProfile}},operation).data.p;assert.equal(P.resolveMediaField(P.buildAgentConfigFromProfile(markerCleared),'logo').value,'','an old uploaded marker cannot become a remote image URL');assert.deepEqual(markerCleared.fields,markerProfile.fields);
});
test('all original media disable switches block old fields and embedded fallback without deleting history or crossing product identity',()=>{
 for(const kind of kinds){const profile=original(),before=structuredClone(profile),disabled=applicationMutation({siteProfiles:{p:profile}},{type:'profile_media',profileId:'p',kind,action:'disable',at:'now'}).data.p;
  const config=P.buildAgentConfigFromProfile(disabled),hint=kind==='featured'?'cover image':kind.startsWith('screenshot')?'screenshot '+kind.slice(10):'logo',descriptor=P.resolveMediaField(config,hint);
  assert.equal(descriptor.value,'',kind);assert.equal(descriptor.useLogoDataUrl,false,kind);assert.deepEqual(disabled.fields,before.fields);assert.deepEqual(disabled.mediaVersions,before.mediaVersions);assert.deepEqual(profile,before);
  assert.equal(P.mergeFillConfig({mediaDisabled:{}},config,{mediaDisabled:{[kind]:false}}).mediaDisabled[kind],true);
  const restored=applicationMutation({siteProfiles:{p:disabled}},{type:'profile_media',profileId:'p',kind,action:'restore',assetId:kind,at:'later'}).data.p;assert.equal(P.resolveMediaField(P.buildAgentConfigFromProfile(restored),hint).value,'cloud-media://'+kind);assert.deepEqual(restored.mediaVersions,before.mediaVersions);
 }
 const selected=P.buildAgentConfigFromProfile(original());assert.equal(selected.logoDataUrl,'','explicit cloud version must outrank preserved embedded image');
 const embeddedOnly=P.buildAgentConfigFromProfile({id:'p',fields:{LOGO:'(uploaded logo)'},logoDataUrl:embedded});assert.equal(embeddedOnly.logoDataUrl,embedded);
});
test('disabled screenshot positions cannot shift later screenshots into explicit earlier slots',()=>{
 const profile=original();profile.mediaDisabled={screenshot3:true};const config=P.buildAgentConfigFromProfile(profile);
 assert.deepEqual(config.screenshots,['cloud-media://shot1','cloud-media://shot2','','cloud-media://shot4']);assert.equal(P.resolveMediaField(config,'screenshot 3').value,'');assert.equal(P.resolveMediaField(config,'screenshot 4').value,'cloud-media://shot4');assert.equal(P.resolveMediaField(config,'gallery',2).value,'');assert.equal(P.resolveMediaField(config,'gallery',3).value,'cloud-media://shot4');
});
test('original 2 MiB logo boundary applies before local persistence and R2 writes while other images keep their existing limit',async()=>{
 const store=new Store(':memory:'),pair={endpoint:'https://fixture.invalid',workspaceId:'original'},scope=workbenchScope(pair);let network=0,writes=0;const runtime={store,cloud:{async request(){network++;throw Error('offline');}}};store.set('pair',pair);store.set('applicationSnapshot',{scope,snapshot:{documents:{siteProfiles:{p:original()}},revisions:{siteProfiles:1}}});
 const objects=new Map(),bytes=size=>{const result=Buffer.alloc(size);imageFormatFixtures[0].bytes.copy(result);return result;},dataUrl=size=>'data:image/gif;base64,'+bytes(size).toString('base64'),boundary=2*1024*1024,bucket={async put(key,bytes,options){if(objects.has(key))return null;writes++;objects.set(key,{...options,bytes});},async get(key){const object=objects.get(key);return object?{...object,arrayBuffer:async()=>object.bytes.buffer.slice(object.bytes.byteOffset,object.bytes.byteOffset+object.bytes.byteLength)}:null;}};
 try{await assert.rejects(enqueueMediaUpload(runtime,{profileId:'p',kind:'logo',dataUrl:dataUrl(boundary+1)}),e=>e.status===400&&/2 MB/.test(e.message));assert.equal(network,0);assert.equal(store.values('mediaUpload:').length,0);
  await assert.rejects(putDeviceMedia(bucket,'original',{assetId:'asset-11111111-1111-4111-8111-111111111111',profileId:'p',kind:'logo',mime:'image/gif',dataUrl:dataUrl(boundary+1),sha256:createHash('sha256').update(bytes(boundary+1)).digest('hex')},{p:original()}),e=>e.status===400&&/2 MB/.test(e.message));assert.equal(writes,0);
  await enqueueMediaUpload(runtime,{profileId:'p',kind:'logo',dataUrl:dataUrl(boundary)});assert.equal(store.values('mediaUpload:').length,1);await enqueueMediaUpload(runtime,{profileId:'p',kind:'featured',dataUrl:dataUrl(boundary+1)});assert.equal(store.values('mediaUpload:').length,2);
  for(const [index,kind]of ['logo','featured','screenshot4'].entries()){const size=kind==='logo'?boundary:boundary+1,input={assetId:'asset-11111111-1111-4111-8111-11111111111'+index,profileId:'p',kind,mime:'image/gif',dataUrl:dataUrl(size),sha256:createHash('sha256').update(bytes(size)).digest('hex')};await putDeviceMedia(bucket,'original',input,{p:original()});assert.equal((await readDeviceMedia(bucket,'original',input.assetId)).sha256,input.sha256);}assert.equal(writes,3);
 }finally{store.close();}
});
test('original clear and disable persist offline and recover lost replies using original IDs and untouched receipt history',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-original-clear-')),path=join(home,'outbox.sqlite'),pair={endpoint:'https://fixture.invalid',workspaceId:'original'},scope=workbenchScope(pair),snapshot={documents:{siteProfiles:{p:original()},submissionRecords:{old:{evidence:'Original receipt'}}},revisions:{siteProfiles:1}};let store=new Store(path),online=false,writes=0;
 const runtime={store,cloud:{async request(route,input){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);writes++;const operation=route==='profile'?{type:'profile',profileId:input.profileId,profile:input.profile,at:'cloud'}:input.operation;snapshot.documents.siteProfiles=applicationMutation(snapshot.documents,operation).data;snapshot.revisions.siteProfiles++;throw Error('write committed response lost');}}};
 try{store.set('pair',pair);store.set('paused',true);store.set('applicationSnapshot',{scope,snapshot});const clear=await enqueueLibraryMutation(runtime,{operation:{type:'profile',profileId:'p',profile:{id:'p',logoDataUrl:''}}}),disable=await enqueueLibraryMutation(runtime,{operation:{type:'profile_media',profileId:'p',kind:'logo',action:'disable'}});assert.equal(writes,0);assert.equal(overlayApplication(runtime,snapshot).documents.siteProfiles.p.logoDataUrl,'');store.close();store=new Store(path);runtime.store=store;online=true;for(let i=0;i<4;i++)await flushApplicationMutations(runtime);assert.equal(writes,2);for(const id of [clear.id,disable.id])assert.equal(store.get('appMutation:'+id).status,'confirmed');assert.equal(snapshot.documents.siteProfiles.p.logoDataUrl,'');assert.equal(P.resolveMediaField(P.buildAgentConfigFromProfile(snapshot.documents.siteProfiles.p),'logo').value,'');assert.equal(snapshot.documents.submissionRecords.old.evidence,'Original receipt');assert.deepEqual(snapshot.documents.siteProfiles.p.mediaVersions,original().mediaVersions);assert.equal(store.get('paused'),true);
 }finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-clear-'));await rm(home,{recursive:true,force:true});}
});
test('real remote profile content changes still retain the original clear edit as a conflict',async()=>{
 const store=new Store(':memory:'),pair={endpoint:'https://fixture.invalid',workspaceId:'original'},snapshot={documents:{siteProfiles:{p:original()}},revisions:{siteProfiles:1}};let online=false,writes=0;const runtime={store,cloud:{async request(route){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);writes++;throw Error('must not overwrite concurrent profile');}}};
 try{store.set('pair',pair);store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});const edit=await enqueueLibraryMutation(runtime,{operation:{type:'profile',profileId:'p',profile:{id:'p',logoDataUrl:''}}});snapshot.documents.siteProfiles.p.logoDataUrl=imageFormatFixtures[1].dataUrl;snapshot.documents.siteProfiles.p.updatedAt='remote';snapshot.revisions.siteProfiles++;online=true;await flushApplicationMutations(runtime);assert.equal(writes,0);assert.equal(store.get('appMutation:'+edit.id).status,'conflict');assert.equal(snapshot.documents.siteProfiles.p.logoDataUrl,imageFormatFixtures[1].dataUrl);}finally{store.close();}
});
