import {isDeepStrictEqual} from 'node:util';
import {workbenchScope} from './workbench-sync.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {prepareOriginalVisitFields} from './original-visit-fill-adapter.mjs';
import {originalHumanGateAttention} from './original-site-classification.mjs';
const durable=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));

// bd916b2 submitUntilAccepted: six stage advances; two validation failures,
// with one refill between them. Only the form engine's explicit negative
// result resolves an attempt here. Unknown clicks keep their boundary.
export function originalFormContinuationKind(result={}){
 if(result.submitted!==false||result.matched||result.evidence||result.existingSubmission||result.error||result.needs_manual||result.captcha||result.blocked)return null;
 return result.stageAdvanced===true?'stage':result.validationFailed===true?'validation':null;
}
export function originalFormPriorStageFields(task){
 return(task.attemptHistory||[]).filter(item=>item.kind==='original_stage_advanced'&&item.invocationId===task.originalFormContinuation?.invocationId&&item.targetId===task.targetId&&item.browserInstance===task.browserInstance&&item.url===task.url&&isDeepStrictEqual(item.profileSnapshot,task.profileSnapshot)).flatMap(item=>item.actualSubmission?.fields||[]);
}
export async function continueOriginalForm(runtime,{task,page,candidate,engines,config,result,active,offline=false,invocationId}){
 const kind=originalFormContinuationKind(result);if(!kind)return{handled:false};
 const scope=workbenchScope(runtime.store.get('pair')),url=page.url(),panel=task.pageOwnership==='manual'?runtime.store.get('singlePagePanel'):undefined;
 const keys=['id','runId','url','profileId','profileRevision','version','targetId','browserInstance','controller','controllerId'],identity=Object.fromEntries(keys.map(key=>[key,task[key]])),profile=structuredClone(task.profileSnapshot);
 const attempted=value=>JSON.stringify(Object.fromEntries(['actualSubmission','networkResponses','baselineEvidence','submitResult','manualSubmissionConsent','consentHistory'].map(key=>[key,value[key]])));let expectedAttempt=attempted(task);
 const media=()=>{const run=runtime.store.get('run:'+task.runId);return JSON.stringify([run?.mediaManifest,run?.originalMediaDefaults]);},originalMedia=media();
 let boundary=task.attemptBoundary,history=durable(task.attemptHistory),continuation=durable(task.originalFormContinuation);
 if(!boundary||task.receipt)return{handled:false};
 const check=()=>{
  const current=runtime.store.get('task:'+task.id);
  if(!current||keys.some(key=>current[key]!==identity[key])||!isDeepStrictEqual(current.profileSnapshot,profile)||current.attemptBoundary!==boundary||current.receipt||attempted(current)!==expectedAttempt||!isDeepStrictEqual(current.attemptHistory,history)||!isDeepStrictEqual(current.originalFormContinuation,continuation)||workbenchScope(runtime.store.get('pair'))!==scope||runtime.host?.startedAt!==task.browserInstance||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||page.isClosed()||page.url()!==url||panel&&!isDeepStrictEqual(runtime.store.get('singlePagePanel'),panel))throw Object.assign(Error('原表单步骤、任务、资料或页面已变化，保留原尝试'),{staleTask:true});
  if(!active())throw Object.assign(Error('原表单接续已暂停，保留原尝试'),{preparationInterrupted:true});
  if(media()!==originalMedia)throw Object.assign(Error('原表单素材清单已变化，保留原尝试'),{staleTask:true});
 };
 const assertCurrent=async()=>{check();const target=await getTargetInfo(runtime.context,page);check();if(target?.targetId!==task.targetId||candidate.frame.isDetached()||!await candidate.engine.isCurrentDocument())throw Object.assign(Error('原表单步骤的页面或文档已变化，保留原尝试'),{staleTask:true});check();};
 const update=(patch,event)=>{check();runtime.update(task,patch,event);boundary=task.attemptBoundary;history=durable(task.attemptHistory);continuation=durable(task.originalFormContinuation);expectedAttempt=attempted(task);};
 await assertCurrent();
 const previous=task.originalFormContinuation?.invocationId===invocationId?task.originalFormContinuation:{stages:0,validationAttempts:0},state={...previous,invocationId,stages:previous.stages+(kind==='stage'?1:0),validationAttempts:previous.validationAttempts+(kind==='validation'?1:0),phase:'refill',kind,...(panel?{panelContext:{id:panel.id,generation:panel.generation,profileId:panel.profileId,selectedTargetId:panel.selectedTargetId}}:{}),at:new Date().toISOString()};
 // Keep the exact attempted fields and negative response before permitting
 // another fill. Cloud failure never causes another click in this work call.
 update({attemptHistory:[...(task.attemptHistory||[]),{kind:kind==='stage'?'original_stage_advanced':'original_validation_rejected',invocationId,targetId:task.targetId,browserInstance:task.browserInstance,url:task.url,profileSnapshot:structuredClone(task.profileSnapshot),at:state.at,attemptBoundary:boundary,baselineEvidence:task.baselineEvidence,actualSubmission:structuredClone(task.actualSubmission),networkResponses:structuredClone(task.networkResponses),submitResult:structuredClone(result)}],attemptBoundary:null,baselineEvidence:'',submitResult:structuredClone(result),status:'filling',siteStatus:'not_submitted',attentionType:null,reason:'',originalFormContinuation:state},'original_form_attempt_resolved');
 if(!offline){await runtime.cloud.flush(runtime.store);await assertCurrent();}
 const stop=(reason,phase,gate)=>{update({status:'needs_manual',siteStatus:'not_submitted',attentionType:originalHumanGateAttention(gate?.reason,gate?.captcha?'needs_captcha':'')||'missing_fields',reason,originalFormContinuation:{...state,phase,...(gate?{gate:structuredClone(gate)}:{})}},'original_form_refill_stopped');return{handled:true,ready:false};};
 if(state.validationAttempts>=2)return stop('表单校验未通过，补完一轮仍缺：'+(result.issues?.[0]||'仍有必填或无效栏'),'validation_limit');
 if(kind==='stage'){await new Promise(resolve=>setTimeout(resolve,900));await assertCurrent();}
 const prepared=await prepareOriginalVisitFields(runtime,{task,page,candidate,engines,config:{...config,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false},assertBase:assertCurrent});
 await prepared.assertCurrent();const gate=prepared.fill.agentResult;
 update({actualPreparation:prepared.actual,formContinuationPreparation:{at:new Date().toISOString(),kind,fill:prepared.fill,actual:prepared.actual}},'original_form_refill_snapshot');
 if(gate?.needs_manual||gate?.captcha||gate?.blocked)return stop(gate.reason|| (gate.captcha?'请完成验证码':'原表单补填需要人工处理'),'gate',gate);
 if(state.stages>=6)return stop('表单已继续六个步骤，请检查当前页后继续','stage_limit');
 update({originalFormContinuation:{...state,phase:'ready'}},'original_form_refill_ready');
 return{handled:true,ready:true,fill:{...prepared.fill,ok:prepared.fill.validation.submitReady!==false},validation:prepared.fill.formState};
}
