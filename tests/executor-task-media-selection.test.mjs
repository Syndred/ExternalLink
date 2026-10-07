import test from 'node:test';import assert from 'node:assert/strict';
import {taskMediaReferences,selectedFrozenPngLogo} from '../core/task-media-selection.mjs';
import {profiles,plain} from '../executor/src/shared.mjs';
import {Runtime} from '../executor/src/runtime.mjs';import {Store} from '../executor/src/store.mjs';

const original={id:'p',name:'Original',url:'https://product.example',fields:{'Cloud LOGO':'cloud-media://selected','Cloud Featured image':'cloud-media://hero','Screenshot 2':'cloud-media://stale-screen'},media:{logo:'cloud-media://stale-logo',screenshots:['cloud-media://one','cloud-media://disabled','cloud-media://three']},mediaDisabled:{screenshot2:true},mediaVersions:[{assetId:'history'}]};
test('task media follows original effective field precedence and screenshot slots, never the version history',()=>{
 const before=structuredClone(original),config=plain(profiles.buildAgentConfigFromProfile(original));
 assert.equal(config.logoUrl,'cloud-media://selected');assert.deepEqual(config.screenshots,['cloud-media://one','','cloud-media://three']);
 assert.deepEqual(taskMediaReferences(original),[{ref:config.logoUrl,kind:'logo'},{ref:config.featuredImage,kind:'featured'},{ref:config.screenshots[0],kind:'screenshot1'},{ref:config.screenshots[2],kind:'screenshot3'}]);assert.deepEqual(original,before);
 const disabled={...original,mediaDisabled:{logo:true,featured:true,screenshot1:true,screenshot2:true,screenshot3:true,screenshot4:true}};assert.deepEqual(taskMediaReferences(disabled),[]);
 assert.deepEqual(taskMediaReferences({id:'public',logoUrl:'https://product.example/logo.png',fields:{LOGO:'https://product.example/logo.png'},mediaVersions:[{assetId:'private-history'}]}),[]);
});
test('directory PNG upload uses the actual selected logo even in an old broad manifest',()=>{
 const manifest=[{asset_id:'stale-logo',media_kind:'logo',file_name:'old.png'},{asset_id:'selected',media_kind:'logo',file_name:'selected.png'},{asset_id:'history',media_kind:'logo',file_name:'historical.png'}],before=structuredClone(manifest);
 assert.equal(selectedFrozenPngLogo(original,manifest).asset_id,'selected');assert.equal(selectedFrozenPngLogo({...original,mediaDisabled:{logo:true}},manifest),null);assert.equal(selectedFrozenPngLogo({...original,fields:{},media:{},logoUrl:'https://public.example/logo.png'},manifest),null);assert.deepEqual(manifest,before);
});
test('actual native work keeps frozen product selection and disabled slots despite a legacy catalogue manifest',async()=>{
 const store=new Store(':memory:');try{
  const task={id:'task',runId:'run',url:'https://directory.example/submit',destinationKey:'directory.example/submit',profileId:'p',profileSnapshot:structuredClone(original),status:'pending',controller:'executor'},manifest=[{asset_id:'stale-logo',media_kind:'logo',file_name:'old.png'},{asset_id:'disabled',media_kind:'screenshot',media_index:1},{asset_id:'history',media_kind:'screenshot',media_index:2}],run={id:'run',profileId:'p',tasks:[task.id],profile:{...original,fields:{'Cloud LOGO':'cloud-media://changed-live'}},mediaManifest:manifest};
  store.set('task:'+task.id,task);store.set('run:run',run);store.set('paused',false);const before=structuredClone(run);let captured,closed=false;
  const page={isClosed:()=>closed,on(){},goto:async()=>{},locator:()=>({first:()=>({waitFor:async()=>{}})}),frames:()=>[]};
  const runtime={store,host:{startedAt:'isolated'},context:{newPage:async()=>page,newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'fixture-target'}}),detach:async()=>{}})},cloud:{request:async route=>{assert.equal(route,'snapshot');return{documents:{submissionRecords:{},siteProfiles:{p:run.profile}},revisions:{siteProfiles:2}};}},synchronize:async()=>{},lease:async()=>{},preparePublicPage:async()=>{},prepareKnownPage:async()=>{},update(t,patch){Object.assign(t,patch);store.set('task:'+t.id,t);},prepareWithAi:async(p,t,config)=>{captured=structuredClone(config);closed=true;store.set('paused',true);return{};}};
  await Runtime.prototype.work.call(runtime,{taskId:task.id});assert.ok(captured);assert.equal(captured.logoUrl,'cloud-media://selected');assert.equal(captured.projectFields['Cloud LOGO'],'cloud-media://selected');assert.deepEqual(captured.screenshots,['cloud-media://one','','cloud-media://three']);assert.deepEqual(store.get('run:run'),before);assert.deepEqual(store.get('task:task').profileSnapshot,original);assert.equal(store.get('task:task').attemptBoundary,undefined);
 }finally{store.close();}
});
