import test from'node:test';import assert from'node:assert/strict';import{fillAndVerifyText}from'../executor/src/text-input.mjs';
test('a matching value is preserved without typing into the currently focused control',async()=>{await fillAndVerifyText({inputValue:async()=> 'JevPlay',fill:async()=>{throw new Error('must not retype');}},'JevPlay');});
test('a successful browser fill does not need a fallback',async()=>{let value='';await fillAndVerifyText({fill:async v=>value=v,inputValue:async()=>value,evaluate:async()=>{throw new Error('unexpected fallback');}},'JevPlay');assert.equal(value,'JevPlay');});
test('misdirected typing repairs the exact observed input with native input events',async()=>{
 class Input{};Object.defineProperty(Input.prototype,'value',{get(){return this.current;},set(v){this.current=v;}});const events=[],element=new Input();Object.assign(element,{current:'syndred',tagName:'INPUT',ownerDocument:{defaultView:{HTMLInputElement:Input,Event:class{constructor(type){this.type=type;}}}},dispatchEvent:e=>events.push(e.type)});
 await fillAndVerifyText({fill:async()=>{},inputValue:async()=>element.value,evaluate:async(fn,v)=>fn(element,v)},'');assert.equal(element.value,'');assert.deepEqual(events,['input','change']);
});
test('a rerender which loses the exact value stops before submission',async()=>{await assert.rejects(fillAndVerifyText({fill:async()=>{},inputValue:async()=> 'lost',evaluate:async()=>{}},'JevPlay'),/未提交/);});
