import test from 'node:test';import assert from 'node:assert/strict';
import {canRegisterMarketingAccount}from'../executor/src/registration.mjs';
test('registration requires exact site, explicit consent, real profile and no previous registration boundary',()=>{
  const task={url:'https://saasaitools.com/',status:'needs_manual',consentHistory:[{scope:'marketing_subscription',source:'user_reply'}],profileSnapshot:{fields:{'Contact person':'syndred','Business mail':'contact@example.com'}}};
  assert.ok(canRegisterMarketingAccount(task));
  for(const patch of [{url:'https://other.test/'},{consentHistory:[]},{registration:{boundary:'started'}},{attemptBoundary:'submitted'},{profileSnapshot:{fields:{}}},{receipt:{evidence:'accepted'}}]) assert.ok(!canRegisterMarketingAccount({...task,...patch}));
});
