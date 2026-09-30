import test from 'node:test';
import assert from 'node:assert/strict';
import {getTargetInfo} from '../executor/src/browser-target.mjs';

test('a page that vanished from CDP after enumeration is treated as a stale target',async()=>{
 const page={isClosed:()=>false};let detached=false;
 const context={newCDPSession:async()=>({send:async()=>{throw new Error('browserContext.newCDPSession: page: no object with guid page@expired');},detach:async()=>{detached=true;}})};
 assert.equal(await getTargetInfo(context,page),null);assert.equal(detached,true);
});

test('an unrelated CDP connection failure is surfaced for browser recovery',async()=>{
 const page={isClosed:()=>false};
 const context={newCDPSession:async()=>{throw new Error('WebSocket connection closed');}};
 await assert.rejects(getTargetInfo(context,page),/WebSocket connection closed/);
});

test('a live task page target is returned and the CDP session is detached',async()=>{
 const page={isClosed:()=>false};let detached=false;
 const context={newCDPSession:async()=>({send:async command=>({targetInfo:{targetId:'task-target',openerId:'parent-target',command}}),detach:async()=>{detached=true;}})};
 assert.deepEqual(await getTargetInfo(context,page),{targetId:'task-target',openerId:'parent-target',command:'Target.getTargetInfo'});
 assert.equal(detached,true);
});
