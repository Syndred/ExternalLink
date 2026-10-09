// The original launch and side-panel workflows share the same 12-step / 60-wait
// budget. Submission is a separate callback reached only after explicit consent.
export const productHuntLimits=Object.freeze({steps:12,waits:60,stableVisualRetries:2,visualFallbacks:2});
export function productHuntHumanGate(result={}){
 const signals=[result.gate,result.status,result.reason,...(Array.isArray(result.missing)?result.missing:[]),...(Array.isArray(result.requiredUnchecked)?result.requiredUnchecked:[])].filter(Boolean).join(' ').toLowerCase();
 return /captcha|recaptcha|hcaptcha|turnstile|验证码|人机验证|\botp\b|verification code|登录|log[ -]?in|sign[ -]?in|oauth|paywall|payment|purchase|checkout|subscribe|付款|支付|购买|订阅|legal|terms|privacy|consent|agree|accept|条款|隐私|同意/.test(signals);
}
export function productHuntVisualHandoff(result={},stable=0){const stage=String(result.stage||'').trim().toLowerCase();return stage.length>0&&stage!=='unknown'&&Array.isArray(result.missing)&&result.missing.length>0&&stable>=productHuntLimits.stableVisualRetries&&!productHuntHumanGate(result);}
export async function runProductHuntLoop({step,checkpoint,active=()=>true,delay,advance,visual,create,confirmCreate=false,entrypoint='launch'}){
 if(!['launch','sidepanel'].includes(entrypoint))throw Error('Product Hunt 发布入口无效');
 let completed=0,waits=0,signature='',stable=0,visuals=0;
 while(completed<productHuntLimits.steps&&waits<productHuntLimits.waits){
  if(!active())return{ok:false,interrupted:true,reason:'原发布操作已暂停或页面已变化'};
  const result=await step({confirmCreate:false});if(!result||typeof result!=='object')throw Error('Product Hunt 步骤返回无效');await checkpoint(result);
  if(!active())return{...result,ok:false,interrupted:true};
  if(result.submittedAttempt)throw Error('未授权创建阶段意外出现提交动作，必须先核验');
  if(result.status==='gate'||result.stage==='gate'||result.needs_manual||result.captcha||/^needs_/.test(result.status||''))return{...result,needs_manual:true};
  if(result.ready_to_create===true||result.status==='ready_to_create'){
   if(confirmCreate!==true)return{...result,ok:true,ready_to_create:true,submittedAttempt:false};
   if(typeof create!=='function')throw Error('缺少原任务创建草稿执行器');return create(result);
  }
  if(result.error||result.status==='error')throw Error(result.error||result.reason||'Product Hunt 步骤失败');
  if(result.waiting){
   if(result.stageCompleted&&result.stageAdvanced===false&&result.advancePoint&&advance){if(await advance(result)){waits++;await delay(900);continue;}}
   const next=[result.stage||'unknown',JSON.stringify(result.missing||result.requiredUnchecked||[]),result.reason||''].join('|');stable=next===signature?stable+1:0;signature=next;
   if(productHuntVisualHandoff(result,stable)){
    if(visual&&visuals<productHuntLimits.visualFallbacks){visuals++;const outcome=await visual(result);if(!active())return{ok:false,interrupted:true};if(outcome?.originalAgentUnavailable||outcome?.interrupted)return outcome;if(outcome?.needs_manual||outcome?.blocked||outcome?.error)return{...outcome,keepTab:true};if(outcome?.ok){stable=0;signature='';waits++;continue;}}
    return{...result,visualEscalation:true,needs_manual:true,keepTab:true};
   }
   if(result.stage&&result.stage!=='unknown'&&result.missing?.length&&stable>=5)return{...result,needs_manual:true,keepTab:true,reason:'Product Hunt '+result.stage+' 仍缺少：'+result.missing.join('、')};
   waits++;const milliseconds=Number(result.retryAfterMs);await delay(Number.isFinite(milliseconds)?Math.max(150,Math.min(milliseconds,5000)):800);continue;
  }
  if(!(result.advanced||result.stageAdvanced||result.stageCompleted||result.entryOpened)){
   if(entrypoint==='sidepanel')return{...result,waiting:true,retryAfterMs:800};
   throw Error(result.reason||'Product Hunt '+(result.stage||'unknown')+' 未推进');
  }
  completed++;waits=0;await delay(900);
 }
 return{ok:false,needs_manual:true,keepTab:true,reason:'Product Hunt 步骤超过原安全上限',completedSteps:completed,waitingRetries:waits};
}
