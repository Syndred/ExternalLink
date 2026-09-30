import path from 'node:path';
export async function acceptAuthorizedCookies(runtime,task,input){
 if(input.authorization!=='explicit_user_all_permissions'||runtime.job||runtime.store.get('paused')!==true||task.attemptBoundary||task.receipt)throw new Error('全部Cookie需要本次用户明确授权');
 const page=await runtime.findPage(task);if(new URL(page.url()).hostname!=='aitoolmall.com')throw new Error('仅允许原AIToolMall任务');
 let accept=page.getByRole('button',{name:'Accept All',exact:true}).filter({visible:true});
 if(await accept.count()===0){const open=page.getByRole('button',{name:'Consent Preferences',exact:true}).filter({visible:true});if(await open.count()===1)await open.click();accept=page.getByRole('button',{name:'Accept All',exact:true}).filter({visible:true});}
 if(await accept.count()!==1)throw new Error('Cookie同意控件未唯一核实');
 await runtime.lease(task);runtime.update(task,{consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'all_site_cookies',source:'user_reply',text:'用户明确表示权限都允许，不用反复问；授权本站投稿所需Cookie'}]},'site_cookie_user_authorized');await runtime.cloud.flush(runtime.store);
 await accept.click();await page.waitForTimeout(5000);const file=path.join(runtime.home,task.id+'-'+Date.now()+'-authorized-cookies.png');await page.screenshot({path:file});
 runtime.update(task,{screenshot:file,artifactRef:'',reason:'已按用户后续全部权限授权接受本站Cookie，继续核验嵌入投稿表单'},'site_cookie_authorized_observed');await runtime.synchronize();return runtime.status();
}
export async function enableFunctionalCookies(runtime,task,input){
 if(input.authorization!=='explicit_user_approved'||runtime.job||runtime.store.get('paused')!==true||task.attemptBoundary||task.receipt)throw new Error('Functional需要用户明确授权及原未投稿任务');
 const page=await runtime.findPage(task);if(new URL(page.url()).hostname!=='aitoolmall.com')throw new Error('Cookie授权仅用于AIToolMall原页');
 const functional=page.locator('#ckySwitchfunctional'),save=page.getByRole('button',{name:'Save My Preferences',exact:true}).filter({visible:true});
 if(await functional.count()!==1||await save.count()!==1)throw new Error('Cookie偏好控件未唯一核验');
 await runtime.lease(task);runtime.update(task,{consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'functional_cookies_only',source:'user_reply',text:'用户允许仅开启Functional，Analytics、Advertisement等仍关闭'}]},'functional_cookie_authorized');await runtime.cloud.flush(runtime.store);
 await functional.check();for(const id of ['#ckySwitchanalytics','#ckySwitchadvertisement','#ckySwitchother']){const c=page.locator(id);if(await c.count()===1&&await c.isChecked())await c.uncheck();}
 const choices=await page.locator('input[id^=ckySwitch]').evaluateAll(es=>es.map(e=>({id:e.id,checked:e.checked})));
 if(choices.some(c=>c.id!=='ckySwitchfunctional'&&c.checked))throw new Error('检测到其他可选类别开启，停止保存');
 await save.click();await page.waitForTimeout(5000);const file=path.join(runtime.home,task.id+'-'+Date.now()+'-functional-only.png');await page.screenshot({path:file});
 runtime.update(task,{cookiePreferences:{at:new Date().toISOString(),choices,text:await page.evaluate(()=>document.body.innerText)},screenshot:file,artifactRef:'',reason:'已按用户授权仅开启Functional，其他可选Cookie关闭；继续核验嵌入投稿表单'},'functional_cookie_observed');await runtime.synchronize();return runtime.status();
}
export async function inspectCookiePreferences(runtime,task){
 if(runtime.job||runtime.store.get('paused')!==true||task.attemptBoundary||task.receipt)throw new Error('Cookie分类核验需要暂停空闲且尚无投稿');
 const page=await runtime.findPage(task);if(new URL(page.url()).hostname!=='aitoolmall.com')throw new Error('Cookie核验只用于原AIToolMall页');
 const open=page.getByRole('button',{name:'Consent Preferences',exact:true}).filter({visible:true});
 if(await open.count()!==1)throw new Error('偏好入口未唯一核验');
 await runtime.lease(task);runtime.update(task,{stageHistory:[...(task.stageHistory||[]),{at:new Date().toISOString(),stage:'inspect_cookie_categories'}]},'cookie_inspection_boundary');await runtime.cloud.flush(runtime.store);
 await open.click();await page.waitForTimeout(500);
 const functional=page.getByRole('button',{name:'Functional',exact:true}).filter({visible:true});if(await functional.count()===1)await functional.click();
 const cookiePreferences={at:new Date().toISOString(),text:await page.evaluate(()=>document.body.innerText),choices:await page.locator('input[type=checkbox]').evaluateAll(es=>es.map(e=>({id:e.id,checked:e.checked,label:e.getAttribute('aria-label')})))};
 const file=path.join(runtime.home,task.id+'-'+Date.now()+'-cookie-options.png');await page.screenshot({path:file});
 runtime.update(task,{cookiePreferences,screenshot:file,artifactRef:'',reason:'已拒绝可选Cookie，嵌入仍被拦；已打开实际Cookie分类，尚未启用额外类别'},'cookie_categories_observed');await runtime.synchronize();return runtime.status();
}
export async function rejectOptionalCookies(runtime,page,task){
 if(new URL(page.url()).hostname!=='aitoolmall.com' || task.attemptBoundary || task.receipt)return false;
 if(task.consentHistory?.some(c=>['all_site_cookies','functional_cookies_only'].includes(c.scope)&&c.source==='user_reply'))return false;
 const reject=page.getByRole('button',{name:'Reject All',exact:true}).filter({visible:true});
 if(await reject.count()!==1)return false;
 await runtime.lease(task);
 runtime.update(task,{consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'necessary_cookies_only',source:'ordinary_submission',text:'拒绝可选跟踪Cookie，仅保留必要Cookie'}]},'necessary_cookie_preference');
 await runtime.cloud.flush(runtime.store);await reject.click({timeout:5000});await page.waitForTimeout(2500);return true;
}
