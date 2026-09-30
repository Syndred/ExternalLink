import path from'node:path';import{randomUUID,createHash}from'node:crypto';import{readFile}from'node:fs/promises';
import{findGooglePopup}from'./google-auth.mjs';import{capturePageEvidence}from'./page-evidence.mjs';
const host=u=>{try{return new URL(u).hostname.replace(/^www\./,'');}catch{return'';}};
const GOOGLE=/^(?:sign in|continue|log in|login|sign up|connect) with google$/i;
export function canAuthenticateOffline(runtime,task,input){
 const continuing=input.continueExistingAuth===true&&task.authAttempts?.length===1&&task.authAttempts[0].offline===true&&
  task.authAttempts[0].onlyBasicAuthentication===true&&task.authAttempts[0].status==='needs_attention';
 const authorization=runtime.store.get('offlineMode');
 const explicitlyAuthorizedOffline=authorization?.enabled===true&&authorization.authorization==='user-explicit-2026-09-29';
 return input.allowOfflineAuthenticationOnly===true&&input.expectedTargetId===task.targetId&&
  (explicitlyAuthorizedOffline||/Your account or project has exceeded the quota/i.test(runtime.cloudError||''))&&runtime.store.get('paused')===true&&
  task.status==='needs_manual'&&task.controller==='executor'&&task.controllerId===runtime.controllerId&&
  task.browserInstance===runtime.host?.startedAt&&task.profileId==='JevPlay'&&task.profileSnapshot?.fields?.Url==='https://jevplay.com'&&
  !task.attemptBoundary&&!task.receipt&&(!task.authAttempts?.length||continuing)&&
  (explicitlyAuthorizedOffline||!runtime.store.pending().some(e=>e.taskId===task.id&&(!continuing||!e.type.startsWith('basic_google_'))));
}
export function decideBasicGoogleStep(task,ui,attempt,{allowSingleRetry=false}={}){
 const text=ui.text||'',current=host(ui.url),original=host(task.url),steps=attempt?.steps||[],controls=ui.controls||[];
 const gate=reason=>({kind:'gate',reason});
 if(current==='accounts.google.com'&&ui.hasPassword||/verify (?:that )?you are human|captcha|enter your password|验证码|输入密码|verification code|enter.{0,20}code|验证码/i.test(text))return gate('真人验证、密码或OTP需要接手；不自动重试登录');
 if(/(?:Google hasn[’']t verified|unverified app|unsafe|access.{0,50}(?:Gmail|Drive|Calendar|Contacts|Photos|YouTube)|(?:read|manage|view|delete).{0,50}(?:Google Drive|Gmail|mail messages|contacts|calendar|photos|YouTube)|不安全|未验证)/i.test(text))return gate('Google安全或额外权限提示，需要核对');
 if(current===original){
  if(steps.length&&(/\b(?:sign\s*out|log\s*out)\b/i.test(text)||ui.hasProductForm))return{kind:'authenticated',proof:text.match(/Successfully signed in[^.\n]*\.?/i)?.[0]||(ui.hasProductForm?'已返回可见产品投稿表单':'原站可见Sign Out/Log Out账户控件')};
  const adCloses=controls.filter(c=>c.role==='button'&&/^(?:close|关闭)$/i.test(c.label));
  if(adCloses.length===1&&/(?:广告|广告内容|advertisement|sponsored)/i.test(text)&&!steps.some(s=>s.kind==='dismiss_ad_overlay'))
   return{kind:'dismiss_ad_overlay',control:adCloses[0]};
  const entries=controls.filter(c=>{
   const href=String(c.href||'');let googleEndpoint=false;
   try{const u=new URL(href);googleEndpoint=host(href)===original&&/(?:^|\/)(?:google|auth\/google)\/(?:connect|login)(?:\/|$)/i.test(u.pathname);}catch{}
   return(GOOGLE.test(c.label)||googleEndpoint)&&(!c.href||[original,'accounts.google.com'].includes(host(c.href)));
  });
  const retriedAfterOverlay=steps.some(s=>s.kind==='open_google')&&steps.some(s=>s.kind==='dismiss_ad_overlay')&&!steps.some(s=>s.kind==='retry_google_after_overlay');
  const safeReopenRetry=allowSingleRetry&&steps.length===1&&steps[0].kind==='open_google';
  if(entries.length===1&&(!steps.some(s=>s.kind==='open_google')||retriedAfterOverlay||safeReopenRetry))return{kind:'open_google',retry:retriedAfterOverlay||safeReopenRetry,control:{...entries[0],label:entries[0].label||'Sign in with Google'}};
  if(steps.some(s=>s.kind==='open_google')&&!steps.some(s=>s.kind==='provider_confirmation')&&
   /sign in via google|about to sign in[^.]{0,160}(?:google|third.party)/i.test(text)){
    const next=controls.filter(c=>c.role==='button'&&/^(?:continue|sign in|OK, Sign in Now)$/i.test(c.label));
    if(next.length===1)return{kind:'provider_confirmation',control:next[0]};
  }
  return gate('未取得唯一可用的Google登录动作或回调证明，保留原页并继续其他站');
 }
 if(current!=='accounts.google.com'||!steps.some(s=>s.kind==='open_google'))return gate('登录页离开已核实的原站或Google官方入口');
 const email=task.profileSnapshot?.fields?.['Business mail'];
 if(email&&text.includes(email)&&/choose an account|选择.*账号|选择.*帐号/i.test(text)&&!steps.some(s=>s.kind==='choose_account'))return{kind:'choose_account',email};
 if(/(?:name|姓名).{0,160}(?:email|电子邮件|邮箱)|(?:email|电子邮件|邮箱).{0,160}(?:profile picture|个人资料|头像)/is.test(text)&&
   !steps.some(s=>s.kind==='continue_basic')){
  const next=controls.filter(c=>c.role==='button'&&/^(?:continue|继续)$/i.test(c.label));
  if(next.length===1)return{kind:'continue_basic',control:next[0]};
 }
 return gate('Google登录状态未唯一确认，未选择其他账号或批准额外权限');
}
export async function readBasicGoogleUI(page){
 return page.evaluate(()=>({url:location.origin+location.pathname,text:document.body?.innerText?.slice(0,18000)||'',
  hasPassword:[...document.querySelectorAll('input[type=password]')].some(e=>e.getBoundingClientRect().width>0),
  hasProductForm:[...document.querySelectorAll('input,textarea')].filter(e=>e.getBoundingClientRect().width>0).some(e=>/tool name|product name|startup name|website url|tool url/i.test((e.labels?.[0]?.textContent||'')+' '+e.placeholder)),
  fields:[...document.querySelectorAll('input:not([type=hidden]):not([type=password]),textarea,select,[contenteditable=true]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({tag:e.tagName,type:e.type,name:e.name,id:e.id,label:e.labels?.[0]?.textContent?.trim()||e.getAttribute('aria-label')||e.placeholder||'',required:e.required,min:e.min,max:e.max,maxLength:e.maxLength,accept:e.accept})),
  controls:[...document.querySelectorAll('button,a[href],[role=button]')].filter(e=>e.getBoundingClientRect().width>0&&!e.disabled).map(e=>({role:e.getAttribute('role')||(e.tagName==='A'?'link':'button'),label:(e.getAttribute('aria-label')||e.innerText||e.textContent||'').replace(/\s+/g,' ').trim(),href:e.tagName==='A'?e.href:undefined}))}));
}
export async function advanceBasicGoogleLogin(runtime,task,original,{offline=false,continueExistingAuth=false,allowSingleRetry=false}={}){
 if(task.authAttempts?.length&&!(continueExistingAuth&&task.authAttempts.length===1&&task.authAttempts[0].status==='needs_attention'))return{authenticated:false,reason:'原任务已有Google登录尝试，先核验原页，不重复登录'};
 let page=original;
 const attempt=continueExistingAuth?structuredClone(task.authAttempts[0]):{id:randomUUID(),at:new Date().toISOString(),status:'in_progress',onlyBasicAuthentication:true,offline,steps:[]};
 attempt.status='in_progress';
 const saveEvidence=async()=>{
  const file=path.join(runtime.home,`${task.id}-${Date.now()}-google-observed.png`);await capturePageEvidence(runtime.context,page,{path:file});
  const sha=createHash('sha256').update(await readFile(file)).digest('hex');
  runtime.update(task,{authEvidence:{at:new Date().toISOString(),url:new URL(page.url()).origin+new URL(page.url()).pathname,screenshot:file,sha256:sha,cloudSyncPending:offline},
    preparationHistory:[...(task.preparationHistory||[]),{at:new Date().toISOString(),kind:'before_basic_google_login',artifactRef:task.artifactRef,artifactSha256:task.artifactSha256,screenshot:task.screenshot}],
    screenshot:file,artifactRef:''},'basic_google_evidence');
 };
 for(let i=attempt.steps.length;i<5;i++){
  const ui=await readBasicGoogleUI(page),decision=decideBasicGoogleStep(task,ui,attempt,{allowSingleRetry});
  if(decision.kind==='gate'){
   attempt.status='needs_attention';attempt.reason=decision.reason;
   await saveEvidence();
   runtime.update(task,{authAttempts:[attempt]},'basic_google_attention');if(!offline)await runtime.synchronize();
   return{authenticated:false,reason:decision.reason,ui};
  }
  if(decision.kind==='authenticated'){
   attempt.status='authenticated';attempt.completedAt=new Date().toISOString();attempt.proof={url:ui.url,text:decision.proof};
   delete attempt.reason;
   await saveEvidence();
   runtime.update(task,{authAttempts:[attempt],authenticationState:{status:'signed_in',at:attempt.completedAt,proof:attempt.proof,cloudSyncPending:offline}},'basic_google_authenticated');
   if(!offline)await runtime.synchronize();return{authenticated:true,proof:attempt.proof,ui};
  }
  let control=decision.kind==='choose_account'?page.getByText(decision.email,{exact:true}):page.getByRole(decision.control.role,{name:decision.control.label,exact:true});
  // An icon's accessible name can differ from the visible link text. Resolve
  // only the exact href observed above; never infer an authentication URL.
  if(decision.control?.role==='link'&&decision.control.href&&await control.count()!==1){
   const matches=[];for(const anchor of await page.locator('a[href]').filter({visible:true}).all())
    if(await anchor.evaluate(e=>e.href)===decision.control.href)matches.push(anchor);
   if(matches.length===1)control=matches[0];
  }
  if(await control.count()!==1||!await control.isVisible())throw new Error('Google基本登录控件未唯一核实，停止本次尝试');
  if(!offline)await runtime.lease(task);
  const screenshot=path.join(runtime.home,`${task.id}-${Date.now()}-basic-google.png`);await capturePageEvidence(runtime.context,page,{path:screenshot});
  attempt.steps.push({at:new Date().toISOString(),kind:decision.kind==='open_google'&&decision.retry?'retry_google_after_overlay':decision.kind,url:ui.url,label:decision.control?.label||'verified_profile_email',screenshot,status:'action_boundary'});
  runtime.update(task,{authAttempts:[attempt]},'basic_google_action_boundary');
  if(!offline)await runtime.synchronize();
  await control.click({timeout:10000});await page.waitForTimeout(2000).catch(()=>{});
  if(page.isClosed())page=original;
  if(host(page.url())===host(task.url)){
   const popup=await findGooglePopup(runtime.context,original).catch(()=>null);
   if(popup){page=popup;const session=await runtime.context.newCDPSession(popup);const id=(await session.send('Target.getTargetInfo')).targetInfo.targetId;await session.detach();
    runtime.update(task,{authTargetId:id,authBrowserInstance:runtime.host.startedAt,authPages:[...(task.authPages||[]),{at:new Date().toISOString(),targetId:id,browserInstance:runtime.host.startedAt,openerTargetId:task.targetId,url:'https://accounts.google.com',retainReason:'原任务基本Google登录'}]},'basic_google_popup_registered');
    if(!offline)await runtime.synchronize();
   }
  }
 }
 attempt.status='needs_attention';attempt.reason='Google基本登录达到5步上限，保留原页，继续下一站';runtime.update(task,{authAttempts:[attempt]},'basic_google_step_limit');
 await saveEvidence();
 if(!offline)await runtime.synchronize();return{authenticated:false,reason:attempt.reason};
}
