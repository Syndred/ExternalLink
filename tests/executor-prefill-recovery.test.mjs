import test from 'node:test';import assert from 'node:assert/strict';
import {Store}from'../executor/src/store.mjs';import {Runtime}from'../executor/src/runtime.mjs';
function setup(patch={},fields=[{name:'toolUrl',value:'https://jevplay.com'}]) {
  const store=new Store(':memory:');store.set('paused',true);
  const task={id:'original',runId:'run',version:1,profileId:'JevPlay',url:'https://poweredbyai.app/submit-tool',
    status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:'boundary',reason:'no_submit_button',
    submitResult:{reason:'no_submit_button'},actualSubmission:{fields},artifactRef:'old-proof',targetId:'original-page',...patch};
  store.set('task:original',task);const runtime=new Runtime(store,'.');runtime.lease=async()=>{};runtime.synchronize=async()=>runtime.status();
  Object.defineProperty(runtime,'cloud',{value:{request:async()=>({documents:{siteProfiles:{JevPlay:{url:'https://jevplay.com'}},submissionRecords:{}},revisions:{siteProfiles:154}})}});
  runtime.findPage=async()=>({locator:()=>({evaluateAll:async()=>fields}),getByRole:()=>({count:async()=>1,isVisible:async()=>true})});
  return{store,task,runtime,input:{taskId:'original',expectedAttemptBoundary:'boundary',expectedReason:'no_submit_button'}};
}
test('URL-only live page and no-button result preserve attempts while resuming same target',async()=>{
  const s=setup();await s.runtime.control('retryPrefillOnly',s.input);const t=s.store.get('task:original');
  assert.equal(t.targetId,'original-page');assert.equal(t.attemptBoundary,null);assert.equal(t.attemptHistory[0].artifactRef,'old-proof');
  assert.equal(t.profileRevision,154);assert.equal(s.store.get('paused'),true);s.store.close();
});
test('receipt, traffic, repeated recovery, changed boundary or expanded form prevent recovery',async()=>{
  for(const patch of [{receipt:{evidence:'accepted'}},{networkResponses:[{status:200}]},{prefillRecovery:true},{submitResult:{clickedSubmit:true}},{url:'https://other.test/'},{attemptBoundary:'changed'}]) {
    const s=setup(patch);await assert.rejects(s.runtime.control('retryPrefillOnly',s.input));assert.equal(s.store.pending().length,0);s.store.close();
  }
  const s=setup({},[{name:'toolUrl'},{name:'toolName'}]);await assert.rejects(s.runtime.control('retryPrefillOnly',s.input));s.store.close();
});
