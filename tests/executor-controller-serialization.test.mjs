import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../executor/src/runtime.mjs';
test('timer does not start a second writer during an API operation',()=>{
  const runtime={controlBusy:true,restoreCloud(){throw new Error('concurrent writer');}};
  assert.doesNotThrow(()=>Runtime.prototype.tick.call(runtime));
});
test('API owns writer until async readback resolves and releases it on failure',async()=>{
  const runtime={controlBusy:false};let release;
  const pending=Runtime.prototype.withControl.call(runtime,()=>new Promise(resolve=>{release=resolve;}));
  assert.equal(runtime.controlBusy,true);await Promise.resolve();assert.equal(runtime.controlBusy,true);
  release('readback');assert.equal(await pending,'readback');assert.equal(runtime.controlBusy,false);
  await assert.rejects(Runtime.prototype.withControl.call(runtime,async()=>{throw new Error('readback failed');}));
  assert.equal(runtime.controlBusy,false);
});
