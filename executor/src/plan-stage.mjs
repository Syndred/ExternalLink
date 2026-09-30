import path from 'node:path';import {attachEngine} from './engine.mjs';import {assessSubmissionQuality} from './quality.mjs';
export function canAdvancePlan(task,observed){let samePath=false;try{const u=new URL(observed.url);samePath=u.origin+u.pathname===task.url;}catch{}
 return task.url==='https://poweredbyai.app/submit-tool'&&task.status==='needs_manual'&&!task.attemptBoundary&&!task.receipt&&task.validation?.allValid&&
 task.actualSubmission?.attachments?.some(a=>/^image\/(?:png|jpeg)$/.test(a.type)&&a.bytes>0)&&samePath&&observed.name===task.profileSnapshot?.name&&observed.website===task.profileSnapshot?.url&&observed.buttonCount===1&&observed.buttonEnabled===true;}
export async function advancePlan(runtime,task){
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.pending().length)throw new Error('方案前进要求暂停空闲及完整回读');
 const page=await runtime.findPage(task),button=page.getByRole('button',{name:'Select Plan >>',exact:true});
 const observed={url:page.url(),name:await page.locator('input[name=name]').inputValue(),website:await page.locator('input[name=toolUrl]').inputValue(),buttonCount:await button.count(),buttonEnabled:await button.isEnabled().catch(()=>false)};
 if(!canAdvancePlan(task,observed))throw new Error('详情、素材或旧尝试不满足前进条件 '+JSON.stringify({...observed,url:page.url().split('?')[0]}));
 const engine=await attachEngine(runtime.context,page.mainFrame());const responses=[];
 const listener=response=>{if(response.request().method()==='POST'){const u=new URL(response.url());if(u.hostname==='poweredbyai.app')responses.push({url:u.origin+u.pathname,status:response.status()});}};
 try{
  const validation=await engine.call({action:'collectFormValidation'}),actual=await engine.call({action:'getFilledFieldsReport'});
  if(!validation.allValid||assessSubmissionQuality(actual,task.profileSnapshot).length)throw new Error('详情实时校验未通过');
  await runtime.lease(task);const at=new Date().toISOString();
  runtime.update(task,{stageHistory:[...(task.stageHistory||[]),{at,stage:'select_plan',observed,actualSubmission:task.actualSubmission}],attemptBoundary:at,status:'submitting',siteStatus:'sent_unconfirmed'},'plan_stage_boundary');await runtime.cloud.flush(runtime.store);
  page.on('response',listener);await button.click({timeout:10000});await page.waitForTimeout(3500);
  const text=await page.evaluate(()=>document.body.innerText);
  runtime.update(task,{planObservation:{at:new Date().toISOString(),url:page.url(),text:text.slice(0,14000),networkResponses:responses},
   status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',reason:'详情已前进至方案选择，保留此站方步骤的尝试边界，先核验是否收件'},'plan_stage_observed');
 }catch(error){runtime.update(task,{status:task.attemptBoundary?'submitted_unconfirmed':task.status,reason:error.message,planStageError:error.message,networkResponses:responses},'plan_stage_attention');throw error;
 }finally{page.off('response',listener);await engine.detach();const file=path.join(runtime.home,task.id+'-'+Date.now()+'-plans.png');await page.screenshot({path:file});runtime.update(task,{screenshot:file,artifactRef:''},'plan_screenshot');await runtime.synchronize();}
 return runtime.status();
}

export async function verifyPlanStage(runtime,task){
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.pending().length||task.receipt||task.url!=='https://poweredbyai.app/submit-tool')throw new Error('方案步骤核验需要原任务暂停空闲');
 const stage=task.stageHistory?.findLast(s=>s.stage==='select_plan');
 if(!stage || stage.observed?.name!==task.profileSnapshot?.name || stage.observed?.website!==task.profileSnapshot?.url)throw new Error('没有本产品已前进的步骤证据');
 const page=await runtime.findPage(task);if(new URL(page.url()).origin+new URL(page.url()).pathname!=='https://poweredbyai.app/submit-tool/plan-selection')throw new Error('原页不在已前进的方案步骤');
 await runtime.lease(task);const text=await page.evaluate(()=>document.body.innerText);
 runtime.update(task,{attemptBoundary:task.attemptBoundary||stage.at,status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',
  planObservation:{at:new Date().toISOString(),url:page.url().split('?')[0],text:text.slice(0,14000)},reason:'已前进至站方方案页，仅见$11.99/$69.99付费档；页尾Tool submitted无具名回执，保留尝试核验，未支付、未再次点击投稿'},'plan_stage_independently_observed');
 const evidence=await runtime.reobserveNavigatedReceipt(page,task);
 if(evidence.matched&&evidence.evidence)await runtime.accept(task,page,evidence);
 const file=path.join(runtime.home,task.id+'-'+Date.now()+'-plan-verification.png');await page.screenshot({path:file});runtime.update(task,{screenshot:file,artifactRef:''},'plan_verify_screenshot');await runtime.synchronize();return runtime.status();
}
