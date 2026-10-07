import {randomUUID} from 'node:crypto';
import '../../core/queue.js';

export const originalAgentLimits=Object.freeze({loops:8,settleMs:600});
export function originalExplicitHumanGate(reply,snapshot){
 if(snapshot?.meta?.hasCaptcha===true)return true;
 const reason=`${reply?.reason||''} ${reply?.message||''}`,status=globalThis.ExtLinkQueue.classifyStatusFromReason(reason,'needs_manual');
 return ['paid','needs_captcha','needs_otp','needs_login'].includes(status)||/legal agreement|accept terms|同意条款|接受协议/i.test(reason);
}
export function originalJudgeTerminal(reply,snapshot){
 if(!reply||typeof reply!=='object')return{needs_manual:true,reason:'judge returned an invalid response'};
 if(reply.status==='needs_manual'&&!originalExplicitHumanGate(reply,snapshot))return null;
 if(reply.status==='blocked')return{blocked:true,reason:reply.reason||reply.message||'judge blocked this page'};
 if(reply.status==='needs_manual')return{needs_manual:true,reason:reply.reason||reply.message||'judge needs manual input'};
 if(reply.status==='error')return{needs_manual:true,reason:reply.reason||reply.message||'judge returned an error'};
 return null;
}
export function originalPlanDecision(reply,snapshot){
 if(!reply||typeof reply!=='object')return{terminal:{needs_manual:true,reason:'unsupported plan status: undefined'}};
 if(reply.status==='needs_manual'){
  if(originalExplicitHumanGate(reply,snapshot))return{terminal:{needs_manual:true,reason:reply.reason||reply.message||'云端 AI 识别到人工闸门'}};
  return{plan:{...reply,status:'act',reason:`${reply.reason||'当前截图不足以决定下一步'}；未发现人工闸门，继续观察页面`,actions:[{type:'scroll',delta_y:Math.round((snapshot?.viewport?.height||800)*0.72)}]}};
 }
 if(['blocked','error'].includes(reply.status))return{terminal:{blocked:true,reason:reply.reason||reply.message||'云端 AI 暂时无法处理该页面'}};
 if(reply.status!=='act')return{terminal:{needs_manual:true,reason:reply.reason||reply.message||`unsupported plan status: ${reply.status}`}};
 return{plan:reply};
}

// bd916b2 runAgentLoop in its preparation phase. All browser/model work stays
// in the original task adapter. This loop never creates a receipt or submits.
export async function runOriginalAgentPreparation(runtime,{task,io}){
 await io.assertCurrent();if(task.attemptBoundary||task.receipt||['ai','supervisor'].includes(task.controller))throw Error('原任务控制权或投稿结果不允许开始接管');
 const prior=task.aiTakeover||{},state={...structuredClone(prior),id:prior.id||randomUUID(),startedAt:prior.startedAt||new Date().toISOString(),calls:Number(prior.calls)||0,actions:Number(prior.actions)||0,history:structuredClone(prior.history||[]),originalVisual:{...prior.originalVisual,loops:Number(prior.originalVisual?.loops)||0,history:structuredClone(prior.originalVisual?.history||[])}};
 // Existing modern takeovers keep their already-frozen ceilings on migration.
 if(prior.id&&!prior.originalVisual)state.legacyCeilings={calls:10,actions:20};
 runtime.update(task,{controller:'ai',aiTakeover:state},'original_agent_started');
 let result={ok:false,needs_manual:true,reason:'AI 未能自动完成，请手动检查（已尝试 8 轮）'};
 const persist=type=>runtime.update(task,{aiTakeover:structuredClone(state)},type);
 const guarded=async work=>{await io.assertCurrent();const value=await work();await io.assertCurrent();return value;};
 async function model(kind,input){
  if(state.legacyCeilings&&state.calls>=state.legacyCeilings.calls)return{status:'legacy_budget',reason:'原接管调用预算已用完，保留原任务'};
  state.calls++;persist('original_agent_model_boundary');const reply=await guarded(()=>io.model(kind,input));state.lastModel={kind,status:reply?.status||'',reason:reply?.reason||reply?.message||'',at:new Date().toISOString()};persist('original_agent_model_observed');return reply;
 }
 const terminal=value=>({ok:false,...value});
 try{
  let snapshot=await guarded(io.observe);
  if(io.readyBeforeJudge&&await guarded(()=>io.ready(snapshot)))return result={ok:true,reason:'prepared'};
  {
   const judge=await model('judge',{snapshot,phase:'initial'});if(judge?.status==='legacy_budget')return result=terminal({interrupted:true,reason:judge.reason});
   state.originalVisual.initialJudgeDone=true;persist('original_agent_initial_judge');const decision=originalJudgeTerminal(judge,snapshot);if(decision)return result=terminal(decision);
  }
  while(state.originalVisual.loops<originalAgentLimits.loops){
   state.originalVisual.loops++;persist('original_agent_loop_boundary');const step=state.originalVisual.loops-1;
   let plan;
   try{plan=await model('vision-plan',{snapshot,step,history:state.originalVisual.history.slice(-8),failure:state.originalVisual.noProgressCount?'Previous action produced no visible page change. Reassess the screenshot and choose a different action.':''});plan={...plan,visualAgent:true};}
   catch(error){if(error.staleTask||error.unattendedBudget||error.batchPaused)throw error;await io.assertCurrent();state.visualFallbackReason=String(error.message||error).slice(0,2000);persist('original_agent_visual_unavailable');plan=await model('plan',{snapshot,step,history:state.originalVisual.history.slice(-8),visualError:state.visualFallbackReason});plan={...plan,visualAgent:false};}
   if(plan.status==='legacy_budget')return result=terminal({interrupted:true,reason:plan.reason});
   const decision=originalPlanDecision(plan,snapshot);if(decision.terminal)return result=terminal(decision.terminal);plan=decision.plan;
   await guarded(()=>io.recordPlan?.(plan));const beforeHash=snapshot.domHash,actionResults=[];
   for(const action of plan.actions||[]){
    if(state.legacyCeilings&&state.actions>=state.legacyCeilings.actions)return result=terminal({interrupted:true,reason:'原接管动作预算已用完，保留原任务'});
    await io.assertCurrent();state.actions++;const event={at:new Date().toISOString(),type:action.type,selector:action.selector};state.history.push(event);state.history=state.history.slice(-100);persist('original_agent_action_boundary');
    let outcome;try{outcome=await io.act(action,{visual:plan.visualAgent===true,snapshot});event.ok=outcome?.ok!==false;}
    catch(error){if(error.staleTask)throw error;event.ok=false;event.error=String(error.message||error).slice(0,2000);if(plan.visualAgent)throw error;outcome=await guarded(()=>io.visualFallback(snapshot,error.message,model,async action=>{if(state.legacyCeilings&&state.actions>=state.legacyCeilings.actions)throw Error('原接管动作预算已用完');state.actions++;state.history.push({at:new Date().toISOString(),type:action.type,selector:action.selector,visualFallback:true});persist('original_agent_fallback_action_boundary');return guarded(()=>io.act(action,{visual:true,snapshot}));}));}
    await io.assertCurrent();persist('original_agent_action_observed');actionResults.push(outcome||{ok:true,type:action.type});
    const gate=outcome?.results?.find(item=>item.needs_manual)||(outcome?.needs_manual?outcome:null);if(gate)return result=terminal({needs_manual:true,reason:gate.error||gate.reason||'当前动作需要人工处理',humanGate:gate.humanGate,semanticReview:gate.semanticReview===true||gate.uncertain===true||gate.humanGate==='payment_uncertain'});
    if(outcome?.blocked)return result=terminal({blocked:true,reason:outcome.reason||'云端 AI 暂时无法处理该页面'});
    if(outcome?.interrupted)return result=terminal(outcome);
    if(action.type==='click'||event.ok===false)break;
   }
   await guarded(()=>io.settle(originalAgentLimits.settleMs));snapshot=await guarded(io.observe);
   const expectedMutation=plan.actions?.some(action=>['fill','select','check','click','scroll'].includes(action.type)),changed=!expectedMutation||!snapshot.domHash||snapshot.domHash!==beforeHash;
   state.originalVisual.noProgressCount=changed?0:(state.originalVisual.noProgressCount||0)+1;
   state.originalVisual.history.push({step:step+1,stage:plan.stage||'',actions:(plan.actions||[]).map(action=>({type:action.type,selector:action.selector})),result:actionResults.map(outcome=>({ok:outcome.ok!==false})),changed,url:snapshot.url||''});state.originalVisual.history=state.originalVisual.history.slice(-8);persist('original_agent_snapshot_observed');
   if(io.readyBeforeJudge&&await guarded(()=>io.ready(snapshot)))return result={ok:true,reason:'prepared'};
   const judge=await model('judge',{snapshot,phase:'after_action',step,plan});if(judge?.status==='legacy_budget')return result=terminal({interrupted:true,reason:judge.reason});
   const judged=originalJudgeTerminal(judge,snapshot);if(judged)return result=terminal(judged);
   // A model success alone never makes a prepared form or a receipt.
   if(await guarded(()=>io.ready(snapshot)))return result={ok:true,reason:'prepared'};
  }
  return result;
 }catch(error){if(error.originalPublicGateResult){result=terminal({...error.originalPublicGateResult,reason:String(error.message||error),originalPublicGateClassified:error.originalPublicGateClassified===true,originalPublicGateDocumentTimeOrigin:error.originalPublicGateDocumentTimeOrigin});return result;}result=terminal({reason:String(error.message||error),status:error.status,cloudNetwork:error.cloudNetwork,...(error.staleTask?{staleTask:true,interrupted:true}:error.unattendedBudget||error.batchPaused?{interrupted:true}:{needs_manual:true,serviceUnavailable:!!(error.cloudNetwork||error.status>=500||/云端|cloud|worker|fetch/i.test(error.message||''))})});return result;}
 finally{
  const current=runtime.store.get('task:'+task.id);if(current?.aiTakeover?.id===state.id&&current.controller==='ai'&&io.canRelease(current)){
   state.finishedAt=new Date().toISOString();state.reason=result.reason;state.ok=result.ok;runtime.update(current,{controller:'executor',aiTakeover:structuredClone(state)},'original_agent_returned');Object.assign(task,current);
  }
 }
}
