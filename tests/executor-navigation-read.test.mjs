import test from 'node:test';import assert from 'node:assert/strict';import {readAfterNavigation} from '../executor/src/navigation-read.mjs';
test('transient destroyed contexts are re-observed on the same page without replaying a click',async()=>{
 let reads=0,waits=0;const page={waitForLoadState:async()=>{},waitForTimeout:async()=>{waits++;}};
 const result=await readAfterNavigation(page,async()=>{reads++;if(reads<3)throw Error('Execution context was destroyed, most likely because of a navigation');return{url:'https://directory.example/login'};});
 assert.equal(reads,3);assert.equal(waits,2);assert.equal(result.url,'https://directory.example/login');
});
test('closed pages and unrelated errors cannot turn into arbitrary navigation recovery',async()=>{
 let reads=0;await assert.rejects(readAfterNavigation({waitForLoadState:async()=>{},waitForTimeout:async()=>{}},async()=>{reads++;throw Error('Target closed');}),/Target closed/);assert.equal(reads,1);
});
