import { randomUUID } from 'node:crypto';
import { restrictPreparationActions } from '../../core/takeover-policy.mjs';

// Runs inside the original executor job. The executor awaits every operation;
// no second queue, page, lease owner or asynchronous controller is introduced.
export async function runPreparationTakeover(runtime,{task,observe,plan,act,ready,active=()=>true}) {
  if(task.attemptBoundary||task.receipt)throw Error('已有提交边界，必须先核验，禁止 AI 重投');
  if(task.controller==='supervisor'||task.controller==='ai')throw Error('任务控制权已被占用');
  const prior=task.aiTakeover;
  const state={id:prior?.id||randomUUID(),startedAt:prior?.startedAt||new Date().toISOString(),actions:prior?.actions||0,calls:prior?.calls||0,strategy:prior?.strategy||'initial',stale:0,history:structuredClone(prior?.history||[]),retries:(prior?.retries||0)+(prior?1:0)};
  runtime.update(task,{controller:'ai',aiTakeover:state},'ai_takeover_started');
  let result={ok:false,reason:'model_limit'},lastHash;
  try {
    for(;;) {
      if(!active()){result={ok:false,reason:'interrupted'};break;}
      if(task.attemptBoundary||task.receipt)throw Error('接管期间出现提交边界，必须先核验');
      await runtime.lease(task,{online:true});
      const snapshot=await observe();
      if(await ready(snapshot)){result={ok:true,reason:'prepared'};break;}
      if(state.calls>=10||state.actions>=20){result={ok:false,reason:state.actions>=20?'action_limit':'model_limit'};break;}
      state.stale=snapshot.domHash===lastHash?state.stale+1:0;
      if(state.stale>=2)state.strategy='alternative';
      lastHash=snapshot.domHash;
      state.calls++;
      runtime.update(task,{aiTakeover:structuredClone(state)},'ai_model_boundary');
      const response=await plan({snapshot,strategy:state.strategy,calls:state.calls,actions:state.actions,history:state.history.slice(-4)});
      if(response.status!=='act'){result={ok:false,reason:response.reason||response.status||'model_no_action'};break;}
      const allowed=restrictPreparationActions(response.actions,snapshot,Math.min(4,20-state.actions));
      if(!allowed.length){result={ok:false,reason:'no_permitted_action'};break;}
      for(const action of allowed){
        if(!active()){result={ok:false,reason:'interrupted'};break;}
        await runtime.lease(task,{online:true});
        state.actions++;
        const event={at:new Date().toISOString(),type:action.type,selector:action.selector,mediaKind:action.mediaKind};
        state.history.push(event);
        runtime.update(task,{aiTakeover:structuredClone(state)},'ai_action_boundary');
        try{await act(action,snapshot);event.ok=true;}catch(error){event.ok=false;event.error=error.message;}
        runtime.update(task,{aiTakeover:structuredClone(state)},'ai_action_observed');
        if(action.type==='click'||event.ok===false)break; // Always observe a changed screen before the next decision.
      }
      if(!active()){result={ok:false,reason:'interrupted'};break;}
      if(await ready()){result={ok:true,reason:'prepared'};break;}
    }
    if(!result.ok&&state.actions>=20)result.reason='action_limit';
  }catch(error){result={ok:false,reason:error.message};}
  finally{state.finishedAt=new Date().toISOString();state.reason=result.reason;state.ok=result.ok;
    runtime.update(task,{controller:'executor',aiTakeover:structuredClone(state)},'ai_takeover_returned');}
  return result;
}
