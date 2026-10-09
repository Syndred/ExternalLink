import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {rememberSubmissionQueuePage,completeSinglePageReceiptQueue} from '../executor/src/single-page-receipt-queue.mjs';
import {originalSinglePageReceipt} from './helpers/original-single-page-receipt.mjs';

test('frozen single-page receipt notification requires original ownership, selection, active page and successful close before acknowledgement',async()=>{
 for(const options of [{owned:false},{selected:false},{profileMatches:false},{pageMatches:false},{active:false},{closeFails:true}]){
  const result=await originalSinglePageReceipt(options);assert.deepEqual(result.calls,[]);if(options.closeFails)assert.equal(result.guardRetained,false);
 }
 const failedOpen=await originalSinglePageReceipt({openFails:true});assert.deepEqual(failedOpen.calls,[{type:'close',id:7}]);assert.equal(failedOpen.guardRetained,false);
});

test('single-page receipt continuation rejects changed identity, receipt, fields, ownership, workspace and selection after awaited page or cloud reads',async()=>{
 for(const mode of ['receipt','fields','verification','controller','panel','workspace','stopped','ownership','shared-page','queue']){
  const store=new Store(':memory:'),pair={endpoint:'https://isolated.invalid',workspaceId:'original'},scope=workbenchScope(pair),pageRecord={targetId:'original-page',browserInstance:'original-browser',url:'https://bai.tools/submit'},task={id:'original',profileId:'p',profileRevision:1,profileSnapshot:{id:'p',fields:{Name:'Original',Url:'https://product.example'}},version:1,controller:'executor',status:'finished',...pageRecord,pageOwnership:'manual',receipt:{evidence:'Original receipt'},actualSubmission:{fields:[{name:'name',value:'Original'}]},cloudVerified:true};
  store.set('pair',pair);store.set('paused',true);store.set('task:'+task.id,task);store.set('singlePagePanel',{id:'original-panel',scope,open:true,generation:1,selectedTargetId:task.targetId,profileId:'p'});store.set('submissionQueue',{scope,key:'bai.tools/submit',index:0,selectedSiteIds:['p'],page:pageRecord});
  let closed=0,opened=0,changed=false;
  const change=()=>{if(changed)return;changed=true;if(mode==='receipt')store.set('task:'+task.id,{...task,receipt:{evidence:'Newer proof'}});if(mode==='fields')store.set('task:'+task.id,{...task,actualSubmission:{fields:[{name:'name',value:'Newer actual value'}]}});if(mode==='verification')store.set('task:'+task.id,{...task,cloudVerified:false});if(mode==='controller')store.set('task:'+task.id,{...task,controller:'supervisor'});if(mode==='panel')store.set('singlePagePanel',{...store.get('singlePagePanel'),selectedTargetId:'user-selected'});if(mode==='workspace')store.set('pair',{...pair,workspaceId:'other'});if(mode==='stopped')store.set('executionStopped',{at:'user-stop'});if(mode==='ownership')store.set('submissionQueuePage:original-browser:original-page',{...store.get('submissionQueuePage:original-browser:original-page'),id:'new-owner'});if(mode==='shared-page')store.set('task:shared',{...task,id:'shared',status:'needs_manual',receipt:null});if(mode==='queue')store.set('submissionQueue',{...store.get('submissionQueue'),key:'user-selected-queue'});};
  const runtime={store,host:{startedAt:'original-browser'},context:{pages:()=>[{isClosed:()=>false,url:()=>pageRecord.url,close:async()=>{closed++;}}],newPage:async()=>{opened++;throw Error('No new page allowed');},newCDPSession:async()=>({send:async()=>{if(mode!=='queue')change();return{targetInfo:{targetId:pageRecord.targetId}};},detach:async()=>{}})},cloud:{request:async()=>{change();return{documents:{siteProfiles:{p:task.profileSnapshot}},revisions:{siteProfiles:1}};}}};
  try{rememberSubmissionQueuePage(runtime,pageRecord);await completeSinglePageReceiptQueue(runtime);assert.equal(changed,true,mode);assert.equal(closed,0,mode);assert.equal(opened,0,mode);assert.equal(store.get('task:'+task.id).tabClosedAt,undefined);if(mode==='queue')assert.equal(store.get('submissionQueue').key,'user-selected-queue');}finally{store.close();}
 }
});
