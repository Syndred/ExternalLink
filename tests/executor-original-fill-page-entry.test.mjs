import test from 'node:test';
import assert from 'node:assert/strict';
import {originalFillPageEntry,originalFillPageSource} from './helpers/original-fill-page-entry.mjs';
test('complete original fillPage captures refreshed identity and fences preconditions before any fill request',async()=>{
 assert.equal(originalFillPageSource.lines,64);
 for(const options of [{noTab:true},{mode:'comment',unavailable:true},{noProfile:true},{noButton:true}]){const proof=await originalFillPageEntry(options);assert.equal(proof.calls[0],'refresh');assert.equal(proof.calls.some(call=>call.request),false);assert.ok(Object.values(proof.buttons).every(button=>!button.disabled));}
});
test('complete original asynchronous fillPage maps form comment submission and Product Hunt while restoring button state',async()=>{
 for(const options of [{result:{ok:true}},{submit:true,result:{submitted:true,matched:true}},{mode:'comment',submit:true,result:{fillOnly:true}},{productHunt:true,result:{ok:true}},{submit:true,result:{ok:true}},{result:{ok:false}}]){
  const proof=await originalFillPageEntry(options),request=proof.calls.find(call=>call.request).request,handled=proof.calls.find(call=>call.handled);assert.equal(request.tabId,7);assert.equal(request.expectedUrl,'https://original.invalid/new');assert.equal(request.profileId,'p');assert.equal(request.commentText,'Original 中文🙂');assert.equal(request.fillOnly,!(options.submit&&options.mode!=='comment'));assert.equal(request.confirmProductHuntCreate,!!options.productHunt);assert.deepEqual(handled.owner,{tabId:7,url:'https://original.invalid/new',profileId:'p'});assert.ok(Object.values(proof.buttons).every(button=>!button.disabled));
  const step=proof.calls.find(call=>call.step)?.step;assert.equal(step,options.result.submitted&&options.result.matched?'done':options.result.ok||options.result.fillOnly?'submit':undefined);
 }
});
test('complete original fillPage ignores timed out busy stale replies and restores controls after both awaited failures',async()=>{
 for(const options of [{result:{timedOut:true,ok:true}},{result:{busy:true,ok:true}},{result:{stale:true,ok:true}},{requestError:true},{handlerError:true,result:{ok:true}}]){
  const proof=await originalFillPageEntry(options);assert.equal(proof.calls.some(call=>call.step),false);assert.ok(Object.values(proof.buttons).every(button=>!button.disabled));if(!options.handlerError)assert.equal(proof.calls.some(call=>call.handled),false);if(options.requestError||options.handlerError)assert.ok(proof.calls.some(call=>call.toast?.includes('Controlled')));
 }
});
