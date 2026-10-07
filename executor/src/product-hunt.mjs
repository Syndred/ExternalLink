import {runProductHuntLoop} from '../../core/product-hunt-workflow.mjs';
import {attachEngine} from './engine.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {profiles,priorProductSuccess} from './shared.mjs';
import {armPageCaptchaResume} from './captcha-resume.mjs';
import {classifyOriginalTaskGate,originalHumanGateAttention} from './original-site-classification.mjs';
const at=()=>new Date().toISOString();
export function isProductHuntLaunch(url){try{const value=new URL(url);return/^https?:$/.test(value.protocol)&&/(^|\.)producthunt\.com$/i.test(value.hostname)&&!value.username&&!value.password;}catch{return false;}}
export async function runProductHuntWorkflow(runtime,task,page,config,{active=()=>runtime.store.get('paused')===false,confirmCreate=false,offline=false,callEngine}={}){
 const scope=workbenchScope(runtime.store.get('pair')),original={runId:task.runId,profileId:task.profileId,targetId:task.targetId,profileRevision:task.profileRevision,browserInstance:task.browserInstance};
 const ensure=(allowAttempt=false)=>{
  if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原 Product Hunt 发布已停止');
  const current=runtime.store.get('task:'+task.id);if(!current||['ai','supervisor'].includes(current.controller)||Object.entries(original).some(([key,value])=>current[key]!==value)||page.isClosed()||!isProductHuntLaunch(page.url()))throw Error('原 Product Hunt 任务或网页已变化');
  if((current.attemptBoundary||current.receipt)&&!allowAttempt)throw Error('原 Product Hunt 已有尝试结果，必须先核验');
  const mismatch=profiles.fillIdentityMismatch(config,task.profileSnapshot);if(mismatch)throw Error('原 Product Hunt 资料身份不一致：'+mismatch);
 };
 const call=callEngine||(async(message,{allowAttempt=false}={})=>{ensure(allowAttempt);const engine=await attachEngine(runtime.context,page.mainFrame(),request=>runtime.bridge(task,request));try{return await engine.call(message);}finally{await engine.detach();}});
 const checkpoint=async result=>{
  const previous=task.productHunt||{},history=[...(previous.history||[]),{at:at(),stage:result.stage||'unknown',reason:result.reason||'',missing:result.missing||[],expectedNext:result.expectedNext||result.nextStage||'',actualPreparation:result.actualPreparation}].slice(-100);
  const stageReports=result.actualPreparation?{...previous.stageReports,[result.stage]:result.actualPreparation}:previous.stageReports;
  const actualSubmission=stageReports?{url:page.url(),fields:Object.entries(stageReports).flatMap(([stage,report])=>(report.fields||[]).map(field=>({...field,stage}))),attachments:Object.entries(stageReports).flatMap(([stage,report])=>(report.attachments||[]).map(file=>({...file,stage})))}:undefined;
  runtime.update(task,{productHunt:{...previous,stage:result.stage||previous.stage||'unknown',readyToCreate:result.ready_to_create===true,expectedNext:result.expectedNext||result.nextStage||'',lastTransitionAt:at(),history,...(stageReports?{stageReports}:{})},...(result.actualPreparation?{actualPreparation:result.actualPreparation}:{}),...(actualSubmission?{actualSubmission}:{})},'producthunt_stage');
 };
 ensure();const result=await runProductHuntLoop({active,delay:milliseconds=>page.waitForTimeout(milliseconds),checkpoint,
  step:async request=>{ensure();await runtime.lease(task,{online:!offline});return call({action:'runProductHuntStep',config,...request});},
  advance:async reply=>{ensure();if(!active())return false;await runtime.lease(task,{online:!offline});ensure();const action=await call({action:'inspectProductHuntAdvance',expectedStage:reply.stage}),point=action.point;if(!action.allowed||!Number.isFinite(action.viewport?.width)||!Number.isFinite(action.viewport?.height)||!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.y<0||point.x>=action.viewport.width||point.y>=action.viewport.height||!active())return false;runtime.update(task,{productHunt:{...task.productHunt,lastTrustedAdvance:{at:at(),stage:reply.stage,label:action.label}}},'producthunt_advance_boundary');await page.mouse.click(point.x,point.y);return true;},
  visual:async reply=>{ensure();if(offline)return{needs_manual:true,reason:'Product Hunt 自定义控件需联网继续原截图接管'};const outcome=await runtime.prepareWithAi(page,task,{...config,productHuntPrepared:true,visualFillOnly:true},active,{normalFillDone:true,readyCheck:async engine=>{const reply=await engine.call({action:'runProductHuntStep',config,confirmCreate:false});await checkpoint(reply);return reply.ready_to_create===true;}});await outcome.candidate?.engine.detach();return outcome;},
  confirmCreate:confirmCreate===true,
  create:async()=>{
   ensure();if(!active())return{interrupted:true,submittedAttempt:false};
   const consent=task.productHuntCreationConsent;if(!consent||Object.entries(original).some(([key,value])=>consent[key]!==value))throw Error('请在原任务明确确认创建 Product Hunt 草稿');
   let prepared=await call({action:'inspectProductHuntCreation',config});await checkpoint(prepared);
   if(!prepared.createDeferred||!prepared.ready_to_create||prepared.finalAction!=='create draft')return{...prepared,needs_manual:true,submittedAttempt:false};
   const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));let point=prepared.createPoint;
   if(point?.y<0||point?.y>=viewport.height){await page.getByRole('button',{name:prepared.label,exact:true}).scrollIntoViewIfNeeded();prepared=await call({action:'inspectProductHuntCreation',config});point=prepared.createPoint;}
   if(!prepared.createDeferred||!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.y<0||point.x>=viewport.width||point.y>=viewport.height)throw Error('Product Hunt 创建按钮位置不可核验');
   await runtime.lease(task,{online:!offline});ensure();const target=await getTargetInfo(runtime.context,page);if(target?.targetId!==original.targetId)throw Error('Product Hunt 原标签编号已变化');
   if(!offline){const snapshot=await runtime.cloud.request('snapshot');ensure();if(!snapshot.documents.siteProfiles?.[task.profileId]||snapshot.documents.siteProfiles[task.profileId].archived||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('Product Hunt 同站已有收件或产品不可用');}
   if(!active())return{interrupted:true,submittedAttempt:false};
   runtime.update(task,{status:'submitting',siteStatus:'sent_unconfirmed',attemptBoundary:at(),baselineEvidence:prepared.baseline?.evidence||'',productHunt:{...task.productHunt,creationBaseline:prepared.baseline,creationPoint:point,creationRequestedAt:at()}},'producthunt_create_boundary');
   if(!offline)await runtime.cloud.flush(runtime.store);
   if(!active())return{submittedAttempt:true,matched:false,reason:'创建边界已保存，暂停后先核验原页面'};
   ensure(true);const latest=await call({action:'inspectProductHuntCreation',config},{allowAttempt:true});point=latest.createPoint;
   if(!latest.allowed||!latest.ready_to_create||latest.finalAction!=='create draft'||!Number.isFinite(latest.viewport?.width)||!Number.isFinite(latest.viewport?.height)||!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||point.x<0||point.y<0||point.x>=latest.viewport.width||point.y>=latest.viewport.height)return{submittedAttempt:true,matched:false,reason:'创建边界已保存，当前清单或按钮变化，未点击创建；先核验原页'};
   if(!active())return{submittedAttempt:true,matched:false,reason:'创建边界已保存，已暂停，未点击创建'};
   ensure(true);runtime.update(task,{productHunt:{...task.productHunt,creationPoint:point}},'producthunt_create_revalidated');await page.mouse.click(point.x,point.y);runtime.update(task,{productHunt:{...task.productHunt,creationClickedAt:at()}},'producthunt_create_clicked');
   await page.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});const proof=await call({action:'observeProductHuntResult',config,baseline:prepared.baseline,timeoutMs:15000},{allowAttempt:true});
   return{...proof,submittedAttempt:true,clickedCreateDraft:true,finalAction:'create draft'};
  }
 });
 if(result.originalAgentUnavailable)return result;
 const classification=!result.ready_to_create&&!result.interrupted?await classifyOriginalTaskGate(runtime,{task,page,result,active,assertPageDocument:async()=>ensure(result.submittedAttempt===true)}):null;
 if(result.submittedAttempt){if(result.matched&&result.evidence)await runtime.accept(task,page,result);else runtime.update(task,{status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attentionType:'unknown_receipt',reason:result.reason||result.error||'Product Hunt 创建结果未知，核验原页面后处理；不重复点击',submitResult:result},'producthunt_create_unknown');}
 else if(!classification?.disposition)runtime.update(task,{status:'needs_manual',siteStatus:'not_submitted',attentionType:result.ready_to_create?'producthunt_create_confirmation':originalHumanGateAttention('',classification?.status)|| (result.gate==='captcha'||result.captcha?'human_verification':result.gate==='login'||result.status==='needs_login'?'login':'manual'),reason:result.ready_to_create?'Product Hunt 必填项已完成，等待确认创建草稿；不会排期或购买推广':result.reason||'Product Hunt 原步骤待处理',productHunt:{...task.productHunt,readyToCreate:result.ready_to_create===true}},'producthunt_handoff');
 if(!callEngine&&task.attentionType==='human_verification'&&!task.attemptBoundary&&!task.receipt&&active())await armPageCaptchaResume(runtime,task,page,{active});
 return result;
}
