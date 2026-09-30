import test from 'node:test';import assert from 'node:assert/strict';import{Store}from'../executor/src/store.mjs';import{Runtime}from'../executor/src/runtime.mjs';
test('continuation preserves prior evidence and uses current facts; any attempt or receipt blocks it',async()=>{
 for(const patch of [{},{attemptBoundary:'keep',status:'submitted_unconfirmed'},{receipt:{evidence:'received'}}]){
 const store=new Store(':memory:');const task={id:'t',url:'https://site.test/submit',profileId:'p',status:'needs_manual',reason:'old',actualSubmission:{fields:[{value:'old'}]},...patch};store.set('paused',true);store.set('task:t',task);const runtime=new Runtime(store,'.');runtime.findPage=async()=>({});runtime.synchronize=async()=>{};runtime.lease=async()=>{};
 Object.defineProperty(runtime,'cloud',{value:{request:async()=>({documents:{siteProfiles:{p:{name:'JevPlay',url:'https://jevplay.com'}},submissionRecords:{}},revisions:{siteProfiles:154}})}});
 if(patch.attemptBoundary||patch.receipt)await assert.rejects(runtime.control('continueUnsubmitted',{taskId:'t'}));else{await runtime.control('continueUnsubmitted',{taskId:'t'});const after=store.get('task:t');assert.equal(after.profileRevision,154);assert.equal(after.preparationHistory[0].actualSubmission.fields[0].value,'old');assert.equal(after.status,'pending');}store.close();}
});
