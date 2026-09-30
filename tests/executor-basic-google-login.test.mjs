import test from'node:test';import assert from'node:assert/strict';
import{decideBasicGoogleStep,canAuthenticateOffline,advanceBasicGoogleLogin}from'../executor/src/basic-google-login.mjs';
const task={id:'task',url:'https://thejoai.com/aitools/submissions/',status:'needs_manual',controller:'executor',controllerId:'owner',version:1,
 browserInstance:'host',targetId:'target',profileId:'JevPlay',profileSnapshot:{fields:{Url:'https://jevplay.com','Business mail':'owner@example.com'}}};

test('an interrupted authentication preserves its original attempt instead of leaving an unrecorded in-progress state',async()=>{
 const copy=structuredClone(task);const runtime={update(t,p){Object.assign(t,p);}};
 await assert.rejects(advanceBasicGoogleLogin(runtime,copy,{evaluate:async()=>{throw Error('Target closed');}},{offline:true}),/Target closed/);
 assert.equal(copy.authAttempts[0].status,'needs_attention');assert.match(copy.authAttempts[0].reason,/Target closed/);assert.equal(copy.authAttempts[0].steps.length,0);
});
test('basic Google login uses a unique visible entry and its same-site confirmation',()=>{
 const ui={url:'https://thejoai.com/accounts/login/',text:'Log in',hasPassword:true,controls:[{role:'link',label:'Log in with Google',href:'https://thejoai.com/accounts/google/login/'}]};
 assert.equal(decideBasicGoogleStep(task,ui,{steps:[]}).kind,'open_google');
 assert.equal(decideBasicGoogleStep(task,{...ui,controls:[...ui.controls,...ui.controls]},{steps:[]}).kind,'gate');
 assert.equal(decideBasicGoogleStep(task,{...ui,url:'https://thejoai.com/accounts/google/login/',text:'Sign In Via Google You are about to sign in using a third-party account from Google.',controls:[{role:'button',label:'Continue'}]}, {steps:[{kind:'open_google'}]}).kind,'provider_confirmation');
 assert.equal(decideBasicGoogleStep(task,{...ui,url:'https://thejoai.com/accounts/google/login/',text:'SIGN IN WITH GOOGLE You are about to sign in with your GOOGLE account',controls:[{role:'button',label:'OK, Sign in Now'}]}, {steps:[{kind:'open_google'}]}).kind,'provider_confirmation');
 assert.equal(decideBasicGoogleStep(task,{...ui,controls:[{role:'button',label:'Continue'}]}, {steps:[]}).kind,'gate');
 const blankIcon={url:'https://www.sideprojectors.com/auth/login',text:'Login to SideProjectors',controls:[
  {role:'link',label:'',href:'https://www.sideprojectors.com/google/connect'},
  {role:'link',label:'',href:'https://www.sideprojectors.com/github/connect'}]};
 const sideTask={...task,url:'https://www.sideprojectors.com/submit'};
 const sideLogin=decideBasicGoogleStep(sideTask,blankIcon,{steps:[]});assert.equal(sideLogin.kind,'open_google');assert.equal(sideLogin.control.href,blankIcon.controls[0].href);
 const overlay={...blankIcon,text:'广告内容 Qwen3.5 登录到SideProjectors',controls:[...blankIcon.controls,{role:'button',label:'Close'}]};
 assert.equal(decideBasicGoogleStep(sideTask,overlay,{steps:[{kind:'open_google'}]}).kind,'dismiss_ad_overlay');
 const afterClose=decideBasicGoogleStep(sideTask,blankIcon,{steps:[{kind:'open_google'},{kind:'dismiss_ad_overlay'}]});
 assert.equal(afterClose.kind,'open_google');assert.equal(afterClose.retry,true);
 assert.equal(decideBasicGoogleStep(sideTask,blankIcon,{steps:[{kind:'open_google'},{kind:'dismiss_ad_overlay'},{kind:'retry_google_after_overlay'}]}).kind,'gate');
 assert.equal(decideBasicGoogleStep(sideTask,blankIcon,{steps:[{kind:'open_google'}]},{allowSingleRetry:true}).retry,true);
 assert.equal(decideBasicGoogleStep(sideTask,blankIcon,{steps:[{kind:'open_google'},{kind:'retry_google'}]},{allowSingleRetry:true}).kind,'gate');
});
test('Google account choice matches the verified email and blocks human checks and extra access',()=>{
 const ui={url:'https://accounts.google.com/select',text:'Choose an account owner@example.com',controls:[]};
 assert.equal(decideBasicGoogleStep(task,ui,{steps:[{kind:'open_google'}]}).kind,'choose_account');
 for(const text of ['Verify you are human','Enter your password','Google hasn’t verified this app','Allow access to your Gmail messages','Read your Google Drive files'])
  assert.equal(decideBasicGoogleStep(task,{...ui,text},{steps:[{kind:'open_google'}]}).kind,'gate',text);
 assert.equal(decideBasicGoogleStep(task,{...ui,text:'Google will share your name, email address and profile picture',controls:[{role:'button',label:'Continue'}]},{steps:[{kind:'open_google'},{kind:'choose_account'}]}).kind,'continue_basic');
 assert.equal(decideBasicGoogleStep(task,{...ui,text:'Continue',controls:[{role:'button',label:'Continue'}]},{steps:[{kind:'choose_account'}]}).kind,'gate');
});
test('callback proof and action history prevent repeated authentication attempts',()=>{
 const ui={url:'https://thejoai.com/accounts/profile/',text:'Welcome Sign Out',controls:[{role:'link',label:'Sign Out'}]};
 assert.equal(decideBasicGoogleStep(task,ui,{steps:[{kind:'open_google'}]}).kind,'authenticated');
 const login={url:'https://thejoai.com/accounts/login/',text:'Log in',controls:[{role:'link',label:'Log in with Google'}]};
 assert.equal(decideBasicGoogleStep(task,login,{steps:[{kind:'open_google'}]}).kind,'gate');
});
test('offline authentication is narrowly owned and never permits a product submission boundary',()=>{
 const runtime={controllerId:'owner',host:{startedAt:'host'},cloudError:'Your account or project has exceeded the quota',store:{get:()=>true,pending:()=>[]}};
 assert.equal(canAuthenticateOffline(runtime,task,{allowOfflineAuthenticationOnly:true,expectedTargetId:'target'}),true);
 for(const patch of [{attemptBoundary:'attempt'},{receipt:{}},{controllerId:'other'},{browserInstance:'old'},{profileId:'Other'},{authAttempts:[{status:'unknown'}]}])
  assert.equal(canAuthenticateOffline(runtime,{...task,...patch},{allowOfflineAuthenticationOnly:true,expectedTargetId:'target'}),false);
 assert.equal(canAuthenticateOffline({...runtime,cloudError:'generic timeout'},task,{allowOfflineAuthenticationOnly:true,expectedTargetId:'target'}),false);
 const offlineRuntime={...runtime,cloudError:'',store:{get:key=>key==='offlineMode'?{enabled:true,authorization:'user-explicit-2026-09-29'}:true,pending:()=>[{taskId:'task',type:'opening'}]}};
 assert.equal(canAuthenticateOffline(offlineRuntime,task,{allowOfflineAuthenticationOnly:true,expectedTargetId:'target'}),true);
 assert.equal(canAuthenticateOffline({...offlineRuntime,store:{get:key=>key==='offlineMode'?{enabled:false}:true,pending:()=>[]}},task,{allowOfflineAuthenticationOnly:true,expectedTargetId:'target'}),false);
});
