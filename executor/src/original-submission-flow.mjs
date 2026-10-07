import {randomUUID} from 'node:crypto';
import {originalAgentLimits,originalJudgeTerminal,originalPlanDecision} from './original-agent-flow.mjs';
import {originalJudgeSuccessDecision} from './original-submission-proof.mjs';
import {originalAgentUnavailableError} from './original-agent-unavailable.mjs';
import {nativeNavigationSnapshotError} from './original-navigation-rejudge.mjs';

// bd916b2 safeVisualActions / isVisualSubmissionAction. Full submission keeps
// final selectors and finite coordinates; preparation still removes them.
export function originalVisualActions(actions,elements=[]){
 const bySelector=new Map(elements.map(element=>[element.selector,element]));
 return(actions||[]).map(action=>{
  if(action.type!=='click'||action.selector)return action;
  const x=Number(action.x),y=Number(action.y);if(!Number.isFinite(x)||!Number.isFinite(y))return action;
  const matches=elements.filter(({rect})=>rect&&x>=rect.x&&y>=rect.y&&x<=rect.x+rect.width&&y<=rect.y+rect.height).sort((a,b)=>a.rect.width*a.rect.height-b.rect.width*b.rect.height);
  return matches[0]?.selector?{...action,selector:matches[0].selector}:action;
 }).filter(action=>{
  if(['wait','scroll'].includes(action.type))return true;
  if(action.type==='click'&&!action.selector)return Number.isFinite(Number(action.x))&&Number.isFinite(Number(action.y));
  return bySelector.has(action.selector);
 });
}
export function originalVisualSubmissionAction(action,elements=[]){
 if(action?.type!=='click')return false;if(!action.selector)return true;
 const target=elements.find(element=>element.selector===action.selector);
 return /\b(submit|publish|launch|create draft|send listing|add (?:my )?(?:site|product|startup)|post comment)\b|提交|发布|创建草稿|发布评论|添加网站|添加产品/.test(`${target?.label||''} ${target?.aria||''} ${target?.type||''}`.toLowerCase());
}

// The original full visual loop, with browser/lease/evidence work supplied by
// its original native task adapter. Only the adapter owns a live attempt.
export async function runOriginalAgentSubmission(runtime,{task,io}){
 await io.assertCurrent();if(!io.authorized||task.receipt||task.fillOnlyRun===true||task.attemptBoundary&&task.attemptBoundary!==io.ownedAttemptBoundary?.()||['ai','supervisor'].includes(task.controller))throw Error('原任务尚未允许完整AI投稿，保留当前结果');
 const prior=task.aiTakeover||{},state={...structuredClone(prior),id:prior.id||randomUUID(),calls:Number(prior.calls)||0,actions:Number(prior.actions)||0,history:structuredClone(prior.history||[]),originalVisual:{...prior.originalVisual,loops:Number(prior.originalVisual?.loops)||0,history:structuredClone(prior.originalVisual?.history||[])},submissionPhase:{...prior.submissionPhase,id:prior.submissionPhase?.id||randomUUID(),loops:Number(prior.submissionPhase?.loops)||0,entry:structuredClone(prior.submissionPhase?.entry||{})}};
 if(state.originalVisual.pendingRejudge?.status==='ready'){state.submissionPhase.loopBase=state.submissionPhase.loops;state.originalVisual.pendingRejudge={...state.originalVisual.pendingRejudge,status:'rejudging',resumedAt:new Date().toISOString()};}
 if(prior.id&&!prior.originalVisual)state.legacyCeilings={calls:10,actions:20};
 runtime.update(task,{controller:'ai',aiTakeover:state},'original_submission_agent_started');
 let result={ok:false,needs_manual:true,reason:'AI 未能自动完成，请手动检查（已尝试 8 轮）'};
 const persist=type=>runtime.update(task,{aiTakeover:structuredClone(state)},type),guarded=async work=>{await io.assertCurrent();const value=await work();await io.assertCurrent();return value;};
 const terminal=value=>({ok:false,...value});
 async function model(kind,input){if(state.legacyCeilings&&state.calls>=state.legacyCeilings.calls)return{status:'legacy_budget',reason:'原接管调用预算已用完，保留原任务'};state.calls++;persist('original_agent_model_boundary');const reply=await guarded(()=>io.model(kind,input));state.lastModel={kind,status:reply?.status||'',reason:reply?.reason||reply?.message||'',at:new Date().toISOString()};persist('original_agent_model_observed');return reply;}
 async function judged(judge,snapshot,phase){
  if(judge?.status==='legacy_budget')return terminal({interrupted:true,reason:judge.reason});
  if(judge?.status==='success'){
   const observed={...judge,phase,evidenceSignals:snapshot.evidenceSignals||[],evidenceUrl:judge.evidenceUrl||snapshot.url||''},decision=originalJudgeSuccessDecision(task,state.submissionPhase.entry,observed);persist('original_submission_judge_proof');
   if(decision.proof.ok){await guarded(()=>io.complete({judge:observed,entry:structuredClone(state.submissionPhase.entry),decision,snapshot}));return{ok:true,receiptRecorded:true,reason:'原成功证据已保存，等待完整云端确认'};}
   if(decision.terminal)return terminal({unconfirmed:true,reason:decision.proof.reason});
  }
  return originalJudgeTerminal(judge,snapshot)?terminal(originalJudgeTerminal(judge,snapshot)):null;
 }
 async function execute(action,visual,snapshot){
  if(state.legacyCeilings&&state.actions>=state.legacyCeilings.actions)throw Object.assign(Error('原接管动作预算已用完'),{unattendedBudget:true});
  state.actions++;const event={at:new Date().toISOString(),type:action.type,selector:action.selector,visual};state.history.push(event);state.history=state.history.slice(-100);persist('original_agent_action_boundary');
  const outcome=await guarded(()=>io.act(action,{visual,snapshot,entry:structuredClone(state.submissionPhase.entry)}));event.ok=outcome?.ok!==false;const submitted=outcome?.results?.find(item=>item?.submitted)||(outcome?.submitted?outcome:null);
  if(submitted){state.submissionPhase.entry={submissionAttempted:true,submissionEvidenceBaseline:submitted.evidenceBaseline||'',submissionUrlBaseline:submitted.beforeUrl||snapshot.url||''};}
  persist('original_submission_action_observed');return outcome;
 }
 try{
  let snapshot=await guarded(io.observe);let decision=await judged(await model('judge',{snapshot,phase:'initial'}),snapshot,'initial');if(decision)return result=decision;
  while(state.submissionPhase.loops-(state.submissionPhase.loopBase||0)<originalAgentLimits.loops){
   state.submissionPhase.loops++;state.originalVisual.loops++;persist('original_submission_loop_boundary');const step=state.submissionPhase.loops-(state.submissionPhase.loopBase||0)-1;let plan;
   try{plan={...await model('vision-plan',{snapshot,step,history:state.originalVisual.history.slice(-8),failure:state.originalVisual.noProgressCount?'Previous action produced no visible page change. Reassess the screenshot and choose a different action.':''}),visualAgent:true};}
   catch(error){if(error.staleTask||error.originalTaskSyncFailure||error.unattendedBudget||error.batchPaused||[401,403,409].includes(error.status))throw error;await io.assertCurrent();state.visualFallbackReason=String(error.message||error).slice(0,2000);persist('original_agent_visual_unavailable');plan={...await model('plan',{snapshot,step,history:state.originalVisual.history.slice(-8),visualError:state.visualFallbackReason}),visualAgent:false};}
   if(plan.status==='legacy_budget')return result=terminal({interrupted:true,reason:plan.reason});const planned=originalPlanDecision(plan,snapshot);if(planned.terminal)return result=terminal(planned.terminal);plan=planned.plan;await guarded(()=>io.recordPlan?.(plan));
   const beforeHash=snapshot.domHash,results=[];
   for(const action of plan.actions||[]){let outcome;try{outcome=await execute(action,plan.visualAgent===true,snapshot);}catch(error){if(error.staleTask||error.originalTaskSyncFailure||error.unattendedBudget||error.batchPaused||[401,403,409].includes(error.status)||plan.visualAgent)throw error;outcome=await guarded(()=>io.visualFallback(snapshot,error.message,model,action=>execute(action,true,snapshot)));}results.push(outcome||{});
    const gate=outcome?.results?.find(item=>item.needs_manual)||(outcome?.needs_manual?outcome:null);if(gate)return result=terminal({needs_manual:true,reason:gate.error||gate.reason||'当前动作需要人工处理',humanGate:gate.humanGate,semanticReview:gate.semanticReview===true||gate.uncertain===true||gate.humanGate==='payment_uncertain'});if(outcome?.blocked||outcome?.interrupted||outcome?.unconfirmed)return result=terminal(outcome);if(action.type==='click'||outcome?.ok===false)break;
   }
   await guarded(()=>io.settle(originalAgentLimits.settleMs));
   if(io.waitForContentReady)await guarded(io.waitForContentReady);
   try{snapshot=await guarded(io.observe);}catch(error){if(!nativeNavigationSnapshotError(error))throw error;await io.assertCurrent();state.originalVisual.pendingRejudge={id:randomUUID(),status:'waiting_navigation',at:new Date().toISOString(),reason:error.message,afterActionLoop:state.originalVisual.loops,submissionPhase:true,...(io.navigationScope?{navigationScope:io.navigationScope()}:{} )};persist('original_navigation_pending_rejudge');return result={ok:false,pendingRejudge:true,reason:'等待原投稿页面导航完成后重新判断'};}
   const changed=!plan.actions?.some(action=>['fill','select','check','click','scroll'].includes(action.type))||!snapshot.domHash||snapshot.domHash!==beforeHash;state.originalVisual.noProgressCount=changed?0:(state.originalVisual.noProgressCount||0)+1;state.originalVisual.history.push({step:step+1,stage:plan.stage||'',actions:plan.actions||[],result:results,changed,url:snapshot.url||''});state.originalVisual.history=state.originalVisual.history.slice(-8);persist('original_submission_snapshot_observed');
   if(!plan.visualAgent&&io.deterministicSubmit){const submitted=await guarded(()=>io.deterministicSubmit(snapshot,state.submissionPhase.entry));if(submitted)return result=submitted;}
   decision=await judged(await model('judge',{snapshot,phase:'after_action',step,plan}),snapshot,'after_action');if(decision)return result=decision;
  }
  return result;
 }catch(error){if(error.originalPublicGateResult){result=terminal({...error.originalPublicGateResult,reason:String(error.message||error),originalPublicGateClassified:error.originalPublicGateClassified===true,originalPublicGateDocumentTimeOrigin:error.originalPublicGateDocumentTimeOrigin});return result;}result=terminal({reason:String(error.message||error),status:error.status,cloudNetwork:error.cloudNetwork,...(error.staleTask?{staleTask:true,interrupted:true}:error.originalTaskSyncFailure?{originalTaskSyncFailure:true,interrupted:true}:error.unattendedBudget||error.batchPaused?{interrupted:true}:task.receipt?{receiptRecorded:true}:task.attemptBoundary?{unconfirmed:true}:originalAgentUnavailableError(error)?{originalAgentUnavailable:true,serviceUnavailable:true}:{needs_manual:true,serviceUnavailable:[401,403,409].includes(error.status)})});return result;}
 finally{const current=runtime.store.get('task:'+task.id);if(current?.aiTakeover?.id===state.id&&current.controller==='ai'&&io.canRelease(current)){state.finishedAt=new Date().toISOString();state.reason=result.reason;state.ok=result.ok;if(state.originalVisual.pendingRejudge?.status==='rejudging'&&!result.pendingRejudge&&!result.interrupted&&!result.staleTask&&!result.originalTaskSyncFailure)state.originalVisual.pendingRejudge={...state.originalVisual.pendingRejudge,status:result.ok?'completed':'finished',completedAt:new Date().toISOString()};runtime.update(current,{controller:'executor',aiTakeover:structuredClone(state)},'original_submission_agent_returned');Object.assign(task,current);}}
}
