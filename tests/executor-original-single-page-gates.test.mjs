import test from 'node:test';
import assert from 'node:assert/strict';
import {originalSinglePageGateResult} from './helpers/original-single-page-gates.mjs';
import {originalSinglePageReceipt} from './helpers/original-single-page-receipt.mjs';

test('original single-page initial gates retain the page while post-stage and retry gates preserve their distinct next-station behavior',async()=>{
 for(const phase of ['initial','stage','validation'])for(const gate of [{needs_manual:true,reason:'Login required'},{captcha:true},{blocked:true,reason:'Cannot submit'}]){
  const original=await originalSinglePageGateResult(phase,gate),ui=await originalSinglePageReceipt({fillResult:original.result,remainingCurrent:true});
  assert.equal(original.fills,phase==='initial'?1:2);assert.equal(original.submits,phase==='initial'?0:1);
  if(phase==='initial'){assert.equal(original.result.advance,false);assert.deepEqual(ui.calls,[]);}
  else{assert.equal(original.result.advance,undefined);assert.deepEqual(ui.calls,[{type:'open',url:'https://alieradox.com/submit',active:true,windowId:1}]);assert.equal(ui.index,1);}
 }
});
