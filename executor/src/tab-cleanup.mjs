import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import {readFile}from'node:fs/promises';
import{capturePageEvidence}from'./page-evidence.mjs';
import{getTargetInfo}from'./browser-target.mjs';
const onWire = value => JSON.parse(JSON.stringify(value));
const bounded=(promise,ms,label)=>{
  let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}超过${ms}ms`)),ms);})]).finally(()=>clearTimeout(timer));
};

export function recoveryStage(task){
  const fields=productFields(task);
  if(task.attemptBoundary||task.status==='submitted_unconfirmed'||task.siteStatus==='sent_unconfirmed')return 'receipt_verification';
  if(task.attentionType==='human_verification')return task.validation?.emptyCount===0&&fields.length?'final_captcha':'human_verification';
  if(task.attentionType==='login')return 'login_required';
  if(task.validation?.emptyCount===0&&task.validation?.validationFailed!==true&&fields.length)return 'validated_form';
  if(fields.length)return 'form_filled';
  return 'not_filled';
}

function productFields(task){
  const excluded=/^(?:q|s|search|query|keyword|captcha|csrf|nonce|token)$/i;
  const signal=/(?:name|title|tool|product|website|url|description|tagline|category|email|logo|image|feature|pricing|company|social|twitter|linkedin|founder|developer)/i;
  const saved=task.actualSubmission?.fields;
  const fields=Array.isArray(saved)?saved:saved&&typeof saved==='object'?Object.entries(saved).filter(([,value])=>value===null||['string','number','boolean'].includes(typeof value)).map(([name,value])=>({name,value})):[];
  return fields.filter(field=>field&&typeof field==='object'&&!excluded.test(String(field.name||'').trim())&&signal.test(`${field.name||''} ${field.label||''}`));
}

export function recoveryCheckpoint(task,page,screenshot,closedAt){
  const stage=recoveryStage(task),fields=productFields(task);
  const nextStep=stage==='receipt_verification'?'核对原任务已保存的站方回执或截图；禁止再次点击提交'
    :stage==='final_captcha'?'重新打开同一任务并完成新的验证码；关闭的验证码响应不可复用'
    :stage==='human_verification'?'重新打开同一任务，恢复已知资料后由用户完成验证码'
    :stage==='login_required'?'打开同一任务的原站入口并登录；登录成功后继续该任务'
    :stage==='validated_form'?'重新打开同一任务并核对资料后继续'
    :stage==='form_filled'?'重新打开同一任务；关闭后表单状态不保证保留，按已保存字段恢复'
    :'重新打开同一任务并重新填写；没有保存可恢复的表单字段';
  return {stage,recordedAt:closedAt,taskId:task.id,profileRevision:task.profileRevision??null,
    completedFields:fields.map(f=>({name:f.name||'',label:f.label||'',value:f.value??'',type:f.type||''})),
    completedFieldCount:fields.length,profileValuesAvailable:fields.length>0,
    recoveryUrl:page?.url?.()||task.recoveryCheckpoint?.recoveryUrl||task.url,
    blockedReason:task.reason||'',nextStep,evidencePath:screenshot||task.screenshot||'',
    attemptBoundary:task.attemptBoundary||null,submitClicked:task.submitResult?.clickedSubmit??null,
    formRecoverability:stage==='receipt_verification'?'original_page_verification_only_no_repost':fields.length?'reopen_and_restore_known_fields_then_revalidate':'unknown_requires_reentry',
    captchaLimitation:task.attentionType==='human_verification'?'challenge response expires with the closed page; a new challenge is required':'',
    loginLimitation:task.attentionType==='login'?'site authentication state must be checked after reopening':'',
    sourceTargetId:task.targetId,sourceBrowserInstance:task.browserInstance,closedAt};
}

export async function closeTaskTab(runtime, task, input, options={}) {
  const plan=runtime.store.get('libraryPlan');
  const planOwned=plan?.status==='active'&&task.libraryPlanId===plan.id;
  const continuous=options.continuous===true&&plan?.status==='active'&&task.libraryPlanId===plan.id&&runtime.activeTaskId===task.id;
  const offline=runtime.store.get('offlineMode')?.enabled===true;
  const evidenceGapAllowed=input.allowEvidenceGap===true&&offline&&planOwned&&task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&
    !task.attemptBoundary&&!task.receipt&&task.attentionType==='site_unavailable'&&/(?:timeout|timed out|ERR_|net::|连接|超时)/i.test(task.reason||'');
  const archiveManual=options.archiveManual===true&&continuous&&task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&
    !task.attemptBoundary&&!task.receipt&&!task.registration?.boundary&&!task.loginLinkRequest?.boundary&&
    ['human_verification','login'].includes(task.attentionType);
  const archiveManualPaused=input.archiveManual===true&&offline&&planOwned&&runtime.job===null&&runtime.store.get('paused')===true&&
    task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&!task.attemptBoundary&&!task.receipt&&
    !task.registration?.boundary&&!task.loginLinkRequest?.boundary&&['human_verification','login'].includes(task.attentionType);
  if(archiveManualPaused&&runtime.activeTaskId)throw new Error('执行器仍有活动任务，不能批量归档待人工页');
  if ((!continuous&&(runtime.job || runtime.store.get('paused') !== true)) || runtime.store.pending().length&&!offline)
    throw new Error('关页前需要暂停空闲且云端事件已回读');
  if (!task.targetId || input.expectedTargetId !== task.targetId || (!task.screenshot&&!evidenceGapAllowed&&!archiveManual&&!archiveManualPaused) || (!task.artifactRef&&!offline))
    throw new Error('任务目标或证据不完整，不能关页');
  const accepted = task.status === 'finished' && task.siteStatus === 'accepted' && task.cloudVerified && task.receipt?.evidence;
  const deferred=t=>t.libraryPlanId===plan?.id&&t.status==='needs_manual'&&!t.attemptBoundary&&!t.receipt&&!t.tabClosedAt&&
    !t.authTargetId&&!t.registration?.boundary&&!t.loginLinkRequest?.boundary&&['human_verification','login'].includes(t.attentionType);
  const archiveDeferred=continuous&&options.archiveDeferred===true&&deferred(task)&&runtime.store.values('task:').filter(deferred).length>plan.retainedTabLimit;
  const terminalTypes=planOwned?['payment','site_form_unavailable','email_only','site_unavailable','missing_fields','missing_real_identity','comments_require_review','site_requires_review']:['payment','site_form_unavailable','email_only'];
  const resolvedBlocker=input.closeBlocked===true&&task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&!task.attemptBoundary&&!task.receipt&&(terminalTypes.includes(task.attentionType)||archiveDeferred);
  if (!accepted&&!resolvedBlocker&&!archiveManual&&!archiveManualPaused) throw new Error('尚需登录、校验、保留表单或核验结果的原页不能关闭');
  await runtime.synchronize();
  if(offline){
    if(accepted&&!task.cloudVerified&&task.receipt?.syncStatus!=='pending')throw new Error('离线收件状态未标记待同步，不能关页');
    let page;try{page=await runtime.findPage(task);}catch(error){if(!/原浏览器宿主已变化|原目标页已关闭/.test(error.message))throw error;}
    let bytes=null,screenshot=task.screenshot||'',sha='';
    if(page&&(archiveManual||archiveManualPaused)){
      const fresh=path.join(runtime.home,`${task.id}-${Date.now()}-recovery.png`);
      try{bytes=await capturePageEvidence(runtime.context,page,{path:fresh,timeoutMs:3000});screenshot=fresh;sha=createHash('sha256').update(bytes).digest('hex');}
      catch(error){runtime.update(task,{recoveryEvidenceFailure:{at:new Date().toISOString(),targetId:task.targetId,reason:error.message}},'recovery_evidence_capture_failed');}
    }
    if(!bytes&&screenshot){try{bytes=await readFile(screenshot);}catch{bytes=null;}}
    if(!bytes&&page){
      screenshot=path.join(runtime.home,`${task.id}-${Date.now()}-cleanup.png`);
      const timeoutMs=Math.max(100,Math.min(5000,Number(input.evidenceCaptureTimeoutMs)||3000));
      try{bytes=await capturePageEvidence(runtime.context,page,{path:screenshot,timeoutMs});sha=createHash('sha256').update(bytes).digest('hex');
        runtime.update(task,{screenshot,artifactRef:'',evidenceCaptureFailure:null},'terminal_evidence_recaptured');}
      catch(error){screenshot='';bytes=null;runtime.update(task,{evidenceCaptureFailure:{at:new Date().toISOString(),reason:error.message,
        source:'terminal_page_cleanup',targetId:task.targetId,browserInstance:task.browserInstance}},'terminal_evidence_gap_registered');}
    }else if(bytes)sha=createHash('sha256').update(bytes).digest('hex');
    else if(!page){runtime.update(task,{evidenceCaptureFailure:{at:new Date().toISOString(),reason:'原目标页不存在，无法补采截图；任务已有导航失败记录，且无投稿尝试',
      source:'terminal_page_cleanup',targetId:task.targetId,browserInstance:task.browserInstance}},'terminal_evidence_gap_registered');}
    const closedAt=new Date().toISOString();
    const checkpoint=recoveryCheckpoint(task,page,screenshot,closedAt);
    const registration={registeredAt:closedAt,taskId:task.id,targetId:task.targetId,browserInstance:task.browserInstance,
      url:page?.url()||task.receipt?.url||task.url,profileRevision:task.profileRevision,actualSubmission:task.actualSubmission,result:task.siteStatus,receipt:task.receipt,
      artifactRef:'',artifactSha256:sha,localScreenshot:screenshot,recordRevision:null,syncStatus:'pending',evidenceGap:!bytes,
      evidenceGapReason:!bytes?task.evidenceCaptureFailure?.reason||'本地截图文件不可读，未取得替代截图；保留任务状态及原始导航失败记录':'',
      recoveryCheckpoint:checkpoint,disposition:page?'ready_to_close':'original_target_unavailable',reason:bytes?'本地站方结果及截图 SHA-256 已登记，云端回读待同步': '截图缺失已登记；任务无投稿尝试，原目标页不存在或证据不可采集'};
    runtime.update(task,{screenshot,recoveryCheckpoint:checkpoint,tabHistory:[...(task.tabHistory||[]),registration]},'tab_closure_registered_offline');
    if(page){
      try{await bounded(page.close({runBeforeUnload:false}),5000,'原任务页关闭');registration.closedAt=new Date().toISOString();registration.disposition='closed';
        const recovery=recoveryCheckpoint(task,{url:()=>registration.url},screenshot,registration.closedAt);
        runtime.update(task,{tabHistory:task.tabHistory,tabClosedAt:registration.closedAt,recoveryCheckpoint:recovery,
          deferredRecovery:{archivedAt:registration.closedAt,requiresFreshCaptcha:task.attentionType==='human_verification',originalTaskOnly:true,
            profileRevision:task.profileRevision??null,evidencePath:screenshot,formRecoverability:recovery.formRecoverability,
            recoveryUrl:recovery.recoveryUrl,stage:recovery.stage,nextStep:recovery.nextStep}},'tab_closed_offline');}
      catch(error){registration.disposition='close_timeout';registration.reason=`本地关闭请求超时；未标记已关闭：${error.message}`;
        runtime.update(task,{tabHistory:task.tabHistory,cleanupFailure:{at:new Date().toISOString(),reason:error.message,targetId:task.targetId}},'tab_close_timeout');}
    }
    return runtime.status();
  }
  const [runs, snapshot, artifact] = await Promise.all([
    runtime.cloud.request('runs'), runtime.cloud.request('snapshot'),
    runtime.cloud.request('artifact-read', { taskId: task.id, ref: task.artifactRef }),
  ]);
  const remote = runs.tasks.find(t => t.id === task.id);
  const record = snapshot.documents.submissionRecords?.[task.destinationKey + '::' + task.profileId];
  const sha = createHash('sha256').update(Buffer.from(artifact.dataUrl.split(',')[1], 'base64')).digest('hex');
  const keys = ['status','siteStatus','reason','attentionType','attemptBoundary','receipt','actualSubmission','profileRevision','artifactRef','artifactSha256'];
  if (!remote || keys.some(k => !isDeepStrictEqual(task[k] ?? null, remote[k] ?? null)) ||
      (accepted?(record?.taskId !== task.id || record?.evidence !== task.receipt.evidence ||
      !isDeepStrictEqual(record?.actualSubmission, task.actualSubmission)):record?.status==='success') || sha !== task.artifactSha256)
    throw new Error('关页前独立云端任务、账本或截图校验失败');
  let page;
  try { page = await runtime.findPage(task); }
  catch (error) {
    if (!/原浏览器宿主已变化|原目标页已关闭/.test(error.message)) throw error;
  }
  const registration = { registeredAt: new Date().toISOString(), taskId: task.id, targetId: task.targetId,
    browserInstance: task.browserInstance, url: page?.url() || task.receipt?.url || task.url, profileRevision: task.profileRevision,
    actualSubmission: task.actualSubmission, result: task.siteStatus, receipt: task.receipt,
    artifactRef: task.artifactRef, artifactSha256: sha, recordRevision: snapshot.revisions.submissionRecords,
    disposition: page ? 'ready_to_close' : 'original_target_unavailable',
    reason: page ? accepted?'站方收件及云端独立回读一致，原页核验完成':archiveDeferred?'全库待办页超出容量，证据回读后关闭原页；恢复时须重新加载验证，旧验证码响应不可复用':'已核验无法免费投稿或表单不可用，阻塞原因及截图独立回读完成：'+task.reason : '原宿主已退出或原目标已不存在；未关闭任何替代或个人页签' };
  await runtime.lease(task);
  runtime.update(task, { tabHistory: [...(task.tabHistory || []), registration] }, 'tab_closure_registered');
  await runtime.synchronize();
  const beforeClose = (await runtime.cloud.request('runs')).tasks.find(t => t.id === task.id);
  if (!isDeepStrictEqual(beforeClose?.tabHistory, onWire(task.tabHistory))) throw new Error('页签登记未独立回读，停止关页');
  if (page) {
    await page.close();
    registration.closedAt = new Date().toISOString();
    registration.disposition = 'closed';
    runtime.update(task, { tabHistory: task.tabHistory, tabClosedAt: registration.closedAt,
      ...(archiveDeferred?{deferredRecovery:{archivedAt:registration.closedAt,requiresFreshCaptcha:task.attentionType==='human_verification',originalTaskOnly:true,profileRevision:task.profileRevision,artifactRef:task.artifactRef,artifactSha256:task.artifactSha256,reason:registration.reason}}:{}) }, 'tab_closed');
    await runtime.synchronize();
    const after = (await runtime.cloud.request('runs')).tasks.find(t => t.id === task.id);
    if (!isDeepStrictEqual(after?.tabHistory, onWire(task.tabHistory))) throw new Error('页签已关，关闭事件云端回读待恢复');
  }
  return runtime.status();
}

export async function archiveDeferredTabs(runtime){
  const plan=runtime.store.get('libraryPlan');
  if(runtime.job||runtime.store.get('paused')!==true||!runtime.store.get('offlineMode')?.enabled||plan?.status!=='active')
    throw new Error('批量归档仅允许暂停空闲的离线连续任务');
  if(!runtime.context)await runtime.connect();
  const pagesByTarget=new Map();
  for(const page of runtime.context.pages()){
    const info=await getTargetInfo(runtime.context,page);
    if(info)pagesByTarget.set(info.targetId,page);
  }
  const candidates=runtime.store.values('task:').filter(task=>task.libraryPlanId===plan.id&&task.browserInstance===runtime.host?.startedAt&&
    task.targetId&&pagesByTarget.has(task.targetId)&&!task.tabClosedAt&&task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&!task.attemptBoundary&&!task.receipt&&
    !task.registration?.boundary&&!task.loginLinkRequest?.boundary&&['human_verification','login'].includes(task.attentionType));
  const closed=[];
  for(const task of candidates){
    await closeTaskTab(runtime,task,{expectedTargetId:task.targetId,archiveManual:true},{archiveManual:true});
    if(task.tabClosedAt)closed.push({taskId:task.id,targetId:task.targetId,closedAt:task.tabClosedAt,stage:task.recoveryCheckpoint?.stage,
      recoveryUrl:task.recoveryCheckpoint?.recoveryUrl,evidencePath:task.recoveryCheckpoint?.evidencePath});
  }
  const checkpointUpdates=[];
  for(const task of runtime.store.values('task:').filter(t=>t.profileId===plan.profileId&&['human_verification','login'].includes(t.attentionType)&&
    t.status==='needs_manual'&&!t.attemptBoundary&&!t.receipt&&!t.registration?.boundary&&
    ((!t.recoveryCheckpoint&&(t.tabClosedAt||!t.targetId||!pagesByTarget.has(t.targetId)))||
      (t.recoveryCheckpoint&&!t.tabClosedAt&&!t.deferredRecovery?.targetUnavailableAt&&(!t.targetId||!pagesByTarget.has(t.targetId)))))){
    const closure=[...(task.tabHistory||[])].reverse().find(entry=>entry.disposition==='closed'||entry.closedAt)||task.deferredRecovery||{};
    const unavailable=!task.tabClosedAt,checkpoint=recoveryCheckpoint({...task,targetId:closure.targetId||task.targetId},
      closure.url?{url:()=>closure.url}:null,task.screenshot||closure.localScreenshot||'',task.tabClosedAt||task.recoveryCheckpoint?.closedAt||'');
    runtime.update(task,{recoveryCheckpoint:{...(task.recoveryCheckpoint||{}),...checkpoint},deferredRecovery:{...(task.deferredRecovery||{}),archivedAt:closure.closedAt||task.tabClosedAt||task.recoveryCheckpoint?.closedAt,
      stage:checkpoint.stage,nextStep:checkpoint.nextStep,recoveryUrl:checkpoint.recoveryUrl,evidencePath:checkpoint.evidencePath,
      targetUnavailableAt:unavailable?new Date().toISOString():undefined,formRecoverability:checkpoint.formRecoverability,
      requiresFreshCaptcha:task.attentionType==='human_verification',originalTaskOnly:true}},unavailable?'missing_original_target_checkpoint':'recovery_checkpoint_backfilled');
    checkpointUpdates.push({taskId:task.id,targetId:checkpoint.sourceTargetId,closedAt:checkpoint.closedAt,stage:checkpoint.stage,
      evidencePath:checkpoint.evidencePath,backfilled:true,targetUnavailable:unavailable});
  }
  const normalized=[];
  for(const task of runtime.store.values('task:').filter(t=>t.libraryPlanId===plan.id&&t.recoveryCheckpoint)){
    const prior=task.recoveryCheckpoint,closure=[...(task.tabHistory||[])].reverse().find(entry=>entry.url)||{};
    const page=pagesByTarget.get(task.targetId),fallbackUrl=prior.recoveryUrl||closure.url||task.url;
    const checkpoint=recoveryCheckpoint(task,page||{url:()=>fallbackUrl},task.screenshot||prior.evidencePath||'',prior.closedAt||task.tabClosedAt||null);
    if(task.attemptBoundary){checkpoint.nextStep='在保留的原任务页核验站方收件结果；不要再次提交';checkpoint.formRecoverability='original_page_verification_only_no_repost';
      checkpoint.originalTargetAvailable=!!page;}
    if(prior.stage!==checkpoint.stage||prior.formRecoverability!==checkpoint.formRecoverability||
      JSON.stringify(prior.completedFields||[])!==JSON.stringify(checkpoint.completedFields||[])){
      runtime.update(task,{recoveryCheckpoint:{...prior,...checkpoint}},'recovery_checkpoint_normalized');normalized.push({taskId:task.id,from:prior.stage,to:checkpoint.stage});
    }
  }
  const unknownCheckpoints=[];
  for(const task of runtime.store.values('task:').filter(t=>t.libraryPlanId===plan.id&&t.status==='submitted_unconfirmed'&&t.attemptBoundary&&
    !t.receipt&&t.attentionType==='unknown_receipt'&&!t.recoveryCheckpoint)){
    const page=pagesByTarget.get(task.targetId),fallbackUrl=task.publicPage?.url||task.url;
    const checkpoint=recoveryCheckpoint(task,page||{url:()=>fallbackUrl},task.screenshot||'',null);
    checkpoint.nextStep='在保留的原任务页核验站方收件结果；不要再次提交';
    checkpoint.formRecoverability='original_page_verification_only_no_repost';checkpoint.originalTargetAvailable=!!page;
    runtime.update(task,{recoveryCheckpoint:checkpoint},'unknown_receipt_checkpoint');
    unknownCheckpoints.push({taskId:task.id,targetId:task.targetId,stage:checkpoint.stage,recoveryUrl:checkpoint.recoveryUrl,evidencePath:checkpoint.evidencePath});
  }
  return {...runtime.status(),cleanup:{examined:candidates.length,closed,recoveryCheckpointUpdates:checkpointUpdates,normalized,unknownCheckpoints}};
}
