import test from 'node:test';import assert from 'node:assert/strict';import {rejectOptionalCookies} from '../executor/src/necessary-cookies.mjs';
test('only the unique visible reject action is used, after durable registration',async()=>{const actions=[];const task={};const runtime={lease:async()=>actions.push('lease'),update:(t,p)=>{Object.assign(t,p);actions.push('register');},cloud:{flush:async()=>actions.push('flush')},store:{}};
const page={url:()=> 'https://aitoolmall.com/submit/',getByRole:(role,options)=>{assert.equal(options.name,'Reject All');return {filter:()=>({count:async()=>1,click:async()=>actions.push('reject')})}},waitForTimeout:async()=>{}};
assert.equal(await rejectOptionalCookies(runtime,page,task),true);assert.deepEqual(actions,['lease','register','flush','reject']);assert.equal(task.consentHistory[0].scope,'necessary_cookies_only');
task.attemptBoundary='keep';assert.equal(await rejectOptionalCookies(runtime,page,task),false);});
test('a saved user cookie preference is preserved when the dialog reappears',async()=>{
 for(const scope of ['all_site_cookies','functional_cookies_only']){
 const task={consentHistory:[{scope,source:'user_reply'}]};
 const page={url:()=> 'https://aitoolmall.com/submit/',getByRole:()=>{throw new Error('must preserve preference');}};
 assert.equal(await rejectOptionalCookies({},page,task),false);
 }
});
