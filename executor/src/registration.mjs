import { randomBytes } from 'node:crypto';
import path from 'node:path';
export function canRegisterMarketingAccount(task) {
  return new URL(task.url).hostname==='saasaitools.com' && task.status==='needs_manual' && !task.attemptBoundary &&
    !task.receipt && !task.registration?.boundary &&
    task.consentHistory?.some(c=>c.scope==='marketing_subscription' && c.source==='user_reply') &&
    !!task.profileSnapshot?.fields?.['Contact person'] && !!task.profileSnapshot?.fields?.['Business mail'];
}
export async function verifyRegistration(runtime,task) {
  if(runtime.job || runtime.store.get('paused')!==true || !task.registration?.boundary)throw new Error('先保留注册尝试再核验原页');
  const page=await runtime.findPage(task);
  if(new URL(page.url()).hostname!=='saasaitools.com')throw new Error('注册原页已离开站点，保留待核验');
  const file=path.join(runtime.home,task.id+'-'+Date.now()+'-registered.png');await page.screenshot({path:file});
  const registration={...task.registration,observedAt:new Date().toISOString(),url:page.url().split('?')[0],
    result:(await page.evaluate(()=>document.body.innerText)).slice(0,8000),status:'observed'};
  const exists=/This email is already registered/i.test(registration.result);
  if(exists)registration.status='existing_account_requires_login';
  await runtime.lease(task);
  runtime.update(task,{registration,screenshot:file,artifactRef:'',reason:exists?'站方明确邮箱已注册，保留注册拒绝；需要现有账号登录，未创建账号或提交产品':'用户授权的免费注册已执行；核验账户结果后再进入原任务投稿'},'account_registration_observed');
  await runtime.synchronize();return runtime.status();
}
export async function registerAccount(runtime,task) {
  if(runtime.job || runtime.store.get('paused')!==true || !canRegisterMarketingAccount(task))throw new Error('注册需要这两个站点的明确用户授权、核实资料且尚无注册尝试');
  const page=await runtime.findPage(task);
  if(new URL(page.url()).origin!=='https://saasaitools.com' || new URL(page.url()).pathname!=='/join/')throw new Error('当前不是已核实的免费注册页');
  const email=task.profileSnapshot.fields['Business mail'],name=task.profileSnapshot.fields['Contact person'];
  const controls=[page.locator('#ff_10_first_name'),page.locator('#ff_10_email'),page.locator('#ff_10_password'),
    page.getByRole('checkbox',{name:/By signing up, I agree to receive promotional emails, marketing communications, and updates/}),
    page.getByRole('button',{name:'Create my account',exact:true})];
  for(const c of controls)if(await c.count()!==1 || !await c.isVisible())throw new Error('注册控件未唯一核实');
  const key='credential:saasaitools.com:'+email;
  const password=runtime.store.get(key)?.password || 'Aa9!'+randomBytes(24).toString('base64url');
  // This private local credential is never placed in tasks, evidence or cloud.
  runtime.store.set(key,{email,password,createdAt:new Date().toISOString()});
  await controls[0].fill(name);await controls[1].fill(email);await controls[2].fill(password);await controls[3].check();
  await runtime.lease(task);
  const registration={boundary:new Date().toISOString(),name,email,marketingConsent:true,credentialStoredLocally:true,status:'started'};
  runtime.update(task,{registration},'account_registration_boundary');await runtime.cloud.flush(runtime.store);
  await controls[4].click({timeout:10000});await page.waitForTimeout(5000);
  return verifyRegistration(runtime,task);
}
