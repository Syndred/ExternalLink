import path from'node:path';import{fillAndVerifyText}from'./text-input.mjs';import{capturePageEvidence}from'./page-evidence.mjs';
export function canAcceptRequiredNewsletter(url,input,field){return url==='https://www.early.tools/submit'&&input.authorization==='explicit_user_all_permissions'&&
 field.id==='submit-signin-newsletter'&&field.type==='checkbox'&&field.required===true&&field.label==='I want to receive the early.tools newsletter';}
export function loginLinkOutcome(text,email=''){
 if(/couldn.t verify you.re human|captcha|human verification failed|真人验证失败/i.test(text))return{status:'rejected_human_verification',attentionType:'human_verification',reason:'站方拒绝登录链接请求：真人验证未通过，未确认发送邮件；保留原页，不重复请求，不计产品收件'};
 if(email&&text.includes(email)&&/Check your email/i.test(text)&&/We['’]ve sent a magic link to/i.test(text))return{status:'sent_confirmed',attentionType:'login_email_verification',reason:'站方明确确认已向核实邮箱发送一次登录链接，等待用户打开验证邮件；原页及请求边界保留，不重复发送，不计产品收件'};
 return{status:'observed',attentionType:'login_email_verification',reason:'已按用户授权请求一次登录链接；等待核验站方响应与邮箱登录，不计产品收件，保留原页'};
}
export function canRequestLoginLink(task,input,url){
 const routes={'betalist.com':'https://betalist.com/sessions/passwordless/new','www.early.tools':'https://www.early.tools/submit'};
 return input.authorization==='explicit_user_all_permissions'&&!task.receipt&&!task.attemptBoundary&&!task.loginLinkRequest?.boundary&&
 ['pending','needs_manual'].includes(task.status)&&routes[new URL(task.url).hostname]===url&&String(input.submitLabel||'').length>0;
}
export async function requestLoginLink(runtime,task,input){
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.pending().length)throw new Error('登录链接需要原未投稿任务暂停空闲并回读');
 const page=await runtime.findPage(task),u=new URL(page.url());
 if(!canRequestLoginLink(task,input,u.origin+u.pathname))throw new Error('登录链接未授权、原页不符或已有请求边界');
 const email=task.profileSnapshot?.fields?.['Business mail'];if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||''))throw new Error('缺少核实登录邮箱');
 const box=page.locator('input[type=email]').filter({visible:true}),button=page.getByRole('button',{name:input.submitLabel,exact:true}).filter({visible:true});
 if(await box.count()!==1||await button.count()!==1)throw new Error('登录邮箱或邮件按钮未唯一核实');
 await fillAndVerifyText(box,email);
 const newsletter=page.locator('input#submit-signin-newsletter[type=checkbox]');
 if(await newsletter.count()===1){
  const field=await newsletter.evaluate(e=>({id:e.id,type:e.type,required:e.required,label:e.labels?.[0]?.textContent?.trim()}));
  if(canAcceptRequiredNewsletter(u.origin+u.pathname,input,field)&&!await newsletter.isChecked()){
   await runtime.lease(task);runtime.update(task,{consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'required_marketing_subscription',source:'user_reply',text:'用户已授权全部普通权限；原登录表单newsletter为真实必选字段',label:field.label}]},'required_login_consent_authorized');await runtime.synchronize();
   await newsletter.check({timeout:5000});if(!await newsletter.isChecked())throw new Error('真实必选newsletter未保持，未发送登录邮件');
  }
 }
 if(!await button.isEnabled()&&u.hostname==='www.early.tools'){
  await box.press('End');await box.press('Space');await box.press('Backspace');
  if(await box.inputValue()!==email)throw new Error('登录邮箱未保持核实值，未发送');
 }
 for(let n=0;n<8&&!await button.isEnabled();n++)await page.waitForTimeout(250);
 if(!await button.isEnabled())throw new Error('已填核实邮箱，登录邮件按钮仍不可用，未发送');await runtime.lease(task);
 runtime.update(task,{loginLinkRequest:{boundary:new Date().toISOString(),email,url:u.origin+u.pathname,button:input.submitLabel,status:'started',authorization:'explicit_user_all_permissions'}},'login_link_requested');await runtime.cloud.flush(runtime.store);
 try{await button.click({timeout:10000});await page.waitForTimeout(2500);
 const text=await page.evaluate(()=>document.body.innerText),file=path.join(runtime.home,task.id+'-'+Date.now()+'-login-link.png');await capturePageEvidence(runtime.context,page,{path:file});
 const outcome=loginLinkOutcome(text,email);runtime.update(task,{loginLinkRequest:{...task.loginLinkRequest,observedAt:new Date().toISOString(),text:text.slice(0,8000),status:outcome.status},status:'needs_manual',attentionType:outcome.attentionType,reason:outcome.reason,screenshot:file,artifactRef:''},'login_link_observed');
 }catch(error){runtime.update(task,{status:'needs_manual',attentionType:'login_email_verification',reason:'登录链接请求边界已保留，结果待核验；不重复发起请求：'+error.message},'login_link_attention');}
 await runtime.synchronize();return runtime.status();
}
