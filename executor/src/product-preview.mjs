import path from 'node:path';import{attachEngine}from'./engine.mjs';
export function canContinueProductPreview(task,input,observed) {
 return task.url==='https://10015.io/product-finder/submit'&&task.status==='submitted_unconfirmed'&&task.siteStatus==='sent_unconfirmed'&&
  !!task.attemptBoundary&&task.attemptBoundary===input.expectedAttemptBoundary&&!task.receipt&&!task.previewFinalAttempt&&
  !(task.networkResponses||[]).length&&task.submitResult?.stageAdvanced===true&&task.submitResult?.submitted===false&&!(task.submitResult?.networkResponses||[]).length&&
  observed.url===task.url&&observed.name===task.profileSnapshot?.name&&observed.website===task.profileSnapshot?.url&&observed.free===true&&
  observed.previewCount===1&&observed.submitCount===1&&observed.continueEditing===true;
}
export async function finishProductPreview(runtime,task,input) {
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.pending().length)throw new Error('预览确认要求暂停空闲且云端回读完成');
 const page=await runtime.findPage(task),preview=page.locator('.content').filter({hasText:'Product Preview'});
 const submit=preview.locator('button').filter({hasText:/^Submit Product$/});
 const observed={url:page.url(),previewCount:await preview.count(),submitCount:await submit.count(),continueEditing:await preview.getByRole('button',{name:'Continue Editing',exact:true}).isVisible().catch(()=>false)};
 if(observed.previewCount===1)Object.assign(observed,await preview.evaluate(e=>{const link=e.querySelector('.product-card a[href]');let website;try{const u=new URL(link.href);if(!u.search||u.search==='?ref=10015.io')website=u.origin+(u.pathname==='/'?'':u.pathname);}catch{}return{name:e.querySelector('.product-card h4')?.textContent?.trim(),website,free:e.querySelector('.product-card .pricing')?.innerText?.trim()==='Free'&&!/checkout|\$|pay now/i.test(e.innerText)};}));
 // The product title is the preview card's first heading after its heading.
 if(observed.previewCount===1)observed.name=await preview.getByRole('heading',{name:task.profileSnapshot?.name,exact:true}).textContent().then(x=>x.trim()).catch(()=>observed.name);
 if(!canContinueProductPreview(task,input,observed))throw new Error('原页预览、产品资料或旧尝试不一致；禁止继续最终投稿。'+JSON.stringify(observed));
 await runtime.lease(task);
 let engine;const responses=[];
 const listener=response=>{if(response.request().method()==='POST'){const u=new URL(response.url());if(u.hostname==='10015.io')responses.push({url:u.origin+u.pathname,status:response.status()});}};
 try {
  engine=await attachEngine(runtime.context,page.mainFrame());
  const baseline=await engine.call({action:'classifySubmitEvidence',destinationUrl:task.url});
  if(baseline.matched)throw new Error('已有收件信号，应先verify，不能点预览');
  runtime.update(task,{stageHistory:[...(task.stageHistory||[]),{at:task.attemptBoundary,stage:'product_preview',observed,submitResult:task.submitResult,artifactRef:task.artifactRef}],
    previewFinalAttempt:true,attemptBoundary:new Date().toISOString(),baselineEvidence:baseline.evidence||'',status:'submitting',reason:'已核对原产品预览，确认最终投稿'},'preview_final_boundary');
  await runtime.cloud.flush(runtime.store);
  page.on('response',listener);await submit.click({timeout:10000});await page.waitForTimeout(4000);
  const result=await runtime.reobserveNavigatedReceipt(page,task);
  runtime.update(task,{networkResponses:responses,submitResult:{...result,clickedSubmit:true,networkResponses:responses}},'preview_final_result');
  if(result.matched&&result.evidence&&result.evidence!==task.baselineEvidence)await runtime.accept(task,page,result);
  else runtime.update(task,{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',reason:'预览最终提交已点击，未取得明确回执；保留原页核验'},'preview_unknown');
 }catch(error){runtime.update(task,{status:'submitted_unconfirmed',reason:error.message},'preview_attention');}
 finally {page.off('response',listener);await engine?.detach();if(!page.isClosed()){const file=path.join(runtime.home,`${task.id}-${Date.now()}-preview.png`);await page.screenshot({path:file});runtime.update(task,{screenshot:file,artifactRef:''},'preview_screenshot');}await runtime.synchronize();}
 return runtime.status();
}
