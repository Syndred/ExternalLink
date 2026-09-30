import test from 'node:test';import assert from 'node:assert/strict';
import {decodeImageAsset,profileMediaReferences} from '../core/media-assets.mjs';
import {Store} from '../executor/src/store.mjs';import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueMediaUpload,flushMediaUploads} from '../executor/src/media-uploads.mjs';
import {resolveApplicationConflict} from '../executor/src/application-mutations.mjs';
import {putDeviceMedia,readDeviceMedia} from '../cloud/worker/src/device-media.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
test('media upload rejects mismatched image signatures and freezes both media models with correct kinds',()=>{
 assert.ok(decodeImageAsset(png).length>0);assert.throws(()=>decodeImageAsset('data:image/jpeg;base64,'+png.split(',')[1]),/格式/);assert.throws(()=>decodeImageAsset('data:image/png;base64,PGh0bWw+'),/格式/);
 const refs=profileMediaReferences({fields:{'Cloud LOGO':'cloud-media://logo','Cloud Featured image':'cloud-media://hero'},media:{logo:'cloud-media://logo',screenshots:['cloud-media://screen']}});
 assert.deepEqual(refs,[{ref:'cloud-media://logo',kind:'logo'},{ref:'cloud-media://hero',kind:'featured'},{ref:'cloud-media://screen',kind:'screenshot1'}]);
 assert.deepEqual(profileMediaReferences({fields:{'Cloud LOGO':'cloud-media://retired'},mediaDisabled:{logo:true}}),[]);
});
test('device media is immutable across unknown retries and cannot be adopted by another product',async()=>{
 let saved,writes=0;const bucket={async get(){return saved?{customMetadata:saved.metadata,httpMetadata:{contentType:saved.mime},arrayBuffer:async()=>saved.bytes.buffer}:null;},async put(key,bytes,options){if(saved)return null;writes++;saved={bytes,metadata:options.customMetadata,mime:options.httpMetadata.contentType};return{};}};
 const bytes=decodeImageAsset(png),sha256=await crypto.subtle.digest('SHA-256',bytes).then(b=>Buffer.from(b).toString('hex')),input={assetId:'asset-11111111-1111-4111-8111-111111111111',profileId:'p',kind:'logo',mime:'image/png',dataUrl:png,sha256,fileName:'logo.png'};
 await putDeviceMedia(bucket,'one',input,{p:{}});await putDeviceMedia(bucket,'one',input,{p:{}});assert.equal(writes,1);assert.equal((await readDeviceMedia(bucket,'one',input.assetId)).sha256,sha256);
 await assert.rejects(putDeviceMedia(bucket,'one',{...input,profileId:'q'},{q:{}}),/范围/);assert.equal(writes,1);
 await assert.rejects(putDeviceMedia(bucket,'one',{...input,sha256:'0'.repeat(64)},{p:{}}),/校验/);
});
test('media bytes persist before upload and lost responses are verified before attaching a version',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one'});let snapshot={documents:{siteProfiles:{p:{id:'p',fields:{},media:{}}}},revisions:{siteProfiles:1}},online=false,asset,writes=0;
 store.set('applicationSnapshot',{scope:workbenchScope(store.get('pair')),snapshot});
 const runtime={store,cloud:{async request(route,input){if(!online){assert.ok(store.values('mediaUpload:')[0].dataUrl);throw Error('offline');}if(route==='snapshot')return structuredClone(snapshot);if(route.startsWith('media-assets/')){if(!asset)throw Object.assign(Error('not found'),{status:404});return{ok:true,asset};}if(route==='media-upload'){writes++;asset={assetId:input.assetId,sha256:input.sha256,profileId:input.profileId,kind:input.kind,mime:input.mime};throw Error('response lost');}if(route==='profile'){snapshot.documents.siteProfiles.p={...snapshot.documents.siteProfiles.p,...input.profile};snapshot.revisions.siteProfiles++;return{ok:true};}throw Error('Unexpected route '+route);}}};
 const result=await enqueueMediaUpload(runtime,{profileId:'p',kind:'logo',dataUrl:png,fileName:'logo.png'});assert.equal(result.pending,1);assert.equal(snapshot.documents.siteProfiles.p.media.logo,undefined);
 online=true;await flushMediaUploads(runtime);await flushMediaUploads({store,cloud:runtime.cloud});assert.equal(writes,1);assert.equal(store.values('mediaUpload:')[0].status,'confirmed');assert.match(snapshot.documents.siteProfiles.p.media.logo,/^cloud-media:\/\//);assert.equal(snapshot.documents.siteProfiles.p.mediaVersions.length,1);store.close();
});
test('choosing the cloud version for a media conflict retains the uploaded asset without an endless pending attachment',async()=>{
 const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'one'});const scope=workbenchScope(store.get('pair')),assetId='asset-11111111-1111-4111-8111-111111111111',snapshot={documents:{siteProfiles:{p:{id:'p',media:{logo:'remote'}}}},revisions:{siteProfiles:2}};
 store.set('applicationSnapshot',{scope,snapshot});store.set('mediaUpload:'+assetId,{assetId,scope,profileId:'p',kind:'logo',mime:'image/png',sha256:'hash',dataUrl:png,status:'reference_pending'});
 store.set('appMutation:media-'+assetId,{id:'media-'+assetId,scope,at:'now',key:'siteProfiles',status:'conflict',baseData:{},operation:{type:'profile',profileId:'p',profile:{id:'p',media:{logo:'local'}}}});
 const runtime={store,cloud:{async request(route){if(route==='snapshot')return structuredClone(snapshot);if(route.startsWith('media-assets/'))return{asset:{assetId,profileId:'p',kind:'logo',mime:'image/png',sha256:'hash'}};throw Error('Must not upload or replace the chosen remote profile');}}};
 await resolveApplicationConflict(runtime,{id:'media-'+assetId,choice:'cloud',revision:2});const result=await flushMediaUploads(runtime);assert.equal(result.pending,0);assert.equal(store.get('mediaUpload:'+assetId).status,'retained');assert.equal(snapshot.documents.siteProfiles.p.media.logo,'remote');store.close();
});
