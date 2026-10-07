import {isDeepStrictEqual} from 'node:util';
import {applySubmissionPreferences,hasManualSubmissionConsent} from './submission-preferences.mjs';
import {priorProductSuccess,plain} from './shared.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {originalTaskSync} from './original-agent-unavailable.mjs';
import {assessSubmissionQuality} from './quality.mjs';
import {originalVisualSubmissionAction} from './original-submission-flow.mjs';

// This adapter is tied to one live invocation. Persisted unknown attempts are
// never adopted as owned attempts by a later call or process.
export function createOriginalSubmissionAdapter(runtime,{task,page,config,active,assertDocument,candidate,visual,ownership}){
 const consent=plain(task.manualSubmissionConsent||null),manualAuthorized=hasManualSubmissionConsent(runtime,task),consentHistory=plain(task.consentHistory||[]),responses=[];
 const responseListener=response=>{
  try{
   if(!ownership.attemptBoundary)return;
   const request=response.request(),frame=candidate()?.frame;
   if(request.method()!=='POST'||!['document','xhr','fetch'].includes(request.resourceType())||request.frame()!==frame)return;
   const target=new URL(response.url());if(target.hostname!==new URL(frame.url()).hostname)return;
   const body=request.postData()||'',identity=[task.profileSnapshot?.fields?.Url,task.profileSnapshot?.fields?.Name].filter(Boolean);
   const carriesProduct=identity.some(value=>[String(value),encodeURIComponent(value),encodeURIComponent(value).replace(/%20/g,'+')].some(encoded=>body.includes(encoded)));
   if(responses.length<20)responses.push({url:target.origin+target.pathname,status:response.status(),matched:carriesProduct&&response.status()>=200&&response.status()<300});
  }catch{/* A detached response never supplies positive proof. */}
 };
 page.on('response',responseListener);
 const assertAuthorized=async()=>{
  await assertDocument();
  if(!active()||task.fillOnlyRun===true||!isDeepStrictEqual(plain(task.manualSubmissionConsent||null),consent)||!isDeepStrictEqual(plain(task.consentHistory||[]),consentHistory))throw Object.assign(Error('原投稿授权已变化，保留原任务'),{staleTask:true});
  const snapshot=await runtime.cloud.request('snapshot');await assertDocument();
  if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('该产品同站已有云端收件，未再次投稿');
  const preferences=applySubmissionPreferences(runtime,task,snapshot.documents,config);
  // Manual consent was verified before the live invocation owned its boundary.
  if(preferences.fillOnly||preferences.autoSubmitDirectory===false&&!manualAuthorized||config.autoSubmitDirectory===false)throw Error('原目录自动投稿已关闭，保留填写结果');
  if(candidate()?.detection.platform==='wp_comment'&&preferences.autoSubmitStandardWpComments!==true)throw Error('标准WordPress评论自动提交未开启，保留填写结果');
  Object.assign(config,preferences,{autoSubmitDirectory:preferences.autoSubmitDirectory||manualAuthorized});
 };
 const beforeClick=async({verifyIdentity=false}={})=>{
  await assertAuthorized();
  const current=candidate(),report=await current.engine.call({action:'getFilledFieldsReport'});await assertDocument();
  await runtime.reconcileTextInputs(current.frame,report);await assertDocument();
  const actual=await current.engine.call({action:'getFilledFieldsReport'}),baseline=await current.engine.call({action:'classifySubmitEvidence',destinationUrl:task.url});await assertDocument();
  if(verifyIdentity){const issues=assessSubmissionQuality(actual,task.profileSnapshot||{});if(actual.allValid===false||issues.length)throw Error(issues.join('；')||'原投稿表单必填项已变化，未点击提交');}
  actual.attachments=await current.frame.locator('input[type=file]').evaluateAll(async inputs=>{
   const attachments=[];for(const input of inputs)for(const file of input.files||[])attachments.push({field:input.name||input.id,name:file.name,type:file.type,bytes:file.size,sha256:globalThis.crypto?.subtle?[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(value=>value.toString(16).padStart(2,'0')).join(''):''});return attachments;
  });await assertDocument();
  const prior={attemptBoundary:task.attemptBoundary,baselineEvidence:task.baselineEvidence,submissionUrlBaseline:task.submissionUrlBaseline,status:task.status,siteStatus:task.siteStatus};
  ownership.attemptBoundary=task.attemptBoundary||new Date().toISOString();
  runtime.update(task,{actualSubmission:actual,status:'submitting',siteStatus:'sent_unconfirmed',attemptBoundary:ownership.attemptBoundary,baselineEvidence:baseline.evidence||'',submissionUrlBaseline:page.url()},'original_visual_attempt_boundary');
  await originalTaskSync(()=>flushBatchTaskEvents(runtime,task));await assertDocument();return prior;
 };
 const restoreNoClick=async(prior,outcome)=>{
  const results=outcome?.results||[outcome],gate=results.some(item=>item?.needs_manual||item?.semanticReview);
  if(gate&&!results.some(item=>item?.ok&&(item.clicked||item.submitted||item.type==='click'))){await assertDocument();ownership.attemptBoundary=prior.attemptBoundary;runtime.update(task,prior,'original_visual_gate_before_click');await originalTaskSync(()=>flushBatchTaskEvents(runtime,task));await assertDocument();}
 };
 const act=async(action,{entry={}}={})=>{
  await assertDocument();
  if(entry.submissionAttempted&&['click','fill','select','check','upload'].includes(action.type)){
   const safeLink=action.type==='click'&&action.selector&&await candidate().frame.locator(action.selector).evaluate(element=>element.tagName==='A'&&/^https?:/.test(element.href)).catch(()=>false);
   if(!safeLink)return{ok:false,unconfirmed:true,reason:'已经执行原投稿动作，先核验回执，不重复修改或投稿'};
  }
  let executed=action;
  if(action.type==='click'&&!action.selector&&candidate().frame!==page.mainFrame()){
   const box=await(await candidate().frame.frameElement()).boundingBox();await assertDocument();
   if(!box||action.x<box.x||action.y<box.y||action.x>box.x+box.width||action.y>box.y+box.height)return{ok:false,needs_manual:true,reason:'截图坐标不属于原嵌入表单，未点击'};
   executed={...action,x:action.x-box.x,y:action.y-box.y};
  }
  const final=originalVisualSubmissionAction(action,visual()?.elements||[]);
  if(final){const validation=await candidate().engine.call({action:'collectFormValidation'}),report=await candidate().engine.call({action:'getFilledFieldsReport'});await assertDocument();const issues=assessSubmissionQuality(report,task.profileSnapshot||{});if(validation.validationFailed||issues.length)return{ok:false,needs_manual:true,reason:issues.join('；')||'原表单必填项未通过，未点击投稿'};}
  let prior;if(action.type==='click')prior=await beforeClick({verifyIdentity:final});
  const outcome=await candidate().engine.call({action:'executeActionPlan',actions:[executed]});
  if(prior)await restoreNoClick(prior,outcome);return outcome;
 };
 const complete=async({judge,entry,snapshot})=>{
  await assertDocument();
  if(!task.actualSubmission)runtime.update(task,{actualSubmission:snapshot.preparation?.filled||{fields:[]}},'original_visual_receipt_fields');
  try{await runtime.accept(task,page,{matched:true,evidence:judge.evidence||snapshot.evidenceSignals?.find(signal=>signal.matched)?.text||''},{judge,entry});}
  finally{if(task.receipt)ownership.receipt=structuredClone(task.receipt);}
 };
 const deterministicSubmit=async(snapshot,entry)=>{
  await assertDocument();if(entry.submissionAttempted)return{ok:false,unconfirmed:true,reason:'原投稿结果尚未确认，不再次提交'};
  const engine=candidate().engine,validation=await engine.call({action:'collectFormValidation'}),empty=await engine.call({action:'countEmptyFields'});await assertDocument();
  if(validation.validationFailed!==false||Number(empty?.emptyCount||0)||Number(empty?.invalidCount||0))return false;
  const action=await engine.call({action:'inspectSubmitAction',config,platform:candidate().detection.platform||'directory'});await assertDocument();if(!action.finalFound)return false;
  if(action.allowed===false)return{ok:false,needs_manual:true,reason:'AI已完成填写，原自动投稿授权未开启'};
  const prior=await beforeClick({verifyIdentity:true});const result=await engine.call({action:'submitFilledForm',config,platform:candidate().detection.platform||'directory'});
  await restoreNoClick(prior,result);await assertDocument();
  if(result?.captcha||result?.needs_manual||result?.blocked)return{ok:false,...result};
  if(result?.validationFailed)return false;
  if(result?.submitted&&result?.matched&&result.evidence){try{await runtime.accept(task,page,result);}finally{if(task.receipt)ownership.receipt=structuredClone(task.receipt);}return{ok:true,receiptRecorded:true,reason:'原确定性提交证据已保存，等待云端确认'};}
  if(result?.submitted)return{ok:false,unconfirmed:true,reason:'已代点提交，但站点未返回可核验回执'};
  return false;
 };
 return{act,complete,deterministicSubmit,ownedAttemptBoundary:()=>ownership.attemptBoundary,
  networkEvidence:()=>responses.find(response=>response.matched)||null,
  dispose:()=>page.off('response',responseListener)};
}
