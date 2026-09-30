import test from 'node:test';
import assert from 'node:assert/strict';
import { findGooglePopup } from '../executor/src/google-auth.mjs';
test('Google popup must belong to exact task page, personal and other-site tabs are ignored',async()=>{
  const task={},personal={},page=(url,opener)=>({url:()=>url,isClosed:()=>false,opener:async()=>opener});
  const popup=page('https://accounts.google.com/select',task);
  const context={pages:()=>[page('https://accounts.google.com/select',personal),page('https://untrusted.test/',task),popup]};
  assert.equal(await findGooglePopup(context,task),popup);
  await assert.rejects(findGooglePopup({pages:()=>context.pages().slice(0,2)},task));
  await assert.rejects(findGooglePopup({pages:()=>[popup,page('https://accounts.google.com/select',task)]},task));
});
